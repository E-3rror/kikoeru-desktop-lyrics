"use strict";
/**
 * 歌词选择窗渲染层.
 *
 * 每个网页端（sourceId）各有一个这样的窗口, 主进程只把属于本窗口那一路的
 * state / lines / timeSync 推过来, 因此多标签页放不同曲目时互不串台.
 * 窗口归属由主进程按 webContents 判定, 这里读到的 sourceId 只用于显示.
 *
 * 功能对齐网页端的 LyricSelection: 行列表 + 点击跳转、自动跟踪、转到当前段落、
 * 编辑行文本、设置/删除结束时间、删除/恢复行、选择其他歌词文件、保存歌词、关闭歌词.
 */
(function () {
  var api = window.desktopLyrics;
  var THEMES = ["dark", "light", "transparent"];
  var THEME_LABEL = { dark: "深色", light: "浅色", transparent: "透明" };

  var els = {
    body: document.body,
    list: document.getElementById("list"),
    empty: document.getElementById("empty"),
    status: document.getElementById("status"),
    track: document.getElementById("track"),
    trackToggle: document.getElementById("track-toggle"),
    themeBtn: document.getElementById("themeBtn"),
    compactBtn: document.getElementById("compactBtn"),
    editModal: document.getElementById("editModal"),
    editText: document.getElementById("editText"),
    saveModal: document.getElementById("saveModal"),
    savePath: document.getElementById("savePath"),
    optionModal: document.getElementById("optionModal"),
    optionList: document.getElementById("optionList"),
  };

  var model = {
    sourceId: new URLSearchParams(location.search).get("sourceId") || "",
    lines: [],
    state: null,
    sync: null,
    connected: false,
    sourceAlive: true,
    autoTrack: true,
    activeIndex: -1,
    editIndex: -1,
    options: [],
    settings: null,
  };

  // ------------------------------------------------------------------ 工具

  function formatTime(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  }

  function playbackSeconds() {
    if (model.sync) {
      var elapsed = model.sync.playing ? (Date.now() - model.sync.at) / 1000 : 0;
      return model.sync.currentTime + elapsed;
    }
    return model.state ? model.state.currentTime || 0 : 0;
  }

  function lyricMs() {
    var offset = model.state ? model.state.lyricOffsetSeconds || 0 : 0;
    return (playbackSeconds() + offset) * 1000;
  }

  function setStatus(text, isError) {
    els.status.textContent = text || "";
    els.status.classList.toggle("error", Boolean(isError));
  }

  function pushLines(lines) {
    model.lines = lines;
    renderList();
    api.command({ type: "setLyricLines", lines: lines, hasLyric: lines.length > 0 });
  }

  function cloneLines() {
    return model.lines.map(function (line) { return Object.assign({}, line); });
  }

  // ------------------------------------------------------------ 外观（主题等）

  function applySettings(settings) {
    if (!settings) {
      return;
    }
    model.settings = settings;
    var theme = THEMES.indexOf(settings.selectTheme) >= 0 ? settings.selectTheme : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty(
      "--sel-font",
      (Number(settings.selectFontSize) || 17) + "px"
    );
    els.body.classList.toggle("compact", Boolean(settings.selectCompact));
    els.compactBtn.classList.toggle("on", Boolean(settings.selectCompact));
    els.themeBtn.title = "切换主题（当前: " + THEME_LABEL[theme] + "）";
  }

  function cycleTheme() {
    var current = (model.settings && model.settings.selectTheme) || "dark";
    var next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    api.saveSettings({ selectTheme: next });
  }

  function toggleCompact() {
    var next = !(model.settings && model.settings.selectCompact);
    api.saveSettings({ selectCompact: next });
  }

  function changeFont(delta) {
    var base = (model.settings && Number(model.settings.selectFontSize)) || 17;
    api.saveSettings({ selectFontSize: Math.max(12, Math.min(32, base + delta)) });
  }

  // ------------------------------------------------------------------ 列表

  function renderList() {
    if (!model.connected) {
      els.list.innerHTML = "";
      els.empty.textContent = "未连接 Kikoeru 服务端…";
      els.empty.style.display = "block";
      return;
    }
    if (!model.sourceAlive) {
      els.list.innerHTML = "";
      els.empty.textContent = "这个网页端已经关闭了。";
      els.empty.style.display = "block";
      return;
    }
    if (!model.state) {
      els.list.innerHTML = "";
      els.empty.textContent = "等待 Kikoeru 网页端…";
      els.empty.style.display = "block";
      return;
    }
    if (!model.lines.length) {
      els.list.innerHTML = "";
      els.empty.textContent = "当前曲目没有歌词，可点「选择其他歌词」挑一个文件。";
      els.empty.style.display = "block";
      return;
    }
    els.empty.style.display = "none";

    els.list.innerHTML = model.lines
      .map(function (line, index) {
        var classes = "row" + (line.deleted ? " deleted" : "");
        var end = typeof line.timeEnd === "number" ? " → " + formatTime(line.timeEnd) : "";
        return (
          '<div class="' + classes + '" data-index="' + index + '">' +
          '<span class="time">' + formatTime(line.time) + end + "</span>" +
          '<span class="text"></span>' +
          '<span class="ops">' +
          '<button data-op="edit">编辑</button>' +
          (line.deleted
            ? '<button data-op="recover">恢复</button>'
            : '<button data-op="delete">删除</button>') +
          "</span></div>"
        );
      })
      .join("");
    // 文本用 textContent 写入, 避免歌词里的尖括号被当成标签
    var textNodes = els.list.querySelectorAll(".row .text");
    for (var i = 0; i < textNodes.length; i += 1) {
      textNodes[i].textContent = model.lines[i].text || "";
    }
    model.activeIndex = -1;
    highlight(true);
  }

  function highlight(forceScroll) {
    if (!model.lines.length) {
      return;
    }
    var ms = lyricMs();
    var index = -1;
    for (var i = 0; i < model.lines.length; i += 1) {
      if (model.lines[i].time <= ms) {
        index = i;
      } else {
        break;
      }
    }
    if (index === model.activeIndex && !forceScroll) {
      return;
    }
    var previous = els.list.querySelector(".row.active");
    if (previous) {
      previous.classList.remove("active");
    }
    model.activeIndex = index;
    var row = els.list.querySelector('.row[data-index="' + index + '"]');
    if (row) {
      row.classList.add("active");
      if (model.autoTrack) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }

  function scrollToCurrent() {
    var row = els.list.querySelector('.row[data-index="' + model.activeIndex + '"]');
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // ------------------------------------------------------------------ 操作

  var ACTIONS = {
    theme: cycleTheme,
    compact: toggleCompact,
    "font-up": function () { changeFont(1); },
    "font-down": function () { changeFont(-1); },
    "close-window": function () { api.hideWindow(); },
    goto: scrollToCurrent,
    "close-lyric": function () {
      api.command({ type: "closeLyric" });
      model.lines = [];
      renderList();
      setStatus("已关闭当前歌词");
    },
    save: openSaveModal,
    other: loadOtherLyrics,
    "set-end": function () {
      if (model.activeIndex < 0) {
        return;
      }
      var lines = cloneLines();
      lines[model.activeIndex].timeEnd = Math.round(lyricMs());
      pushLines(lines);
      setStatus("已把当前时间设为第 " + (model.activeIndex + 1) + " 行的结束时间");
    },
    "del-end": function () {
      if (model.activeIndex < 0) {
        return;
      }
      var lines = cloneLines();
      delete lines[model.activeIndex].timeEnd;
      pushLines(lines);
      setStatus("已删除第 " + (model.activeIndex + 1) + " 行的结束时间");
    },
    "edit-cancel": function () { els.editModal.classList.remove("open"); },
    "edit-ok": function () {
      if (model.editIndex >= 0) {
        var lines = cloneLines();
        lines[model.editIndex].text = els.editText.value;
        pushLines(lines);
      }
      els.editModal.classList.remove("open");
      model.editIndex = -1;
    },
    "save-cancel": function () { els.saveModal.classList.remove("open"); },
    "save-ok": doSave,
    "option-cancel": function () { els.optionModal.classList.remove("open"); },
  };

  document.body.addEventListener("click", function (event) {
    var actionEl = event.target.closest("[data-act]");
    if (actionEl && ACTIONS[actionEl.getAttribute("data-act")]) {
      ACTIONS[actionEl.getAttribute("data-act")]();
    }
  });

  els.list.addEventListener("click", function (event) {
    var row = event.target.closest(".row");
    if (!row) {
      return;
    }
    var index = Number(row.getAttribute("data-index"));
    var opButton = event.target.closest("button[data-op]");
    if (opButton) {
      var op = opButton.getAttribute("data-op");
      if (op === "edit") {
        model.editIndex = index;
        els.editText.value = model.lines[index].text || "";
        els.editModal.classList.add("open");
        els.editText.focus();
      } else if (op === "delete" || op === "recover") {
        var lines = cloneLines();
        if (op === "delete") {
          lines[index].deleted = true;
        } else {
          delete lines[index].deleted;
        }
        pushLines(lines);
      }
      return;
    }
    // 点行本身 = 跳转到该行（精简模式下这是唯一保留的交互）
    api.command({ type: "seekToLine", index: index });
  });

  els.trackToggle.addEventListener("change", function () {
    model.autoTrack = els.trackToggle.checked;
    if (model.autoTrack) {
      scrollToCurrent();
    }
  });

  // ------------------------------------------------------------ 歌词文件操作

  function openSaveModal() {
    var track = (model.state && model.state.track) || {};
    var prefix = track.subtitle ? track.subtitle + "/" : "";
    els.savePath.value = prefix + (track.title || "lyric") + ".vtt";
    els.saveModal.classList.add("open");
    els.savePath.focus();
  }

  function doSave() {
    var writePath = els.savePath.value.trim();
    if (!writePath.endsWith(".vtt")) {
      setStatus("保存路径必须以 .vtt 结尾", true);
      return;
    }
    var workId = model.state ? model.state.workId : 0;
    if (!workId) {
      setStatus("当前没有正在播放的作品，无法保存", true);
      return;
    }
    els.saveModal.classList.remove("open");
    setStatus("正在保存…");
    api.saveLyric(workId, writePath, model.lines).then(function (res) {
      if (res && res.ok) {
        setStatus(
          "保存歌词成功（由于文件变动，如果播放历史无法正常播放以往记录，需要删除当前作品的历史播放记录来恢复）"
        );
      } else {
        setStatus("保存失败: " + ((res && res.error) || "未知错误"), true);
      }
    });
  }

  function loadOtherLyrics() {
    var track = (model.state && model.state.track) || {};
    if (!track.hash) {
      setStatus("当前没有正在播放的曲目", true);
      return;
    }
    setStatus("正在查询可用歌词…");
    api.queryLyric(track.hash).then(function (res) {
      if (!res || !res.ok) {
        setStatus("查询歌词失败: " + ((res && res.error) || "未知错误"), true);
        return;
      }
      // 与网页端一致: 匹配度高的排前面
      var all = res.data || [];
      var unmatched = all.filter(function (o) { return o.matchLevel < 0; });
      var matched = all.filter(function (o) { return o.matchLevel >= 0; });
      model.options = matched.concat(unmatched);
      renderOptions();
      setStatus(model.options.length ? "" : "没有找到其他歌词文件");
      els.optionModal.classList.add("open");
    });
  }

  function renderOptions() {
    els.optionList.innerHTML = model.options
      .map(function (option, index) {
        return (
          '<div class="option" data-option="' + index + '">' +
          '<div class="name"></div><div class="sub"></div>' +
          (option.isAI ? '<span class="ai">AI</span>' : "") +
          "</div>"
        );
      })
      .join("");
    var nodes = els.optionList.querySelectorAll(".option");
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].querySelector(".name").textContent = model.options[i].title || "";
      nodes[i].querySelector(".sub").textContent = model.options[i].subtitle || "";
    }
  }

  els.optionList.addEventListener("click", function (event) {
    var node = event.target.closest("[data-option]");
    if (!node) {
      return;
    }
    var option = model.options[Number(node.getAttribute("data-option"))];
    if (!option) {
      return;
    }
    // 路径拼法与网页端保持一致: AI 歌词用 作品ID/任务ID/1, 本地文件用 曲目hash/0
    var workId = model.state ? model.state.workId : 0;
    var pathPart = option.isAI ? workId + "/" + option.hash + "/1" : option.hash + "/0";
    setStatus("正在读取歌词…");
    api.fetchLyric(pathPart).then(function (res) {
      if (!res || !res.ok) {
        setStatus("读取歌词失败: " + ((res && res.error) || "未知错误"), true);
        return;
      }
      els.optionModal.classList.remove("open");
      pushLines(res.data || []);
      setStatus("已切换歌词: " + (option.title || ""));
    });
  });

  // ------------------------------------------------------------------ 数据

  function updateTrackLabel() {
    var track = (model.state && model.state.track) || {};
    els.track.textContent = track.title
      ? (track.subtitle ? track.subtitle + " / " : "") + track.title
      : "";
  }

  function adoptSnapshot(snap) {
    if (!snap) {
      return;
    }
    model.connected = Boolean(snap.connected);
    model.sourceAlive = snap.sourceAlive !== false;
    model.state = snap.state || null;
    model.lines = snap.lines || [];
    model.sync = snap.timeSync || null;
    applySettings(snap.settings);
    updateTrackLabel();
    renderList();
  }

  api.on("dl:snapshot", adoptSnapshot);
  api.on("dl:settings", applySettings);
  api.on("dl:connection", function (info) {
    model.connected = Boolean(info && info.connected);
    renderList();
  });
  api.on("dl:state", function (state) {
    var previous = (model.state && model.state.track) || {};
    model.state = state;
    model.sourceAlive = true;
    if (previous.hash !== ((state && state.track) || {}).hash) {
      updateTrackLabel();
    }
  });
  api.on("dl:lines", function (payload) {
    model.lines = payload.lines || [];
    renderList();
  });
  api.on("dl:timeSync", function (sync) {
    model.sync = sync;
  });

  setInterval(function () {
    if (model.lines.length) {
      highlight(false);
    }
  }, 250);

  api.getSettings().then(applySettings);
  api.getSnapshot().then(adoptSnapshot);
})();
