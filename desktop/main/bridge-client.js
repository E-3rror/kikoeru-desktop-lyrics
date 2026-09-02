"use strict";

const { EventEmitter } = require("events");
const bridgeServer = require("./bridge-server");

const COMMAND_TIMEOUT_MS = 8000;

function emptySource(sourceId) {
  return { sourceId, state: null, lines: [], linesRev: -1, timeSync: null, selectOpen: false, title: "", workTitle: "" };
}

class BridgeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.sources = new Map();
    this.activeSourceId = null;
    this.peers = { sources: 0, clients: 1, sourceList: [] };
    this.lyricsOpen = false;
    this.pending = new Map();
    this.started = false;
    this.onServerSource = this.onServerSource.bind(this);
    this.onServerGone = this.onServerGone.bind(this);
    this.onServerData = this.onServerData.bind(this);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    bridgeServer.on("source", this.onServerSource);
    bridgeServer.on("sourceGone", this.onServerGone);
    for (const event of ["state", "lines", "timeSync", "command-result"]) bridgeServer.on(event, this.onServerData);
    try {
      const info = await bridgeServer.start();
      this.info = info;
      console.log(`[bridge] listening on http://${info.host}:${info.port}; secret=${info.secret}`);
      this.connected = true;
      this.emit("connection", { connected: true, reason: "本地 Bridge 已启动", info });
    } catch (err) {
      this.connected = false;
      this.emit("connection", { connected: false, reason: err.message });
    }
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    bridgeServer.removeListener("source", this.onServerSource);
    bridgeServer.removeListener("sourceGone", this.onServerGone);
    for (const event of ["state", "lines", "timeSync", "command-result"]) bridgeServer.removeListener(event, this.onServerData);
    await bridgeServer.stop();
    this.connected = false;
    this.sources.clear();
    this.activeSourceId = null;
    for (const pending of this.pending.values()) pending.reject(new Error("Bridge 已关闭"));
    this.pending.clear();
    this.emit("connection", { connected: false, reason: "Bridge 已关闭" });
  }

  onServerSource(data) {
    const slot = this.ensureSource(data.sourceId);
    Object.assign(slot, { title: data.title || "", workTitle: data.workTitle || "" });
    this.recomputeActive();
    this.emit("peers", this.peerSnapshot());
    this.emit("snapshot");
  }

  onServerGone(data) {
    if (!data || !data.sourceId) return;
    this.sources.delete(data.sourceId);
    if (this.activeSourceId === data.sourceId) this.activeSourceId = null;
    this.emit("sourceGone", data);
    this.emit("peers", this.peerSnapshot());
  }

  onServerData(data) {
    if (!data || typeof data !== "object") return;
    if (data.type === "commandResult" || data.requestId) {
      const pending = this.pending.get(data.requestId);
      if (pending) {
        this.pending.delete(data.requestId);
        if (data.ok === false) pending.reject(new Error(data.error || "命令失败"));
        else pending.resolve(data);
      }
      return;
    }
    const slot = this.ensureSource(data.sourceId);
    if (!slot) return;
    const eventName = data.kind || data.type;
    if (eventName === "state") {
      slot.state = data.state || data;
      this.emit("state", data.state || data);
    } else if (eventName === "lines") {
      slot.lines = data.lines || [];
      slot.linesRev = Number.isFinite(data.linesRev) ? data.linesRev : slot.linesRev + 1;
      this.emit("lines", data);
    } else if (eventName === "timeSync") {
      slot.timeSync = data;
      if (slot.state) Object.assign(slot.state, { playing: data.playing, currentTime: data.currentTime });
      this.emit("timeSync", data);
    }
    this.recomputeActive();
  }

  ensureSource(sourceId) {
    if (!sourceId || typeof sourceId !== "string") return null;
    if (!this.sources.has(sourceId)) this.sources.set(sourceId, emptySource(sourceId));
    return this.sources.get(sourceId);
  }

  getSource(sourceId) { return sourceId ? this.sources.get(sourceId) || null : null; }
  getActive() { return this.getSource(this.activeSourceId); }
  listSources() { return Array.from(this.sources.values()); }
  recomputeActive() {
    const previous = this.activeSourceId;
    const playing = this.listSources().filter((slot) => slot.state && slot.state.playing);
    this.activeSourceId = playing[0] ? playing[0].sourceId : (this.listSources()[0] ? this.listSources()[0].sourceId : null);
    if (previous !== this.activeSourceId) this.emit("activeSource", { sourceId: this.activeSourceId, state: this.getActive() ? this.getActive().state : null });
  }

  peerSnapshot() {
    const sourceList = this.listSources().map((s) => ({ sourceId: s.sourceId, title: s.title, workTitle: s.workTitle }));
    this.peers = { sources: sourceList.length, clients: 1, sourceList };
    return Object.assign({}, this.peers, { activeSourceId: this.activeSourceId });
  }

  sendCommand(command, targetSourceId) {
    const sourceId = targetSourceId || this.activeSourceId;
    if (!sourceId) return Promise.reject(new Error("没有可用的网页音源"));
    const requestId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const payload = Object.assign({}, command, { requestId, sourceId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("网页端命令超时")); }, COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (err) => { clearTimeout(timer); reject(err); } });
      try { bridgeServer.send(sourceId, "command", payload); } catch (err) { clearTimeout(timer); this.pending.delete(requestId); reject(err); }
    });
  }

  hasSource() { return this.sources.size > 0; }
  getInfo() { return bridgeServer.currentConfig(); }
  reconfigure(port, secret) { return bridgeServer.reconfigure(port, secret); }
}

module.exports = new BridgeClient();
