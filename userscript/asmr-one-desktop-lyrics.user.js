// ==UserScript==
// @name         ASMR.ONE Desktop Lyrics
// @namespace    asmr-one-desktop-lyrics
// @version      1.0.0
// @description  将 ASMR.ONE 播放器状态和歌词同步到 Electron 桌面歌词
// @match        https://asmr.one/*
// @match        https://www.asmr.one/*
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @author       ErrorRua
// ==/UserScript==

;(function () {
  "use strict"

  var BRIDGE_KEY = "asmr-one-desktop-lyrics-bridge"
  var SOURCE_KEY = "asmr-one-desktop-lyrics-source-id"

  var sourceId = sessionStorage.getItem(SOURCE_KEY)

  if (!sourceId) {
    sourceId =
      crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(16).slice(2)

    sessionStorage.setItem(SOURCE_KEY, sourceId)
  }

  var config = null

  try {
    config = JSON.parse(localStorage.getItem(BRIDGE_KEY) || "null")
  } catch (_err) {}

  function saveConfig() {
    var url = prompt(
      "请输入 Electron Bridge 地址",
      (config && config.url) || "http://127.0.0.1:18765",
    )

    if (!url) return

    var secret = prompt(
      "请输入 Bridge Secret（可留空）",
      (config && config.secret) || "",
    )

    if (secret === null) return

    config = {
      url: url.replace(/\/$/, ""),
      secret: secret,
    }

    localStorage.setItem(BRIDGE_KEY, JSON.stringify(config))

    connect()
  }

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("配置 Electron Bridge", saveConfig)
  }

  var eventSource = null
  var reconnectTimer = null

  var audio = null
  var lastState = ""
  var lastLines = ""
  var linesRev = 0
  var lastTrack = ""

  function store() {
    var app = document.querySelector("#q-app")
    return app && app.__vue__ && app.__vue__.$store
  }

  function playerState() {
    var s = store()
    return s && s.state.AudioPlayer
  }

  function currentFile() {
    var s = store()
    return s && s.getters["AudioPlayer/currentPlayingFile"]
  }

  function track() {
    var file = currentFile()

    if (!file) {
      return {
        title: "",
        subtitle: "",
        hash: "",
        workId: 0,
        trackIndex: 0,
      }
    }

    var state = playerState()
    var index = 0

    if (state && Array.isArray(state.queue)) {
      index = state.queue.indexOf(file)

      if (index < 0 && file.hash) {
        index = state.queue.findIndex(function (item) {
          return item && item.hash === file.hash
        })
      }

      if (index < 0) index = 0
    }

    return {
      title: file.title || "",
      subtitle: file.workTitle || "",
      hash: file.hash || "",
      workId: file.work && file.work.id ? Number(file.work.id) : 0,
      trackIndex: index,
    }
  }

  function lines() {
    var state = playerState()
    return state && Array.isArray(state.lrcLines) ? state.lrcLines : []
  }

  function currentLineIndex() {
    var state = playerState()
    return state ? Number(state.currentLrcLineIndex) : -1
  }

  function findAudio() {
    var list = Array.from(document.querySelectorAll("audio,video"))

    return (
      list.find(function (el) {
        return !el.paused && !el.ended
      }) ||
      list.find(function (el) {
        return el.readyState > 0
      }) ||
      list[0] ||
      null
    )
  }

  function statePayload() {
    audio = audio || findAudio()

    var t = track()

    return {
      sourceId: sourceId,
      site: "asmr.one",
      url: location.href,

      currentTime: audio ? Number(audio.currentTime) || 0 : 0,

      duration: audio ? Number(audio.duration) || 0 : 0,

      playing: Boolean(audio && !audio.paused && !audio.ended),

      paused: !audio || audio.paused,

      timestamp: performance.now(),
      at: Date.now(),

      track: t,
      workId: t.workId,
      trackIndex: t.trackIndex,

      title: document.title,

      lyricOffsetSeconds: 0,
      currentLyricIndex: currentLineIndex(),
    }
  }

  function request(path, body) {
    if (!config || !config.url) {
      return Promise.reject(new Error("未配置 Electron Bridge"))
    }

    return new Promise(function (resolve, reject) {
      var done = false

      var timer = setTimeout(function () {
        if (done) return
        done = true
        reject(new Error("Bridge 请求超时"))
      }, 5000)

      function finish(fn, value) {
        if (done) return
        done = true
        clearTimeout(timer)
        fn(value)
      }

      var options = {
        method: body ? "POST" : "GET",
        url: config.url + path,

        headers: {
          Authorization: "Bearer " + (config.secret || ""),

          "Content-Type": "application/json",
        },

        data: body ? JSON.stringify(body) : undefined,

        onload: function (r) {
          try {
            var value = JSON.parse(r.responseText)

            if (r.status >= 200 && r.status < 300) {
              finish(resolve, value)
            } else {
              finish(reject, new Error("Bridge HTTP " + r.status))
            }
          } catch (e) {
            finish(reject, e)
          }
        },

        onerror: function () {
          finish(reject, new Error("Bridge 网络错误"))
        },

        ontimeout: function () {
          finish(reject, new Error("Bridge 请求超时"))
        },
      }

      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest(options)
      } else {
        fetch(config.url + path, {
          method: options.method,
          headers: options.headers,
          body: options.data,
        })
          .then(function (r) {
            if (!r.ok) {
              throw new Error("Bridge HTTP " + r.status)
            }

            return r.json()
          })
          .then(
            function (value) {
              finish(resolve, value)
            },
            function (e) {
              finish(reject, e)
            },
          )
      }
    })
  }

  function post(path, data) {
    return request(
      path,
      Object.assign({ sourceId: sourceId }, data || {}),
    ).catch(function () {})
  }

  function pushSource() {
    var t = track()

    post("/source", {
      title: document.title,
      workTitle: t.subtitle,
      workId: t.workId,
      trackIndex: t.trackIndex,
      url: location.href,
      site: "asmr.one",
    })
  }

  function pushState(force) {
    var state = statePayload()

    var signature = JSON.stringify([
      state.currentTime.toFixed(2),
      state.playing,
      state.duration,
      state.track.hash,
      state.track.title,
      state.track.workId,
      state.track.trackIndex,
    ])

    if (!force && signature === lastState) {
      return
    }

    lastState = signature

    post("/state", Object.assign({ kind: "state" }, state))

    if (force) {
      post("/timeSync", Object.assign({ kind: "timeSync" }, state))
    }
  }

  function pushLines(force) {
    var data = lines()
    var signature = JSON.stringify(data)

    if (!force && signature === lastLines) {
      return
    }

    lastLines = signature
    linesRev += 1

    post("/lines", {
      kind: "lines",
      lines: data,
      linesRev: linesRev,
      currentLineNumber: currentLineIndex(),
    })
  }

  function result(command, ok, data, error) {
    post("/command-result", {
      type: "commandResult",
      requestId: command.requestId,
      ok: ok,
      data: data === undefined ? null : data,
      error: error || "",
    })
  }

  function commit(name) {
    var s = store()

    if (!s || !s.commit || !s._mutations || !s._mutations[name]) {
      return false
    }

    try {
      s.commit(name)
      return true
    } catch (_err) {
      return false
    }
  }

  function handleCommand(command) {
    try {
      audio = findAudio()

      switch (command.type) {
        case "seek": {
          var seconds = Number(command.seconds)

          if (!audio || !Number.isFinite(seconds)) {
            throw new Error("播放器不存在或时间无效")
          }

          audio.currentTime = Math.max(0, seconds)
          pushState(true)
          result(command, true, null, "")
          break
        }

        case "seekToLine": {
          var index = Number(command.index)
          var line = lines()[index]

          if (!Number.isInteger(index) || !line || !audio) {
            throw new Error("歌词行或播放器不存在")
          }

          audio.currentTime = Math.max(0, Number(line.time) / 1000)

          pushState(true)
          result(command, true, null, "")
          break
        }

        case "toggle":
        case "TOGGLE_PLAYING":
          if (!audio) {
            throw new Error("播放器不存在")
          }

          if (audio.paused) {
            var p = audio.play()

            if (p && p.catch) {
              p.catch(function () {})
            }
          } else {
            audio.pause()
          }

          pushState(true)
          result(command, true, null, "")
          break

        case "play": {
          if (!audio) {
            throw new Error("播放器不存在")
          }

          var playResult = audio.play()

          if (playResult && playResult.catch) {
            playResult.catch(function () {})
          }

          pushState(true)
          result(command, true, null, "")
          break
        }

        case "pause":
          if (!audio) {
            throw new Error("播放器不存在")
          }

          audio.pause()
          pushState(true)
          result(command, true, null, "")
          break

        case "previous":
        case "PREVIOUS_TRACK":
          if (!commit("AudioPlayer/PREVIOUS_TRACK")) {
            throw new Error("上一曲执行失败")
          }

          result(command, true, null, "")
          break

        case "next":
        case "NEXT_TRACK":
          if (!commit("AudioPlayer/NEXT_TRACK")) {
            throw new Error("下一曲执行失败")
          }

          result(command, true, null, "")
          break

        case "requestSnapshot":
          pushSource()
          pushState(true)
          pushLines(true)

          result(
            command,
            true,
            {
              state: statePayload(),
              lines: lines(),
            },
            "",
          )
          break

        case "setLyricLines":
          pushLines(true)
          result(command, true, null, "")
          break

        case "queryLyrics":
        case "fetchLyrics":
          result(
            command,
            true,
            {
              lrc: getLyricContent(),
              lines: lines(),
            },
            "",
          )
          break

        default:
          throw new Error("未知命令: " + command.type)
      }
    } catch (e) {
      result(command, false, null, e.message || String(e))
    }
  }

  function getLyricContent() {
    var s = store()

    return s && s.getters && s.getters["AudioPlayer/lyricContent"]
      ? String(s.getters["AudioPlayer/lyricContent"])
      : ""
  }

  function connect() {
    if (!config || !config.url) {
      return
    }

    if (eventSource) {
      try {
        eventSource.close()
      } catch (_err) {}

      eventSource = null
    }

    var url =
      config.url +
      "/events?sourceId=" +
      encodeURIComponent(sourceId) +
      "&secret=" +
      encodeURIComponent(config.secret || "")

    try {
      eventSource = new EventSource(url)
    } catch (_err) {
      reconnectTimer = setTimeout(connect, 1500)
      return
    }

    eventSource.onopen = function () {
      pushSource()
      pushState(true)
      pushLines(true)
    }

    eventSource.addEventListener("command", function (event) {
      try {
        handleCommand(JSON.parse(event.data))
      } catch (_err) {}
    })

    eventSource.onerror = function () {
      if (eventSource) {
        try {
          eventSource.close()
        } catch (_err) {}

        eventSource = null
      }

      clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(connect, 1500)
    }
  }

  function observeAudio() {
    var next = findAudio()

    if (!next || next === audio) {
      return
    }

    audio = next
    ;[
      "play",
      "playing",
      "pause",
      "waiting",
      "seeked",
      "durationchange",
      "loadedmetadata",
      "emptied",
      "ended",
    ].forEach(function (name) {
      audio.addEventListener(name, function () {
        pushState(true)
      })
    })

    pushState(true)
    pushLines(true)
  }

  function checkTrack() {
    var t = track()

    var signature = JSON.stringify([t.hash, t.title, t.workId, t.trackIndex])

    if (signature === lastTrack) {
      return
    }

    lastTrack = signature
    lastState = ""
    lastLines = ""

    pushSource()
    pushState(true)
    pushLines(true)
  }

  // 等待 ASMR.ONE 的 Vuex 初始化。
  function start() {
    if (!store()) {
      setTimeout(start, 250)
      return
    }

    console.log("[ASMR.ONE Desktop Lyrics] connected")

    observeAudio()
    checkTrack()
    connect()

    // 播放器和歌词会动态变化。
    setInterval(function () {
      observeAudio()
      checkTrack()
      pushState(false)
      pushLines(false)
    }, 250)

    // 心跳。
    setInterval(function () {
      pushSource()
    }, 5000)

    // 播放中的高频时间同步。
    setInterval(function () {
      if (audio && !audio.paused && !audio.ended) {
        post("/timeSync", Object.assign({ kind: "timeSync" }, statePayload()))
      }
    }, 500)
  }

  start()

  window.addEventListener("beforeunload", function () {
    post("/source", {
      closed: true,
    })

    if (eventSource) {
      try {
        eventSource.close()
      } catch (_err) {}
    }
  })
})()
