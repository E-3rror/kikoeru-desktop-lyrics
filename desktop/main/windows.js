"use strict"
/**
 * 桌面窗口的创建与生命周期.
 *
 *   lyrics — 悬浮歌词: 全局唯一, 无边框 / 透明 / 置顶 / 可锁定鼠标穿透
 *   select — 歌词选择: 每一路网页端（sourceId）各一个, 互不干扰
 *
 * 关窗一律走 hide(), 不真正销毁, 这样重新打开是瞬时的, 也不会丢渲染进程里的状态;
 * 只有对应的网页端彻底消失时才 destroy.
 */
const path = require("path")
const { BrowserWindow, screen } = require("electron")
const settings = require("./settings")
const api = require("./api")

const LYRICS_DEFAULT = { width: 40, height: 150 }
const LYRICS_REFERENCE_FONT_SIZE = 34
const SELECT_DEFAULT = { width: 720, height: 560 }
/** 多开时逐个错开, 避免叠在一起 */
const CASCADE_STEP = 32
const BOUNDS_SAVE_DEBOUNCE_MS = 400
/** 悬停检测的轮询间隔; 100ms 足够跟手, 开销可忽略 */
const POINTER_POLL_MS = 100

let lyricsWindow = null
let bridgeSettingsWindow = null
let lyricsSaveTimer = null
let pointerTimer = null
let pointerOver = false
/** sourceId -> BrowserWindow */
const selectWindows = new Map()
/** webContents.id -> sourceId, 让主进程能从 IPC 事件反查窗口归属 */
const contentsToSource = new Map()
const selectSaveTimers = new Map()

function preloadPath() {
  return path.join(__dirname, "..", "preload", "bridge.js")
}

function defaultLyricsBounds() {
  const area = screen.getPrimaryDisplay().workArea
  const size = lyricsSizeForFont(settings.get("fontSize"))
  const width = Math.min(size.width, area.width - 40)
  const height = Math.min(size.height, area.height - 40)
  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height - height - 60),
  }
}

/** 旧版本的首次默认值；命中时可安全迁移到按字号计算的新尺寸。 */
function isLegacyDefaultLyricsBounds(bounds) {
  return Boolean(bounds && bounds.width === 980 && bounds.height === 190)
}

/**
 * 悬浮歌词的基准尺寸随字号同比例变化。歌词文本本身仍会由渲染层折行/缩放，
 * 因而切歌时窗口不会来回跳动；只有用户调整字号时，窗口才同步调整。
 */
function lyricsSizeForFont(fontSize) {
  const size = Number(fontSize) || LYRICS_REFERENCE_FONT_SIZE
  const scale = size / LYRICS_REFERENCE_FONT_SIZE
  return {
    width: Math.max(320, Math.round(LYRICS_DEFAULT.width * scale)),
    height: Math.max(90, Math.round(LYRICS_DEFAULT.height * scale)),
  }
}

function defaultSelectBounds(index) {
  const stored = settings.get("selectBounds")
  const area = screen.getPrimaryDisplay().workArea
  const base = stored || {
    width: Math.min(SELECT_DEFAULT.width, area.width - 80),
    height: Math.min(SELECT_DEFAULT.height, area.height - 120),
    x: Math.round(area.x + (area.width - SELECT_DEFAULT.width) / 2),
    y: Math.round(area.y + 60),
  }
  const offset = (index || 0) * CASCADE_STEP
  return {
    width: base.width,
    height: base.height,
    x: base.x + offset,
    y: base.y + offset,
  }
}

/** 把窗口夹回它所在显示器的工作区, 防止上次关机前的位置这次开机时不存在 */
function clampToDisplay(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
  }
}

// ------------------------------------------------------------------ 悬浮歌词

function scheduleSaveLyricsBounds() {
  if (lyricsSaveTimer) {
    clearTimeout(lyricsSaveTimer)
  }
  lyricsSaveTimer = setTimeout(() => {
    lyricsSaveTimer = null
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      settings.save({ lyricsBounds: lyricsWindow.getBounds() })
    }
  }, BOUNDS_SAVE_DEBOUNCE_MS)
}

