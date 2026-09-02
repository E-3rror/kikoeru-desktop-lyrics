"use strict";
/**
 * 渲染进程的受限 API 面.
 *
 * 两个窗口共用这一个 preload. 渲染层拿不到 Node, 只能通过这里列出的通道
 * 与主进程交互, 保持 contextIsolation 开启.
 */
const { contextBridge, ipcRenderer } = require("electron");

const INBOUND = [
  "dl:snapshot",
  "dl:state",
  "dl:lines",
  "dl:timeSync",
  "dl:connection",
  "dl:settings",
  "dl:pointer-over",
  "lock-changed",
];

const listeners = new Map();

INBOUND.forEach((channel) => {
  ipcRenderer.on(channel, (_event, payload) => {
    const handlers = listeners.get(channel);
    if (!handlers) {
      return;
    }
    handlers.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[preload] ${channel} 处理失败`, err);
      }
    });
  });
});

contextBridge.exposeInMainWorld("desktopLyrics", {
  on(channel, handler) {
    if (!INBOUND.includes(channel) || typeof handler !== "function") {
      return () => {};
    }
    if (!listeners.has(channel)) {
      listeners.set(channel, new Set());
    }
    listeners.get(channel).add(handler);
    return () => listeners.get(channel).delete(handler);
  },

  /** 取当前完整现场（播放状态 + 歌词 + 设置 + 连接状态） */
  getSnapshot: () => ipcRenderer.invoke("dl:getSnapshot"),
  getSettings: () => ipcRenderer.invoke("dl:getSettings"),
  saveSettings: (patch) => ipcRenderer.invoke("dl:saveSettings", patch),

  /** 控制网页播放器: play/pause/toggle/next/previous/seek/seekToLine/setOffset/... */
  command: (command) => ipcRenderer.invoke("dl:command", command),

  /**
   * 窗口自身操作.
   * 归属由主进程按 event.sender.id 判定, 因此这里不需要（也不应该）传 sourceId.
   */
  hideWindow: () => ipcRenderer.invoke("dl:window", { action: "hide" }),
  /** 按悬浮歌词当前的实际内容收紧窗口尺寸 */
  resizeLyrics: (size) => ipcRenderer.invoke("dl:window", { action: "resizeLyrics", size }),
  toggleSelect: () => ipcRenderer.invoke("dl:window", { action: "toggleSelect" }),
  setLock: (locked) => ipcRenderer.invoke("dl:window", { action: "lock", value: locked }),
  /** 锁定态下鼠标进入解锁热区时临时放开穿透 */
  setInteractive: (value) => ipcRenderer.invoke("dl:setInteractive", value),
  quit: () => ipcRenderer.invoke("dl:window", { action: "quit" }),
  getBridgeInfo: () => ipcRenderer.invoke("dl:getBridgeInfo"),
  saveBridgeInfo: (config) => ipcRenderer.invoke("dl:saveBridgeInfo", config),

  /** 歌词文件相关 REST */
  queryLyric: (trackHash) => ipcRenderer.invoke("dl:lyric", { action: "query", trackHash }),
  fetchLyric: (pathPart) => ipcRenderer.invoke("dl:lyric", { action: "fetch", pathPart }),
  saveLyric: (workId, writePath, lines) =>
    ipcRenderer.invoke("dl:lyric", { action: "save", workId, writePath, lines }),
});
