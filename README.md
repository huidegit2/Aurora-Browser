# 极光 Aurora

飞牛 fnOS 原生网页代理浏览器，提供 **ARM64** 与 **x86_64** 双架构 FPK。

- 外网：优先 Scramjet（Service Worker + Epoxy/Wisp），现代站点兼容性好
- 内网：局域网 IP、`.local` 等走内置轻量直连代理，可访问路由器 / PVE 等自签名 HTTPS 设备
- 多标签页、书签、历史记录、深浅主题；服务端口 18920
- 可选 `AUTH_TOKEN` 鉴权，避免代理端点被公网滥用

## 内核选择

| 内核 | 依赖 | 适用场景 | 状态 |
|------|------|----------|------|
| Scramjet | HTTPS + Service Worker | 外网现代站点 | 活跃维护，推荐 |
| 轻量直连 | 仅 Node.js | 内网设备、HTTP 入口的兜底 | 默认可用，HTML 重写有上限 |
| Ultraviolet | HTTPS + Service Worker | 旧方案 | 已停止维护，不采用 |
| Rammerhead | Node.js 服务端 + 会话 | 匿名会话浏览 | 不适合 NAS 内网访问 |

飞牛桌面入口默认走 **HTTP**，此时 `crossOriginIsolated` 不可用，Scramjet 会自动回退到轻量内核。要用完整 Scramjet，请为 18920 端口配置 HTTPS 反向代理后用 HTTPS 打开。

轻量内核参考了开源项目 [OWU](https://github.com/TypeThe0ry/OWU)（MIT）的设计：剥离凭证头、限制目标协议、不回显内部错误。它仍是正则级 HTML 重写，不处理 `srcset`、JS 动态拼接 URL 和 WebSocket——复杂站点会碎，这是兜底内核的固有上限。

## 构建

```bash
./build.sh arm   # -> dist/fn-browser-arm64.fpk   (manifest platform = arm)
./build.sh x86   # -> dist/fn-browser-x86_64.fpk  (manifest platform = x86)
```

构建脚本会：生成四张必需图标 → 下载目标架构 Node.js 运行时 → `npm ci --omit=dev --omit=optional`（跳过 native 包，保证跨架构可用）→ 按构建主机架构下载 fnpack → 在隔离目录改 `platform`/`version` 后打包。

内部 `appname` 固定为 `fn-browser`，保证老版本覆盖升级；应用中心显示名为「极光」。

图标唯一来源是 `assets/icon.svg`（定稿的极光球，内嵌 256×256 PNG）。`scripts/generate_icons.py` 从 SVG 提取原图并生成四张入库 PNG（纯标准库，可复现，不依赖渲染器）：`ICON.PNG` 64×64、`ICON_256.PNG` 256×256、`app/ui/images/icon_64.png`、`icon_256.png`。改图标只需替换 SVG 内嵌的 256×256 PNG，然后运行 `python3 scripts/generate_icons.py`，不要手改生成的 PNG。fnpack 会在打包前强制校验这四个 PNG 以及 `cmd/`、`config/`、`wizard/` 目录。

## 自动构建与发布

推送 `v*` 标签，或在 Actions 页面手动触发 **Build and Release FPK**：

- 自动构建 arm64 与 x86_64 两个 FPK
- 从 `CHANGELOG.md` 对应版本段落提取更新日志
- 创建 GitHub Release 并上传两个安装包

手动触发可填 `version`，并勾选 `dry_run` 只构建验证、不创建 Release。版本号取自 `manifest`，构建脚本会覆盖为触发时指定的版本。

## 鉴权（建议）

在应用运行环境设置 `AUTH_TOKEN` 后，`/api/*`、`/lite-proxy/*` 和 `/wisp/` 都需要鉴权。访问外壳时带上一次 token：

```
https://<nas>:18920/?_aurora_token=<your-token>
```

前端会把它缓存到 `sessionStorage`，后续请求自动携带。不设置 `AUTH_TOKEN` 时保持内网开箱即用，但任何能访问 18920 端口的人都能使用代理——**公网暴露时必须设置**。

## 目录

- `cmd/` — 生命周期脚本（安装/启动/停止/状态）
- `config/` — 权限与资源声明
- `wizard/` — fnpack 预检所需目录
- `app/server/` — Node.js 服务端（Scramjet/Wisp + 轻量代理 + 书签/历史 API）
- `app/www/` — 前端页面与 Service Worker
- `app/ui/` — 飞牛桌面入口配置与图标
- `assets/icon.svg` — 图标矢量设计源
- `scripts/` — 图标生成、更新日志提取
- `.github/workflows/release.yml` — 自动构建与发布

## 许可

本项目代码未声明许可证。捆绑的 Scramjet / epoxy-transport 为 AGPL-3.0，wisp-js 为 LGPL-3.0-or-later；分发 FPK 时请履行对应开源义务。