function createLyrics() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    return lyricsWindow
  }
  const storedBounds = settings.get("lyricsBounds")
  const bounds = clampToDisplay(
    !storedBounds || isLegacyDefaultLyricsBounds(storedBounds)
      ? defaultLyricsBounds()
      : storedBounds,
  )
  const transparent = settings.get("transparent") !== false

  const win = new BrowserWindow(
    Object.assign({}, bounds, {
      frame: false,
      transparent,
      backgroundColor: transparent ? "#00000000" : "#1e1e1e",
      hasShadow: false,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      title: "Kikoeru 桌面歌词",
      minWidth: 320,
      minHeight: 90,
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    }),
  )

  win.setAlwaysOnTop(true, "screen-saver")
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(__dirname, "..", "renderer", "lyrics.html"))

  win.on("move", scheduleSaveLyricsBounds)
  win.on("resize", scheduleSaveLyricsBounds)
  win.on("close", (event) => {
    event.preventDefault()
    hideLyrics()
  })

  lyricsWindow = win
  applyLock(settings.get("locked"))
  startPointerWatch()
  return win
}

function createBridgeSettings() {
  if (bridgeSettingsWindow && !bridgeSettingsWindow.isDestroyed()) return bridgeSettingsWindow
  const win = new BrowserWindow({
    width: 560,
    height: 560,
    resizable: false,
    title: "Bridge 设置",
    backgroundColor: "#0d151b",
    show: false,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  // 设置窗口是独立工具面板，不显示原生菜单栏。
  win.setMenuBarVisibility(false)
  win.setAutoHideMenuBar(true)
  win.loadFile(path.join(__dirname, "..", "renderer", "bridge-settings.html"))
  win.on("close", (event) => { if (!require("electron").app.isQuitting) { event.preventDefault(); win.hide(); } })
  bridgeSettingsWindow = win
  return win
}

function showBridgeSettings() {
  const win = createBridgeSettings()
  win.show()
  win.focus()
  return win
}

/**
 * 指针是否悬停在悬浮歌词上 —— 由主进程比对光标坐标与窗口矩形得出.
 *
 * 不用渲染层的 CSS :hover / mouseenter: 悬浮歌词整块是 -webkit-app-region: drag,
 * 拖拽区域不接收鼠标事件, CSS 悬停并不可靠; 而且锁定（鼠标穿透）时渲染层根本收不到
 * 常规事件. 用光标坐标判断则两种情况都成立.
 */
function startPointerWatch() {
  if (pointerTimer) {
    return
  }
  pointerTimer = setInterval(() => {
    let inside = false
    if (
      lyricsWindow &&
      !lyricsWindow.isDestroyed() &&
      lyricsWindow.isVisible()
    ) {
      const point = screen.getCursorScreenPoint()
      const b = lyricsWindow.getBounds()
      inside =
        point.x >= b.x &&
        point.x < b.x + b.width &&
        point.y >= b.y &&
        point.y < b.y + b.height
    }
    if (inside !== pointerOver) {
      pointerOver = inside
      sendToLyrics("dl:pointer-over", inside)
    }
  }, POINTER_POLL_MS)
  if (typeof pointerTimer.unref === "function") {
    pointerTimer.unref()
  }
}

function showLyrics() {
  const win = createLyrics()
  win.showInactive()
  win.setAlwaysOnTop(true, "screen-saver")
  api.reportWindowState("lyrics", true).catch(() => {})
  return win
}

function hideLyrics() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.hide()
  }
  api.reportWindowState("lyrics", false).catch(() => {})
}

function isLyricsVisible() {
  return Boolean(
    lyricsWindow && !lyricsWindow.isDestroyed() && lyricsWindow.isVisible(),
  )
}

