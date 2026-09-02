"use strict";
/**
 * 桌面歌词主进程入口.
 *
 * 托盘常驻应用: 关掉窗口不等于退出, 只有托盘菜单里的「退出」才真正结束.
 *
 * 窗口归属: 悬浮歌词全局唯一; 歌词选择每一路网页端各一个, 由 sourceId 索引.
 * 渲染层发来的 IPC 一律用 event.sender.id 反查归属, 不信任渲染层自报的 id.
 */
const path = require("path");
const {
  app,
  Tray,
  Menu,
  ipcMain,
  globalShortcut,
  nativeImage,
} = require("electron");
const settings = require("./settings");
const bridge = require("./bridge-client");
const windows = require("./windows");

const TOGGLE_LOCK_ACCELERATOR = "Control+Alt+L";

let tray = null;
app.isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    windows.showLyrics();
  });
  app.whenReady().then(bootstrap);
}

function bootstrap() {
  registerIpc();
  windows.createLyrics();
  windows.showLyrics();
  createTray();
  wireBridge();
  registerShortcuts();
  bridge.start();
}

// -------------------------------------------------------------------- 托盘

function trayIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "build", "tray.png"));
  return icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 });
}

/** 每一路网页端一个子项, 用曲目名区分, 方便多开时找到想要的那个 */
function selectSubmenu() {
  const list = (bridge.peers && bridge.peers.sourceList) || [];
  if (!list.length) {
    return [{ label: "（没有已连接的网页端）", enabled: false }];
  }
  return list.map((source, index) => {
    const label = source.title || source.workTitle || `网页端 ${index + 1}`;
    return {
      label: (windows.isSelectVisible(source.sourceId) ? "✓ " : "") + label,
      click: () => {
        windows.toggleSelect(source.sourceId);
        refreshTray();
      },
    };
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: windows.isLyricsVisible() ? "隐藏悬浮歌词" : "显示悬浮歌词",
      click: () => {
        if (windows.isLyricsVisible()) {
          windows.hideLyrics();
        } else {
          windows.showLyrics();
        }
        refreshTray();
      },
    },
    {
      label: "锁定歌词（鼠标穿透）",
      type: "checkbox",
      checked: Boolean(settings.get("locked")),
      accelerator: TOGGLE_LOCK_ACCELERATOR,
      click: (item) => {
        windows.setLock(item.checked);
        refreshTray();
      },
    },
    { type: "separator" },
    { label: "歌词选择", submenu: selectSubmenu() },
    { label: "Bridge 设置", click: () => windows.showBridgeSettings() },
    { type: "separator" },
    {
      label: bridge.connected ? "本地 Bridge 已启动" : "本地 Bridge 未启动（点击重试）",
      enabled: !bridge.connected,
      click: () => {
        bridge.stop();
        bridge.start();
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTray() {
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildTrayMenu());
  }
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("Kikoeru 桌面歌词");
  refreshTray();
  tray.on("click", () => {
    if (windows.isLyricsVisible()) {
      windows.hideLyrics();
    } else {
      windows.showLyrics();
    }
    refreshTray();
  });
}

function registerShortcuts() {
  const ok = globalShortcut.register(TOGGLE_LOCK_ACCELERATOR, () => {
    windows.setLock(!settings.get("locked"));
    refreshTray();
  });
  if (!ok) {
    console.warn(`[main] 全局快捷键 ${TOGGLE_LOCK_ACCELERATOR} 注册失败, 可从托盘菜单解锁`);
  }
}

// -------------------------------------------------------------------- 快照

/** 悬浮歌词用: 活跃音源那一份 */
function lyricsSnapshot() {
  const active = bridge.getActive();
  return {
    sourceId: active ? active.sourceId : null,
    state: active ? active.state : null,
    lines: active ? active.lines : [],
    linesRev: active ? active.linesRev : -1,
    timeSync: active ? active.timeSync : null,
    connected: bridge.connected,
    settings: settings.load(),
    visible: { lyrics: windows.isLyricsVisible() },
  };
}

/** 歌词选择窗用: 它自己那一路 */
function selectSnapshot(sourceId) {
  const slot = bridge.getSource(sourceId);
  return {
    sourceId,
    state: slot ? slot.state : null,
    lines: slot ? slot.lines : [],
    linesRev: slot ? slot.linesRev : -1,
    timeSync: slot ? slot.timeSync : null,
    connected: bridge.connected,
    sourceAlive: Boolean(slot),
    settings: settings.load(),
  };
}

function pushLyricsSnapshot() {
  windows.sendToLyrics("dl:snapshot", lyricsSnapshot());
}

function pushSelectSnapshot(sourceId) {
  windows.sendToSelect(sourceId, "dl:snapshot", selectSnapshot(sourceId));
}

// -------------------------------------------------------------------- 桥接

function wireBridge() {
  bridge.on("snapshot", () => {
    pushLyricsSnapshot();
    windows.listSelectSourceIds().forEach(pushSelectSnapshot);
    refreshTray();
  });

  bridge.on("state", (data) => {
    if (data.sourceId === bridge.activeSourceId) {
      windows.sendToLyrics("dl:state", data);
    }
    windows.sendToSelect(data.sourceId, "dl:state", data);
  });

  bridge.on("lines", (data) => {
    if (data.sourceId === bridge.activeSourceId) {
      windows.sendToLyrics("dl:lines", data);
    }
    windows.sendToSelect(data.sourceId, "dl:lines", data);
  });

  bridge.on("timeSync", (data) => {
    if (data.sourceId === bridge.activeSourceId) {
      windows.sendToLyrics("dl:timeSync", data);
    }
    windows.sendToSelect(data.sourceId, "dl:timeSync", data);
  });

  bridge.on("activeSource", () => {
    // 活跃音源换人了, 悬浮歌词整体换一份现场
    pushLyricsSnapshot();
    refreshTray();
  });

  bridge.on("peers", () => refreshTray());

  bridge.on("sourceGone", (data) => {
    if (!data || !data.sourceId) {
      return;
    }
    // 网页端关了, 它那一个选择窗也没有存在意义了
    windows.destroySelect(data.sourceId);
    pushLyricsSnapshot();
    refreshTray();
  });

  bridge.on("connection", (info) => {
    windows.broadcast("dl:connection", info);
    refreshTray();
  });

  // 网页端点工具栏按钮下来的开关窗命令, 带着发起者 sourceId
  bridge.on("command", (command) => {
    if (!command || !command.window) {
      return;
    }
    if (command.window === "lyrics") {
      if (command.type === "openWindow") {
        windows.showLyrics();
      } else if (command.type === "closeWindow") {
        windows.hideLyrics();
      }
    } else if (command.window === "select" && command.sourceId) {
      if (command.type === "openWindow") {
        windows.showSelect(command.sourceId);
        pushSelectSnapshot(command.sourceId);
      } else if (command.type === "closeWindow") {
        windows.hideSelect(command.sourceId);
      }
    }
    refreshTray();
  });
}

// -------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle("dl:getBridgeInfo", () => bridge.getInfo());

  ipcMain.handle("dl:saveBridgeInfo", async (_event, payload) => {
    try {
      const info = await bridge.reconfigure(payload && payload.port, payload && payload.secret);
      return { ok: true, host: info.host, port: info.port, secret: info.secret };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("dl:getSnapshot", (event) => {
    const sourceId = windows.sourceIdOfContents(event.sender.id);
    return sourceId ? selectSnapshot(sourceId) : lyricsSnapshot();
  });

  ipcMain.handle("dl:getSettings", () => settings.load());

  ipcMain.handle("dl:saveSettings", (_event, patch) => {
    // settings.save 会原地扩展缓存对象，因此必须先取出旧字号值。
    const previousFontSize = settings.get("fontSize");
    const next = settings.save(patch || {});
    if (
      patch &&
      Object.prototype.hasOwnProperty.call(patch, "fontSize") &&
      previousFontSize !== next.fontSize
    ) {
      windows.resizeLyricsForFont(previousFontSize, next.fontSize);
    }
    windows.broadcast("dl:settings", next);
    return next;
  });

  ipcMain.handle("dl:command", (event, command) => {
    // 选择窗的命令必须打到它自己那一路; 悬浮歌词不指定, 走活跃音源
    const sourceId = windows.sourceIdOfContents(event.sender.id);
    return bridge
      .sendCommand(command, sourceId)
      .catch((err) => ({ result: false, reason: err.message }));
  });

  ipcMain.handle("dl:setInteractive", (_event, value) => {
    windows.setInteractive(Boolean(value));
    return true;
  });

  ipcMain.handle("dl:window", (event, payload) => {
    const action = payload && payload.action;
    const ownSourceId = windows.sourceIdOfContents(event.sender.id);
    switch (action) {
      case "hide":
        if (ownSourceId) {
          windows.hideSelect(ownSourceId);
        } else {
          windows.hideLyrics();
        }
        break;
      case "resizeLyrics":
        // 仅全局唯一的悬浮歌词窗可请求自身按文本内容收紧尺寸。
        if (!ownSourceId) {
          windows.resizeLyricsToContent(payload.size);
        }
        break;
      case "toggleSelect": {
        // 悬浮歌词上的「歌词选择」按钮: 开当前活跃音源那一路
        const target = ownSourceId || bridge.activeSourceId;
        if (target) {
          windows.toggleSelect(target);
          pushSelectSnapshot(target);
        }
        break;
      }
      case "lock":
        windows.setLock(Boolean(payload.value));
        break;
      case "quit":
        app.isQuitting = true;
        app.quit();
        break;
      default:
        break;
    }
    refreshTray();
    return true;
  });

  ipcMain.handle("dl:lyric", async (event, payload) => {
    try {
      switch (payload && payload.action) {
        case "query":
          {
            const result = await bridge.sendCommand({ type: "queryLyrics", trackHash: payload.trackHash }, sourceId(event));
            return { ok: true, data: result.data && (result.data.lyricList || result.data.result && result.data.result.lyricList) || result.data || [] };
          }
        case "fetch":
          {
            const result = await bridge.sendCommand({ type: "fetchLyrics", pathPart: payload.pathPart }, sourceId(event));
            return { ok: true, data: result.data && (result.data.lrc || result.data.result && result.data.result.lrc) || result.data || [] };
          }
        case "save":
          return {
            ok: true,
            data: await bridge.sendCommand({ type: "saveLyrics", workId: payload.workId, writePath: payload.writePath, lines: payload.lines }, sourceId(event)),
          };
        default:
          return { ok: false, error: "未知的歌词操作" };
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function sourceId(event) {
  return windows.sourceIdOfContents(event.sender.id) || bridge.activeSourceId;
}

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  bridge.stop();
  windows.destroyAll();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
