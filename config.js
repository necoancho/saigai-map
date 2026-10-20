// ===== アプリの設定 =====
// Firebase の設定値を貼り付けると、投稿が全員で共有されます。
// 空のまま（apiKey が ""）だと「お試しモード」になり、投稿はこの端末の中だけに保存されます。
export const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

// 地図の中心と範囲（初期値：松永地区公民館を中心に半径3km）
// 位置は国土地理院「指定緊急避難場所データ」に登録された松永地区公民館の座標
export const MAP = {
  title: "松永地区 災害情報マップ",
  centerName: "松永地区公民館",
  center: [31.784297, 130.769067],
  radiusMeters: 3000,
  // 範囲外にどれだけ地図を動かせるか（範囲の何倍まで）
  panLimit: 1.6
};