/**
 * 以窗口中心为锚点缩放，避免调节字号后歌词窗口向某一侧漂移。
 * 用户手动拉伸过的宽高同样按比例保留，而不是重置为固定的桌面占用尺寸。
 */
function resizeLyricsForFont(previousFontSize, nextFontSize) {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    return
  }
  const previous = Number(previousFontSize) || LYRICS_REFERENCE_FONT_SIZE
  const next = Number(nextFontSize) || LYRICS_REFERENCE_FONT_SIZE
  if (previous === next) {
    return
  }
  const oldBounds = lyricsWindow.getBounds()
  const scale = next / previous
  const desired = {
    width: Math.max(320, Math.round(oldBounds.width * scale)),
    height: Math.max(90, Math.round(oldBounds.height * scale)),
  }
  desired.x = Math.round(oldBounds.x + (oldBounds.width - desired.width) / 2)
  desired.y = Math.round(oldBounds.y + (oldBounds.height - desired.height) / 2)
  lyricsWindow.setBounds(clampToDisplay(desired))
  scheduleSaveLyricsBounds()
}

/** 渲染层测量文本后的尺寸请求；主进程负责范围校验及保持窗口中心不漂移。 */
function resizeLyricsToContent(size) {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || !size) {
    return
  }
  const oldBounds = lyricsWindow.getBounds()
  const desired = {
    width: Math.max(320, Math.round(Number(size.width) || oldBounds.width)),
    height: Math.max(90, Math.round(Number(size.height) || oldBounds.height)),
  }
  desired.x = Math.round(oldBounds.x + (oldBounds.width - desired.width) / 2)
  desired.y = Math.round(oldBounds.y + (oldBounds.height - desired.height) / 2)
  const bounds = clampToDisplay(desired)
  if (bounds.width === oldBounds.width && bounds.height === oldBounds.height) {
    return
  }
  lyricsWindow.setBounds(bounds)
  scheduleSaveLyricsBounds()
}

// ------------------------------------------------------------------ 歌词选择

function scheduleSaveSelectBounds(sourceId) {
  const existing = selectSaveTimers.get(sourceId)
  if (existing) {
    clearTimeout(existing)
  }
  selectSaveTimers.set(
    sourceId,
    setTimeout(() => {
      selectSaveTimers.delete(sourceId)
      const win = selectWindows.get(sourceId)
      if (win && !win.isDestroyed()) {
        // 只记尺寸模板, 位置由错开算法决定, 避免多开时全部重叠
        settings.save({ selectBounds: win.getBounds() })
      }
    }, BOUNDS_SAVE_DEBOUNCE_MS),
  )
}

function createSelect(sourceId) {
  if (!sourceId) {
    return null
  }
  const existing = selectWindows.get(sourceId)
  if (existing && !existing.isDestroyed()) {
    return existing
  }
  const bounds = clampToDisplay(defaultSelectBounds(selectWindows.size))

  const win = new BrowserWindow(
    Object.assign({}, bounds, {
      frame: false,
      // 始终建成透明窗, 三种主题（深色/浅色/透明）就都能靠 CSS 切换,
      // 不必为了换主题重建窗口
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: true,
      skipTaskbar: true,
      show: false,
      title: "歌词选择",
      minWidth: 360,
      minHeight: 220,
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    }),
  )

  win.setAlwaysOnTop(true, "screen-saver")
  // sourceId 通过 query 传给渲染层做展示; 归属判断一律用主进程的 contentsToSource
  win.loadFile(path.join(__dirname, "..", "renderer", "select.html"), {
    query: { sourceId },
  })

  contentsToSource.set(win.webContents.id, sourceId)
  win.on("move", () => scheduleSaveSelectBounds(sourceId))
  win.on("resize", () => scheduleSaveSelectBounds(sourceId))
  win.on("close", (event) => {
    event.preventDefault()
    hideSelect(sourceId)
  })

  selectWindows.set(sourceId, win)
  return win
}

