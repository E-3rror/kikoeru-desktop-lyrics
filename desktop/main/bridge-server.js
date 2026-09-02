"use strict";

const http = require("http");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 18765;
const CONFIG_FILE = "bridge.json";
const SOURCE_TTL_MS = 20000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(res, status, value, origin) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", origin || "null");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.end(body);
}

class BridgeServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.port = null;
    this.config = null;
    this.secret = "";
    this.sources = new Map();
    this.timer = null;
  }

  info() {
    return { host: HOST, port: this.port, secret: this.secret, version: 1 };
  }

  start() {
    if (this.server) return Promise.resolve(this.info());
    this.loadConfig();
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        this.port = null;
        reject(err);
      };
      this.server.once("error", onError);
      this.server.listen(this.config.port, HOST, () => {
        this.server.removeListener("error", onError);
        this.port = this.server.address().port;
        this.saveConfig();
        this.timer = setInterval(() => this.expireSources(), 5000);
        if (this.timer.unref) this.timer.unref();
        this.emit("started", this.info());
        resolve(this.info());
      });
    });
  }

  configPath() {
    try {
      const { app } = require("electron");
      return require("path").join(app.getPath("userData"), CONFIG_FILE);
    } catch (_err) {
      return null;
    }
  }

  loadConfig() {
    let stored = {};
    const file = this.configPath();
    if (file) {
      try { stored = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch (_err) { stored = {}; }
    }
    const envPort = Number.parseInt(process.env.DESKTOP_LYRICS_PORT, 10);
    const envSecret = process.env.DESKTOP_LYRICS_SECRET;
    this.config = {
      port: Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : (Number(stored.port) || DEFAULT_PORT),
      secret: typeof envSecret === "string" ? envSecret : (typeof stored.secret === "string" ? stored.secret : ""),
    };
    this.secret = this.config.secret;
  }

  saveConfig() {
    const file = this.configPath();
    if (!file) return;
    try {
      const fs = require("fs");
      fs.mkdirSync(require("path").dirname(file), { recursive: true });
      // 重启重配置时 server 会先停止并清空 this.port, 此时要保存待启动配置中的端口。
      const port = this.port || (this.config && this.config.port) || DEFAULT_PORT;
      fs.writeFileSync(file, JSON.stringify({ host: HOST, port, secret: this.secret, version: 1 }, null, 2), "utf8");
    } catch (err) {
      this.emit("warning", `写入 Bridge 配置失败: ${err.message}`);
    }
  }

  currentConfig() {
    return { host: HOST, port: this.port || (this.config && this.config.port) || DEFAULT_PORT, secret: this.secret, version: 1 };
  }

  async reconfigure(port, secret) {
    const nextPort = Number.parseInt(port, 10);
    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) throw new Error("端口必须是 1-65535 之间的整数");
    if (typeof secret !== "string") throw new Error("Secret 必须是字符串");
    const wasRunning = Boolean(this.server);
    if (wasRunning) await this.stop();
    this.config = { port: nextPort, secret };
    this.secret = secret;
    if (!wasRunning) {
      this.saveConfig();
      return this.currentConfig();
    }
    this.saveConfig();
    await this.start();
    return this.currentConfig();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const source of this.sources.values()) {
      if (source.res) source.res.end();
    }
    this.sources.clear();
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    this.port = null;
    return new Promise((resolve) => server.close(() => resolve()));
  }

  authorized(req) {
    const header = String(req.headers.authorization || "");
    if (this.secret === "") return true;
    const querySecret = new URL(req.url, `http://${HOST}`).searchParams.get("secret");
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-bridge-secret"] || querySecret;
    return typeof supplied === "string" && supplied === this.secret;
  }

  validOrigin(req) {
    const origin = req.headers.origin;
    return !origin || origin === "null" || /^https?:\/\//i.test(origin);
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) {
          reject(new Error("请求体过大"));
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (_err) {
          reject(new Error("JSON 格式无效"));
        }
      });
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const origin = req.headers.origin || "null";
    if (req.method === "OPTIONS") return json(res, 204, {}, origin);
    if (!this.validOrigin(req)) return json(res, 403, { ok: false, error: "来源不被允许" }, origin);
    const url = new URL(req.url, `http://${HOST}`);
    if (req.method === "GET" && url.pathname === "/info") {
      return json(res, 200, { ok: true, bridge: this.info() }, origin);
    }
    if (!this.authorized(req)) return json(res, 401, { ok: false, error: "Bridge secret 无效" }, origin);
    if (req.method === "GET" && url.pathname === "/events") return this.openEvents(req, res, url);
    if (req.method !== "POST") return json(res, 404, { ok: false, error: "路径不存在" }, origin);
    try {
      const body = await this.readBody(req);
      if (url.pathname === "/source") this.registerSource(body, origin);
      else if (url.pathname === "/state" || url.pathname === "/lines" || url.pathname === "/timeSync") { this.touchSource(body); this.emit(url.pathname.slice(1), body); }
      else if (url.pathname === "/command-result") this.emit("command-result", body);
      else return json(res, 404, { ok: false, error: "路径不存在" }, origin);
      return json(res, 200, { ok: true }, origin);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message }, origin);
    }
  }

  openEvents(req, res, url) {
    const sourceId = url.searchParams.get("sourceId");
    if (!sourceId) return json(res, 400, { ok: false, error: "缺少 sourceId" }, req.headers.origin || "null");
    const source = this.sources.get(sourceId) || { sourceId };
    if (source.res) source.res.end();
    source.res = res;
    source.lastSeen = Date.now();
    this.sources.set(sourceId, source);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "null");
    res.write(": connected\n\n");
    req.on("close", () => {
      if (source.res === res) source.res = null;
      source.lastSeen = Date.now();
    });
  }

  registerSource(data, origin) {
    if (!data || typeof data.sourceId !== "string" || !/^[0-9a-f-]{16,}$/i.test(data.sourceId)) throw new Error("sourceId 无效");
    const source = this.sources.get(data.sourceId) || { sourceId: data.sourceId };
    if (data.closed) {
      if (source.res) source.res.end();
      this.sources.delete(data.sourceId);
      this.emit("sourceGone", { sourceId: data.sourceId });
      return;
    }
    Object.assign(source, { title: data.title || "", workTitle: data.workTitle || "", lastSeen: Date.now(), origin });
    this.sources.set(data.sourceId, source);
    this.emit("source", { sourceId: data.sourceId, title: source.title, workTitle: source.workTitle });
  }

  touchSource(data) {
    if (!data || typeof data.sourceId !== "string") throw new Error("sourceId 无效");
    const source = this.sources.get(data.sourceId) || { sourceId: data.sourceId };
    source.lastSeen = Date.now();
    this.sources.set(data.sourceId, source);
  }

  send(sourceId, event, data) {
    const source = this.sources.get(sourceId);
    if (!source || !source.res) throw new Error("网页端未连接");
    source.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  expireSources() {
    const now = Date.now();
    for (const [sourceId, source] of this.sources) {
      if (now - (source.lastSeen || 0) > SOURCE_TTL_MS) {
        if (source.res) source.res.end();
        this.sources.delete(sourceId);
        this.emit("sourceGone", { sourceId });
      }
    }
  }
}

module.exports = new BridgeServer();
