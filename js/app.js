// 畫面控制：所有資料都透過 window.api 存取
(function () {
  'use strict';
  var HH = window.HH;
  var api = window.api;
  var Charts = window.Charts;
  var HHPhoto = window.HHPhoto;

  var MEAL_ORDER = ['早餐', '午餐', '晚餐', '點心'];
  var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  var st = { provider: null, profile: null, body: [], meals: [], water: [], bowel: [], tab: 'today' };
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
  function signed(v, decimals) {
    var r = Number(Math.abs(v).toFixed(decimals));
    if (r === 0) return '±0';
    return (v < 0 ? '−' : '+') + r.toFixed(decimals);
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

  function openFaq() {
    faqReturn = { view: currentView() || 'login', scroll: window.scrollY };
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
    bindLogin();
    bindOnboard();
    bindToday();
    bindTrend();
    bindAccount();
    $$('.tabbar button').forEach(function (b) {
      b.onclick = function () { switchTab(b.dataset.tab); };
    });

    // 沒有個別處理的錯誤（例如網路斷線），統一用提示訊息告訴使用者
    window.addEventListener('unhandledrejection', function (e) {
      toast((e.reason && e.reason.message) || '發生錯誤，請稍後再試');
    });

    // LINE 登入回來時網址會帶登入代碼：先記下來並立刻從網址列清掉
    var lineCallback = captureLineCallback();

    if (!api.isDemo) {
      api.onAuthLost = function (msg) {
        st = { provider: null, profile: null, body: [], meals: [], water: [], bowel: [], tab: 'today' };
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

  // ---------- 基本資料（第一次登入、我的帳號共用檢查）----------
  function readProfileForm(form, errEl, needAgree) {
    var p = {
      nickname: form.nickname.value.trim(),
      sex: radioValue(form, 'sex'),
      heightCm: num(form.heightCm.value),
      targetKg: num(form.targetKg.value)
    };
    var err = '';
    if (!p.sex) err = '請選擇性別';
    else if (p.heightCm == null || p.heightCm < 100 || p.heightCm > 230) err = '請填寫身高（100～230 公分）';
    else if (p.targetKg == null || p.targetKg < 30 || p.targetKg > 200) err = '請填寫目標體重（30～200 公斤）';
    else if (needAgree && !form.agree.checked) err = '請先勾選同意隱私權政策';
    errEl.textContent = err;
    return err ? null : p;
  }

  function bindOnboard() {
    var form = $('#onboard-form');
    form.onsubmit = async function (e) {
      e.preventDefault();
      var p = readProfileForm(form, $('#onboard-error'), true);
      if (!p) return;
      var profile = await api.saveProfile(p, true);
      enterApp(profile);
      toast('歡迎，' + profile.nickname + '！');
    };
  }

  // ---------- 主畫面 ----------
  async function enterApp(profile) {
    st.profile = profile;
    var data = await Promise.all([api.getBody(), api.getMeals(), api.getWater(), api.getBowel()]);
    st.body = data[0];
    st.meals = data[1];
    st.water = data[2];
    st.bowel = data[3];
    $('#hello').textContent = '嗨，' + profile.nickname;
    showView('app');
    setupDatePicker();
    clearPending();
    switchTab('today');
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
    $('#in-visceral').value = rec && rec.visceralFat != null ? rec.visceralFat : '';
    $('#body-status').textContent = rec ? '這天已經記過了，改完按儲存就會更新' : '';
    $('#body-save').textContent = rec ? '更新身體數據' : '儲存身體數據';
    renderDayMeals(date);
    renderWater();
    renderDayBowel();
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
    var list = st.meals.filter(function (m) { return m.date === date; });
    if (!list.length) { $('#day-meals').innerHTML = '<p class="hint">這天還沒有飲食紀錄</p>'; return; }
    list.sort(mealSort);
    $('#day-meals').innerHTML = '<p class="sub">這天已記錄</p>' + list.map(function (m) {
      return '<div class="meal-row"><span class="meal-tag">' + esc(m.meal) + '</span><span class="meal-text">' + mealTextHtml(m) +
        photoThumbsHtml(m) + '</span></div>';
    }).join('');
    hydratePhotos($('#day-meals'));
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
    $('#photo-hint').textContent = busyPhotos ? '照片處理中…' : (left > 0 ? '還可以加 ' + left + ' 張' : '已達 3 張上限');
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

    $('#body-save').onclick = async function () {
      var date = $('#rec-date').value;
      var rec = {
        date: date,
        weightKg: num($('#in-weight').value),
        bodyFatPct: num($('#in-fat').value),
        muscleKg: num($('#in-muscle').value),
        visceralFat: num($('#in-visceral').value)
      };
      if (rec.weightKg == null && rec.bodyFatPct == null && rec.muscleKg == null && rec.visceralFat == null) {
        toast('請至少填一項');
        return;
      }
      var warn = [];
      if (rec.weightKg != null && (rec.weightKg < 20 || rec.weightKg > 300)) warn.push('體重 ' + rec.weightKg + ' 公斤');
      if (rec.bodyFatPct != null && (rec.bodyFatPct <= 0 || rec.bodyFatPct > 70)) warn.push('體脂 ' + rec.bodyFatPct + '%');
      if (rec.muscleKg != null && (rec.muscleKg <= 0 || rec.muscleKg > 150)) warn.push('肌肉量 ' + rec.muscleKg + ' 公斤');
      if (rec.visceralFat != null && (rec.visceralFat <= 0 || rec.visceralFat > 50)) warn.push('內臟脂肪 ' + rec.visceralFat + '%');
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
      var gap = HH.round1(lw.weightKg - p.targetKg);
      h.push('<p>' + (gap > 0
        ? '目標 ' + p.targetKg + ' 公斤，<strong>還差 ' + gap.toFixed(1) + ' 公斤</strong>'
        : '已達成目標體重 ' + p.targetKg + ' 公斤！') + '</p>');
    } else {
      h.push('<p class="sub">我的 BMI</p><p>記錄體重後就會顯示 BMI</p>');
      h.push('<p class="bmi-range">建議範圍 ' + HH.BMI_LOW + '～' + HH.BMI_HIGH + '，依你的身高建議體重 ' + range[0].toFixed(1) + '～' + range[1].toFixed(1) + ' 公斤</p>');
    }
    if (lf) {
      h.push('<p class="fat-line">體脂 ' + lf.bodyFatPct.toFixed(1) + '% ' + tag(HH.fatStatus(p.sex, lf.bodyFatPct)) +
        '<span class="hint">' + (p.sex === 'F' ? '女性' : '男性') + ' ' + HH.fatThreshold(p.sex) + '% 以上屬偏高</span></p>');
    }
    $('#bmi-card').innerHTML = h.join('');
    renderCharts();
  }

  var METRICS = [
    { key: 'weightKg', name: '體重', unit: '公斤', decimals: 1 },
    { key: 'bodyFatPct', name: '體脂', unit: '%', decimals: 1 },
    { key: 'muscleKg', name: '肌肉量', unit: '公斤', decimals: 1 },
    { key: 'visceralFat', name: '內臟脂肪', unit: '%', decimals: 1 }
  ];

  function renderCharts() {
    var range = radioValue($('#range-seg'), 'range');
    var from = range === 'all' ? null : HH.addDays(HH.today(), -(parseInt(range, 10) - 1));
    var p = st.profile;
    var html = METRICS.map(function (m) {
      var pts = st.body
        .filter(function (r) { return r[m.key] != null && (!from || r.date >= from); })
        .map(function (r) { return { date: r.date, value: r[m.key] }; });
      var summary = '';
      if (pts.length >= 2) {
        var diff = pts[pts.length - 1].value - pts[0].value;
        var unit = m.unit === '%' ? '%' : ' ' + m.unit;
        summary = (range === 'all' ? '記錄以來' : '這 ' + range + ' 天') + m.name + ' <strong>' + signed(diff, m.decimals) + unit + '</strong>';
      }
      var opts = { label: m.name + '變化圖', decimals: m.decimals, band: null, target: null };
      if (m.key === 'weightKg') {
        opts.band = HH.suggestedWeight(p.heightCm);
        opts.target = p.targetKg;
      }
      return '<div class="card chart-card"><div class="chart-head"><h2>' + m.name + '</h2><span class="chart-sum">' + summary + '</span></div>' +
        Charts.lineChart(pts, opts) + '</div>';
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
        return n ? '<span class="seg-' + i + '" style="flex:' + n + '">' + v + ' ' + n + '</span>' : '';
      }).join('') + '</div>';
    }
    return head +
      '<p>' + rangeWord(range) + '共 <strong>' + list.length + ' 次</strong>，平均每天 <strong>' + (list.length / days).toFixed(1) + ' 次</strong></p>' +
      '<p class="sub stat-label">型態</p>' + bar('form', ['硬', '軟', '未成形']) +
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
      var bodyHtml = rec ? '<div class="body-grid">' + METRICS.map(function (m) {
        var v = rec[m.key];
        var unit = m.unit === '%' ? '%' : ' ' + m.unit;
        return '<span class="body-stat"><span class="sub">' + m.name + '</span>' +
          (v == null ? '<span class="hint">—</span>' : '<span><strong>' + Number(v).toFixed(m.decimals) + '</strong>' + unit + '</span>') + '</span>';
      }).join('') + '</div>' : NOT_RECORDED;

      var ml = waterOn(d);
      var waterHtml = ml ? '<strong>' + fmtNum(ml) + '</strong> c.c.' : NOT_RECORDED;

      var bowels = st.bowel.filter(function (b) { return b.date === d; })
        .sort(function (a, b) { return a.createdAt - b.createdAt; });
      var bowelHtml = bowels.length
        ? '<strong>' + bowels.length + '</strong> 次（' + bowels.map(function (b) { return esc(b.amount) + '・' + esc(b.form); }).join('、') + '）'
        : NOT_RECORDED;

      var meals = byDate[d].sort(mealSort);
      var mealHtml = meals.length
        ? '<ul class="diary-list">' + meals.map(function (m) {
          return '<li class="diary-item"><span class="meal-tag">' + esc(m.meal) + '</span>' +
            '<span class="meal-text">' + mealTextHtml(m) + photoThumbsHtml(m) + '</span>' +
            '<span class="diary-actions"><button type="button" class="link-btn" data-edit="' + esc(m.id) + '">修改</button>' +
            '<button type="button" class="link-btn danger-text" data-del="' + esc(m.id) + '">刪除</button></span></li>';
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
    $$('[data-edit]').forEach(function (b) { b.onclick = function () { editMeal(b.dataset.edit); }; });
    $$('[data-del]').forEach(function (b) { b.onclick = function () { deleteMeal(b.dataset.del); }; });
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
    renderDiary();
    toast('已修改');
  }

  async function deleteMeal(id) {
    var m = st.meals.find(function (x) { return x.id === id; });
    if (!m) return;
    var photoNote = m.photoIds && m.photoIds.length ? '（含 ' + m.photoIds.length + ' 張照片）' : '';
    if (!(await ask('確定要刪除「' + m.meal + '：' + (m.text || '照片') + '」' + photoNote + '嗎？', { okText: '刪除', danger: true }))) return;
    await api.deleteMeal(id);
    st.meals = await api.getMeals();
    renderDiary();
    toast('已刪除');
  }

  // ---------- 競賽排行 ----------
  async function renderRank() {
    $('#board').innerHTML = '<li class="hint">讀取中…</li>';
    var lb = await api.getLeaderboard();
    $('#season-label').textContent = lb.season.label;
    $('#season-note').textContent = lb.note || '';
    $('#season-note').hidden = !lb.note;

    var r = lb.me.result;
    var me;
    if (r.qualified) {
      me = '<p class="sub">我的成績</p>' +
        '<p class="me-rank">第 <strong>' + lb.me.rank + '</strong> 名 · ' + r.score.toFixed(2) + ' 分</p>' +
        '<p>體脂 ' + r.first.bodyFatPct + '% → ' + r.last.bodyFatPct + '%（減少比例 ' + r.fatPct.toFixed(2) + '%）</p>' +
        '<p>體重 ' + r.first.weightKg + ' → ' + r.last.weightKg + ' 公斤（減少比例 ' + r.weightPct.toFixed(2) + '%）</p>' +
        '<p class="hint">這一欄只有你自己看得到</p>';
    } else if (r.status === 'none') {
      me = '<p class="sub">我的成績</p><p>記錄一筆同時有<strong>體重和體脂</strong>的資料，就開始參加這一季的比賽</p>';
    } else if (r.status === 'waiting') {
      me = '<p class="sub">我的成績</p><p>再記錄 <strong>' + r.daysLeft + ' 天</strong>就能上榜</p>' +
        '<p class="hint">第一筆到最新一筆要相隔至少 ' + HH.MIN_SPAN_DAYS + ' 天</p>';
    } else if (r.status === 'ready') {
      me = '<p class="sub">我的成績</p><p>已經滿 ' + HH.MIN_SPAN_DAYS + ' 天了，<strong>再記一筆體重和體脂</strong>就能上榜</p>';
    } else {
      me = '<p class="sub">我的成績</p><p>這一季剩下的天數不夠 ' + HH.MIN_SPAN_DAYS + ' 天，下一季再一起加油！</p>';
    }
    $('#my-status').innerHTML = me;

    if (!lb.entries.length) {
      $('#board').innerHTML = '<li class="hint">這一季還沒有人上榜</li>';
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
    f.heightCm.value = p.heightCm;
    f.targetKg.value = p.targetKg;
    $('#profile-error').textContent = '';
    $('#login-with').textContent = '目前用 LINE 登入';
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
    f.onsubmit = async function (e) {
      e.preventDefault();
      var p = readProfileForm(f, $('#profile-error'), false);
      if (!p) return;
      st.profile = await api.saveProfile(p, false);
      $('#hello').textContent = '嗨，' + st.profile.nickname;
      fillAccount();
      toast('已儲存');
    };

    $('#export-body').onclick = function () {
      var rows = [['日期', '體重（公斤）', '體脂（%）', '肌肉量（公斤）', '內臟脂肪（%）']];
      st.body.forEach(function (r) { rows.push([r.date, r.weightKg, r.bodyFatPct, r.muscleKg, r.visceralFat]); });
      download('花蓮共好健康生活_身體數據_' + HH.today() + '.csv', rows);
    };

    $('#export-meals').onclick = function () {
      var rows = [['日期', '餐別', '內容', '照片張數']];
      st.meals.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : mealSort(a, b); })
        .forEach(function (m) { rows.push([m.date, m.meal, m.text, (m.photoIds || []).length]); });
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
      var ok = await ask('刪除後，你的身體數據、飲食紀錄和照片都會永久消失，無法復原。確定要刪除，請輸入「確認刪除」。', {
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
      st = { provider: null, profile: null, body: [], meals: [], water: [], bowel: [], tab: 'today' };
      showView('login');
      toast('帳號和所有資料已刪除');
    };
  }

  init();
})();
