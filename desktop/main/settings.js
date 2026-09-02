"use strict";
/**
 * 桌面端本地设置.
 *
 * 存在 Electron 的 userData 目录里, 与服务端的 config.json 完全分离 ——
 * 悬浮窗位置、字号、锁定状态这类东西只对本机这一个用户有意义.
 */
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  /** 悬浮歌词窗几何; null 表示首次启动, 由 windows.js 按屏幕居中底部摆放 */
  lyricsBounds: null,
  /** 歌词选择窗几何（多开时作为新窗口的初始尺寸, 逐个错开摆放） */
  selectBounds: null,
  fontSize: 34,
  /** 已唱部分的颜色, 未唱部分用 unsungColor */
  sungColor: "#9c27b0",
  unsungColor: "#f2f2f2",
  strokeColor: "#000000",
  /** 半透明背板; 0 = 全透明 */
  backdropOpacity: 0,
  locked: false,
  showNextLine: true,
  /** 部分显卡/驱动组合下透明窗有黑边, 这时可以关掉透明 */
  transparent: true,
  // ---- 歌词选择窗 ----
  /** dark | light | transparent */
  selectTheme: "dark",
  /** 精简模式: 只留歌词列表与点击跳转 */
  selectCompact: false,
  selectFontSize: 17,
};

let cached = null;
let settingsPath = "";

function getSettingsPath() {
  if (!settingsPath) {
    settingsPath = path.join(app.getPath("userData"), "settings.json");
  }
  return settingsPath;
}

function load() {
  if (cached) {
    return cached;
  }
  let stored = {};
  try {
    const file = getSettingsPath();
    if (fs.existsSync(file)) {
      stored = JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch (err) {
    console.error("[settings] 读取设置失败, 使用默认值: ", err.message);
    stored = {};
  }
  cached = Object.assign({}, DEFAULTS, stored);
  return cached;
}

function save(patch) {
  const next = Object.assign(load(), patch || {});
  cached = next;
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    console.error("[settings] 写入设置失败: ", err.message);
  }
  return next;
}

function get(key) {
  return load()[key];
}

module.exports = { DEFAULTS, load, save, get, getSettingsPath };
