// 日期、BMI、競賽計分的共用工具
// 之後後台小程式（Step 4、6）會沿用同一套計分規則，改規則時兩邊要一起改
(function (g) {
  'use strict';

  // ---- 日期（一律用 YYYY-MM-DD 字串，以手機所在時區為準）----
  function pad(n) { return String(n).padStart(2, '0'); }
  function toStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function today() { return toStr(new Date()); }
  function addDays(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return toStr(d); }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }

  // ---- 賽季：每季一賽 ----
  function seasonOf(s) {
    var d = parse(s);
    var y = d.getFullYear();
    var q = Math.floor(d.getMonth() / 3) + 1;
    var sm = (q - 1) * 3;
    return {
      year: y, q: q,
      start: toStr(new Date(y, sm, 1)),
      end: toStr(new Date(y, sm + 3, 0)),
      label: y + ' 年第 ' + q + ' 季（' + (sm + 1) + '–' + (sm + 3) + ' 月）'
    };
  }
  function prevSeason(season) { return seasonOf(addDays(season.start, -1)); }

  function round1(x) { return Math.round(x * 10) / 10; }
  function round2(x) { return Math.round(x * 100) / 100; }

  // ---- 競賽計分 ----
  var MIN_SPAN_DAYS = 14;   // 第一筆到最新一筆至少相隔幾天才上榜
  var W_FAT = 0.7;          // 體脂減少比例的權重
  var W_WEIGHT = 0.3;       // 體重項（往健康體重範圍靠近的比例）的權重
  var EDIT_WINDOW_DAYS = 3; // 只能新增或修改最近幾天的身體數據

  // 體重項（2026-10-03 岳志決定）：只算「往健康體重範圍（BMI 18.5～24）靠近」多少，以第一筆體重的百分比表示。
  // 太重的人減重加分、太輕的人增重加分；已經在範圍內的人這項不加不扣；從範圍內減到過輕會扣分。
  // 沒有身高時退回舊算法（體重減少比例）。後台 Code.gs 的 weightTowardRange_ 必須同步修改。
  function weightTowardRange(firstKg, lastKg, heightCm) {
    if (!(heightCm > 0)) return (firstKg - lastKg) / firstKg * 100;
    var m = heightCm / 100, lo = BMI_LOW * m * m, hi = BMI_HIGH * m * m;
    function dist(w) { return w > hi ? w - hi : w < lo ? lo - w : 0; }
    return (dist(firstKg) - dist(lastKg)) / firstKg * 100;
  }
  function inHealthyRange(kg, heightCm) {
    var m = heightCm / 100;
    return heightCm > 0 && kg >= BMI_LOW * m * m && kg <= BMI_HIGH * m * m;
  }

  // records: [{date, weightKg, bodyFatPct, ...}]，refDate: 今天，heightCm: 身高（體重項要用）
  function scoreMember(records, season, refDate, heightCm) {
    var rs = records
      .filter(function (r) {
        return r.date >= season.start && r.date <= season.end &&
          r.weightKg != null && r.bodyFatPct != null;
      })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

    if (rs.length === 0) return { qualified: false, status: 'none' };

    var first = rs[0];
    var last = rs[rs.length - 1];
    if (rs.length < 2 || daysBetween(first.date, last.date) < MIN_SPAN_DAYS) {
      var eligibleFrom = addDays(first.date, MIN_SPAN_DAYS);
      if (eligibleFrom > season.end) return { qualified: false, status: 'tooLate', first: first };
      var daysLeft = daysBetween(refDate, eligibleFrom);
      return daysLeft > 0
        ? { qualified: false, status: 'waiting', daysLeft: daysLeft, first: first }
        : { qualified: false, status: 'ready', first: first };
    }

    var fatPct = (first.bodyFatPct - last.bodyFatPct) / first.bodyFatPct * 100;
    var weightPct = weightTowardRange(first.weightKg, last.weightKg, heightCm);
    return {
      qualified: true,
      score: round2(fatPct * W_FAT + weightPct * W_WEIGHT),
      fatPct: round2(fatPct),
      weightPct: round2(weightPct),
      weightInRange: inHealthyRange(first.weightKg, heightCm) && inHealthyRange(last.weightKg, heightCm),
      first: first,
      last: last,
      achievedAt: last.date
    };
  }

  // entries: [{id, nickname, hidden, result}] → 依分數排序，同分時較早達到的排前面
  function rankEntries(entries) {
    return entries
      .filter(function (e) { return !e.hidden && e.result.qualified; })
      .sort(function (a, b) {
        if (b.result.score !== a.result.score) return b.result.score - a.result.score;
        return a.result.achievedAt < b.result.achievedAt ? -1 : a.result.achievedAt > b.result.achievedAt ? 1 : 0;
      })
      .map(function (e, i) { return Object.assign({ rank: i + 1 }, e); });
  }

  // ---- BMI 與體脂判讀（衛福部標準）----
  var BMI_LOW = 18.5;
  var BMI_HIGH = 24;

  function bmi(weightKg, heightCm) {
    var m = heightCm / 100;
    return round1(weightKg / (m * m));
  }
  function bmiCategory(v) {
    if (v < 18.5) return { text: '過輕', level: 'warn' };
    if (v < 24) return { text: '正常', level: 'ok' };
    if (v < 27) return { text: '過重', level: 'warn' };
    return { text: '肥胖', level: 'bad' };
  }
  function suggestedWeight(heightCm) {
    var m = heightCm / 100;
    return [round1(BMI_LOW * m * m), round1(BMI_HIGH * m * m)];
  }
  // 男性 25% 以上、女性 30% 以上屬體脂偏高
  function fatThreshold(sex) { return sex === 'F' ? 30 : 25; }
  function fatStatus(sex, fat) {
    return fat >= fatThreshold(sex)
      ? { text: '體脂偏高', level: 'warn' }
      : { text: '正常範圍', level: 'ok' };
  }

  // ---- 出生年與年齡（長者提醒用）----
  var ELDER_AGE = 65;
  var MIN_AGE = 10, MAX_AGE = 110;
  // 民眾習慣填民國年：1～150 當民國年（+1911），1900 以上當西元年；不合理回傳 null
  function parseBirthYear(v) {
    var n = parseInt(String(v == null ? '' : v).trim(), 10);
    if (isNaN(n)) return null;
    if (n >= 1 && n <= 150) n += 1911;
    var y = new Date().getFullYear();
    return n >= y - MAX_AGE && n <= y - MIN_AGE ? n : null;
  }
  function ageOf(birthYear) {
    return birthYear == null ? null : new Date().getFullYear() - birthYear;
  }
  function isElder(birthYear) {
    var a = ageOf(birthYear);
    return a != null && a >= ELDER_AGE;
  }

  // ---- 內臟脂肪的單位（不同儀器用的單位不同，彼此不能換算）----
  var VISCERAL = {
    '級': { unit: '級', decimals: 1, step: 0.5, hint: '填體脂計上顯示的級數。各品牌範圍不同：Tanita 1–59、Omron 1–30、InBody 1–20，不能互相比較。' },
    '%': { unit: '%', decimals: 1, step: 0.1, hint: '體脂計顯示的是百分比，就填這個。' },
    '公斤': { unit: '公斤', decimals: 2, step: 0.01, hint: '醫療儀器（例如 DEXA）報告上的「內臟脂肪量」，通常零點幾到幾公斤。' }
  };
  var VISCERAL_UNITS = ['級', '%', '公斤'];
  function visceralMeta(unit) { return VISCERAL[unit] || VISCERAL['%']; }

  g.HH = {
    toStr: toStr, parse: parse, today: today, addDays: addDays, daysBetween: daysBetween,
    seasonOf: seasonOf, prevSeason: prevSeason, round1: round1, round2: round2,
    MIN_SPAN_DAYS: MIN_SPAN_DAYS, EDIT_WINDOW_DAYS: EDIT_WINDOW_DAYS,
    scoreMember: scoreMember, rankEntries: rankEntries, weightTowardRange: weightTowardRange,
    BMI_LOW: BMI_LOW, BMI_HIGH: BMI_HIGH,
    bmi: bmi, bmiCategory: bmiCategory, suggestedWeight: suggestedWeight,
    fatThreshold: fatThreshold, fatStatus: fatStatus,
    ELDER_AGE: ELDER_AGE, parseBirthYear: parseBirthYear, ageOf: ageOf, isElder: isElder,
    VISCERAL_UNITS: VISCERAL_UNITS, visceralMeta: visceralMeta
  };
})(typeof window !== 'undefined' ? window : globalThis);
