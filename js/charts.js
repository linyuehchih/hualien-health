// 自己畫的折線圖（不靠外部套件，沒網路也能顯示）
(function (g) {
  'use strict';
  var HH = g.HH;

  function fmt(v, decimals) {
    return Number(v).toLocaleString('zh-TW', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  function md(dateStr) { var d = HH.parse(dateStr); return (d.getMonth() + 1) + '/' + d.getDate(); }

  // points: [{date, value}]（日期由舊到新）
  // o: {label, decimals, band: [下限, 上限] 或 null, target: 數字或 null}
  function lineChart(points, o) {
    if (points.length === 0) return '<p class="chart-empty">還沒有紀錄</p>';
    if (points.length === 1) return '<p class="chart-empty">再多記幾天就能看到曲線囉</p>';

    var W = 340, H = 180, L = 42, R = 14, T = 14, B = 26;
    var vals = points.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, vals);
    var hi = Math.max.apply(null, vals);
    if (o.target != null) { lo = Math.min(lo, o.target); hi = Math.max(hi, o.target); }
    // 建議範圍在資料外面時，把最靠近資料的那條邊納入畫面，讓人看得出差多少
    if (o.band) {
      if (o.band[1] < lo) lo = o.band[1];
      if (o.band[0] > hi) hi = o.band[0];
    }
    if (o.decimals === 0 && hi - lo <= 3) {
      // 變化很小的整數項目：刻度對齊整數
      var step = Math.max(1, Math.ceil((Math.ceil(hi) - Math.floor(lo) + 2) / 3));
      lo = Math.floor(lo) - 1;
      hi = lo + step * 3;
    } else if (o.decimals === 0) {
      // 數字大的整數項目（飲水 c.c.）：刻度取整齊的數字，例如 0、1,000、2,000
      var raw = (hi - lo) / 3;
      var mag = Math.pow(10, Math.floor(Math.log10(raw)));
      var nice = [1, 2, 2.5, 5, 10, 20];
      var st = nice[nice.length - 1] * mag;
      for (var n = 0; n < nice.length; n++) {
        var cand = nice[n] * mag;
        if (Math.floor(lo / cand) * cand + 3 * cand >= hi) { st = cand; break; }
      }
      lo = Math.floor(lo / st) * st;
      hi = lo + 3 * st;
    } else {
      // 變化很小時撐開範圍，避免一點點起伏看起來像大起大落
      var span = hi - lo;
      if (span < 1) { var mid = (hi + lo) / 2; lo = mid - 0.5; hi = mid + 0.5; span = 1; }
      lo -= span * 0.12;
      hi += span * 0.12;
    }

    var t0 = HH.parse(points[0].date).getTime();
    var t1 = HH.parse(points[points.length - 1].date).getTime();
    function x(dateStr) { return L + (HH.parse(dateStr).getTime() - t0) / ((t1 - t0) || 1) * (W - L - R); }
    function y(v) { return T + (hi - v) / (hi - lo) * (H - T - B); }

    var s = [];
    s.push('<svg class="chart' + (o.tone ? ' tone-' + o.tone : '') + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + o.label + '">');

    if (o.band) {
      var bTop = y(Math.min(o.band[1], hi));
      var bBot = y(Math.max(o.band[0], lo));
      if (bBot > bTop) {
        s.push('<rect class="c-band" x="' + L + '" y="' + bTop.toFixed(1) + '" width="' + (W - L - R) + '" height="' + (bBot - bTop).toFixed(1) + '"/>');
        s.push('<text class="c-band-label" x="' + (W - R - 4) + '" y="' + (bTop + 12).toFixed(1) + '" text-anchor="end">建議範圍</text>');
      }
    }

    for (var k = 0; k <= 3; k++) {
      var gv = lo + (hi - lo) * k / 3;
      var gy = y(gv);
      s.push('<line class="c-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + gy.toFixed(1) + '" y2="' + gy.toFixed(1) + '"/>');
      s.push('<text class="c-axis" x="' + (L - 6) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end">' + fmt(gv, o.decimals) + '</text>');
    }

    if (o.target != null) {
      var ty = y(o.target).toFixed(1);
      s.push('<line class="c-target" x1="' + L + '" x2="' + (W - R) + '" y1="' + ty + '" y2="' + ty + '"/>');
      s.push('<text class="c-target-label" x="' + (L + 4) + '" y="' + (ty - 5) + '">' + (o.targetLabel || '目標') + ' ' + fmt(o.target, o.decimals) + '</text>');
    }

    var d = points.map(function (p, i) { return (i ? 'L' : 'M') + x(p.date).toFixed(1) + ' ' + y(p.value).toFixed(1); }).join(' ');
    s.push('<path class="c-line" d="' + d + '"/>');

    if (points.length <= 40) {
      points.forEach(function (p) {
        s.push('<circle class="c-dot" cx="' + x(p.date).toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="2.6"/>');
      });
    }
    var lp = points[points.length - 1];
    s.push('<circle class="c-last" cx="' + x(lp.date).toFixed(1) + '" cy="' + y(lp.value).toFixed(1) + '" r="4.5"/>');

    s.push('<text class="c-axis" x="' + L + '" y="' + (H - 6) + '">' + md(points[0].date) + '</text>');
    s.push('<text class="c-axis" x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">' + md(lp.date) + '</text>');
    s.push('</svg>');
    return s.join('');
  }

  g.Charts = { lineChart: lineChart };
})(window);
