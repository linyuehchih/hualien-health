// 網站設定：這裡只放「本來就會公開在網頁上」的編號，不放任何密碼或密鑰
// 帳號：競選團隊專用 Google 帳號 ehunabc@gmail.com（Google Cloud 專案 Hualien Health Life）
window.HH_CONFIG = {
  // 後台網址（Apps Script 網頁應用程式；2026-10-01 部署 v1）
  // 專案：https://script.google.com/d/1cAHSIlVqOSctsIl_v55JN_b5rj5ylIsJipIxjAW2uxmFp7SKOsgg_dCj/edit
  // 更新後台：在 hualien-health 資料夾執行 clasp push，再用 clasp update-deployment 更新這個部署（網址不變）
  // 留空白＝使用示範資料；網址加 ?demo=1 也會強制使用示範資料
  apiUrl: 'https://script.google.com/macros/s/AKfycbxC0_ozqt4SN9vnsF2iigYWMgoWC_GwpIErK5q17OZrrZfETRqP-BVprxvfcqUXFV63hQ/exec',
  // Google 登入的用戶端 ID（2026-10-01 建立；授權來源：http://localhost、http://localhost:8792、https://linyuehchih.github.io）
  googleClientId: '455906854487-r5bditl8mkevdttjfu7oe79ar8p4e0eb.apps.googleusercontent.com',
  // LINE 登入的 Channel ID（2026-10-01 建立；Provider「花蓮共好健康生活」，狀態 Developing；
  // Callback URL：http://localhost:8792/、https://linyuehchih.github.io/hualien-health/）
  lineChannelId: '2011809221'
};
