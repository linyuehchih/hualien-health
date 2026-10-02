// 照片壓縮：在民眾手機上先縮小再上傳
// 重新畫到畫布上再輸出 JPG，會順便去掉照片裡的拍攝地點、手機型號等資訊
(function (g) {
  'use strict';

  var MAX_EDGE = 1280;          // 最長邊縮到幾像素
  var QUALITY = 0.7;            // 第一次壓縮的畫質
  var QUALITY_RETRY = 0.55;     // 太大時再壓一次的畫質
  var RETRY_OVER_BYTES = 350 * 1024;
  var MAX_PER_MEAL = 1;

  // 依照片內的方向資訊轉正（iPhone 直拍照片才不會轉 90 度）
  function decode(file) {
    if (g.createImageBitmap) {
      return g.createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return decodeWithImg(file); });
    }
    return decodeWithImg(file);
  }

  function decodeWithImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('這張照片的格式無法讀取，請換一張試試')); };
      img.src = url;
    });
  }

  function toBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('照片處理失敗，請再試一次')); }, 'image/jpeg', quality);
    });
  }

  // 回傳 {blob, width, height, originalBytes}
  async function compress(file) {
    if (!file.type || file.type.indexOf('image/') !== 0) throw new Error('請選擇照片檔');
    var src = await decode(file);
    var w = src.width, h = src.height;
    var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    var cw = Math.round(w * scale), ch = Math.round(h * scale);
    var canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // 透明背景的圖轉 JPG 時用白底
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(src, 0, 0, cw, ch);
    if (src.close) src.close();
    var blob = await toBlob(canvas, QUALITY);
    if (blob.size > RETRY_OVER_BYTES) blob = await toBlob(canvas, QUALITY_RETRY);
    return { blob: blob, width: cw, height: ch, originalBytes: file.size };
  }

  function formatBytes(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
    return Math.max(1, Math.round(n / 1024)) + 'KB';
  }

  g.HHPhoto = { compress: compress, formatBytes: formatBytes, MAX_PER_MEAL: MAX_PER_MEAL, MAX_EDGE: MAX_EDGE };
})(window);
