// ==UserScript==
// @name         Kikoeru Desktop Lyrics Adapter
// @namespace    kikoeru-desktop-lyrics
// @version      2.0.0
// @description  将 Kikoeru 播放器状态和歌词旁路同步到独立 Electron 桌面歌词
// @match        http://127.0.0.1:8888/*
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @author       ErrorRua
// ==/UserScript==

;(function () {
  "use strict"

  var STORAGE_KEY = "kikoeru-desktop-lyrics-source-id"
  var BRIDGE_KEY = "kikoeru-desktop-lyrics-bridge"
  var sourceId = sessionStorage.getItem(STORAGE_KEY)
  if (!sourceId) {
    sourceId = crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(16).slice(2)
    sessionStorage.setItem(STORAGE_KEY, sourceId)
  }

  function detectKikoeru() {
    return Boolean(
      document.querySelector("#q-app") ||
      /kikoeru/i.test(document.title) ||
      /\/api\/media\//.test(location.href),
    )
  }
  if (!detectKikoeru()) return

  var config = null
  try {
    config = JSON.parse(localStorage.getItem(BRIDGE_KEY) || "null")
  } catch (_err) {
    config = null
  }
  function saveConfig() {
    var value = prompt(
      "请输入 Electron Bridge 地址（例如 http://127.0.0.1:18765）",
      (config && config.url) || "",
    )
    if (!value) return
    var secret = prompt(
      "请输入 Bridge Secret（可留空）",
      (config && config.secret) || "",
    )
    if (secret === null) return
    config = { url: value.replace(/\/$/, ""), secret: secret }
    localStorage.setItem(BRIDGE_KEY, JSON.stringify(config))
    connect()
  }
  if (typeof GM_registerMenuCommand === "function")
    GM_registerMenuCommand("配置 Electron Bridge", saveConfig)

  var audio = null
  var lastState = null
  var lastLines = []
  var linesRev = 0
  var eventSource = null
  var retryTimer = null
  var heartbeatTimer = null
  var syncTimer = null
  var pendingFetch = new Map()

  function bridgeRequest(path, body) {
    if (!config || !config.url)
      return Promise.reject(new Error("未配置 Bridge"))
    var url = config.url + path
    return new Promise(function (resolve, reject) {
      var done = false
      var timer = setTimeout(function () {
        if (!done) {
          done = true
          reject(new Error("Bridge 请求超时"))
        }
      }, 5000)
      var finish = function (fn, value) {
        if (done) return
        done = true
        clearTimeout(timer)
        fn(value)
      }
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: body ? "POST" : "GET",
          url: url,
          data: body ? JSON.stringify(body) : undefined,
          headers: {
            Authorization: "Bearer " + (config.secret || ""),
            "Content-Type": "application/json",
          },
          onload: function (r) {
            try {
              finish(resolve, JSON.parse(r.responseText))
            } catch (e) {
              finish(reject, e)
            }
          },
          onerror: function () {
            finish(reject, new Error("Bridge 网络错误"))
          },
        })
      } else {
        fetch(url, {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: "Bearer " + (config.secret || ""),
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        })
          .then(function (r) {
            return r.json()
          })
          .then(
            function (v) {
              finish(resolve, v)
            },
            function (e) {
              finish(reject, e)
            },
          )
      }
    })
  }

  function findRoot() {
    var app = document.querySelector("#q-app")
    return (
      app &&
      (app.__vue__ ||
        (app.__vueParentComponent && app.__vueParentComponent.proxy))
    )
  }
  function storeState() {
    var root = findRoot()
    return (root && root.$store && root.$store.state) || {}
  }
  function findValue(value, keys, depth) {
    if (!value || depth > 4 || typeof value !== "object") return undefined
    for (var i = 0; i < keys.length; i += 1)
      if (value[keys[i]] !== undefined) return value[keys[i]]
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        var found = findValue(value[key], keys, depth + 1)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  function getTrack() {
    var state = storeState()
    var track =
      findValue(state, ["currentTrack", "playingTrack", "track"], 0) || {}
    return {
      title: track.title || track.name || "",
      subtitle: track.subtitle || track.workTitle || "",
      hash: track.hash || track.trackHash || "",
      workId:
        track.workId || track.work_id || findValue(state, ["workId"], 0) || 0,
      trackIndex: track.trackIndex || track.index || 0,
    }
  }
  function findAudioElement() {
    var elements = Array.prototype.slice.call(
      document.querySelectorAll("audio,video"),
    )
    return (
      elements
        .filter(function (el) {
          return el.readyState > 0 || !el.paused
        })
        .sort(function (a, b) {
          return (
            Number(b === document.activeElement) -
            Number(a === document.activeElement)
          )
        })[0] ||
      elements[0] ||
      null
    )
  }
  function normalizedLines(value) {
    var rows = Array.isArray(value)
      ? value
      : (value &&
          (value.lrc || value.lines || (value.result && value.result.lrc))) ||
        []
    return rows
      .map(function (line) {
        return typeof line === "string"
          ? { time: 0, text: line }
          : {
              time: Number(line.time) || 0,
              timeEnd: Number.isFinite(Number(line.timeEnd))
                ? Number(line.timeEnd)
                : undefined,
              text: String(line.text || ""),
              extLrc: line.extLrc,
            }
      })
      .filter(function (line) {
        return line.text || line.time
      })
  }
  function getLinesFromStore() {
    var value = findValue(storeState(), ["lyricLines", "lyrics", "lrc"], 0)
    return normalizedLines(value)
  }
  function statePayload() {
    var track = getTrack()
    var el = audio || findAudioElement()
    return {
      sourceId: sourceId,
      currentTime: el ? Number(el.currentTime) || 0 : 0,
      duration: el ? Number(el.duration) || 0 : 0,
      playing: Boolean(el && !el.paused && !el.ended),
      paused: !el || el.paused,
      timestamp: performance.now(),
      at: Date.now(),
      track: track,
      workId: track.workId,
      trackIndex: track.trackIndex,
      title: document.title,
      lyricOffsetSeconds:
        Number(
          findValue(storeState(), ["lyricOffsetSeconds", "lyricOffset"], 0),
        ) || 0,
    }
  }
  function post(path, payload) {
    return bridgeRequest(
      path,
      Object.assign({ sourceId: sourceId }, payload || {}),
    ).catch(function () {})
  }
  function pushState(immediate) {
    var state = statePayload()
    var signature = JSON.stringify([
      state.currentTime.toFixed(2),
      state.playing,
      state.duration,
      state.track.hash,
      state.track.title,
    ])
    if (immediate || signature !== lastState) {
      lastState = signature
      post("/state", Object.assign({ kind: "state" }, state))
    }
    if (immediate) post("/timeSync", Object.assign({ kind: "timeSync" }, state))
  }
  function pushLines(lines) {
    lines = normalizedLines(lines)
    if (JSON.stringify(lines) === JSON.stringify(lastLines)) return
    lastLines = lines
    linesRev += 1
    post("/lines", {
      kind: "lines",
      lines: lines,
      linesRev: linesRev,
      currentLineNumber: -1,
    })
  }
  function installFetchObserver() {
    var pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window
    var originalFetch = pageWindow.fetch
    if (
      typeof originalFetch !== "function" ||
      originalFetch.__kikoeruLyricsObserver
    )
      return
    var wrapped = function () {
      var fetchArgs = arguments
      return originalFetch.apply(this, fetchArgs).then(function (response) {
        try {
          var requestUrl =
            typeof fetchArgs[0] === "string"
              ? fetchArgs[0]
              : (fetchArgs[0] && fetchArgs[0].url) || ""
          if (
            /\/api\/media\/(check-lrc|query-lrc|fetch-lrc)\//.test(requestUrl)
          ) {
            response
              .clone()
              .json()
              .then(function (value) {
                var rows =
                  value &&
                  (value.lrc ||
                    value.lines ||
                    (value.result && (value.result.lrc || value.result.lines)))
                if (rows) pushLines(rows)
              })
              .catch(function () {})
          }
        } catch (_err) {}
        return response
      })
    }
    wrapped.__kikoeruLyricsObserver = true
    pageWindow.fetch = wrapped
  }

  function handleCommand(command) {
    var ok = true
    var data = null
    var error = ""
    try {
      audio = findAudioElement()
      if (command.type === "seek" || command.type === "seekToLine") {
        var seconds = Number(command.seconds)
        if (command.type === "seekToLine")
          seconds =
            Number(lastLines[command.index] && lastLines[command.index].time) /
            1000
        if (audio && Number.isFinite(seconds))
          audio.currentTime = Math.max(0, seconds)
        pushState(true)
      } else if (
        command.type === "toggle" ||
        command.type === "TOGGLE_PLAYING"
      ) {
        if (audio) {
          if (audio.paused) audio.play()
          else audio.pause()
        }
      } else if (command.type === "play") {
        if (audio) audio.play()
      } else if (command.type === "pause") {
        if (audio) audio.pause()
      } else if (
        command.type === "previous" ||
        command.type === "PREVIOUS_TRACK"
      )
        dispatchPlayer([
          "AudioPlayer/PREVIOUS_TRACK",
          "audio/previous",
          "player/previous",
          "playback/previous",
          "previousTrack",
        ])
      else if (command.type === "next" || command.type === "NEXT_TRACK")
        dispatchPlayer([
          "AudioPlayer/NEXT_TRACK",
          "audio/next",
          "player/next",
          "playback/next",
          "nextTrack",
        ])
      else if (command.type === "requestSnapshot") {
        pushState(true)
        pushLines(getLinesFromStore())
      } else if (command.type === "setLyricLines") {
        pushLines(command.lines || [])
      } else if (command.type === "queryLyrics")
        data = pageFetchJson(
          "/api/media/query-lrc/" + encodeURIComponent(command.trackHash),
        )
      else if (command.type === "fetchLyrics")
        data = pageFetchJson("/api/media/fetch-lrc/" + command.pathPart)
      else if (command.type === "saveLyrics")
        data = pageFetchJson(
          "/api/media/save-lrc/" + encodeURIComponent(command.workId),
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              writePath: command.writePath,
              lrc: command.lines,
            }),
          },
        )
    } catch (e) {
      ok = false
      error = e.message
    }
    return Promise.resolve(data).then(
      function (result) {
        post("/command-result", {
          type: "commandResult",
          requestId: command.requestId,
          sourceId: sourceId,
          ok: ok,
          data: result,
          error: error,
        })
      },
      function (e) {
        post("/command-result", {
          type: "commandResult",
          requestId: command.requestId,
          sourceId: sourceId,
          ok: false,
          error: e.message,
        })
      },
    )
  }
  function pageFetchJson(url, options) {
    return fetch(
      url,
      Object.assign({ credentials: "include" }, options || {}),
    ).then(function (response) {
      if (!response.ok) throw new Error("Kikoeru API HTTP " + response.status)
      return response.json()
    })
  }
  function dispatchPlayer(actions) {
    var root = findRoot()
    var store = root && root.$store
    if (!store) return
    for (var i = 0; i < actions.length; i += 1) {
      var action = actions[i]
      try {
        // Kikoeru 播放器控制注册为 Vuex mutation，使用 commit 才能真正切换曲目。
        if (
          store._mutations &&
          store._mutations[action] &&
          typeof store.commit === "function"
        ) {
          store.commit(action)
          return
        }
        // 兼容旧版本中以 action 注册的控制命令。
        if (
          store._actions &&
          store._actions[action] &&
          typeof store.dispatch === "function"
        ) {
          var result = store.dispatch(action)
          if (result && typeof result.catch === "function")
            result.catch(function () {})
          return
        }
      } catch (_err) {}
    }
  }
  function connect() {
    if (!config || !config.url) return
    if (eventSource) eventSource.close()
    eventSource = new EventSource(
      config.url +
        "/events?sourceId=" +
        encodeURIComponent(sourceId) +
        "&secret=" +
        encodeURIComponent(config.secret || ""),
    )
    eventSource.onopen = function () {
      post("/source", { title: document.title, workTitle: getTrack().subtitle })
      pushState(true)
      pushLines(getLinesFromStore())
    }
    eventSource.addEventListener("command", function (event) {
      try {
        handleCommand(JSON.parse(event.data))
      } catch (_err) {}
    })
    eventSource.onerror = function () {
      eventSource.close()
      clearTimeout(retryTimer)
      retryTimer = setTimeout(connect, 1500)
    }
  }
  function observeAudio() {
    var next = findAudioElement()
    if (next === audio) return
    audio = next
    if (!audio) return
    ;[
      "play",
      "playing",
      "pause",
      "waiting",
      "seeked",
      "durationchange",
      "loadedmetadata",
      "emptied",
    ].forEach(function (name) {
      audio.addEventListener(name, function () {
        pushState(true)
      })
    })
  }
  setInterval(function () {
    observeAudio()
    pushState(false)
    pushLines(getLinesFromStore())
  }, 250)
  heartbeatTimer = setInterval(function () {
    post("/source", { title: document.title, workTitle: getTrack().subtitle })
  }, 5000)
  syncTimer = setInterval(function () {
    if (audio && !audio.paused)
      post("/timeSync", Object.assign({ kind: "timeSync" }, statePayload()))
  }, 500)
  window.addEventListener("beforeunload", function () {
    post("/source", { closed: true })
    if (eventSource) eventSource.close()
    clearInterval(heartbeatTimer)
    clearInterval(syncTimer)
  })
  installFetchObserver()
  connect()
})()
