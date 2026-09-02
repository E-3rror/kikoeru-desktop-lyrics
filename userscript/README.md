# Kikoeru 非侵入式桌面歌词 Userscript

`kikoeru-desktop-lyrics.user.js` 是浏览器侧 Adapter。它只在 Kikoeru 页面中读取 `<audio>/<video>`、旁路观察歌词 API，并通过本机 Bridge 将数据发送给 Electron；不会注入歌词窗口、修改 Kikoeru 源码或读取服务端配置。

## 安装与连接

1. 在 Tampermonkey/Violentmonkey 中安装脚本，并把 `@match` 收窄为自己的 Kikoeru 地址。
2. 启动 Electron 桌面程序。程序默认在 `127.0.0.1:18765` 启动 Bridge，并将端口和 secret 持久化到 Electron `userData/bridge.json`；后续启动会复用同一配置。
3. 在脚本管理器菜单执行「配置 Electron Bridge」，填写 `http://127.0.0.1:<端口>` 与 secret（可为空）。配置保存在当前站点的 `localStorage`，每个标签页会生成独立 `sourceId`。

打包版没有控制台时，可从 Electron 托盘菜单打开「Bridge 设置」查看当前端口和 secret，也可以修改并保存。保存后 Bridge 会自动重启。

脚本会自动保持 SSE 连接、每 5 秒发送 source 心跳；Electron 或网页任一方重启后会自动重连。Electron 未运行或未配置时，脚本静默退出，不影响 Kikoeru 播放。可用环境变量 `DESKTOP_LYRICS_PORT`、`DESKTOP_LYRICS_SECRET` 覆盖默认配置。

## 协议与权限

Electron Bridge 仅绑定回环地址，请求使用可选 secret 鉴权。Userscript 通过页面自身的 `fetch`、cookie 和登录身份调用现有 `/api/media/check-lrc`、`query-lrc`、`fetch-lrc`、`save-lrc` 接口，Electron 不保存或转发 Kikoeru JWT。

歌词选择、获取和保存命令均带 `requestId`，超时或 Kikoeru 返回错误会明确反馈给选择窗口。多标签页分别对应不同 source，悬浮歌词使用当前正在播放的 active source。
