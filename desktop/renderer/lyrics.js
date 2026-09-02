"use strict";
/**
 * 悬浮歌词渲染层.
 *
 * 时间是本地插值出来的: 桥接每 500ms 送一个「锚点」(currentTime + 采样时刻),
 * 这里每帧按 (now - at) 推算, 于是逐字高亮是连续的, 而链路只有 2Hz.
 * 同机无时钟偏移, 不需要做时钟校正.
 */
(function () {
  var api = window.desktopLyrics;

  var els = {
    body: document.body,
    root: document.getElementById("root"),
    hint: document.getElementById("hint"),
    current: document.getElementById("current"),
    next: document.getElementById("next"),
    bar: document.getElementById("bar"),
    unlock: document.getElementById("unlock"),
    playBtn: document.getElementById("playBtn"),
  };
  var currentStroke = els.current.querySelector(".stroke");
  var currentFill = els.current.querySelector(".fill");
  var nextStroke = els.next.querySelector(".stroke");
  var nextFill = els.next.querySelector(".fill");

  var model = {
    lines: [],
    state: null,
    sync: null,
    settings: null,
    connected: false,
    lastText: null,
    lastNextText: null,
    fontScale: 1,
    lastContentSize: null,
  };

  // ------------------------------------------------------------------ 时间

  function playbackSeconds() {
    if (model.sync) {
      var elapsed = model.sync.playing ? (Date.now() - model.sync.at) / 1000 : 0;
      return model.sync.currentTime + elapsed;
    }
    return model.state ? model.state.currentTime || 0 : 0;
  }

  /** 与网页播放器一致: 歌词时间轴要加上用户设定的偏移 */
  function lyricSeconds() {
    var offset = model.state ? model.state.lyricOffsetSeconds || 0 : 0;
    return playbackSeconds() + offset;
  }

  function findLineIndex(ms) {
    var lines = model.lines;
    if (!lines.length) {
      return -1;
    }
    var lo = 0;
    var hi = lines.length - 1;
    var found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].time <= ms) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  function lineEnd(index) {
    var line = model.lines[index];
    if (!line) {
      return 0;
    }
    if (typeof line.timeEnd === "number" && line.timeEnd > line.time) {
      return line.timeEnd;
    }
    var following = model.lines[index + 1];
    if (following) {
      return following.time;
    }
    return line.time + 5000;
  }

  // ------------------------------------------------------------------ 渲染

  function setLineText(strokeEl, fillEl, text) {
    strokeEl.textContent = text;
    fillEl.textContent = text;
  }

  /**
   * 文字放不下时按比例缩小, 保证任何窗口尺寸下都不会被裁切.
   * 这正是原画中画方案（canvas 手工测量 + 固定公式）做不好的地方.
   */
  function fitText() {
    var base = model.settings ? model.settings.fontSize || 34 : 34;
    model.fontScale = 1;
    document.documentElement.style.setProperty("--dl-font-size", base + "px");
    var guard = 0;
    while (els.root.scrollHeight > els.root.clientHeight && guard < 14) {
      model.fontScale *= 0.92;
      document.documentElement.style.setProperty(
        "--dl-font-size",
        Math.max(12, Math.round(base * model.fontScale)) + "px"
      );
      guard += 1;
    }
  }

  /**
   * 窗口宽度由当前歌词的实际绘制宽度决定，而不是预留一整条桌面宽度。
   * 控制条所需的最小宽度也一并计算，避免按钮在短歌词时被裁掉。
   */
  function resizeToContent() {
    var canvas = document.createElement("canvas");
    var context = canvas.getContext("2d");
    var widest = 0;

    function measure(el, text) {
      if (!text) {
        return 0;
      }
      var style = window.getComputedStyle(el);
      context.font = style.font || (style.fontWeight + " " + style.fontSize + " " + style.fontFamily);
      return String(text)
        .split("\n")
        .reduce(function (max, part) { return Math.max(max, context.measureText(part).width); }, 0);
    }

    var currentText = model.lastText || els.hint.textContent || "";
    widest = Math.max(widest, measure(currentFill, currentText));
    if (model.settings && model.settings.showNextLine !== false) {
      widest = Math.max(widest, measure(nextFill, model.lastNextText || ""));
    }

    var currentStyle = window.getComputedStyle(currentFill);
    var currentFont = parseFloat(currentStyle.fontSize) || 34;
    var nextFont = parseFloat(window.getComputedStyle(nextFill).fontSize) || currentFont * 0.62;
    var showNext = !model.settings || model.settings.showNextLine !== false;
    var textHeight = currentFont * 1.25 + (showNext ? nextFont * 1.25 + 6 : 0);
    var controlWidth = els.bar.scrollWidth + 28;
    var size = {
      width: Math.ceil(Math.max(420, controlWidth, widest + 48)),
      height: Math.ceil(Math.max(90, textHeight + 52)),
    };
    if (
      model.lastContentSize &&
      Math.abs(model.lastContentSize.width - size.width) < 2 &&
      Math.abs(model.lastContentSize.height - size.height) < 2
    ) {
      return;
    }
    model.lastContentSize = size;
    api.resizeLyrics(size);
  }

  function applySettings(settings) {
    if (!settings) {
      return;
    }
    model.settings = settings;
    var rootStyle = document.documentElement.style;
    rootStyle.setProperty("--dl-sung", settings.sungColor);
    rootStyle.setProperty("--dl-unsung", settings.unsungColor);
    rootStyle.setProperty("--dl-stroke", settings.strokeColor);
    rootStyle.setProperty(
      "--dl-backdrop",
      "rgba(0,0,0," + (Number(settings.backdropOpacity) || 0) + ")"
    );
    els.next.classList.toggle("hidden", settings.showNextLine === false);
    els.body.classList.toggle("locked", Boolean(settings.locked));
    fitText();
    resizeToContent();
  }

  function renderIdle(message) {
    els.hint.textContent = message;
    els.hint.classList.remove("hidden");
    setLineText(currentStroke, currentFill, "");
    setLineText(nextStroke, nextFill, "");
    model.lastText = null;
    model.lastNextText = null;
    resizeToContent();
  }

  function frame() {
    requestAnimationFrame(frame);

    if (!model.connected) {
      renderIdle("未连接 Kikoeru 服务端…");
      return;
    }
    if (!model.state) {
      renderIdle("等待 Kikoeru 网页端…");
      return;
    }
    if (!model.lines.length) {
      renderIdle(
        model.state.track && model.state.track.title
          ? model.state.track.title + " — 当前曲目没有歌词"
          : "当前曲目没有歌词"
      );
      return;
    }

    els.hint.classList.add("hidden");

    var ms = lyricSeconds() * 1000;
    var index = findLineIndex(ms);
    var line = index >= 0 ? model.lines[index] : null;
    var text = line ? line.text || "" : "";
    var following = model.lines[index + 1];
    var nextText = following ? following.text || "" : "";

    if (text !== model.lastText) {
      model.lastText = text;
      setLineText(currentStroke, currentFill, text);
      fitText();
      resizeToContent();
    }
    if (nextText !== model.lastNextText) {
      model.lastNextText = nextText;
      setLineText(nextStroke, nextFill, nextText);
      fitText();
      resizeToContent();
    }

    var progress = 0;
    if (line) {
      var end = lineEnd(index);
      var span = end - line.time;
      progress = span > 0 ? ((ms - line.time) / span) * 100 : 100;
      progress = Math.max(0, Math.min(100, progress));
    }
    els.current.style.setProperty("--progress", progress.toFixed(2) + "%");
    els.playBtn.textContent = model.state.playing ? "⏸" : "▶";
  }

  // ------------------------------------------------------------------ 交互

  var ACTIONS = {
    prev: function () { api.command({ type: "previous" }); },
    next: function () { api.command({ type: "next" }); },
    toggle: function () { api.command({ type: "toggle" }); },
    "font-up": function () { changeFont(2); },
    "font-down": function () { changeFont(-2); },
    lock: function () { api.setLock(true); },
    select: function () { api.toggleSelect(); },
    close: function () { api.hideWindow(); },
  };

  function changeFont(delta) {
    var base = model.settings ? model.settings.fontSize || 34 : 34;
    var size = Math.max(14, Math.min(96, base + delta));
    api.saveSettings({ fontSize: size });
  }

  els.bar.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-act]");
    if (!button) {
      return;
    }
    var handler = ACTIONS[button.getAttribute("data-act")];
    if (handler) {
      handler();
    }
  });

  els.unlock.addEventListener("click", function () {
    api.setLock(false);
  });

  // 锁定时窗口整体穿透, 但 forward:true 仍会把 mousemove 送进来,
  // 于是可以在鼠标靠近右上角热区时临时放开穿透, 让它点得到.
  var interactive = false;
  window.addEventListener("mousemove", function (event) {
    if (!model.settings || !model.settings.locked) {
      return;
    }
    var hot = event.clientX > window.innerWidth - 40 && event.clientY < 40;
    if (hot !== interactive) {
      interactive = hot;
      api.setInteractive(hot);
    }
  });

  window.addEventListener("resize", function () {
    fitText();
    resizeToContent();
  });

  // ------------------------------------------------------------------ 数据

  function adoptSnapshot(snap) {
    if (!snap) {
      return;
    }
    model.connected = Boolean(snap.connected);
    model.state = snap.state || null;
    model.lines = (snap.lines || []).filter(function (l) { return l && !l.deleted; });
    model.sync = snap.timeSync || null;
    applySettings(snap.settings);
  }

  api.on("dl:snapshot", adoptSnapshot);
  api.on("dl:settings", applySettings);
  api.on("dl:connection", function (info) {
    model.connected = Boolean(info && info.connected);
  });
  api.on("dl:state", function (state) {
    model.state = state;
  });
  api.on("dl:lines", function (payload) {
    model.lines = (payload.lines || []).filter(function (l) { return l && !l.deleted; });
    model.lastText = null;
    model.lastNextText = null;
  });
  api.on("dl:timeSync", function (sync) {
    model.sync = sync;
  });
  api.on("lock-changed", function (locked) {
    if (model.settings) {
      model.settings.locked = Boolean(locked);
    }
    els.body.classList.toggle("locked", Boolean(locked));
  });
  // 悬停状态由主进程按光标坐标判定, 拖拽区域与锁定穿透两种情况都能覆盖
  api.on("dl:pointer-over", function (over) {
    els.body.classList.toggle("pointer-over", Boolean(over));
  });

  api.getSnapshot().then(adoptSnapshot);
  requestAnimationFrame(frame);
})();
