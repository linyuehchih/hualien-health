// 示範用的假後台：資料只存在這個瀏覽器
// 真正的後台在 api.js；設定檔沒有 apiUrl、或網址加 ?demo=1 時才用這份
(function (g) {
  'use strict';
  var HH = g.HH;
  var KEY = 'hh_demo_v1';
  var memory = null; // 瀏覽器不給存時的備用
  var activeId = null; // 代管中的成員編號；null＝自己
  // 示範模式的照片只暫存在這次開啟的畫面裡（重新整理就不見），Step 4 改存到雲端硬碟
  var photoStore = {};

  function emptyState() { return { session: null, profile: null, body: [], meals: [], water: [], bowel: [] }; }

  function load() {
    var s = null;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) s = JSON.parse(raw);
    } catch (e) { /* 改用記憶體 */ }
    s = s || memory || emptyState();
    // 舊版示範資料沒有飲水、排便
    if (!s.water) s.water = [];
    if (!s.bowel) s.bowel = [];
    return s;
  }
  function save(s) {
    memory = s;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 只留在記憶體 */ }
  }
  function delay(v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 120); }); }
  function fail(msg) { return Promise.reject(new Error(msg)); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  // 目前操作的對象：自己（整份資料），或代管的成員（s.managed 裡的一筆，欄位同樣有 profile、body…）
  function cur(s) {
    if (!activeId) return s;
    return (s.managed || []).find(function (m) { return m.id === activeId; }) || s;
  }

  // 固定亂數，讓每次產生的示範資料都一樣
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function randomTag() { return '夥伴#' + String(Math.floor(Math.random() * 10000)).padStart(4, '0'); }

  // 示範：過去約 95 天的身體數據（不含今天，讓人可以自己試著記一筆）
  function seedBody() {
    var r = rng(20261001);
    var today = HH.today();
    var out = [];
    for (var i = 95; i >= 1; i--) {
      if (r() < 0.2) continue;
      var t = (95 - i) / 95;
      out.push({
        date: HH.addDays(today, -i),
        weightKg: HH.round1(78.4 - 3.4 * t + (r() - 0.5) * 0.8),
        bodyFatPct: HH.round1(29.6 - 2.4 * t + (r() - 0.5) * 0.6),
        muscleKg: HH.round1(30.2 + 0.4 * t + (r() - 0.5) * 0.4),
        visceralFat: HH.round1(11.2 - 1.4 * t + (r() - 0.5) * 0.4),
        updatedAt: Date.now()
      });
    }
    return out;
  }

  function seedMeals() {
    var today = HH.today();
    var sample = [
      [0, '早餐', '地瓜稀飯、燙青菜、滷蛋'],
      [1, '早餐', '無糖豆漿、全麥饅頭'],
      [1, '午餐', '雞胸肉便當，飯半碗'],
      [1, '晚餐', '清蒸魚、炒高麗菜、糙米飯'],
      [1, '點心', '芭樂一顆'],
      [2, '午餐', '扁食湯、燙地瓜葉'],
      [2, '晚餐', '朋友聚餐吃火鍋，有點吃太多'],
      [3, '早餐', '鮪魚蛋餅、無糖紅茶'],
      [3, '晚餐', '牛肉麵（小碗）']
    ];
    return sample.map(function (s, i) {
      return { id: 'm' + i + Date.now(), date: HH.addDays(today, -s[0]), meal: s[1], text: s[2], createdAt: Date.now() + i };
    });
  }

  // 示範：過去 40 天的飲水與排便（不含今天）
  function seedWater() {
    var r = rng(77);
    var today = HH.today();
    var out = [];
    for (var i = 40; i >= 1; i--) {
      if (r() < 0.15) continue;
      out.push({ date: HH.addDays(today, -i), ml: 900 + Math.round(r() * 13) * 100, updatedAt: Date.now() });
    }
    return out;
  }

  function seedBowel() {
    var r = rng(99);
    var today = HH.today();
    var amounts = ['多', '中', '中', '少'];
    var forms = ['硬', '軟', '軟', '軟', '未成形'];
    var out = [];
    for (var i = 40; i >= 1; i--) {
      var n = r() < 0.2 ? 0 : (r() < 0.8 ? 1 : 2);
      for (var k = 0; k < n; k++) {
        out.push({
          id: 'b' + i + '_' + k,
          date: HH.addDays(today, -i),
          amount: amounts[Math.floor(r() * amounts.length)],
          form: forms[Math.floor(r() * forms.length)],
          createdAt: Date.now() - i * 86400000 + k
        });
      }
    }
    return out;
  }

  // 示範：其他會員（每個賽季固定產生同一批）
  var OTHER_NAMES = ['七星潭晨跑', '太魯閣步道客', '夥伴#2931', '鯉魚潭划船手', '美崙山散步', '曼波阿姨',
    '夥伴#0457', '吉安騎單車', '洄瀾健走隊', '瑞穗泡湯人', '夥伴#7812', '花蓮薯愛好者'];

  function othersFor(season, refDate) {
    var r = rng(hash(season.start));
    var lastDay = season.end < refDate ? season.end : refDate;
    return OTHER_NAMES.map(function (name, i) {
      var w0 = HH.round1(52 + r() * 40);
      var f0 = HH.round1(20 + r() * 15);
      var startOffset = Math.floor(r() * 25);
      var spanDays = 6 + Math.floor(r() * 75);
      var nPts = 1 + Math.floor(r() * 4);
      var wChange = -0.08 + r() * 0.1;
      var fChange = wChange * 1.3 + (r() - 0.5) * 0.04;
      var records = [];
      for (var k = 0; k < nPts; k++) {
        var frac = nPts === 1 ? 0 : k / (nPts - 1);
        var date = HH.addDays(season.start, startOffset + Math.round(spanDays * frac));
        if (date > lastDay) break;
        records.push({ date: date, weightKg: HH.round1(w0 * (1 + wChange * frac)), bodyFatPct: HH.round1(f0 * (1 + fChange * frac)) });
      }
      return { id: 'o' + i, nickname: name, hidden: false, records: records };
    });
  }

  function dropPhotos(ids) {
    (ids || []).forEach(function (pid) {
      if (photoStore[pid]) URL.revokeObjectURL(photoStore[pid]);
      delete photoStore[pid];
    });
  }

  function inEditWindow(date) {
    var today = HH.today();
    return date <= today && date >= HH.addDays(today, -HH.EDIT_WINDOW_DAYS);
  }

  var api = {
    isDemo: true,

    getSession: function () {
      var s = load();
      return delay({ loggedIn: !!s.session, provider: s.session && s.session.provider, profile: s.profile ? clone(s.profile) : null });
    },

    login: function (provider) {
      var s = load();
      activeId = null;
      s.session = { provider: provider };
      save(s);
      return delay({ needsProfile: !s.profile });
    },

    logout: function () {
      var s = load();
      activeId = null;
      s.session = null;
      save(s);
      return delay(true);
    },

    // isNew：第一次登入填資料時為 true，會順便放進示範資料
    saveProfile: function (p, isNew) {
      var s = load();
      if (!s.session) return fail('請先登入');
      var nickname = (p.nickname || '').trim();
      if (!nickname) nickname = (cur(s).profile && cur(s).profile.nickname) || randomTag();
      cur(s).profile = {
        nickname: nickname.slice(0, 12),
        sex: p.sex,
        heightCm: p.heightCm,
        targetKg: p.targetKg,
        birthYear: p.birthYear || (cur(s).profile && cur(s).profile.birthYear) || null,
        village: p.village || '',
        siteId: p.siteId || '',
        agreedAt: (cur(s).profile && cur(s).profile.agreedAt) || Date.now()
      };
      if (isNew) { cur(s).body = seedBody(); cur(s).meals = seedMeals(); cur(s).water = seedWater(); cur(s).bowel = seedBowel(); }
      save(s);
      return delay(clone(cur(s).profile));
    },

    refresh: function () { return delay(true); },

    // ---- 代管成員（幫沒有 LINE 的長輩記錄；示範資料）----
    listManaged: function () {
      return delay((load().managed || []).map(function (m) { return { id: m.id, nickname: m.profile.nickname }; }));
    },

    createManaged: function (p) {
      if (p.consent !== true) return fail('請勾選「我已告知對方並取得同意」');
      var s = load();
      s.managed = s.managed || [];
      if (s.managed.length >= 5) return fail('一個帳號最多可以幫 5 位長輩建立帳號');
      var m = {
        id: 'g' + Date.now() + Math.floor(Math.random() * 1000),
        profile: {
          nickname: ((p.nickname || '').trim() || randomTag()).slice(0, 12), sex: p.sex, heightCm: p.heightCm, targetKg: p.targetKg,
          birthYear: p.birthYear || null, village: p.village || '', siteId: p.siteId || '', agreedAt: Date.now(), managed: true
        },
        body: seedBody(), meals: [], water: seedWater(), bowel: seedBowel()
      };
      s.managed.push(m);
      save(s);
      return delay({ id: m.id, profile: clone(m.profile) });
    },

    switchTo: function (id) {
      var s = load();
      var m = id ? (s.managed || []).find(function (x) { return x.id === id; }) : null;
      if (id && !m) return fail('找不到這位代管的成員，請重新整理網頁');
      activeId = id || null;
      return delay(clone(cur(s).profile));
    },

    getActive: function () { return activeId; },

    getBody: function () {
      var s = load();
      return delay(clone(cur(s).body).sort(function (a, b) { return a.date < b.date ? -1 : 1; }));
    },

    saveBody: function (rec) {
      if (!inEditWindow(rec.date)) return fail('只能新增或修改最近 ' + HH.EDIT_WINDOW_DAYS + ' 天的紀錄');
      var s = load();
      var clean = {
        date: rec.date,
        weightKg: rec.weightKg, bodyFatPct: rec.bodyFatPct,
        muscleKg: rec.muscleKg, visceralFat: rec.visceralFat,
        updatedAt: Date.now()
      };
      var i = cur(s).body.findIndex(function (r) { return r.date === rec.date; });
      if (i >= 0) cur(s).body[i] = clean; else cur(s).body.push(clean);
      save(s);
      return delay(clone(clean));
    },

    getMeals: function () {
      return delay(clone(load().meals));
    },

    // m.photos：壓縮好的照片 [Blob]，最多 3 張
    addMeal: function (m) {
      var s = load();
      var photos = (m.photos || []).slice(0, 3);
      var photoIds = photos.map(function (blob, i) {
        var pid = 'p' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 1000);
        photoStore[pid] = URL.createObjectURL(blob);
        return pid;
      });
      var meal = { id: 'm' + Date.now() + Math.floor(Math.random() * 1000), date: m.date, meal: m.meal, text: m.text, photoIds: photoIds, createdAt: Date.now() };
      cur(s).meals.push(meal);
      save(s);
      return delay(clone(meal));
    },

    // 回傳可以放進 <img> 的網址；找不到時回傳 null
    getPhotoUrl: function (photoId) {
      return delay(photoStore[photoId] || null);
    },

    updateMeal: function (id, patch) {
      var s = load();
      var m = cur(s).meals.find(function (x) { return x.id === id; });
      if (!m) return fail('找不到這筆紀錄');
      m.meal = patch.meal;
      m.text = patch.text;
      save(s);
      return delay(clone(m));
    },

    deleteMeal: function (id) {
      var s = load();
      var m = cur(s).meals.find(function (x) { return x.id === id; });
      if (m) dropPhotos(m.photoIds);
      cur(s).meals = cur(s).meals.filter(function (x) { return x.id !== id; });
      save(s);
      return delay(true);
    },

    // ---- 飲水：每天一個總數（c.c.）----
    getWater: function () {
      return delay(clone(load().water).sort(function (a, b) { return a.date < b.date ? -1 : 1; }));
    },

    setWater: function (date, ml) {
      if (!inEditWindow(date)) return fail('只能新增或修改最近 ' + HH.EDIT_WINDOW_DAYS + ' 天的紀錄');
      if (!(ml >= 0) || ml > 20000) return fail('飲水量的數字不正確');
      var s = load();
      var rec = { date: date, ml: Math.round(ml), updatedAt: Date.now() };
      var i = cur(s).water.findIndex(function (w) { return w.date === date; });
      if (i >= 0) cur(s).water[i] = rec; else cur(s).water.push(rec);
      save(s);
      return delay(clone(rec));
    },

    // ---- 排便：每次一筆，量（多/中/少）＋型態（硬/軟/未成形）----
    getBowel: function () {
      return delay(clone(load().bowel));
    },

    addBowel: function (b) {
      if (!inEditWindow(b.date)) return fail('只能新增或修改最近 ' + HH.EDIT_WINDOW_DAYS + ' 天的紀錄');
      if (['多', '中', '少'].indexOf(b.amount) < 0 || ['硬', '軟', '未成形'].indexOf(b.form) < 0) return fail('請選擇量和型態');
      var s = load();
      var rec = { id: 'b' + Date.now() + Math.floor(Math.random() * 1000), date: b.date, amount: b.amount, form: b.form, createdAt: Date.now() };
      cur(s).bowel.push(rec);
      save(s);
      return delay(clone(rec));
    },

    deleteBowel: function (id) {
      var s = load();
      cur(s).bowel = cur(s).bowel.filter(function (x) { return x.id !== id; });
      save(s);
      return delay(true);
    },

    getLeaderboard: function (scope) {
      var s = load();
      var prof = cur(s).profile || {};
      var today = HH.today();
      var season = HH.seasonOf(today);
      var note = '';
      // 示範用：本季剛開始、大家都還沒上榜時，改用上一季的資料展示排行榜長相
      if (HH.daysBetween(season.start, today) < HH.MIN_SPAN_DAYS) {
        season = HH.prevSeason(season);
        note = '本季剛開始，示範畫面先用上一季的資料展示';
      }
      // 示範用：每 3 位其他會員裡，1 位跟你同據點、1 位跟你同里
      var others = othersFor(season, today).filter(function (o, i) {
        if (scope === 'site') return i % 3 === 0;
        if (scope === 'village') return i % 3 !== 2;
        return true;
      });
      var site = (window.HH_SITES ? window.HH_SITES.sites : []).find(function (x) { return x.id === prof.siteId; });
      var group = { scope: scope || 'all', label: scope === 'village' ? prof.village : scope === 'site' ? (site ? site.name : '') : '全部' };
      var entries = others.map(function (o) {
        return { id: o.id, nickname: o.nickname, hidden: o.hidden, isMe: false, result: HH.scoreMember(o.records, season, today) };
      });
      var mine = HH.scoreMember(cur(s).body, season, today);
      entries.push({ id: 'me', nickname: cur(s).profile ? cur(s).profile.nickname : '我', hidden: false, isMe: true, result: mine });
      var ranked = HH.rankEntries(entries);
      var meRow = ranked.find(function (e) { return e.isMe; });
      return delay({
        season: season,
        group: group,
        note: note,
        entries: ranked.map(function (e) { return { rank: e.rank, nickname: e.nickname, score: e.result.score, isMe: e.isMe }; }),
        me: { result: mine, rank: meRow ? meRow.rank : null }
      });
    },

    deleteAccount: function () {
      if (activeId) {
        var s = load();
        s.managed = (s.managed || []).filter(function (m) { return m.id !== activeId; });
        activeId = null;
        save(s);
        return delay(true);
      }
      dropPhotos(Object.keys(photoStore));
      save(emptyState());
      return delay(true);
    },

    // 示範專用：清掉全部假資料，回到剛打開的狀態
    resetDemo: function () {
      try { localStorage.removeItem(KEY); } catch (e) { /* 沒關係 */ }
      memory = null;
      activeId = null;
      return delay(true);
    }
  };

  g.mockApi = api; // 由 api.js 決定要用示範資料還是真正後台
})(window);
