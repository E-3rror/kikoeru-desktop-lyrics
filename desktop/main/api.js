"use strict";

// 兼容旧窗口调用的通用 Bridge 门面。这里不读取 Kikoeru 配置，也不直接访问 Kikoeru API。
const bridge = require("./bridge-client");

function sendCommand(command, targetSourceId) {
  return bridge.sendCommand(command, targetSourceId);
}

function reportWindowState(windowName, open, sourceId) {
  return sendCommand({ type: "windowState", window: windowName, open, sourceId }, sourceId);
}

function queryLyric(trackHash, sourceId) {
  return sendCommand({ type: "queryLyrics", trackHash }, sourceId).then((result) => result.data || result.lyricList || []);
}

function fetchLyric(pathPart, sourceId) {
  return sendCommand({ type: "fetchLyrics", pathPart }, sourceId).then((result) => result.data || result.lrc || []);
}

function saveLyric(workId, writePath, lines, sourceId) {
  return sendCommand({ type: "saveLyrics", workId, writePath, lines }, sourceId);
}

module.exports = { sendCommand, reportWindowState, queryLyric, fetchLyric, saveLyric };
