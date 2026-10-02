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
  function clone(x) { return x === undefined ? x : JSON.parse(JSON.stringify(x)); } // undefined 不能直接轉，否則 Safari 會跳出看不懂的 JSON Parse error
  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }

  var cache = null;      // 登入後一次讀回的個人資料，之後的寫入直接更新這份
  var cachePromise = null; // 正在向後台讀取中的那一次（同時有好幾個地方要資料時，共用同一次讀取）
  var cacheGen = 0;        // 每次清掉快取就加 1，讀到一半被清掉的舊結果不會寫回來
  var photoCache = {};
  var pending = 0;

  // 代管：幫沒有 LINE 的長輩記錄時，每個請求都帶上長輩的編號（as），後台會檢查這位長輩真的是你建立的
  var activeAs = null;     // 目前代管中的成員編號；null＝自己
  var stash = {};          // 切換成員時，把各人已讀回的資料先收起來 {成員編號或 'self': cache}
  var managedList = [];    // 我代管的成員 [{id, nickname}]
  var NO_AS = { createManaged: true, logout: true, loginLine: true }; // 這些動作一定要用自己的身分
  function keyOf(id) { return id || 'self'; }

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
        body: JSON.stringify({ action: action, data: data || {}, token: read(TOKEN_KEY), as: NO_AS[action] ? undefined : (activeAs || undefined) })
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
        resetAll();
        if (api.onAuthLost) api.onAuthLost(json.error);
      }
      if (json.code === 'MANAGED' && activeAs) {
        // 這位成員已經不存在（例如在別的裝置刪掉了）：忘掉他、回到自己
        forgetManaged(activeAs);
        if (api.onManagedLost) api.onManagedLost(json.error);
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
    resetAll();
    return { needsProfile: res.needsProfile };
  }

  function resetCache() {
    cache = null;
    cachePromise = null;
    cacheGen++;
  }

  // 登入、登出、登入失效：連代管狀態和各成員暫存的資料一起清掉
  function resetAll() {
    activeAs = null;
    managedList = [];
    stash = {};
    resetCache();
  }

  // 忘掉某位代管成員；如果正在代管他，就切回自己
  function forgetManaged(id) {
    managedList = managedList.filter(function (m) { return m.id !== id; });
    delete stash[id];
    if (activeAs === id) {
      activeAs = null;
      cache = stash.self || null;
      cachePromise = null;
      cacheGen++;
    }
  }

  async function ensureCache() {
    if (cache) return cache;
    if (!cachePromise) {
      var gen = cacheGen, forId = activeAs;
      var p = call('bootstrap').then(function (c) {
        c = c || {};
        // 缺少的欄位補成空的，避免後面程式拿到 undefined
        var fresh = { profile: c.profile || null, body: c.body || [], meals: c.meals || [], water: c.water || [], bowel: c.bowel || [] };
        if (gen === cacheGen) {
          cache = fresh;
          if (forId === null) managedList = c.managedMembers || []; // 自己的資料會帶回我代管的成員名單
        }
        return fresh;
      });
      var clear = function () { if (cachePromise === p) cachePromise = null; };
      p.then(clear, clear);
      cachePromise = p;
    }
    return cachePromise;
  }

  var api = {
    isDemo: false,
    onAuthLost: null, // 畫面程式設定：登入失效時回到登入頁
    onManagedLost: null, // 畫面程式設定：代管的成員不見了（被刪除）時回到自己

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
      resetAll();
      photoCache = {};
      return true;
    },

    saveProfile: async function (p, isNew) {
      var profile = await call('saveProfile', Object.assign({}, p, { agree: !!isNew }));
      if (!profile) {
        // 後台沒有把資料帶回來：資料多半已經存好了，重新讀一次確認
        resetCache();
        profile = (await ensureCache()).profile;
        if (!profile) throw new Error('資料可能已經儲存，但讀取失敗，請重新整理網頁再試一次');
      }
      if (cache) cache.profile = profile;
      if (activeAs) managedList.forEach(function (m) { if (m.id === activeAs) m.nickname = profile.nickname; });
      return clone(profile);
    },

    // ---- 代管成員（幫沒有 LINE 的長輩記錄）----
    listManaged: async function () {
      if (activeAs === null) await ensureCache();
      return clone(managedList);
    },

    // p：基本資料＋consent:true（我已告知對方並取得同意）；回傳 {id, profile}
    createManaged: async function (p) {
      var res = await call('createManaged', p);
      if (!res || !res.id || !res.profile) throw new Error('帳號可能已建立，但讀取失敗，請重新整理網頁');
      managedList.push({ id: res.id, nickname: res.profile.nickname });
      return clone(res);
    },

    // id＝成員編號；null＝切回自己。回傳那位成員的基本資料
    switchTo: async function (id) {
      stash[keyOf(activeAs)] = cache;
      activeAs = id || null;
      cache = stash[keyOf(activeAs)] || null;
      cachePromise = null;
      cacheGen++;
      var c = await ensureCache();
      return clone(c.profile);
    },

    getActive: function () { return activeAs; },

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

    // scope：all（全部）／village（本里）／site（本據點）
    getLeaderboard: function (scope) { return call('leaderboard', { scope: scope || 'all' }); },

    deleteAccount: async function () {
      var was = activeAs; // 代管中＝只刪這位成員，不會登出
      await call('deleteAccount');
      if (was) { forgetManaged(was); return true; }
      store(TOKEN_KEY, null);
      resetAll();
      photoCache = {};
      return true;
    },

    // 重新向後台讀一次全部資料（畫面讀取失敗時用）
    refresh: async function () {
      resetCache();
      await ensureCache();
    }
  };

  var forceDemo = /[?&]demo=1\b/.test(location.search);
  g.realApi = api;
  g.api = CFG.apiUrl && !forceDemo ? api : g.mockApi;
})(window);