function showSelect(sourceId) {
  const win = createSelect(sourceId)
  if (!win) {
    return null
  }
  win.showInactive()
  win.setAlwaysOnTop(true, "screen-saver")
  api.reportWindowState("select", true, sourceId).catch(() => {})
  return win
}

function hideSelect(sourceId) {
  const win = selectWindows.get(sourceId)
  if (win && !win.isDestroyed()) {
    win.hide()
  }
  api.reportWindowState("select", false, sourceId).catch(() => {})
}

function toggleSelect(sourceId) {
  if (isSelectVisible(sourceId)) {
    hideSelect(sourceId)
  } else {
    showSelect(sourceId)
  }
}

function isSelectVisible(sourceId) {
  const win = selectWindows.get(sourceId)
  return Boolean(win && !win.isDestroyed() && win.isVisible())
}

/** 网页端彻底消失了, 把它那一个选择窗销毁掉 */
function destroySelect(sourceId) {
  const win = selectWindows.get(sourceId)
  selectWindows.delete(sourceId)
  if (win && !win.isDestroyed()) {
    contentsToSource.delete(win.webContents.id)
    win.removeAllListeners("close")
    win.destroy()
  }
}

function listSelectSourceIds() {
  return Array.from(selectWindows.keys())
}

function visibleSelectCount() {
  let count = 0
  selectWindows.forEach((win) => {
    if (win && !win.isDestroyed() && win.isVisible()) {
      count += 1
    }
  })
  return count
}

/** 从 IPC 事件反查这是哪一路网页端的选择窗 */
function sourceIdOfContents(webContentsId) {
  return contentsToSource.get(webContentsId) || null
}

// -------------------------------------------------------------------- 锁定

function applyLock(locked) {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    return
  }
  lyricsWindow.setIgnoreMouseEvents(Boolean(locked), { forward: true })
  sendToLyrics("lock-changed", Boolean(locked))
}

function setLock(locked) {
  settings.save({ locked: Boolean(locked) })
  applyLock(locked)
}

function setInteractive(interactive) {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    return
  }
  const locked = settings.get("locked")
  lyricsWindow.setIgnoreMouseEvents(Boolean(locked) && !interactive, {
    forward: true,
  })
}

// -------------------------------------------------------------------- 发送

function sendToLyrics(channel, payload) {
  if (lyricsWindow && !lyricsWindow.isDestroyed() && lyricsWindow.webContents) {
    lyricsWindow.webContents.send(channel, payload)
  }
}

function sendToSelect(sourceId, channel, payload) {
  const win = selectWindows.get(sourceId)
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send(channel, payload)
  }
}

function sendToAllSelect(channel, payload) {
  selectWindows.forEach((win) => {
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send(channel, payload)
    }
  })
}

function broadcast(channel, payload) {
  sendToLyrics(channel, payload)
  sendToAllSelect(channel, payload)
}

function destroyAll() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.removeAllListeners("close")
    lyricsWindow.destroy()
  }
  lyricsWindow = null
  Array.from(selectWindows.keys()).forEach(destroySelect)
  if (bridgeSettingsWindow && !bridgeSettingsWindow.isDestroyed()) {
    bridgeSettingsWindow.removeAllListeners("close")
    bridgeSettingsWindow.destroy()
  }
  bridgeSettingsWindow = null
}

module.exports = {
  createLyrics,
  createBridgeSettings,
  showBridgeSettings,
  showLyrics,
  hideLyrics,
  isLyricsVisible,
  resizeLyricsForFont,
  resizeLyricsToContent,
  createSelect,
  showSelect,
  hideSelect,
  toggleSelect,
  isSelectVisible,
  destroySelect,
  listSelectSourceIds,
  visibleSelectCount,
  sourceIdOfContents,
  setLock,
  applyLock,
  setInteractive,
  sendToLyrics,
  sendToSelect,
  sendToAllSelect,
  broadcast,
  destroyAll,
}
