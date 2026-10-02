// 把「成果」畫成一張直式圖片（在民眾的手機上現場畫，不經過後台）
// 預設不畫出實際的體重、體脂數字，只畫曲線和變化量；勾選「顯示實際數字」才會畫座標數字
(function (g) {
  'use strict';
  var HH = g.HH;

  var FONT = '"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif';
  var W = 1080;        // 圖片寬度（像素）
  var PAD = 56;        // 左右留白
  var CARD_W = W - PAD * 2;
  var INNER = 36;      // 卡片內留白
  var C = {
    bg: '#f3f6f4', card: '#ffffff', ink: '#1b2a24', muted: '#5a6a63', grid: '#e4ebe7',
    primary: '#1f7a5c', primarySoft: '#e3f1ea', sea: '#2a86b3'
  };

  var HEAD_H = 250, FOOT_H = 230, GAP = 30;
  var CHART_CARD_H = 560, RANK_CARD_H = 290, CHART_H = 300;

  function font(px, weight) { return (weight || '400') + ' ' + px + 'px ' + FONT; }
  function fmt(v, d) {
    return Number(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function md(dateStr) { var d = HH.parse(dateStr); return (d.getMonth() + 1) + '/' + d.getDate(); }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function card(ctx, y, h) {
    ctx.save();
    ctx.shadowColor = 'rgba(20, 40, 30, 0.10)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = C.card;
    roundRect(ctx, PAD, y, CARD_W, h, 28);
    ctx.fill();
    ctx.restore();
  }

  function text(ctx, s, x, y, size, weight, color, align, maxW) {
    ctx.font = font(size, weight);
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    if (maxW) ctx.fillText(s, x, y, maxW); else ctx.fillText(s, x, y);
  }

  // 折線圖：sec = {title, summary, pts:[{date,value}], decimals, tone}
  function drawChartCard(ctx, y, sec, showNumbers) {
    card(ctx, y, CHART_CARD_H);
    var x0 = PAD + INNER, innerW = CARD_W - INNER * 2;
    var color = sec.tone === 'sea' ? C.sea : C.primary;

    text(ctx, sec.title, x0, y + 74, 48, '700', C.ink, 'left', innerW);
    text(ctx, sec.summary, x0, y + 128, 36, '400', C.muted, 'left', innerW);

    var L = showNumbers ? 120 : 24, R = 28, T = 24, B = 64;
    var top = y + 160;
    var cx = x0 + L, cw = innerW - L - R;
    var chH = CHART_H;
    var pts = sec.pts;

    var vals = pts.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    var span = hi - lo;
    // 變化很小時撐開範圍，避免一點點起伏看起來像大起大落
    var minSpan = sec.decimals === 0 ? 100 : 1;
    if (span < minSpan) { var mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; span = minSpan; }
    lo -= span * 0.12; hi += span * 0.12;

    var t0 = HH.parse(pts[0].date).getTime();
    var t1 = HH.parse(pts[pts.length - 1].date).getTime();
    function px(dateStr) { return cx + (HH.parse(dateStr).getTime() - t0) / ((t1 - t0) || 1) * cw; }
    function py(v) { return top + T + (hi - v) / (hi - lo) * (chH - T); }

    // 橫格線（要顯示數字時才標刻度）
    ctx.lineWidth = 2;
    for (var k = 0; k <= 3; k++) {
      var gv = lo + (hi - lo) * k / 3, gy = py(gv);
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(cx, gy); ctx.lineTo(cx + cw, gy); ctx.stroke();
      if (showNumbers) text(ctx, fmt(gv, sec.decimals), cx - 14, gy + 10, 28, '400', C.muted, 'right');
    }

    ctx.strokeStyle = color; ctx.lineWidth = 7; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach(function (p, i) { if (i) ctx.lineTo(px(p.date), py(p.value)); else ctx.moveTo(px(p.date), py(p.value)); });
    ctx.stroke();

    if (pts.length <= 40) {
      ctx.fillStyle = color;
      pts.forEach(function (p) { ctx.beginPath(); ctx.arc(px(p.date), py(p.value), 8, 0, Math.PI * 2); ctx.fill(); });
    }
    var lp = pts[pts.length - 1];
    ctx.fillStyle = color; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(px(lp.date), py(lp.value), 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    var dy = top + chH + 46;
    text(ctx, md(pts[0].date), cx, dy, 30, '400', C.muted, 'left');
    text(ctx, md(lp.date), cx + cw, dy, 30, '400', C.muted, 'right');
  }

  function drawRankCard(ctx, y, sec) {
    card(ctx, y, RANK_CARD_H);
    var x0 = PAD + INNER, innerW = CARD_W - INNER * 2;
    text(ctx, sec.title, x0, y + 74, 48, '700', C.ink, 'left', innerW);
    text(ctx, sec.line1, x0, y + 168, 66, '700', C.primary, 'left', innerW);
    if (sec.line2) text(ctx, sec.line2, x0, y + 228, 34, '400', C.muted, 'left', innerW);
  }

  // spec: {nickname, periodLabel, dateText, showNumbers, sections:[{type:'chart'|'rank', ...}], url}
  function render(spec) {
    var sections = spec.sections || [];
    var height = HEAD_H + GAP;
    sections.forEach(function (s) { height += (s.type === 'rank' ? RANK_CARD_H : CHART_CARD_H) + GAP; });
    height += FOOT_H - GAP;

    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = height;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, height);

    // 上方標題帶
    ctx.fillStyle = C.primary;
    ctx.fillRect(0, 0, W, HEAD_H);
    text(ctx, '花蓮共好健康生活', PAD, 92, 40, '400', 'rgba(255,255,255,0.85)', 'left');
    text(ctx, spec.nickname + ' 的健康紀錄', PAD, 168, 62, '700', '#ffffff', 'left', W - PAD * 2);
    text(ctx, spec.periodLabel + '  ·  ' + spec.dateText, PAD, 220, 34, '400', 'rgba(255,255,255,0.85)', 'left');

    var y = HEAD_H + GAP;
    sections.forEach(function (s) {
      if (s.type === 'rank') { drawRankCard(ctx, y, s); y += RANK_CARD_H + GAP; }
      else { drawChartCard(ctx, y, s, !!spec.showNumbers); y += CHART_CARD_H + GAP; }
    });

    // 下方：邀請與免責
    var fy = height - FOOT_H + 20;
    text(ctx, '一起記錄，一起健康', W / 2, fy + 60, 46, '700', C.primary, 'center');
    text(ctx, spec.url, W / 2, fy + 118, 34, '400', C.ink, 'center', W - PAD * 2);
    text(ctx, '本圖僅供記錄參考，不提供醫療建議', W / 2, fy + 170, 28, '400', C.muted, 'center');

    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('圖片產生失敗')); }, 'image/png');
      } else {
        try {
          var bin = atob(canvas.toDataURL('image/png').split(',')[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: 'image/png' }));
        } catch (e) { reject(new Error('圖片產生失敗')); }
      }
    });
  }

  g.HHShare = { render: render };
})(window);
