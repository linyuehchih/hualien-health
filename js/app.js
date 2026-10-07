// 畫面控制：所有資料都透過 window.api 存取
(function () {
  'use strict';
  var HH = window.HH;
  var api = window.api;
  var Charts = window.Charts;
  var HHPhoto = window.HHPhoto;

  var MEAL_ORDER = ['早餐', '午餐', '晚餐', '點心'];
  var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  var st = { provider: null, profile: null, body: [], meals: [], water: [], bowel: [], tab: 'today', rankScope: 'all', managed: [], selfNick: '', switching: false };
  var waterQueue = Promise.resolve(); // 飲水連按時依序存檔，不會漏算
  var WATER_WARN_ML = 6000;
  var pending = [];   // 還沒送出的照片 [{blob, url}]
  var busyPhotos = 0; // 正在壓縮的照片數

  // ---------- 小工具 ----------
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) {
    if (v === '' || v == null) return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  // 數字最多顯示到小數點後 2 位（多的 0 去掉），但至少保留 decimals 位，例如 63.25、63.2、63.0
  function numText(v, decimals) {
    var r = Math.round(Number(v) * 100) / 100;
    var s = String(r), d = s.indexOf('.') < 0 ? 0 : s.length - s.indexOf('.') - 1;
    return d >= decimals ? s : r.toFixed(decimals);
  }
  function signed(v, decimals) {
    var r = decimals === 0 ? Math.round(Math.abs(v)) : Math.round(Math.abs(v) * 100) / 100;
    if (r === 0) return '±0';
    return (v < 0 ? '−' : '+') + numText(r, decimals);
  }
  function dateLabel(s) {
    var d = HH.parse(s);
    var base = (d.getMonth() + 1) + '月' + d.getDate() + '日（週' + WEEKDAYS[d.getDay()] + '）';
    var diff = HH.daysBetween(s, HH.today());
    if (diff === 0) return '今天 · ' + base;
    if (diff === 1) return '昨天 · ' + base;
    return base;
  }
  function radioValue(container, name) {
    var el = container.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }
  function setRadio(container, name, value) {
    container.querySelectorAll('input[name="' + name + '"]').forEach(function (el) { el.checked = el.value === value; });
  }

  // 程式內部的錯誤訊息（例如 JSON Parse error）民眾看不懂，換成白話
  function friendlyError(e) {
    var msg = (e && e.message) || '';
    if (!msg) return '發生錯誤，請稍後再試';
    if (/JSON|Unexpected|undefined|null|not a function|not an object|Cannot read|is not/i.test(msg)) {
      return '畫面讀取資料時出了點問題，請重新整理網頁再試一次';
    }
    return msg;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  // 共用對話框：回傳 Promise，按確定為 true
  // opts: {okText, cancelText, danger, extraHtml, onOpen, validate}
  function ask(message, opts) {
    opts = opts || {};
    var dlg = $('#modal');
    $('#modal-msg').textContent = message;
    $('#modal-extra').innerHTML = opts.extraHtml || '';
    var ok = $('#modal-ok');
    ok.textContent = opts.okText || '確定';
    ok.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
    $('#modal-cancel').textContent = opts.cancelText || '取消';
    return new Promise(function (resolve) {
      function done(v) {
        $('#modal-form').onsubmit = null;
        $('#modal-cancel').onclick = null;
        dlg.oncancel = null;
        dlg.close();
        resolve(v);
      }
      $('#modal-form').onsubmit = function (e) {
        e.preventDefault();
        if (opts.validate && !opts.validate()) return;
        done(true);
      };
      $('#modal-cancel').onclick = function () { done(false); };
      dlg.oncancel = function (e) { e.preventDefault(); done(false); };
      dlg.showModal();
      if (opts.onOpen) opts.onOpen();
    });
  }

  function showView(name) {
    ['login', 'onboard', 'app', 'faq'].forEach(function (v) { $('#view-' + v).hidden = v !== name; });
    window.scrollTo(0, 0);
  }

  // ---------- 常見問題 ----------
  var faqReturn = { view: 'login', scroll: 0 };

  function currentView() {
    return ['login', 'onboard', 'app', 'faq'].filter(function (v) { return !$('#view-' + v).hidden; })[0];
  }

  // ---------- 使用導覽（2026-10-03）：第一次進主畫面時，一步一步圈出重點，最後停在「問」----------
  // 看過了記在這支手機的瀏覽器裡；之後可以從「問」頁面最上面「再看一次使用說明」重看
  var TOUR_KEY = 'hh_tour_v1';
  var TOUR_STEPS = [
    { sel: '.tabbar [data-tab="today"]', text: '每天在「今天記錄」記體重、三餐、喝水和排便' },
    { sel: '.tabbar [data-tab="trend"]', text: '「我的變化」看 BMI、變化曲線，還有離目標還差多少' },
    { sel: '.tabbar [data-tab="rank"]', text: '「競賽排行」每季一場比賽，可以看全部、本里、本據點的排名' },
    { sel: '.tabbar [data-tab="groups"]', text: '「家人群組」跟家人組隊互相打氣，也能幫沒有 LINE 的長輩記錄' },
    { sel: '#view-app .help-btn', text: '不知道怎麼用、有問題，就按右上角的「問」，裡面有常見問題可以查' }
  ];
  var tourIdx = 0;

  function tourSeen() { try { return localStorage.getItem(TOUR_KEY) === '1'; } catch (e) { return false; } }
  function markTourSeen() { try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) { /* 存不了就算了，下次再看一次 */ } }

  function startTour() {
    tourIdx = 0;
    $('#tour').hidden = false;
    showTourStep();
    $('#tour-next').focus();
  }

  function endTour() {
    $('#tour').hidden = true;
    markTourSeen();
  }

  function showTourStep() {
    var s = TOUR_STEPS[tourIdx];
    var el = $(s.sel);
    if (!el) { endTour(); return; }
    var r = el.getBoundingClientRect(), pad = 6;
    var hole = $('.tour-hole');
    hole.style.left = (r.left - pad) + 'px';
    hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + pad * 2) + 'px';
    hole.style.height = (r.height + pad * 2) + 'px';
    var last = tourIdx === TOUR_STEPS.length - 1;
    $('#tour-step').textContent = (tourIdx + 1) + '／' + TOUR_STEPS.length;
    $('#tour-text').textContent = s.text;
    $('#tour-next').textContent = last ? '知道了' : '下一步';
    $('#tour-skip').hidden = last;
    // 說明框放在圈起來的地方旁邊：目標在畫面下半部就放上面，否則放下面
    var tip = $('.tour-tip');
    var w = Math.min(340, window.innerWidth - 32);
    tip.style.width = w + 'px';
    tip.style.left = Math.max(16, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 16)) + 'px';
    if (r.top > window.innerHeight / 2) {
      tip.style.top = '';
      tip.style.bottom = (window.innerHeight - r.top + pad + 12) + 'px';
    } else {
      tip.style.bottom = '';
      tip.style.top = (r.bottom + pad + 12) + 'px';
    }
  }

  function bindTour() {
    $('#tour-next').onclick = function () {
      if (tourIdx >= TOUR_STEPS.length - 1) { endTour(); return; }
      tourIdx++;
      showTourStep();
    };
    $('#tour-skip').onclick = endTour;
    window.addEventListener('resize', function () { if (!$('#tour').hidden) showTourStep(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#tour').hidden) endTour(); });
    $('#tour-again').onclick = function () {
      closeFaq();
      window.scrollTo(0, 0);
      setTimeout(startTour, 200);
    };
  }

  function openFaq() {
    faqReturn = { view: currentView() || 'login', scroll: window.scrollY };
    $('#tour-again').hidden = faqReturn.view !== 'app'; // 登入前看常見問題時不顯示
    $('#faq-q').value = '';
    renderFaq();
    showView('faq');
  }

  function closeFaq() {
    showView(faqReturn.view);
    window.scrollTo(0, faqReturn.scroll);
  }

  function renderFaq() {
    var all = window.HH_FAQ || [];
    var words = $('#faq-q').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var hits = all.filter(function (f) {
      var text = (f.cat + ' ' + f.q + ' ' + f.a.replace(/<[^>]+>/g, '') + ' ' + (f.k || '')).toLowerCase();
      return words.every(function (w) { return text.indexOf(w) >= 0; });
    });
    $('#faq-count').textContent = words.length ? '找到 ' + hits.length + ' 題' : '共 ' + all.length + ' 題，點問題看答案';
    if (!hits.length) {
      $('#faq-list').innerHTML = '<div class="card"><p>找不到相關的問題，換個關鍵字試試，例如「體脂」「喝水」「排行」。</p></div>';
      return;
    }
    var cats = [];
    hits.forEach(function (f) { if (cats.indexOf(f.cat) < 0) cats.push(f.cat); });
    $('#faq-list').innerHTML = cats.map(function (c) {
      return '<div class="card faq-cat"><h2>' + esc(c) + '</h2>' + hits.filter(function (f) { return f.cat === c; }).map(function (f) {
        // 答案是我們自己寫好的固定內容（js/faq.js），直接當 HTML 顯示
        return '<details class="faq-item"' + (words.length && hits.length <= 3 ? ' open' : '') + '><summary>' + esc(f.q) + '</summary><div class="faq-a">' + f.a + '</div></details>';
      }).join('') + '</div>';
    }).join('');
  }

  // ---------- 啟動 ----------
  function init() {
    if (api.isDemo) {
      $('#demo-banner').innerHTML = '示範模式：畫面上都是假資料，還沒連接後台 ' +
        '<button type="button" id="demo-reset" class="link-btn">重設示範</button>';
      $('#demo-banner').hidden = false;
      $('#demo-reset').onclick = async function () {
        if (!(await ask('要清掉所有示範資料，回到剛打開的狀態嗎？'))) return;
        await api.resetDemo();
        location.reload();
      };
    }
    $$('[data-open-faq]').forEach(function (b) { b.onclick = openFaq; });
    $('#faq-back').onclick = closeFaq;
    $('#faq-q').oninput = renderFaq;
    bindTour();
    bindLogin();
    bindOnboard();
    bindToday();
    bindTrend();
    bindRank();
    bindAccount();
    bindShare();
    bindManaged();
    bindGroups();
    $$('.tabbar button').forEach(function (b) {
      b.onclick = function () { switchTab(b.dataset.tab); };
    });

    // 沒有個別處理的錯誤（例如網路斷線），統一用提示訊息告訴使用者
    window.addEventListener('unhandledrejection', function (e) {
      toast(friendlyError(e.reason));
    });

    // LINE 登入回來時網址會帶登入代碼：先記下來並立刻從網址列清掉
    var lineCallback = captureLineCallback();

    if (!api.isDemo) {
      api.onAuthLost = function (msg) {
        st = { provider: null, profile: null, body: [], meals: [], water: [], bowel: [], tab: 'today', rankScope: 'all', managed: [], selfNick: '', switching: false };
        showView('login');
        toast(msg);
      };
    }

    if (lineCallback && !api.isDemo) {
      finishLineLogin(lineCallback);
      return;
    }

    api.getSession().then(function (s) {
      st.provider = s.provider;
      if (!s.loggedIn) showView('login');
      else if (!s.profile) showView('onboard');
      else enterApp(s.profile);
    }).catch(function (e) {
      showView('login');
      toast(e.message);
    });
  }

  // ---------- LINE 登入（正式模式） ----------
  var LINE_AUTH_KEY = 'hh_line_auth';

  // 從 LINE 授權頁按「上一頁」回來時，把按鈕恢復成可以按
  window.addEventListener('pageshow', function () {
    var b = document.querySelector('[data-login="line"]');
    if (b) b.disabled = false;
  });

  // 登入結束後要回到的網址，必須和 LINE 後台設定的 Callback URL 完全一樣
  function lineRedirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }

  function base64url(bytes) {
    var s = '';
    bytes.forEach(function (b) { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomCode(n) { return base64url(crypto.getRandomValues(new Uint8Array(n))); }

  function saveTemp(v) {
    try { sessionStorage.setItem(LINE_AUTH_KEY, v); } catch (e) { /* 存不了就算了 */ }
    try { localStorage.setItem(LINE_AUTH_KEY, v); } catch (e) { /* 有些 LINE 內建瀏覽器會清 sessionStorage */ }
  }
  function takeTemp() {
    var v = null;
    try { v = sessionStorage.getItem(LINE_AUTH_KEY); sessionStorage.removeItem(LINE_AUTH_KEY); } catch (e) { /* 略過 */ }
    try { v = v || localStorage.getItem(LINE_AUTH_KEY); localStorage.removeItem(LINE_AUTH_KEY); } catch (e) { /* 略過 */ }
    try { return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }

  async function startLineLogin() {
    var cfg = window.HH_CONFIG || {};
    var state = randomCode(16), nonce = randomCode(16), verifier = randomCode(32);
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    saveTemp(JSON.stringify({ state: state, nonce: nonce, verifier: verifier, at: Date.now() }));
    var q = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.lineChannelId,
      redirect_uri: lineRedirectUri(),
      state: state,
      scope: 'openid profile',
      nonce: nonce,
      code_challenge: base64url(new Uint8Array(digest)),
      code_challenge_method: 'S256'
    });
    location.href = 'https://access.line.me/oauth2/v2.1/authorize?' + q.toString();
  }

  function captureLineCallback() {
    var q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return null;
    var cb = { code: q.get('code'), state: q.get('state'), error: q.get('error') };
    history.replaceState(null, '', lineRedirectUri() + location.hash);
    return cb;
  }

  async function finishLineLogin(cb) {
    var saved = takeTemp();
    showView('login');
    if (cb.error) { toast('已取消 LINE 登入'); return; }
    // 登入代碼要在 10 分鐘內用掉，且 state 要對得上，才確定是這個瀏覽器發出的登入
    if (!saved || saved.state !== cb.state || Date.now() - saved.at > 600000) {
      toast('LINE 登入驗證失敗，請再按一次「用 LINE 登入」');
      return;
    }
    try {
      var res = await api.loginLine({ code: cb.code, redirectUri: lineRedirectUri(), codeVerifier: saved.verifier, nonce: saved.nonce });
      st.provider = 'line';
      if (res.needsProfile) {
        showView('onboard');
      } else {
        var s = await api.getSession();
        enterApp(s.profile);
      }
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- 登入（只用 LINE；示範模式直接進入） ----------
  function bindLogin() {
    $$('[data-login]').forEach(function (b) {
      b.onclick = async function () {
        if (!api.isDemo && b.dataset.login === 'line') {
          b.disabled = true;
          startLineLogin().catch(function (e) { b.disabled = false; toast(e.message); });
          return;
        }
        st.provider = b.dataset.login;
        var res = await api.login(st.provider);
        if (res.needsProfile) {
          showView('onboard');
        } else {
          var s = await api.getSession();
          enterApp(s.profile);
        }
      };
    });
  }

  // ---------- 里別 → 據點類型 → 承辦單位（清單在 js/sites.js）----------
  var SITES = window.HH_SITES || { villages: [], types: [], sites: [] };
  function siteById(id) { return SITES.sites.find(function (s) { return s.id === id; }) || null; }
  function opt(value, text) { return '<option value="' + esc(value) + '">' + esc(text) + '</option>'; }

  function buildSitePicker(form) {
    form.querySelector('.site-picker').innerHTML =
      '<label class="field"><span>住在哪一里</span><select name="village">' + opt('', '請選擇') +
        SITES.villages.map(function (v) { return opt(v, v); }).join('') + '</select></label>' +
      '<div class="site-more" hidden>' +
        '<p class="hint">有參加社區據點的話，再選據點類型和承辦單位；居家的長輩不用選</p>' +
        '<label class="field"><span>據點類型</span><select name="siteType"></select></label>' +
        '<label class="field"><span>承辦單位</span><select name="siteId"></select></label>' +
        '<p class="sub site-full"></p>' +
      '</div>';
    form.village.onchange = function () { fillSiteTypes(form); };
    form.siteType.onchange = function () { fillSiteUnits(form); };
    form.siteId.onchange = function () { showSiteFull(form); };
  }

  // 承辦單位名稱很長，選單裡會被截斷，在下面顯示完整名稱
  function showSiteFull(form) {
    var s = siteById(form.siteId.value);
    var el = form.querySelector('.site-full');
    el.textContent = s ? '已選：' + s.name : '';
    el.hidden = !s;
  }

  function fillSiteTypes(form) {
    var inVillage = SITES.sites.filter(function (s) { return s.village === form.village.value; });
    var types = SITES.types.filter(function (t) { return inVillage.some(function (s) { return s.type === t; }); });
    form.querySelector('.site-more').hidden = !types.length;
    form.siteType.innerHTML = opt('', '沒有參加據點（居家）') + types.map(function (t) { return opt(t, t); }).join('');
    fillSiteUnits(form);
  }

  function fillSiteUnits(form) {
    var type = form.siteType.value;
    var list = SITES.sites.filter(function (s) { return s.village === form.village.value && s.type === type; });
    form.siteId.disabled = !type;
    form.siteId.innerHTML = !type ? opt('', '—')
      : (list.length > 1 ? opt('', '請選擇') : '') + list.map(function (s) { return opt(s.id, s.name); }).join('');
    showSiteFull(form);
  }

  function setSitePicker(form, village, siteId) {
    form.village.value = village || '';
    fillSiteTypes(form);
    var s = siteById(siteId);
    if (s && s.village === form.village.value) {
      form.siteType.value = s.type;
      fillSiteUnits(form);
      form.siteId.value = s.id;
      showSiteFull(form);
    }
  }

  // ---------- 出生年、身高、目標體重：旁邊即時顯示建議體重範圍與提醒 ----------
  var ELDER_TARGET_NOTE = '65 歲以上不建議快速減重。目標請先和醫師或營養師討論；如果現在的體重已在建議範圍內，目標以「維持體重和肌力」為主。';
  var RANK_NORMAL_NOTE = '你的體重已在建議範圍內：體重這一項不加分也不扣分，分數主要看體脂率。建議以維持體重、增加肌力為主，減到過輕反而會扣分。';
  var RANK_LOW_NOTE = '你的體重低於建議範圍：繼續減重會扣分，也可能傷害健康；體重往建議範圍增加反而會加分。建議諮詢醫師或營養師。';

  // 排行榜上體重這一項的說明（2026-10-03 起只算往健康體重範圍靠近多少）
  function weightScoreText(r) {
    if (r.weightInRange) return '都在健康範圍內，這項不加不扣';
    var v = r.weightPct || 0;
    return v >= 0 ? '往健康範圍靠近 ' + v.toFixed(2) + '%' : '離健康範圍遠了 ' + Math.abs(v).toFixed(2) + '%';
  }
  var ELDER_SHORT_NOTE ='65 歲以上不建議快速減重；體重已在建議範圍內的話，以維持體重和肌力為主。有疑問請洽醫師或營養師。';

  function bindBodyFields(form) {
    var birthHint = form.querySelector('.birth-hint');
    var rangeLine = form.querySelector('.range-line');
    var fillBtn = form.querySelector('.fill-mid');
    var warn = form.querySelector('.target-warn');

    function refresh() {
      var by = HH.parseBirthYear(form.birthYear.value);
      var raw = form.birthYear.value.trim();
      birthHint.textContent = by != null ? '西元 ' + by + ' 年，今年約 ' + HH.ageOf(by) + ' 歲'
        : (raw ? '請填民國年，例如 45（民國 45 年出生）' : '');

      var h = num(form.heightCm.value);
      var range = h != null && h >= 100 && h <= 230 ? HH.suggestedWeight(h) : null;
      if (range) {
        rangeLine.innerHTML = '依你的身高，建議體重 <strong>' + range[0].toFixed(1) + '～' + range[1].toFixed(1) + ' 公斤</strong>（BMI ' + HH.BMI_LOW + '～' + HH.BMI_HIGH + '）';
        var mid = HH.round1((range[0] + range[1]) / 2);
        fillBtn.textContent = '不知道怎麼設？填入範圍中間值（' + mid.toFixed(1) + ' 公斤）';
        fillBtn.dataset.mid = mid;
        fillBtn.hidden = false;
      } else {
        rangeLine.textContent = '先填身高，這裡會顯示適合你的建議體重範圍';
        fillBtn.hidden = true;
      }

      var msgs = [];
      var t = num(form.targetKg.value);
      if (range && t != null && t > 0 && t < range[0]) {
        msgs.push('目標比建議範圍的下限（' + range[0].toFixed(1) + ' 公斤）還低，太瘦對健康也不好，建議重新考慮。');
      }
      if (HH.isElder(by)) msgs.push(ELDER_TARGET_NOTE);
      warn.innerHTML = msgs.map(esc).join('<br>');
      warn.hidden = !msgs.length;
    }

    ['birthYear', 'heightCm', 'targetKg'].forEach(function (n) { form[n].addEventListener('input', refresh); });
    fillBtn.onclick = function () { form.targetKg.value = fillBtn.dataset.mid; refresh(); };
    form.refreshBodyFields = refresh;
    refresh();
  }

  // ---------- 基本資料（第一次登入、我的帳號共用檢查）----------
  function readProfileForm(form, errEl, needAgree) {
    var p = {
      nickname: form.nickname.value.trim(),
      sex: radioValue(form, 'sex'),
      heightCm: num(form.heightCm.value),
      targetKg: num(form.targetKg.value),
      birthYear: HH.parseBirthYear(form.birthYear.value),
      village: form.village.value,
      siteId: form.siteType.value ? form.siteId.value : ''
    };
    var err = '';
    if (!p.sex) err = '請選擇性別';
    else if (p.birthYear == null) err = '請填寫出生年（民國年，例如 45）';
    else if (p.heightCm == null || p.heightCm < 100 || p.heightCm > 230) err = '請填寫身高（100～230 公分）';
    else if (p.targetKg != null && (p.targetKg < 30 || p.targetKg > 200)) err = '目標體重請填 30～200 公斤，不知道的話可以先留空';
    else if (!p.village) err = '請選擇住在哪一里';
    else if (form.siteType.value && !p.siteId) err = '請選擇承辦單位；沒有參加據點的話，類型選「沒有參加據點」';
    else if (needAgree && !form.agree.checked) err = '請先勾選同意隱私權政策';
    errEl.textContent = err;
    return err ? null : p;
  }

  function bindOnboard() {
    var form = $('#onboard-form');
    buildSitePicker(form);
    setSitePicker(form, '', '');
    bindBodyFields(form);
    form.onsubmit = async function (e) {
      e.preventDefault();
      var p = readProfileForm(form, $('#onboard-error'), true);
      if (!p) return;
      var btn = form.querySelector('button[type="submit"]');
      if (btn.disabled) return; // 連按兩次不重複送出
      btn.disabled = true;
      try {
        var profile = await api.saveProfile(p, true);
        try {
          await enterApp(profile);
        } catch (err) {
          // 會員已建好，只是讀取資料時出錯：重新向後台讀一次，再進主畫面
          if (api.refresh) await api.refresh();
          await enterApp(profile);
        }
        toast('歡迎，' + profile.nickname + '！');
      } catch (err) {
        $('#onboard-error').textContent = friendlyError(err);
        toast(friendlyError(err));
      } finally {
        btn.disabled = false;
      }
    };
  }

  // ---------- 代管：幫沒有 LINE 的長輩記錄 ----------
  // 讀取「目前操作的人」（自己或代管的長輩）的全部資料
  async function loadMemberData(profile) {
    st.profile = profile;
    var data = await Promise.all([api.getBody(), api.getMeals(), api.getWater(), api.getBowel()]);
    st.body = data[0];
    st.meals = data[1];
    st.water = data[2];
    st.bowel = data[3];
  }

  // 頂端的「記錄給誰」選單、藍色提示條，依目前狀態更新
  function updateWho() {
    var acting = !!(api.getActive && api.getActive());
    var has = st.managed.length > 0;
    var sel = $('#who');
    $('#hello').hidden = has;
    $('#hello').textContent = '嗨，' + st.selfNick;
    sel.hidden = !has;
    if (has) {
      var active = api.getActive();
      sel.innerHTML = '<option value="">我自己（' + esc(st.selfNick) + '）</option>' + st.managed.map(function (m) {
        return '<option value="' + esc(m.id) + '">幫 ' + esc(m.nickname) + ' 記錄</option>';
      }).join('');
      sel.value = active || '';
    }
    $('#view-app').classList.toggle('is-acting', acting);
    $('#acting-bar').hidden = !acting;
    if (acting) $('#acting-text').textContent = '目前是幫「' + st.profile.nickname + '」記錄（不是你自己）';
  }

  // 切換記錄的對象；id＝null 就是換回自己
  async function loadMember(id) {
    if (st.switching) return;
    st.switching = true;
    try {
      await waterQueue.catch(function () { /* 前一筆飲水存檔失敗也不影響切換 */ });
      var profile = await api.switchTo(id);
      await loadMemberData(profile);
      st.managed = await api.listManaged();
      updateWho();
      clearPending();
      setupDatePicker();
      switchTab('today');
      if (id) toast('現在是幫「' + profile.nickname + '」記錄');
    } catch (e) {
      toast(friendlyError(e));
      try {
        // 切換失敗：回到自己，畫面不要留在半套的狀態
        var me = await api.switchTo(null);
        await loadMemberData(me);
        st.managed = await api.listManaged();
        updateWho();
        switchTab('today');
      } catch (e2) { /* 還是失敗的話，提示已經跳出，請使用者重新整理 */ }
    } finally {
      st.switching = false;
    }
  }

  async function afterProfileSaved() {
    if (!api.getActive()) st.selfNick = st.profile.nickname;
    st.managed = await api.listManaged();
    updateWho();
  }

  function renderManagedList() {
    var acting = !!api.getActive();
    $('#managed-card').hidden = acting;
    if (acting) return;
    var n = st.managed.length;
    $('#managed-list').innerHTML = (n ? '<p class="count">已建立 ' + n + '／5 位</p>' : '') + st.managed.map(function (m) {
      return '<div class="managed-row"><span class="nick">' + esc(m.nickname) + '</span>' +
        '<button type="button" class="link-btn" data-switch="' + esc(m.id) + '">切換過去記錄</button></div>';
    }).join('');
    $('#managed-add').disabled = n >= 5;
    $('#managed-add').textContent = n >= 5 ? '已經建立 5 位了（上限）' : '新增長輩的帳號';
  }

  function bindManaged() {
    var form = $('#managed-form');
    buildSitePicker(form);
    bindBodyFields(form);
    $('#who').onchange = function () { loadMember($('#who').value || null); };
    $('#acting-back').onclick = function () { loadMember(null); };
    $('#managed-list').onclick = function (e) {
      var b = e.target.closest('[data-switch]');
      if (b) loadMember(b.dataset.switch);
    };
    api.onManagedLost = function (msg) { toast(msg); loadMember(null); };

    $('#managed-add').onclick = function () {
      form.reset();
      setSitePicker(form, '', '');
      form.refreshBodyFields();
      $('#managed-error').textContent = '';
      $('#managed-dialog').showModal();
    };
    $('#managed-cancel').onclick = function () { $('#managed-dialog').close(); };
    form.onsubmit = async function (e) {
      e.preventDefault();
      var p = readProfileForm(form, $('#managed-error'), false);
      if (!p) return;
      if (!form.consent.checked) { $('#managed-error').textContent = '請勾選「我已告知對方，並取得對方同意」'; return; }
      var btn = $('#managed-submit');
      if (btn.disabled) return;
      // 已經建立過性別、出生年、身高、里別都一樣的長輩：先確認，避免同一個人建立兩次
      var twin = (st.managed || []).find(function (m) { return similarManaged(m, p); });
      if (twin && !(await ask('你已經建立過很像的長輩「' + twin.nickname + '」（性別、出生年、身高、里別都一樣）。確定要再建立一位嗎？', { okText: '確定再建立一位' }))) return;
      btn.disabled = true;
      try {
        var res = await api.createManaged(Object.assign({}, p, { consent: true }));
        $('#managed-dialog').close();
        await loadMember(res.id);
      } catch (err) {
        $('#managed-error').textContent = friendlyError(err);
      } finally {
        btn.disabled = false;
      }
    };
  }

  // ---------- 主畫面 ----------
  async function enterApp(profile) {
    if (!profile) throw new Error('讀取不到個人資料');
    await loadMemberData(profile);
    st.selfNick = profile.nickname;
    st.managed = await api.listManaged();
    updateWho();
    showView('app');
    setupDatePicker();
    clearPending();
    switchTab('today');
    // 舊會員先補出生年；導覽留到下次打開（不要兩個視窗疊在一起）
    if (!profile.birthYear) promptBirthYear();
    else if (!tourSeen()) setTimeout(startTour, 500);
  }

  // 舊會員沒有出生年：打開網站時主動提醒，按「現在去填」直接帶到「我的帳號」
  async function promptBirthYear() {
    var go = await ask('請補填「出生年」。只收年份，不收月日，用來判斷是否為 65 歲以上；65 歲以上的朋友會多一些減重安全提醒。', {
      okText: '現在去填', cancelText: '稍後再說'
    });
    if (!go) return;
    switchTab('account');
    $('#profile-form').birthYear.focus();
  }

  function switchTab(name) {
    st.tab = name;
    $$('.tab').forEach(function (t) { t.hidden = t.id !== 'tab-' + name; });
    $$('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    if (name === 'today') renderToday();
    if (name === 'trend') renderTrend();
    if (name === 'diary') { diaryLimit = DIARY_PAGE; renderDiary(); }
    if (name === 'rank') renderRank();
    if (name === 'account') fillAccount();
    if (name === 'groups') loadGroups();
    window.scrollTo(0, 0);
  }

  // ---------- 今天記錄 ----------
  function setupDatePicker() {
    var d = $('#rec-date');
    var today = HH.today();
    d.max = today;
    d.min = HH.addDays(today, -HH.EDIT_WINDOW_DAYS);
    d.value = today;
  }

  function bodyOn(date) {
    return st.body.find(function (r) { return r.date === date; }) || null;
  }

  function renderToday() {
    var date = $('#rec-date').value;
    var rec = bodyOn(date);
    $('#in-weight').value = rec && rec.weightKg != null ? rec.weightKg : '';
    $('#in-fat').value = rec && rec.bodyFatPct != null ? rec.bodyFatPct : '';
    $('#in-muscle').value = rec && rec.muscleKg != null ? rec.muscleKg : '';
    renderVisceralField(rec);
    $('#body-status').textContent = rec ? '這天已經記過了，改完按儲存就會更新' : '';
    $('#body-save').textContent = rec ? '更新身體數據' : '儲存身體數據';
    renderDayMeals(date);
    renderWater();
    renderDayBowel();
  }

  // ---------- 內臟脂肪的單位（級／%／公斤）----------
  // 每位會員選自己體脂計用的單位；每筆紀錄記住當時的單位。紀錄沒有單位＝舊紀錄，當作 %。
  function viscUnit() { return (st.profile && st.profile.visceralUnit) || '%'; }
  function recVU(rec) { return (rec && rec.visceralUnit) || '%'; }
  function unitText(u) { return u === '%' || u === '級' ? u : ' ' + u; }
  // 內臟脂肪的單位和小數位數依會員的選擇，其他項目照舊
  function metricMeta(m) {
    if (m.key !== 'visceralFat') return m;
    var vm = HH.visceralMeta(viscUnit());
    return { key: m.key, name: m.name, unit: vm.unit, decimals: vm.decimals };
  }

  function renderVisceralField(rec) {
    var u = viscUnit(), vm = HH.visceralMeta(u);
    var old = !!(rec && rec.visceralFat != null && recVU(rec) !== u);
    $('#visceral-unit').value = u;
    $('#in-visceral').step = vm.step;
    $('#in-visceral').value = rec && rec.visceralFat != null && !old ? rec.visceralFat : '';
    var hint = $('#visceral-hint');
    hint.className = old ? 'hint old' : 'hint';
    hint.textContent = old
      ? '這天已記的內臟脂肪是 ' + rec.visceralFat + unitText(recVU(rec)) + '（原本的單位），會保留；填新的數字就會改成「' + u + '」。'
      : vm.hint;
  }

  async function changeVisceralUnit(unit) {
    var before = viscUnit();
    if (unit === before) return;
    try {
      st.profile = await api.setVisceralUnit(unit);
      var others = st.body.filter(function (r) { return r.visceralFat != null && recVU(r) !== unit; }).length;
      renderToday();
      toast(others ? '已改用「' + unit + '」。以前用其他單位記的 ' + others + ' 筆還在，但不會畫進曲線' : '已改用「' + unit + '」');
    } catch (e) {
      $('#visceral-unit').value = before;
      toast(friendlyError(e));
    }
  }

  function dayWord(date) { return date === HH.today() ? '今天' : '這天'; }
  function fmtNum(n) { return Number(n).toLocaleString('zh-TW'); }

  // ---------- 飲水 ----------
  function waterOn(date) {
    var w = st.water.find(function (x) { return x.date === date; });
    return w ? w.ml : 0;
  }

  // 建議喝水量：最新體重 × 30 c.c.，取到 50
  function suggestedWater() {
    var lw = latest('weightKg');
    return lw ? Math.round(lw.weightKg * 30 / 50) * 50 : null;
  }

  function renderWater() {
    var date = $('#rec-date').value;
    var ml = waterOn(date);
    $('#water-label').textContent = dayWord(date) + '已喝';
    $('#water-total').textContent = fmtNum(ml);
    var sug = suggestedWater();
    if (sug) {
      $('#water-suggest').textContent = '建議每天約 ' + fmtNum(sug) + ' c.c.（體重 × 30）' + (ml >= sug ? '，已達標！' : '，還差 ' + fmtNum(sug - ml) + ' c.c.');
      $('#water-bar').hidden = false;
      $('#water-bar-fill').style.width = Math.min(100, ml / sug * 100) + '%';
    } else {
      $('#water-suggest').textContent = '記錄體重後，會顯示建議喝水量';
      $('#water-bar').hidden = true;
    }
    if (document.activeElement !== $('#water-input')) $('#water-input').value = ml || '';
  }

  // 先更新畫面，再排隊存檔；連按很多下也會依序存成最後的總數
  async function setWaterTotal(date, ml) {
    if (ml > WATER_WARN_ML && waterOn(date) <= WATER_WARN_ML &&
      !(await ask('一天喝 ' + fmtNum(ml) + ' c.c.，數字好像不太對，確定要記錄嗎？', { okText: '確定', cancelText: '取消' }))) return false;
    var i = st.water.findIndex(function (w) { return w.date === date; });
    var rec = { date: date, ml: ml };
    if (i >= 0) st.water[i] = rec; else st.water.push(rec);
    renderWater();
    waterQueue = waterQueue
      .then(function () { return api.setWater(date, ml); })
      .catch(async function (e) {
        toast(e.message);
        st.water = await api.getWater();
        renderWater();
      });
    return true;
  }

  // ---------- 排便 ----------
  function renderDayBowel() {
    var date = $('#rec-date').value;
    var list = st.bowel.filter(function (b) { return b.date === date; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
    $('#bowel-count').textContent = dayWord(date) + ' ' + list.length + ' 次';
    if (!list.length) { $('#day-bowel').innerHTML = ''; return; }
    $('#day-bowel').innerHTML = list.map(function (b, i) {
      return '<div class="meal-row"><span class="meal-tag">第 ' + (i + 1) + ' 次</span>' +
        '<span class="meal-text">量：' + esc(b.amount) + '　型態：' + esc(b.form) + '</span>' +
        '<button type="button" class="link-btn danger-text" data-bdel="' + esc(b.id) + '">刪除</button></div>';
    }).join('');
    $$('[data-bdel]').forEach(function (btn) {
      btn.onclick = async function () {
        if (!(await ask('確定要刪除這一次的排便紀錄嗎？', { okText: '刪除', danger: true }))) return;
        await api.deleteBowel(btn.dataset.bdel);
        st.bowel = await api.getBowel();
        renderDayBowel();
        toast('已刪除');
      };
    });
  }

  function renderDayMeals(date) {
    var box = $('#day-meals');
    var list = orderMeals(st.meals.filter(function (m) { return m.date === date; }));
    if (!list.length) { box.innerHTML = '<p class="hint">這天還沒有飲食紀錄</p>'; return; }
    // 「今天記錄」這裡也可以修改、刪除（2026-10-04：原本只有「每日紀錄」有，民眾找不到）
    box.innerHTML = '<p class="sub">這天已記錄</p>' + list.map(function (m) {
      return '<div class="meal-row"><span class="meal-tag">' + esc(m.meal) + '</span><span class="meal-text">' + mealTextHtml(m) +
        photoThumbsHtml(m) + '</span>' +
        '<span class="diary-actions"><button type="button" class="link-btn" data-edit="' + esc(m.id) + '">修改</button>' +
        '<button type="button" class="link-btn danger-text" data-del="' + esc(m.id) + '">刪除</button></span></div>';
    }).join('');
    hydratePhotos(box);
    bindMealActions(box);
  }

  function bindMealActions(container) {
    container.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { editMeal(b.dataset.edit); }; });
    container.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { deleteMeal(b.dataset.del); }; });
  }

  // 修改或刪除飲食後，「今天記錄」和「每日紀錄」兩邊都要更新
  function refreshMealViews() {
    if ($('#rec-date') && $('#rec-date').value) renderDayMeals($('#rec-date').value);
    renderDiary();
  }

  // ---------- 照片 ----------
  function mealTextHtml(m) {
    return m.text ? esc(m.text) : '<span class="hint">（只有照片）</span>';
  }

  function photoThumbsHtml(m) {
    if (!m.photoIds || !m.photoIds.length) return '';
    return '<span class="thumbs thumbs-sm">' + m.photoIds.map(function (pid) {
      return '<button type="button" class="thumb" data-pid="' + esc(pid) + '" aria-label="看大張照片"></button>';
    }).join('') + '</span>';
  }

  // 先畫出照片框，再一張一張把照片補上
  function hydratePhotos(container) {
    container.querySelectorAll('[data-pid]').forEach(function (btn) {
      api.getPhotoUrl(btn.dataset.pid).then(function (url) {
        if (!url) {
          btn.classList.add('thumb-missing');
          btn.textContent = '照片未保留';
          btn.disabled = true;
          return;
        }
        var img = document.createElement('img');
        img.src = url;
        img.alt = '';
        btn.appendChild(img);
        btn.onclick = function () { openViewer(url); };
      });
    });
  }

  function openViewer(url) {
    $('#viewer-img').src = url;
    $('#viewer').showModal();
  }

  function renderPending() {
    $('#photo-preview').innerHTML = pending.map(function (p, i) {
      return '<span class="thumb thumb-lg"><img src="' + p.url + '" alt="">' +
        '<button type="button" class="thumb-x" data-remove="' + i + '" aria-label="移除這張">×</button></span>';
    }).join('');
    $$('[data-remove]').forEach(function (b) {
      b.onclick = function () {
        var p = pending.splice(parseInt(b.dataset.remove, 10), 1)[0];
        if (p) URL.revokeObjectURL(p.url);
        renderPending();
      };
    });
    var left = HHPhoto.MAX_PER_MEAL - pending.length;
    $('#photo-hint').textContent = busyPhotos ? '照片處理中…' : (left > 0 ? '每餐最多 ' + HHPhoto.MAX_PER_MEAL + ' 張' : '已加 ' + HHPhoto.MAX_PER_MEAL + ' 張（每餐上限）');
  }

  function clearPending() {
    pending.forEach(function (p) { URL.revokeObjectURL(p.url); });
    pending = [];
    renderPending();
  }

  async function addPhotos(files) {
    var room = HHPhoto.MAX_PER_MEAL - pending.length - busyPhotos;
    if (files.length > room) toast('每一餐最多 ' + HHPhoto.MAX_PER_MEAL + ' 張照片');
    var picked = files.slice(0, Math.max(0, room));
    var before = 0, after = 0;
    busyPhotos += picked.length;
    renderPending();
    for (var i = 0; i < picked.length; i++) {
      try {
        var r = await HHPhoto.compress(picked[i]);
        pending.push({ blob: r.blob, url: URL.createObjectURL(r.blob) });
        before += r.originalBytes;
        after += r.blob.size;
      } catch (e) {
        toast(e.message);
      }
      busyPhotos--;
      renderPending();
    }
    if (after) toast('照片已壓縮：' + HHPhoto.formatBytes(before) + ' → ' + HHPhoto.formatBytes(after));
  }

  function mealSort(a, b) {
    var d = MEAL_ORDER.indexOf(a.meal) - MEAL_ORDER.indexOf(b.meal);
    return d || a.createdAt - b.createdAt;
  }

  // 一天的飲食怎麼排（2026-10-04 岳志：要看得出點心是在哪兩餐之間吃的）
  // 早餐、午餐、晚餐固定照順序；點心依「記錄的時間」插在它之前最後記錄的那一餐後面。
  // 例：早餐→午餐→點心→晚餐這樣記，就照這樣排；事後才補記早餐，早餐還是排第一，不會跑到最後
  function orderMeals(list) {
    var out = list.filter(function (m) { return m.meal !== '點心'; }).sort(mealSort);
    list.filter(function (m) { return m.meal === '點心'; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; })
      .forEach(function (s) {
        var pos = 0;
        out.forEach(function (m, i) { if (m.createdAt <= s.createdAt) pos = i + 1; });
        out.splice(pos, 0, s);
      });
    return out;
  }

  function bindToday() {
    $('#rec-date').onchange = function () {
      var d = this.value;
      var min = this.min, max = this.max;
      if (!d || d < min || d > max) {
        toast('只能選最近 ' + HH.EDIT_WINDOW_DAYS + ' 天');
        this.value = HH.today();
      }
      renderToday();
    };

    $('#visceral-unit').onchange = function () { changeVisceralUnit(this.value); };

    $('#body-save').onclick = async function () {
      var date = $('#rec-date').value;
      var rec = {
        date: date,
        weightKg: num($('#in-weight').value),
        bodyFatPct: num($('#in-fat').value),
        muscleKg: num($('#in-muscle').value)
      };
      // 內臟脂肪：沒填、而且這天原本有「別的單位」的紀錄 → 連單位原樣保留，不要被清掉
      var before = bodyOn(date);
      var vv = num($('#in-visceral').value), vu = viscUnit();
      if (vv == null && before && before.visceralFat != null && recVU(before) !== vu) { vv = before.visceralFat; vu = recVU(before); }
      rec.visceralFat = vv;
      if (vv != null) rec.visceralUnit = vu;
      if (rec.weightKg == null && rec.bodyFatPct == null && rec.muscleKg == null && rec.visceralFat == null) {
        toast('請至少填一項');
        return;
      }
      var warn = [];
      if (rec.weightKg != null && (rec.weightKg < 20 || rec.weightKg > 300)) warn.push('體重 ' + rec.weightKg + ' 公斤');
      if (rec.bodyFatPct != null && (rec.bodyFatPct <= 0 || rec.bodyFatPct > 70)) warn.push('體脂率 ' + rec.bodyFatPct + '%');
      if (rec.muscleKg != null && (rec.muscleKg <= 0 || rec.muscleKg > 150)) warn.push('肌肉量 ' + rec.muscleKg + ' 公斤');
      if (warn.length && !(await ask(warn.join('、') + '，數字好像不太對，確定要儲存嗎？', { okText: '確定儲存', cancelText: '回去修改' }))) return;
      if (bodyOn(date) && !(await ask('這天已經記過了，要更新嗎？', { okText: '更新' }))) return;
      try {
        await api.saveBody(rec);
        st.body = await api.getBody();
        renderToday();
        toast('已儲存');
      } catch (e) {
        toast(e.message);
      }
    };

    $('#meal-photo').onchange = function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = ''; // 讓同一張照片可以再選一次
      if (files.length) addPhotos(files);
    };

    $('#meal-add').onclick = async function () {
      if (busyPhotos) { toast('照片還在處理，請稍等一下'); return; }
      var text = $('#meal-text').value.trim();
      if (!text && !pending.length) { toast('請寫下吃了什麼，或拍張照片'); $('#meal-text').focus(); return; }
      var meal = radioValue($('#meal-seg'), 'meal');
      var btn = this;
      btn.disabled = true;
      try {
        await api.addMeal({ date: $('#rec-date').value, meal: meal, text: text, photos: pending.map(function (p) { return p.blob; }) });
        st.meals = await api.getMeals();
        $('#meal-text').value = '';
        clearPending();
        renderDayMeals($('#rec-date').value);
        toast('已新增' + meal);
      } catch (e) {
        toast(e.message);
      } finally {
        btn.disabled = false;
      }
    };

    $$('[data-water]').forEach(function (b) {
      b.onclick = function () {
        var date = $('#rec-date').value;
        var add = parseInt(b.dataset.water, 10);
        setWaterTotal(date, waterOn(date) + add).then(function (ok) { if (ok) toast('+' + add + ' c.c.'); });
      };
    });

    $('#water-save').onclick = async function () {
      var v = num($('#water-input').value);
      if (v == null || v < 0) { toast('請輸入 0 以上的數字'); return; }
      v = Math.round(v);
      if (await setWaterTotal($('#rec-date').value, v)) {
        $('#water-input').blur();
        $('.water-edit').open = false;
        renderWater();
        toast('已改成 ' + fmtNum(v) + ' c.c.');
      }
    };

    $('#bowel-add').onclick = async function () {
      var amount = radioValue($('#bowel-amount'), 'bowel-amount');
      var form = radioValue($('#bowel-form'), 'bowel-form');
      if (!amount || !form) { toast(!amount ? '請選擇「量」' : '請選擇「型態」'); return; }
      try {
        await api.addBowel({ date: $('#rec-date').value, amount: amount, form: form });
        st.bowel = await api.getBowel();
        setRadio($('#bowel-amount'), 'bowel-amount', null);
        setRadio($('#bowel-form'), 'bowel-form', null);
        renderDayBowel();
        toast('已記錄');
      } catch (e) {
        toast(e.message);
      }
    };

    $('#viewer-close').onclick = function () { $('#viewer').close(); };
    $('#viewer').onclick = function (e) { if (e.target === this) this.close(); };
  }

  // ---------- 家人群組 ----------
  // 群組一律用「自己」的身分（不是目前代管的長輩）。成員可以是 LINE 會員，也可以是他代管的長輩。
  // 沒公開實際數字的人，後台只傳相對高低和變化量，圖上不畫座標數字。
  var gs = { list: [], id: null, view: 'board', member: null, range: '30', seq: 0, paneSeq: 0 };
  var GROUP_METRICS = {
    weightKg: { name: '體重', unit: '公斤', decimals: 1 },
    bodyFatPct: { name: '體脂率', unit: '%', decimals: 1 },
    muscleKg: { name: '肌肉量', unit: '公斤', decimals: 1 },
    visceralFat: { name: '內臟脂肪', unit: '%', decimals: 1 },
    water: { name: '飲水', unit: 'c.c.', decimals: 0 }
  };

  function curGroup() { return gs.list.find(function (g) { return g.id === gs.id; }) || null; }

  async function loadGroups() {
    var seq = ++gs.seq;
    $('#groups-loading').hidden = false;
    var list = gs.list;
    try { list = await api.listGroups(); } catch (e) { toast(friendlyError(e)); }
    if (seq !== gs.seq) return;
    $('#groups-loading').hidden = true;
    gs.list = list;
    if (!curGroup()) { gs.id = list.length ? list[0].id : null; gs.member = null; }
    renderGroups();
  }

  // 後台說「你不在這個群組裡」之類的錯誤：重新讀一次清單，畫面才會跟實際一致
  function groupError(e) {
    toast(friendlyError(e));
    if (e && e.code === 'GROUP') loadGroups();
  }

  // ---------- 我的家人圖（2026-10-03）----------
  // 兩位代管長輩的性別、出生年、身高、里別都一樣（或綽號一樣），很可能是重複建立了同一個人
  function managedKey(m) {
    return [m.sex, m.birthYear, m.heightCm, m.village].join('|');
  }
  function similarManaged(a, b) {
    var full = a.sex && a.birthYear && a.heightCm && a.village;
    return (full && managedKey(a) === managedKey(b)) || (a.nickname || '').replace(/\s+/g, '') === (b.nickname || '').replace(/\s+/g, '');
  }
  // 回傳 [[長輩A, 長輩B], ...]
  function managedDups(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) if (similarManaged(list[i], list[j])) out.push([list[i], list[j]]);
    }
    return out;
  }

  function renderFamilyMap() {
    var box = $('#family-map');
    var managed = st.managed || [];
    if (!managed.length && !gs.list.length) { box.hidden = true; return; }
    var dups = managedDups(managed);
    var dupIds = {};
    dups.forEach(function (p) { dupIds[p[0].id] = dupIds[p[1].id] = true; });
    var node = function (text, cls) { return '<span class="fam-node' + (cls ? ' ' + cls : '') + '">' + text + '</span>'; };

    var branches = [];
    branches.push('<div class="fam-branch"><p class="fam-label">我代管的長輩<b>' + managed.length + '／5 位</b></p><div class="fam-nodes">' +
      (managed.length ? managed.map(function (m) { return node(esc(m.nickname) + (dupIds[m.id] ? ' ⚠' : ''), dupIds[m.id] ? 'warn' : 'elder'); }).join('')
        : '<span class="hint">還沒有。沒有 LINE 的長輩可以到「我的帳號」幫他建立</span>') + '</div></div>');
    gs.list.forEach(function (g) {
      branches.push('<div class="fam-branch"><p class="fam-label">群組「' + esc(g.name) + '」<b>' + g.count + '／' + g.max + ' 人</b></p><div class="fam-nodes">' +
        // 我排第一、我代管的長輩接著，其他人在後面
        g.members.slice().sort(function (a, b) {
          var rank = function (m) { return m.isMe ? 0 : m.managedByMe ? 1 : 2; };
          return rank(a) - rank(b);
        }).map(function (m) {
          if (m.isMe) return node(esc(m.nickname) + '（我）', 'me');
          return node(esc(m.nickname) + (m.managedByMe ? '<small>代管</small>' : ''), m.managedByMe ? 'elder' : '');
        }).join('') + '</div></div>');
    });
    if (!gs.list.length) {
      branches.push('<div class="fam-branch"><p class="fam-label">家庭群組<b>0 個</b></p><div class="fam-nodes"><span class="hint">還沒有加入群組，可以在下面建立或用邀請碼加入</span></div></div>');
    }

    var warn = dups.map(function (p) {
      return '<p class="fam-warn">⚠ 「' + esc(p[0].nickname) + '」和「' + esc(p[1].nickname) + '」的資料一樣，可能重複建立了同一位長輩。' +
        '不需要的那一位：在畫面上方切換成他 →「我的帳號」→ 最下面的「刪除帳號」。</p>';
    }).join('');

    box.innerHTML = '<h2>我的家人圖</h2>' +
      '<div class="fam-root">' + node('我：' + esc(st.selfNick || '我'), 'root') + '</div>' +
      '<div class="fam-branches">' + branches.join('') + '</div>' + warn;
    box.hidden = false;
  }

  function renderGroups() {
    renderFamilyMap();
    var g = curGroup();
    $('#groups-acting-hint').hidden = !(api.getActive && api.getActive());
    $('#groups-intro').hidden = gs.list.length > 0;
    $('#groups-main').hidden = !g;
    $('#g-create').disabled = gs.list.length >= 3;
    $('#groups-limit').textContent = gs.list.length >= 3 ? '你已經加入 3 個群組了（每個人最多 3 個）' : '一個群組最多 10 人（含長輩），每個人最多加入 3 個群組';
    if (!g) return;

    var picker = $('#group-picker');
    picker.hidden = gs.list.length < 2;
    picker.innerHTML = gs.list.map(function (x) {
      return '<button type="button" class="chip' + (x.id === gs.id ? ' on' : '') + '" data-gid="' + esc(x.id) + '">' + esc(x.name) + '</button>';
    }).join('');

    var head = '<div class="group-title"><h2>' + esc(g.name) + '</h2><span class="sub">' + g.count + '／' + g.max + ' 人</span></div>';
    if (g.inviteCode) {
      head += '<p class="invite">邀請碼　<strong>' + esc(g.inviteCode) + '</strong></p>' +
        '<p class="hint">把邀請碼傳給有 LINE 的家人，他登入後到「家人群組」輸入就能加入。</p>' +
        '<div class="btn-row"><button type="button" class="btn primary" id="g-invite-share">分享邀請</button>' +
        '<button type="button" class="btn" id="g-invite-regen">重新產生邀請碼</button></div>';
    }
    head += '<div class="btn-row"><button type="button" class="btn danger-outline" id="g-leave">退出群組</button>' +
      (g.isCreator ? '<button type="button" class="btn danger-outline" id="g-disband">解散群組</button>' : '') + '</div>';
    $('#group-head').innerHTML = head;

    setRadio($('#group-view'), 'gview', gs.view);
    ['board', 'trend', 'members'].forEach(function (v) { $('#gpane-' + v).hidden = v !== gs.view; });
    if (gs.view === 'board') renderGroupBoard();
    else if (gs.view === 'trend') renderGroupTrend();
    else renderGroupMembers();
  }

  async function renderGroupBoard() {
    var g = curGroup(), box = $('#gpane-board');
    var seq = ++gs.paneSeq;
    box.innerHTML = '<div class="card"><p class="hint">讀取中…</p></div>';
    var lb;
    try { lb = await api.groupBoard(g.id); } catch (e) { box.innerHTML = ''; groupError(e); return; }
    if (seq !== gs.paneSeq) return;
    var rows = lb.entries.map(function (e) {
      return '<li class="board-row' + (e.isMe ? ' is-me' : '') + '">' +
        '<span class="rank rank-' + (e.rank <= 3 ? e.rank : 'n') + '">' + e.rank + '</span>' +
        '<span class="nick">' + esc(e.nickname) + (e.isMe ? '<span class="me-mark">你</span>' : '') + (e.mine ? '<span class="me-mark mine">我代管</span>' : '') + '</span>' +
        '<span class="score' + (e.score < 0 ? ' neg' : '') + '">' + e.score.toFixed(2) + '</span></li>';
    }).join('');
    box.innerHTML = '<div class="card"><h2>群組排行</h2><p class="sub">' + esc(lb.season.label) + '</p>' +
      (lb.note ? '<p class="rank-note">' + esc(lb.note) + '</p>' : '') +
      '<p class="hint">只顯示綽號和分數，不會顯示任何人的體重。算法和總排行榜一樣。</p>' +
      (rows ? '<ol class="board">' + rows + '</ol>'
        : '<p class="hint" style="margin-top:10px">還沒有人上榜。每位成員本季至少記錄兩筆（體重和體脂率都要有），而且第一筆到最新一筆相隔 14 天以上，就會出現在這裡。</p>') +
      (lb.notRanked ? '<p class="hint" style="margin-top:8px">還有 ' + lb.notRanked + ' 位成員還沒上榜</p>' : '') + '</div>';
  }

  async function renderGroupTrend() {
    var g = curGroup();
    if (!gs.member || !g.members.some(function (m) { return m.memberId === gs.member; })) {
      gs.member = (g.members.find(function (m) { return m.isMe; }) || g.members[0]).memberId;
    }
    $('#gtrend-members').innerHTML = g.members.map(function (m) {
      return '<button type="button" class="chip' + (m.memberId === gs.member ? ' on' : '') + '" data-mid="' + esc(m.memberId) + '">' +
        esc(m.nickname) + (m.isMe ? '（你）' : '') + '</button>';
    }).join('');
    setRadio($('#gtrend-range'), 'grange', gs.range);

    var seq = ++gs.paneSeq;
    var box = $('#gtrend-charts');
    box.innerHTML = '<div class="card"><p class="hint">讀取中…</p></div>';
    var d;
    try { d = await api.groupDetail(g.id, gs.member, gs.range); } catch (e) { box.innerHTML = ''; groupError(e); return; }
    if (seq !== gs.paneSeq) return;

    var note = $('#gtrend-note');
    note.hidden = d.showNumbers;
    note.textContent = '「' + d.nickname + '」沒有公開實際數字，圖上只顯示起伏和變化量。';

    var word = rangeWord(d.range);
    box.innerHTML = d.metrics.map(function (m) {
      var meta = m.key === 'visceralFat' ? Object.assign({ name: '內臟脂肪' }, HH.visceralMeta(d.visceralUnit)) : GROUP_METRICS[m.key];
      var unit = unitText(meta.unit), summary = '';
      if (m.n >= 2) {
        if (m.key === 'water') {
          var avg = m.pts.reduce(function (s, p) { return s + p.value; }, 0) / m.pts.length;
          summary = d.showNumbers ? word + '平均每天 <strong>' + fmtNum(Math.round(avg / 10) * 10) + ' c.c.</strong>' : word + '記錄了 <strong>' + m.n + ' 天</strong>';
        } else {
          summary = word + meta.name + ' <strong>' + signed(m.change, 1) + unit + '</strong>';
          if (d.showNumbers && m.current != null) summary += '（目前 ' + numText(m.current, meta.decimals) + unit + '）';
        }
      }
      var chart = Charts.lineChart(m.pts, {
        label: meta.name + '變化圖', decimals: d.showNumbers ? meta.decimals : 1, band: null, target: null,
        hideNumbers: !d.showNumbers, tone: m.key === 'water' ? 'sea' : undefined
      });
      var gTitle = m.key === 'visceralFat' ? meta.name + '（' + meta.unit + '）' : meta.name;
      return '<div class="card chart-card"><div class="chart-head"><h2>' + gTitle + '</h2><span class="chart-sum">' + summary + '</span></div>' + chart + '</div>';
    }).join('');
  }

  function renderGroupMembers() {
    var g = curGroup(), box = $('#gpane-members');
    var rows = g.members.map(function (m) {
      var badges = (m.isMe ? '<span class="me-mark">你</span>' : '') + (m.managedByMe ? '<span class="me-mark mine">我代管</span>' : '') +
        (m.isCreator ? '<span class="me-mark creator">建立者</span>' : '');
      var ctl = '';
      if (m.isMe || m.managedByMe) {
        ctl += '<label class="check small"><input type="checkbox" data-share="' + esc(m.memberId) + '"' + (m.showNumbers ? ' checked' : '') + '><span>讓這個群組看到實際數字（預設不公開）</span></label>';
      }
      if (m.managedByMe) ctl += '<button type="button" class="link-btn" data-remove="' + esc(m.memberId) + '">讓他退出群組</button>';
      else if (g.isCreator && !m.isMe) ctl += '<button type="button" class="link-btn danger-text" data-remove="' + esc(m.memberId) + '">移出群組</button>';
      return '<div class="gm-row"><div class="gm-name"><span class="nick">' + esc(m.nickname) + '</span>' + badges + '</div>' + ctl + '</div>';
    }).join('');

    var inGroup = g.members.map(function (m) { return m.memberId; });
    var addable = st.managed.filter(function (m) { return inGroup.indexOf(m.id) < 0; });
    var add = addable.map(function (m) {
      return '<button type="button" class="btn block" data-add="' + esc(m.id) + '"' + (g.count >= g.max ? ' disabled' : '') + '>讓「' + esc(m.nickname) + '」也加入這個群組</button>';
    }).join('');

    box.innerHTML = '<div class="card"><h2>成員</h2>' + rows +
      '<p class="hint" style="margin-top:10px">「實際數字」指體重、體脂率、肌肉量、內臟脂肪、飲水量的數值。沒有公開的話，家人只看得到起伏和變化量。</p></div>' +
      (add ? '<div class="card"><h2>幫長輩加入</h2><p class="hint">你代管的長輩不用邀請碼，由你決定要不要加入。</p>' + add + '</div>' : '');
  }

  function setGroupFromResult(sum) {
    var i = gs.list.findIndex(function (x) { return x.id === sum.id; });
    if (i >= 0) gs.list[i] = sum; else gs.list.push(sum);
  }

  function askText(message, id, placeholder, maxlength, okText) {
    return ask(message, {
      okText: okText, extraHtml: '<input type="text" id="' + id + '" maxlength="' + maxlength + '" placeholder="' + placeholder + '" autocomplete="off">',
      onOpen: function () { $('#' + id).value = ''; $('#' + id).focus(); },
      validate: function () { if ($('#' + id).value.trim()) return true; toast('請先填寫'); return false; }
    }).then(function (ok) { return ok ? $('#' + id).value.trim() : null; });
  }

  function bindGroups() {
    $('#group-picker').onclick = function (e) {
      var b = e.target.closest('[data-gid]');
      if (!b) return;
      gs.id = b.dataset.gid; gs.member = null; renderGroups();
    };
    $('#group-view').onchange = function (e) { gs.view = e.target.value; renderGroups(); };
    $('#gtrend-members').onclick = function (e) {
      var b = e.target.closest('[data-mid]');
      if (!b) return;
      gs.member = b.dataset.mid; renderGroupTrend();
    };
    $('#gtrend-range').onchange = function (e) { gs.range = e.target.value; renderGroupTrend(); };

    $('#g-create').onclick = async function () {
      var name = await askText('幫家庭群組取個名字（最多 20 字）', 'grp-name', '例如：我的家', 20, '建立');
      if (!name) return;
      try {
        var sum = await api.createGroup(name);
        setGroupFromResult(sum);
        gs.id = sum.id; gs.member = null;
        renderGroups();
        toast('群組建立好了，把邀請碼傳給家人吧');
      } catch (e) { groupError(e); }
    };

    $('#g-join').onclick = async function () {
      var code = await askText('請輸入家人給你的 6 碼邀請碼', 'grp-code', '例如 AB3K9X', 6, '加入');
      if (!code) return;
      try {
        var sum = await api.joinGroup(code);
        setGroupFromResult(sum);
        gs.id = sum.id; gs.member = null;
        renderGroups();
        toast('已加入「' + sum.name + '」');
      } catch (e) { groupError(e); }
    };

    // 群組抬頭裡的按鈕（內容每次重畫，用事件委派）
    $('#group-head').onclick = async function (e) {
      var g = curGroup();
      if (!g) return;
      var id = e.target.id;
      try {
        if (id === 'g-invite-share') {
          var text = '邀請你加入「' + g.name + '」家庭群組！\n邀請碼：' + g.inviteCode + '\n用 LINE 登入「花蓮共好健康生活」，到「家人群組」按「輸入邀請碼加入」：\n' + SHARE_URL + '?openExternalBrowser=1';
          if (navigator.share) {
            try { await navigator.share({ text: text }); } catch (err) { if (err && err.name !== 'AbortError') toast('分享沒有成功，邀請碼是 ' + g.inviteCode); }
          } else if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            toast('已複製邀請訊息，貼到 LINE 傳給家人');
          } else {
            toast('邀請碼是 ' + g.inviteCode + '，請傳給家人');
          }
        } else if (id === 'g-invite-regen') {
          if (!(await ask('重新產生邀請碼後，舊的邀請碼會立刻失效（已經加入的人不受影響）。確定嗎？', { okText: '重新產生' }))) return;
          setGroupFromResult(await api.regenInvite(g.id));
          renderGroups();
          toast('已產生新的邀請碼');
        } else if (id === 'g-leave') {
          var msg = '退出「' + g.name + '」後，家人馬上看不到你的資料（你的紀錄不會被刪除）。你代管的長輩也會一起退出。';
          if (g.isCreator) msg += g.count <= 1 ? '你是最後一位成員，退出後群組會解散。' : '你是建立者，退出後群組會交給最早加入的成員。';
          if (!(await ask(msg + '確定要退出嗎？', { okText: '退出', danger: true }))) return;
          await api.removeFromGroup(g.id, null);
          gs.id = null; gs.member = null;
          await loadGroups();
          toast('已退出群組');
        } else if (id === 'g-disband') {
          if (!(await ask('解散後，所有成員都會離開，群組會消失，無法復原。確定要解散「' + g.name + '」嗎？', { okText: '解散', danger: true }))) return;
          await api.disbandGroup(g.id);
          gs.id = null; gs.member = null;
          await loadGroups();
          toast('群組已解散');
        }
      } catch (err) { groupError(err); }
    };

    // 成員頁：公開實際數字、移出、讓長輩加入
    $('#gpane-members').onchange = async function (e) {
      var cb = e.target.closest('[data-share]');
      var g = curGroup();
      if (!cb || !g) return;
      try {
        setGroupFromResult(await api.setGroupShare(g.id, cb.dataset.share, cb.checked));
        renderGroupMembers();
        toast(cb.checked ? '這個群組現在看得到實際數字' : '已改回不公開實際數字');
      } catch (err) { cb.checked = !cb.checked; groupError(err); }
    };
    $('#gpane-members').onclick = async function (e) {
      var g = curGroup();
      if (!g) return;
      var rm = e.target.closest('[data-remove]'), add = e.target.closest('[data-add]');
      try {
        if (rm) {
          var who = g.members.find(function (m) { return m.memberId === rm.dataset.remove; });
          if (!who || !(await ask('確定要讓「' + who.nickname + '」離開「' + g.name + '」嗎？離開後群組裡的人就看不到他的資料了。', { okText: '確定', danger: true }))) return;
          await api.removeFromGroup(g.id, who.memberId);
          await loadGroups();
          toast('已移出群組');
        } else if (add) {
          setGroupFromResult(await api.addManagedToGroup(g.id, add.dataset.add));
          renderGroups(); // 上方的人數也要跟著更新
          toast('已加入群組');
        }
      } catch (err) { groupError(err); }
    };
  }

  // ---------- 分享成果（勾選項目 → 畫成圖片 → 用手機的分享選單傳出去）----------
  var SHARE_URL = 'https://linyuehchih.github.io/hualien-health/';
  var SHARE_ITEMS = [
    { key: 'weightKg', name: '體重變化圖', metric: 0 },
    { key: 'bodyFatPct', name: '體脂率變化圖', metric: 1 },
    { key: 'muscleKg', name: '肌肉量變化圖', metric: 2 },
    { key: 'visceralFat', name: '內臟脂肪變化圖', metric: 3 },
    { key: 'water', name: '飲水曲線' },
    { key: 'rank', name: '本季排名與分數' }
  ];
  var SHARE_DEFAULT_ON = ['weightKg', 'bodyFatPct', 'rank']; // 預設只勾這幾項，其他讓民眾自己加
  var share = { blob: null, url: null, seq: 0, timer: null, rank: null, checked: {} };

  function shareFrom(range) { return range === 'all' ? null : HH.addDays(HH.today(), -(parseInt(range, 10) - 1)); }

  function sharePoints(item, from) {
    if (item.key === 'water') {
      return st.water.filter(function (w) { return w.ml > 0 && (!from || w.date >= from); })
        .map(function (w) { return { date: w.date, value: w.ml }; });
    }
    return st.body.filter(function (r) {
      return r[item.key] != null && (!from || r.date >= from) && (item.key !== 'visceralFat' || recVU(r) === viscUnit());
    }).map(function (r) { return { date: r.date, value: r[item.key] }; });
  }

  function shareAvailable(item, from) {
    if (item.key === 'rank') return !!(share.rank && share.rank.qualified);
    return sharePoints(item, from).length >= 2;
  }

  function buildShareItems() {
    var range = radioValue($('#share-range'), 'share-range');
    var from = shareFrom(range);
    $('#share-items').innerHTML = SHARE_ITEMS.map(function (it) {
      var ok = shareAvailable(it, from);
      var note = ok ? '' : (it.key === 'rank' ? (share.rank ? '（還沒上榜）' : '（讀取中…）') : '（記錄還不夠）');
      var on = ok && (share.checked[it.key] !== undefined ? share.checked[it.key] : SHARE_DEFAULT_ON.indexOf(it.key) >= 0);
      return '<label class="check' + (ok ? '' : ' off') + '"><input type="checkbox" name="share-item" value="' + it.key + '"' +
        (on ? ' checked' : '') + (ok ? '' : ' disabled') + '><span>' + it.name + '<span class="note">' + note + '</span></span></label>';
    }).join('');
    $$('#share-items input').forEach(function (b) {
      b.onchange = function () { share.checked[b.value] = b.checked; scheduleShareRender(); };
    });
  }

  function shareSpec() {
    var range = radioValue($('#share-range'), 'share-range');
    var from = shareFrom(range);
    var showNumbers = $('#share-numbers').checked;
    var picked = $$('#share-items input:checked').map(function (b) { return b.value; });
    var sections = [];
    SHARE_ITEMS.forEach(function (it) {
      if (picked.indexOf(it.key) < 0) return;
      if (it.key === 'rank') {
        var r = share.rank;
        if (!r || !r.qualified) return;
        sections.push({ type: 'rank', title: r.seasonLabel,
          line1: '第 ' + r.rank + ' 名 · ' + r.score.toFixed(2) + ' 分',
          line2: '體脂率減少 ' + r.fatPct.toFixed(2) + '%｜體重' + weightScoreText(r) });
        return;
      }
      var pts = sharePoints(it, from);
      if (pts.length < 2) return;
      if (it.key === 'water') {
        var avg = pts.reduce(function (s, p) { return s + p.value; }, 0) / pts.length;
        sections.push({ type: 'chart', title: '飲水', pts: pts, decimals: 0, tone: 'sea',
          summary: showNumbers ? rangeWord(range) + '平均每天 ' + fmtNum(Math.round(avg / 10) * 10) + ' c.c.' : rangeWord(range) + '記錄了 ' + pts.length + ' 天' });
        return;
      }
      var m = metricMeta(METRICS[it.metric]);
      var diff = pts[pts.length - 1].value - pts[0].value;
      var unit = unitText(m.unit);
      var summary = rangeWord(range) + m.name + ' ' + signed(diff, m.decimals) + unit;
      if (showNumbers) summary += '（目前 ' + numText(pts[pts.length - 1].value, m.decimals) + unit + '）';
      sections.push({ type: 'chart', title: m.name, pts: pts, decimals: m.decimals, summary: summary });
    });
    var d = HH.parse(HH.today());
    return {
      nickname: st.profile.nickname,
      periodLabel: range === 'all' ? '記錄以來' : '近 ' + range + ' 天',
      dateText: (d.getMonth() + 1) + '/' + d.getDate() + ' 製作',
      showNumbers: showNumbers,
      sections: sections,
      url: SHARE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')
    };
  }

  function scheduleShareRender() {
    clearTimeout(share.timer);
    share.timer = setTimeout(renderShare, 120);
  }

  async function renderShare() {
    var seq = ++share.seq;
    var spec = shareSpec();
    var has = spec.sections.length > 0;
    var anyAvailable = $$('#share-items input:not(:disabled)').length > 0;
    $('#share-empty').textContent = anyAvailable ? '請至少勾選一項' : '記錄還不夠，多記錄幾天就能分享囉';
    $('#share-empty').hidden = has;
    $('#share-img').hidden = !has;
    $('#share-send').disabled = !has;
    $('#share-save').disabled = !has;
    if (!has) { share.blob = null; return; }
    try {
      var blob = await HHShare.render(spec);
      if (seq !== share.seq) return; // 已經又改了勾選，這張作廢
      share.blob = blob;
      if (share.url) URL.revokeObjectURL(share.url);
      share.url = URL.createObjectURL(blob);
      $('#share-img').src = share.url;
    } catch (e) {
      toast('圖片產生失敗，請再試一次');
    }
  }

  function saveShareImage() {
    if (!share.blob) return;
    var a = document.createElement('a');
    a.href = URL.createObjectURL(share.blob);
    a.download = 'hualien-gohealth-' + HH.today().replace(/-/g, '') + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  async function sendShare() {
    if (!share.blob) return;
    var file = new File([share.blob], 'hualien-gohealth.png', { type: 'image/png' });
    var data = { files: [file], text: '我在「花蓮共好健康生活」記錄健康，一起來！\n' + SHARE_URL + '?openExternalBrowser=1' };
    if (navigator.canShare && navigator.canShare(data)) {
      try {
        await navigator.share(data);
      } catch (e) {
        if (e && e.name !== 'AbortError') toast('分享沒有成功，請改按「儲存圖片」');
      }
    } else {
      saveShareImage();
      toast('這個瀏覽器不能直接分享，已儲存圖片，再到 LINE 傳給家人');
    }
  }

  async function openShare() {
    var cur = radioValue($('#range-seg'), 'range');
    setRadio($('#share-range'), 'share-range', cur);
    $('#share-numbers').checked = false;
    share.rank = null;
    share.checked = {};
    $('#share-tip').textContent = /Line\//.test(navigator.userAgent)
      ? '你現在在 LINE 裡開啟，分享選單可能不能用；可以按「儲存圖片」，再到 LINE 傳給家人。'
      : '按「分享」後選 LINE 就能傳出去；也可以長按上面的圖片儲存。';
    buildShareItems();
    $('#share-dialog').showModal();
    renderShare();
    // 排名要向後台讀，讀好後再更新勾選項目
    try {
      var lb = await api.getLeaderboard('all');
      var r = lb.me && lb.me.result;
      share.rank = r && r.qualified
        ? { qualified: true, rank: lb.me.rank, score: r.score, fatPct: r.fatPct, weightPct: r.weightPct, weightInRange: r.weightInRange, seasonLabel: lb.season.label }
        : { qualified: false };
    } catch (e) {
      share.rank = { qualified: false };
    }
    if ($('#share-dialog').open) { buildShareItems(); renderShare(); }
  }

  // 關閉時釋放圖片佔的記憶體，並讓還在畫的那張作廢（重複呼叫也沒關係）
  function cleanupShare() {
    clearTimeout(share.timer);
    share.seq++;
    if (share.url) { URL.revokeObjectURL(share.url); share.url = null; }
    share.blob = null;
    $('#share-img').removeAttribute('src');
  }

  function bindShare() {
    $('#share-open').onclick = openShare;
    $('#share-close').onclick = function () { cleanupShare(); $('#share-dialog').close(); };
    $('#share-dialog').addEventListener('close', cleanupShare); // 按 Esc 等其他方式關閉時
    $('#share-range').onchange = function () { buildShareItems(); scheduleShareRender(); };
    $('#share-numbers').onchange = scheduleShareRender;
    $('#share-send').onclick = sendShare;
    $('#share-save').onclick = saveShareImage;
  }

  // ---------- 我的變化 ----------
  function bindTrend() {
    $('#range-seg').onchange = renderCharts;
  }

  function latest(field) {
    for (var i = st.body.length - 1; i >= 0; i--) {
      if (st.body[i][field] != null) return st.body[i];
    }
    return null;
  }

  function tag(t) { return '<span class="tag tag-' + t.level + '">' + t.text + '</span>'; }

  function renderTrend() {
    var p = st.profile;
    var lw = latest('weightKg');
    var lf = latest('bodyFatPct');
    var range = HH.suggestedWeight(p.heightCm);
    var h = [];

    if (lw) {
      var b = HH.bmi(lw.weightKg, p.heightCm);
      h.push('<div class="bmi-top"><div><p class="sub">我的 BMI</p><p class="bmi-num">' + b.toFixed(1) + '</p></div>' + tag(HH.bmiCategory(b)) + '</div>');
      h.push('<p class="bmi-range">建議範圍 ' + HH.BMI_LOW + '～' + HH.BMI_HIGH + '</p>');
      h.push('<p>依你的身高 ' + p.heightCm + ' 公分，建議體重 <strong>' + range[0].toFixed(1) + '～' + range[1].toFixed(1) + ' 公斤</strong></p>');
      if (p.targetKg == null) {
        h.push('<p class="hint">還沒設定目標體重，想設定可以到「我的帳號」填寫</p>');
      } else {
        // 目標可能比現在重（想增重）也可能比較輕；差 0.5 公斤以內算達成
        var gap = HH.round2(lw.weightKg - p.targetKg);
        h.push('<p>' + (Math.abs(gap) <= 0.5
          ? '已達成目標體重 ' + p.targetKg + ' 公斤！'
          : '目標 ' + p.targetKg + ' 公斤，<strong>還要' + (gap > 0 ? '減' : '增加') + ' ' + numText(Math.abs(gap), 1) + ' 公斤</strong>') + '</p>');
      }
    } else {
      h.push('<p class="sub">我的 BMI</p><p>記錄體重後就會顯示 BMI</p>');
      h.push('<p class="bmi-range">建議範圍 ' + HH.BMI_LOW + '～' + HH.BMI_HIGH + '，依你的身高建議體重 ' + range[0].toFixed(1) + '～' + range[1].toFixed(1) + ' 公斤</p>');
    }
    if (lf) {
      h.push('<p class="fat-line">體脂率 ' + numText(lf.bodyFatPct, 1) + '% ' + tag(HH.fatStatus(p.sex, lf.bodyFatPct)) +
        '<span class="hint">' + (p.sex === 'F' ? '女性' : '男性') + ' ' + HH.fatThreshold(p.sex) + '% 以上屬偏高</span></p>');
    }
    if (HH.isElder(p.birthYear)) h.push('<p class="elder-note">' + esc(ELDER_SHORT_NOTE) + '</p>');
    $('#bmi-card').innerHTML = h.join('');
    renderCharts();
  }

  var METRICS = [
    { key: 'weightKg', name: '體重', unit: '公斤', decimals: 1 },
    { key: 'bodyFatPct', name: '體脂率', unit: '%', decimals: 1 },
    { key: 'muscleKg', name: '肌肉量', unit: '公斤', decimals: 1 },
    { key: 'visceralFat', name: '內臟脂肪', unit: '%', decimals: 1 }
  ];

  function renderCharts() {
    var range = radioValue($('#range-seg'), 'range');
    var from = range === 'all' ? null : HH.addDays(HH.today(), -(parseInt(range, 10) - 1));
    var p = st.profile;
    var html = METRICS.map(function (m0) {
      var m = metricMeta(m0);
      var inRange = st.body.filter(function (r) { return r[m.key] != null && (!from || r.date >= from); });
      // 內臟脂肪只畫目前單位的紀錄；其他單位的紀錄不混進來
      var pts = inRange
        .filter(function (r) { return m.key !== 'visceralFat' || recVU(r) === m.unit; })
        .map(function (r) { return { date: r.date, value: r[m.key] }; });
      var otherUnit = m.key === 'visceralFat' ? inRange.length - pts.length : 0;
      var summary = '';
      if (pts.length >= 2) {
        var diff = pts[pts.length - 1].value - pts[0].value;
        summary = (range === 'all' ? '記錄以來' : '這 ' + range + ' 天') + m.name + ' <strong>' + signed(diff, m.decimals) + unitText(m.unit) + '</strong>';
      }
      var title = m.key === 'visceralFat' ? m.name + '（' + m.unit + '）' : m.name;
      var opts = { label: m.name + '變化圖', decimals: m.decimals, band: null, target: null };
      if (m.key === 'weightKg') {
        opts.band = HH.suggestedWeight(p.heightCm);
        opts.target = p.targetKg;
      }
      var note = otherUnit ? '<p class="hint">另有 ' + otherUnit + ' 筆用其他單位記的紀錄，沒有畫在這張圖裡（在「每日紀錄」看得到）</p>' : '';
      return '<div class="card chart-card"><div class="chart-head"><h2>' + title + '</h2><span class="chart-sum">' + summary + '</span></div>' +
        Charts.lineChart(pts, opts) + note + '</div>';
    }).join('');
    $('#charts').innerHTML = html + waterChartHtml(range, from) + bowelStatsHtml(range, from);
  }

  function rangeWord(range) { return range === 'all' ? '記錄以來' : '這 ' + range + ' 天'; }

  function waterChartHtml(range, from) {
    var pts = st.water
      .filter(function (w) { return w.ml > 0 && (!from || w.date >= from); })
      .map(function (w) { return { date: w.date, value: w.ml }; });
    var summary = '';
    if (pts.length) {
      var avg = pts.reduce(function (s, p) { return s + p.value; }, 0) / pts.length;
      summary = rangeWord(range) + '平均每天 <strong>' + fmtNum(Math.round(avg / 10) * 10) + ' c.c.</strong>';
    }
    var sug = suggestedWater();
    return '<div class="card chart-card"><div class="chart-head"><h2>飲水</h2><span class="chart-sum">' + summary + '</span></div>' +
      Charts.lineChart(pts, { label: '飲水量變化圖', decimals: 0, band: null, target: sug, targetLabel: '建議', tone: 'sea' }) + '</div>';
  }

  function bowelStatsHtml(range, from) {
    var list = st.bowel.filter(function (b) { return !from || b.date >= from; });
    var head = '<div class="card"><div class="chart-head"><h2>排便</h2></div>';
    if (!list.length) return head + '<p class="chart-empty">還沒有紀錄</p></div>';
    // 平均天數：從選的範圍起點（或第一筆紀錄，取比較晚的）算到今天
    var firstDate = list.reduce(function (m, b) { return b.date < m ? b.date : m; }, list[0].date);
    var start = from && from > firstDate ? from : firstDate;
    var days = HH.daysBetween(start, HH.today()) + 1;
    function count(field, value) { return list.filter(function (b) { return b[field] === value; }).length; }
    function bar(field, values) {
      return '<div class="stat-bar">' + values.map(function (v, i) {
        var n = count(field, v);
        return n ? '<span class="seg-' + i + '" style="flex:' + n + '">' + v + '<br>' + n + '</span>' : '';
      }).join('') + '</div>';
    }
    return head +
      '<p>' + rangeWord(range) + '共 <strong>' + list.length + ' 次</strong>，平均每天 <strong>' + (list.length / days).toFixed(1) + ' 次</strong></p>' +
      '<p class="sub stat-label">型態</p>' + bar('form', ['硬', '軟', '未成形', '拉肚子']) +
      '<p class="sub stat-label">量</p>' + bar('amount', ['多', '中', '少']) +
      '</div>';
  }

  // ---------- 每日紀錄：依日期分，每天固定列 身體、飲水、排便、飲食 ----------
  function dayHeading(s) {
    var d = HH.parse(s);
    var text = (d.getMonth() + 1) + '月' + d.getDate() + '日（週' + WEEKDAYS[d.getDay()] + '）';
    var diff = HH.daysBetween(s, HH.today());
    var badge = diff === 0 ? '今天' : diff === 1 ? '昨天' : '';
    return '<h2 class="diary-date">' + text + (badge ? '<span class="day-badge">' + badge + '</span>' : '') + '</h2>';
  }

  function dayRow(label, html) {
    return '<div class="day-row"><span class="day-label">' + label + '</span><div class="day-value">' + html + '</div></div>';
  }

  var NOT_RECORDED = '<span class="hint">未記錄</span>';
  var DIARY_PAGE = 7;          // 一次顯示幾天，按「看更早的紀錄」再多 7 天
  var diaryLimit = DIARY_PAGE; // 修改、刪除後重畫時維持目前展開的天數

  function renderDiary() {
    var byDate = {};
    st.meals.forEach(function (m) { (byDate[m.date] = byDate[m.date] || []).push(m); });
    // 只有身體數據、飲水或排便、沒有三餐的日子也要列出來
    st.body.forEach(function (r) { byDate[r.date] = byDate[r.date] || []; });
    st.water.forEach(function (w) { if (w.ml > 0) byDate[w.date] = byDate[w.date] || []; });
    st.bowel.forEach(function (b) { byDate[b.date] = byDate[b.date] || []; });
    var dates = Object.keys(byDate).sort().reverse();
    if (!dates.length) {
      $('#diary').innerHTML = '<div class="card"><p>還沒有紀錄，到「今天記錄」記下第一筆吧</p></div>';
      return;
    }
    var shown = dates.slice(0, diaryLimit);
    var moreHtml = dates.length > shown.length
      ? '<button type="button" class="btn block" id="diary-more">看更早的紀錄（還有 ' + (dates.length - shown.length) + ' 天）</button>'
      : '';
    $('#diary').innerHTML = shown.map(function (d) {
      var rec = bodyOn(d);
      var bodyHtml = rec ? '<div class="body-grid">' + METRICS.map(function (m0) {
        var m = m0.key === 'visceralFat' ? Object.assign({}, m0, HH.visceralMeta(recVU(rec))) : m0; // 內臟脂肪用這筆紀錄自己的單位
        var v = rec[m.key];
        return '<span class="body-stat"><span class="sub">' + m.name + '</span>' +
          (v == null ? '<span class="hint">—</span>' : '<span><strong>' + numText(v, m.decimals) + '</strong>' + unitText(m.unit) + '</span>') + '</span>';
      }).join('') + '</div>' : NOT_RECORDED;

      var ml = waterOn(d);
      var waterHtml = ml ? '<strong>' + fmtNum(ml) + '</strong> c.c.' : NOT_RECORDED;

      var bowels = st.bowel.filter(function (b) { return b.date === d; })
        .sort(function (a, b) { return a.createdAt - b.createdAt; });
      var bowelHtml = bowels.length
        ? '<strong>' + bowels.length + '</strong> 次（' + bowels.map(function (b) { return esc(b.amount) + '・' + esc(b.form); }).join('、') + '）'
        : NOT_RECORDED;

      var meals = orderMeals(byDate[d]);
      var mealHtml = meals.length
        ? '<ul class="diary-list">' + meals.map(function (m) {
          // 每日紀錄只看不改（2026-10-04 岳志：當天的紀錄當天改，過幾天也記不清楚了）；修改、刪除在「今天記錄」
          return '<li class="diary-item"><span class="meal-tag">' + esc(m.meal) + '</span>' +
            '<span class="meal-text">' + mealTextHtml(m) + photoThumbsHtml(m) + '</span></li>';
        }).join('') + '</ul>'
        : NOT_RECORDED;

      return '<div class="card">' + dayHeading(d) +
        dayRow('身體', bodyHtml) + dayRow('飲水', waterHtml) + dayRow('排便', bowelHtml) + dayRow('飲食', mealHtml) + '</div>';
    }).join('') + moreHtml;

    if (moreHtml) {
      $('#diary-more').onclick = function () {
        diaryLimit += DIARY_PAGE;
        renderDiary();
      };
    }
    hydratePhotos($('#diary'));
  }

  async function editMeal(id) {
    var m = st.meals.find(function (x) { return x.id === id; });
    if (!m) return;
    var seg = MEAL_ORDER.map(function (name) {
      return '<label><input type="radio" name="edit-meal" value="' + name + '"' + (name === m.meal ? ' checked' : '') + '><span>' + name + '</span></label>';
    }).join('');
    var ok = await ask('修改 ' + dateLabel(m.date) + ' 的紀錄', {
      okText: '儲存',
      extraHtml: '<div class="seg seg-4" id="edit-seg">' + seg + '</div><textarea id="edit-text" rows="3" maxlength="200"></textarea>',
      onOpen: function () { var t = $('#edit-text'); t.value = m.text; t.focus(); },
      validate: function () {
        if ($('#edit-text').value.trim() || (m.photoIds && m.photoIds.length)) return true;
        toast('內容不能空白');
        return false;
      }
    });
    if (!ok) return;
    await api.updateMeal(id, { meal: radioValue($('#edit-seg'), 'edit-meal'), text: $('#edit-text').value.trim() });
    st.meals = await api.getMeals();
    refreshMealViews();
    toast('已修改');
  }

  async function deleteMeal(id) {
    var m = st.meals.find(function (x) { return x.id === id; });
    if (!m) return;
    var photoNote = m.photoIds && m.photoIds.length ? '（含 ' + m.photoIds.length + ' 張照片）' : '';
    if (!(await ask('確定要刪除「' + m.meal + '：' + (m.text || '照片') + '」' + photoNote + '嗎？', { okText: '刪除', danger: true }))) return;
    await api.deleteMeal(id);
    st.meals = await api.getMeals();
    refreshMealViews();
    toast('已刪除');
  }

  // ---------- 競賽排行 ----------
  // 排行範圍：全部／本里／本據點（只能看自己的里和據點）
  var rankSeq = 0;
  function bindRank() {
    $('#rank-scope').onchange = function (e) {
      st.rankScope = e.target.value;
      renderRank();
    };
  }

  function setupRankScope() {
    var p = st.profile || {};
    var box = $('#rank-scope');
    box.querySelector('input[value="village"] + span').textContent = p.village || '本里';
    box.querySelector('input[value="village"]').parentNode.hidden = !p.village;
    box.querySelector('input[value="site"]').parentNode.hidden = !p.siteId;
    if ((st.rankScope === 'village' && !p.village) || (st.rankScope === 'site' && !p.siteId)) st.rankScope = 'all';
    setRadio(box, 'scope', st.rankScope);
  }

  async function renderRank() {
    setupRankScope();
    var seq = ++rankSeq;
    $('#board').innerHTML = '<li class="hint">讀取中…</li>';
    var lb = await api.getLeaderboard(st.rankScope);
    if (seq !== rankSeq) return; // 已經切到別的範圍了
    var group = lb.group || { scope: 'all', label: '全部' };
    var inGroup = group.scope === 'all' ? '' : '（' + (group.scope === 'village' ? group.label : '本據點') + '）';
    $('#season-label').textContent = lb.season.label;
    $('#season-note').textContent = lb.note || '';
    $('#season-note').hidden = !lb.note;
    $('#board-title').textContent = '排行榜' + (group.scope === 'all' ? '（全部）' : inGroup);
    $('#board-group').textContent = group.scope === 'site' ? group.label : '';
    $('#board-group').hidden = group.scope !== 'site';
    $('#rank-elder').textContent = ELDER_SHORT_NOTE;
    $('#rank-elder').hidden = !HH.isElder(st.profile.birthYear);
    // 依最新 BMI 提醒：標準體重內不要為了名次減太多；過輕要暫停減重（只是文字，不影響分數與排名）
    var lw = latest('weightKg');
    var bmiNow = lw && st.profile.heightCm ? HH.bmi(lw.weightKg, st.profile.heightCm) : null;
    var bmiNote = bmiNow == null ? '' : bmiNow < HH.BMI_LOW ? RANK_LOW_NOTE : bmiNow < HH.BMI_HIGH ? RANK_NORMAL_NOTE : '';
    $('#rank-bmi').textContent = bmiNote;
    $('#rank-bmi').hidden = !bmiNote;

    var r = lb.me.result;
    var me;
    if (r.qualified) {
      me = '<p class="sub">我的成績</p>' +
        '<p class="me-rank">' + inGroup + '第 <strong>' + lb.me.rank + '</strong> 名 · ' + r.score.toFixed(2) + ' 分</p>' +
        '<p>體脂率 ' + r.first.bodyFatPct + '% → ' + r.last.bodyFatPct + '%（減少比例 ' + r.fatPct.toFixed(2) + '%）</p>' +
        '<p>體重 ' + r.first.weightKg + ' → ' + r.last.weightKg + ' 公斤（' + weightScoreText(r) + '）</p>' +
        '<p class="hint">這一欄只有你自己看得到</p>';
    } else if (r.status === 'none') {
      me = '<p class="sub">我的成績</p><p>記錄一筆同時有<strong>體重和體脂率</strong>的資料，就開始參加這一季的比賽</p>';
    } else if (r.status === 'waiting') {
      me = '<p class="sub">我的成績</p><p>再記錄 <strong>' + r.daysLeft + ' 天</strong>就能上榜</p>' +
        '<p class="hint">第一筆到最新一筆要相隔至少 ' + HH.MIN_SPAN_DAYS + ' 天</p>';
    } else if (r.status === 'ready') {
      me = '<p class="sub">我的成績</p><p>已經滿 ' + HH.MIN_SPAN_DAYS + ' 天了，<strong>再記一筆體重和體脂率</strong>就能上榜</p>';
    } else {
      me = '<p class="sub">我的成績</p><p>這一季剩下的天數不夠 ' + HH.MIN_SPAN_DAYS + ' 天，下一季再一起加油！</p>';
    }
    $('#my-status').innerHTML = me;

    if (!lb.entries.length) {
      $('#board').innerHTML = '<li class="hint">這一季' + (group.scope === 'village' ? '本里' : group.scope === 'site' ? '本據點' : '') + '還沒有人上榜</li>';
      return;
    }
    $('#board').innerHTML = lb.entries.map(function (e) {
      return '<li class="board-row' + (e.isMe ? ' is-me' : '') + '">' +
        '<span class="rank rank-' + (e.rank <= 3 ? e.rank : 'n') + '">' + e.rank + '</span>' +
        '<span class="nick">' + esc(e.nickname) + (e.isMe ? '<span class="me-mark">你</span>' : '') + '</span>' +
        '<span class="score' + (e.score < 0 ? ' neg' : '') + '">' + e.score.toFixed(2) + '</span></li>';
    }).join('');
  }

  // ---------- 我的帳號 ----------
  function fillAccount() {
    var f = $('#profile-form');
    var p = st.profile;
    f.nickname.value = p.nickname;
    setRadio(f, 'sex', p.sex);
    f.birthYear.value = p.birthYear ? p.birthYear - 1911 : '';
    f.heightCm.value = p.heightCm;
    f.targetKg.value = p.targetKg == null ? '' : p.targetKg;
    f.refreshBodyFields();
    setSitePicker(f, p.village, p.siteId);
    $('#profile-error').textContent = !p.birthYear ? '請補填出生年，才能看到適合你的提醒'
      : (p.village ? '' : '請補選住在哪一里，才能看本里的排行');
    var acting = !!api.getActive();
    $('#profile-title').textContent = acting ? '「' + p.nickname + '」的基本資料' : '基本資料';
    $('#login-with').textContent = acting ? '你正在幫「' + p.nickname + '」管理這個帳號（長輩不需要登入）' : '目前用 LINE 登入';
    $('#logout').hidden = acting;
    $('#delete-account').textContent = acting ? '刪除「' + p.nickname + '」的帳號和所有資料' : '刪除帳號和所有資料';
    renderManagedList();
  }

  function csvCell(v) {
    if (v == null) return '';
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download(filename, rows) {
    var csv = '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function bindAccount() {
    var f = $('#profile-form');
    buildSitePicker(f);
    bindBodyFields(f);
    f.onsubmit = async function (e) {
      e.preventDefault();
      var p = readProfileForm(f, $('#profile-error'), false);
      if (!p) return;
      try {
        st.profile = await api.saveProfile(p, false);
      } catch (err) {
        // 例如綽號已經有人用了：顯示在表單上，讓使用者直接改
        $('#profile-error').textContent = friendlyError(err);
        return;
      }
      await afterProfileSaved();
      fillAccount();
      toast('已儲存');
    };

    $('#export-body').onclick = function () {
      var rows = [['日期', '體重（公斤）', '體脂率（%）', '肌肉量（公斤）', '內臟脂肪', '內臟脂肪單位']];
      st.body.forEach(function (r) { rows.push([r.date, r.weightKg, r.bodyFatPct, r.muscleKg, r.visceralFat, r.visceralFat != null ? recVU(r) : '']); });
      download('花蓮共好健康生活_身體數據_' + HH.today() + '.csv', rows);
    };

    $('#export-meals').onclick = function () {
      var rows = [['日期', '餐別', '內容', '照片張數']];
      var byDate = {};
      st.meals.forEach(function (m) { (byDate[m.date] = byDate[m.date] || []).push(m); });
      Object.keys(byDate).sort().forEach(function (d) {
        orderMeals(byDate[d]).forEach(function (m) { rows.push([m.date, m.meal, m.text, (m.photoIds || []).length]); });
      });
      download('花蓮共好健康生活_飲食紀錄_' + HH.today() + '.csv', rows);
    };

    $('#export-water').onclick = function () {
      var rows = [['日期', '飲水量（c.c.）']];
      st.water.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; })
        .forEach(function (w) { rows.push([w.date, w.ml]); });
      download('花蓮共好健康生活_飲水紀錄_' + HH.today() + '.csv', rows);
    };

    $('#export-bowel').onclick = function () {
      var rows = [['日期', '當天第幾次', '量', '型態']];
      var seen = {};
      st.bowel.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt; })
        .forEach(function (b) { seen[b.date] = (seen[b.date] || 0) + 1; rows.push([b.date, seen[b.date], b.amount, b.form]); });
      download('花蓮共好健康生活_排便紀錄_' + HH.today() + '.csv', rows);
    };

    $('#logout').onclick = async function () {
      await api.logout();
      showView('login');
      toast('已登出');
    };

    $('#delete-account').onclick = async function () {
      var wasActing = !!api.getActive();
      var msg;
      if (wasActing) {
        msg = '刪除後，「' + st.profile.nickname + '」的身體數據、飲食紀錄和照片都會永久消失，無法復原。確定要刪除，請輸入「確認刪除」。';
      } else {
        msg = '刪除後，你的身體數據、飲食紀錄和照片都會永久消失，無法復原。';
        if (st.managed.length) {
          msg += '你幫忙建立的 ' + st.managed.length + ' 位長輩（' + st.managed.map(function (m) { return m.nickname; }).join('、') + '）的資料也會一起刪除。';
        }
        msg += '確定要刪除，請輸入「確認刪除」。';
      }
      var ok = await ask(msg, {
        okText: '永久刪除',
        danger: true,
        extraHtml: '<input type="text" id="confirm-input" placeholder="確認刪除" autocomplete="off">',
        onOpen: function () { $('#confirm-input').focus(); },
        validate: function () {
          if ($('#confirm-input').value.trim() === '確認刪除') return true;
          toast('請輸入「確認刪除」四個字');
          return false;
        }
      });
      if (!ok) return;
      await api.deleteAccount();
      if (wasActing) {
        // 只刪了這位長輩：回到自己
        await loadMember(null);
        toast('已刪除這位長輩的帳號和所有資料');
        return;
      }
      st = { provider: null, profile: null, body: [], meals: [], water: [], bowel: [], tab: 'today', rankScope: 'all', managed: [], selfNick: '', switching: false };
      showView('login');
      toast('帳號和所有資料已刪除');
    };
  }

  init();
})();
