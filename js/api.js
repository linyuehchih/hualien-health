// 真正的後台連線（Google Apps Script）
// 介面和 mock-api.js 一樣，畫面程式只認 window.api
// 設定檔有 apiUrl 就用真正後台；網址加上 ?demo=1 可以強制使用示範資料
(function (g) {
  'use strict';
  var HH = g.HH;
  var CFG = g.HH_CONFIG || {};
  var TOKEN_KEY = 'hh_token';
  var PROVIDER_KEY = 'hh_provider';

  function store(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* 無痕模式等情況存不了 */ }
  }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }

  var cache = null;      // 登入後一次讀回的個人資料，之後的寫入直接更新這份
  var photoCache = {};
  var pending = 0;

  function busy(delta) {
    pending += delta;
    document.documentElement.classList.toggle('is-busy', pending > 0);
  }

  async function call(action, data) {
    busy(1);
    var res;
    try {
      res = await fetch(CFG.apiUrl, {
        method: 'POST',
        // 用 text/plain 送，瀏覽器才不會多發一次預檢請求（Apps Script 不支援）
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: action, data: data || {}, token: read(TOKEN_KEY) })
      });
    } catch (e) {
      busy(-1);
      throw new Error('網路連線有問題，請稍後再試');
    }
    var json;
    try { json = await res.json(); } catch (e) { json = { ok: false, error: '伺服器回應有問題，請稍後再試' }; }
    busy(-1);
    if (!json.ok) {
      if (json.code === 'AUTH') {
        store(TOKEN_KEY, null);
        cache = null;
        if (api.onAuthLost) api.onAuthLost(json.error);
      }
      throw new Error(json.error || '發生錯誤');
    }
    return json.data;
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('照片讀取失敗')); };
      r.readAsDataURL(blob);
    });
  }

  function afterLogin(res, provider) {
    store(TOKEN_KEY, res.token);
    store(PROVIDER_KEY, provider);
    cache = null;
    return { needsProfile: res.needsProfile };
  }

  async function ensureCache() {
    if (!cache) cache = await call('bootstrap');
    return cache;
  }

  var api = {
    isDemo: false,
    onAuthLost: null, // 畫面程式設定：登入失效時回到登入頁

    getSession: async function () {
      if (!read(TOKEN_KEY)) return { loggedIn: false, provider: null, profile: null };
      try {
        var c = await ensureCache();
        return { loggedIn: true, provider: read(PROVIDER_KEY), profile: c.profile ? clone(c.profile) : null };
      } catch (e) {
        if (!read(TOKEN_KEY)) return { loggedIn: false, provider: null, profile: null };
        throw e;
      }
    },

    loginLine: async function (p) {
      return afterLogin(await call('loginLine', p), 'line');
    },

    logout: async function () {
      try { await call('logout'); } catch (e) { /* 登出時後台出錯也照樣清掉本機的登入狀態 */ }
      store(TOKEN_KEY, null);
      cache = null;
      photoCache = {};
      return true;
    },

    saveProfile: async function (p, isNew) {
      var profile = await call('saveProfile', Object.assign({}, p, { agree: !!isNew }));
      if (cache) cache.profile = profile;
      return clone(profile);
    },

    getBody: async function () { return clone((await ensureCache()).body).sort(byDate); },

    saveBody: async function (rec) {
      var saved = await call('saveBody', rec);
      var list = (await ensureCache()).body;
      var i = list.findIndex(function (r) { return r.date === saved.date; });
      if (i >= 0) list[i] = saved; else list.push(saved);
      return clone(saved);
    },

    getMeals: async function () { return clone((await ensureCache()).meals); },

    addMeal: async function (m) {
      var photos = await Promise.all((m.photos || []).map(blobToDataUrl));
      var meal = await call('addMeal', { date: m.date, meal: m.meal, text: m.text, photos: photos });
      meal.photoIds.forEach(function (id, i) { photoCache[id] = photos[i]; });
      (await ensureCache()).meals.push(meal);
      return clone(meal);
    },

    getPhotoUrl: async function (id) {
      if (!photoCache[id]) {
        try { photoCache[id] = await call('getPhoto', { id: id }); } catch (e) { return null; }
      }
      return photoCache[id];
    },

    updateMeal: async function (id, patch) {
      var meal = await call('updateMeal', { id: id, meal: patch.meal, text: patch.text });
      var list = (await ensureCache()).meals;
      var i = list.findIndex(function (x) { return x.id === id; });
      if (i >= 0) list[i] = meal;
      return clone(meal);
    },

    deleteMeal: async function (id) {
      await call('deleteMeal', { id: id });
      var c = await ensureCache();
      c.meals = c.meals.filter(function (x) { return x.id !== id; });
      return true;
    },

    getWater: async function () { return clone((await ensureCache()).water).sort(byDate); },

    setWater: async function (date, ml) {
      var saved = await call('setWater', { date: date, ml: ml });
      var list = (await ensureCache()).water;
      var i = list.findIndex(function (w) { return w.date === date; });
      if (i >= 0) list[i] = saved; else list.push(saved);
      return clone(saved);
    },

    getBowel: async function () { return clone((await ensureCache()).bowel); },

    addBowel: async function (b) {
      var saved = await call('addBowel', b);
      (await ensureCache()).bowel.push(saved);
      return clone(saved);
    },

    deleteBowel: async function (id) {
      await call('deleteBowel', { id: id });
      var c = await ensureCache();
      c.bowel = c.bowel.filter(function (x) { return x.id !== id; });
      return true;
    },

    getLeaderboard: function () { return call('leaderboard'); },

    deleteAccount: async function () {
      await call('deleteAccount');
      store(TOKEN_KEY, null);
      cache = null;
      photoCache = {};
      return true;
    }
  };

  var forceDemo = /[?&]demo=1\b/.test(location.search);
  g.realApi = api;
  g.api = CFG.apiUrl && !forceDemo ? api : g.mockApi;
})(window);
