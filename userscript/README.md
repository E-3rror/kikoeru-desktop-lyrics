# 非侵入式桌面歌词 Userscript

浏览器侧 Adapter：只在目标站点页面中读取播放器状态与歌词，并通过本机 Bridge 发送给 Electron；不注入歌词窗口、不修改站点源码、不读取服务端配置。

目录中包含两份脚本，共用同一个 Bridge 协议和同一个桌面端：

| 脚本                              | 站点     | `@match`                                       | 歌词来源                                  | 歌词写入 |
| --------------------------------- | -------- | ---------------------------------------------- | ----------------------------------------- | -------- |
| `kikoeru-desktop-lyrics.user.js`  | Kikoeru  | `http://127.0.0.1:8888/*`                      | 旁路包装页面 `fetch`，观察 `*-lrc` 接口   | 支持     |
| `asmr-one-desktop-lyrics.user.js` | ASMR.ONE | `https://asmr.one/*`、`https://www.asmr.one/*` | 直接读取页面 Vuex 的 `AudioPlayer` 模块   | 不支持   |

两份脚本的 `localStorage` / `sessionStorage` 键名互相独立（`kikoeru-desktop-lyrics-*` 与 `asmr-one-desktop-lyrics-*`），可以同时安装，各自配置一次 Bridge，各标签页生成独立 `sourceId`。

## 安装与连接

1. 在 Tampermonkey/Violentmonkey 中安装对应站点的脚本。Kikoeru 脚本需要把 `@match` 收窄为自己的 Kikoeru 地址；ASMR.ONE 脚本通常无需修改。
2. 启动 Electron 桌面程序。程序默认在 `127.0.0.1:18765` 启动 Bridge，并将端口和 secret 持久化到 Electron `userData/bridge.json`；后续启动会复用同一配置。
3. 在脚本管理器菜单执行「配置 Electron Bridge」，填写 `http://127.0.0.1:<端口>` 与 secret（可为空）。配置保存在当前站点的 `localStorage`。

打包版没有控制台时，可从 Electron 托盘菜单打开「Bridge 设置」查看当前端口和 secret，也可以修改并保存。保存后 Bridge 会自动重启。

脚本会自动保持 SSE 连接、每 5 秒发送 source 心跳；Electron 或网页任一方重启后会自动重连。Electron 未运行或未配置时，脚本静默退出，不影响站点播放。桌面端可用环境变量 `DESKTOP_LYRICS_PORT`、`DESKTOP_LYRICS_SECRET` 覆盖默认配置。

## 协议与权限

Electron Bridge 仅绑定回环地址，请求使用可选 secret 鉴权；Bridge 的 CORS 会回显请求来源，因此 HTTPS 页面（ASMR.ONE）同样可以访问回环地址上的 Bridge。命令通过 SSE (`/events`) 下发，状态、歌词和命令结果通过 `POST` 回传。

歌词选择、获取和保存命令均带 `requestId`，超时或站点返回错误会明确反馈给选择窗口。多标签页分别对应不同 source，悬浮歌词使用当前正在播放的 active source。

### Kikoeru 适配

Userscript 通过页面自身的 `fetch`、cookie 和登录身份调用现有 `/api/media/check-lrc`、`query-lrc`、`fetch-lrc`、`save-lrc` 接口，Electron 不保存或转发 Kikoeru JWT。支持完整的歌词文件列表、切换和保存流程。

### ASMR.ONE 适配

脚本从 `#q-app` 的 Vuex store 读取 `AudioPlayer` 状态：`lrcLines`（歌词行）、`currentLrcLineIndex`（当前行）、getter `currentPlayingFile`（曲目信息）和 `lyricContent`（歌词文本）。播放控制直接作用于页面的 `<audio>/<video>` 元素，上一曲/下一曲通过 `commit("AudioPlayer/PREVIOUS_TRACK" / "AudioPlayer/NEXT_TRACK")` 触发。

因此该站点下：

- `queryLyrics` / `fetchLyrics` 返回页面当前已加载的歌词，而不是可选歌词文件列表。
- 不实现 `saveLyrics`，歌词选择窗口中的保存会返回“未知命令: saveLyrics”。请把它当作只读的查看与定位工具。
- 站点自身没有加载出歌词的曲目，桌面端也不会有歌词。

脚本启动时会等待 Vuex 初始化后再连接；如果 ASMR.ONE 前端结构发生变化（store 路径或字段改名），需要同步更新这些读取逻辑。
