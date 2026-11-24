# 极光 Aurora

飞牛 fnOS（ARM64）网页代理浏览器应用，Scramjet 内核。

- 外网浏览走 Scramjet（Service Worker + Epoxy/Wisp 通道），现代网站兼容性好
- 内网地址（局域网 IP、.local 等）走内置轻量直连代理，保留内网设备快捷访问
- 多标签页、书签、历史记录；服务端口 18920

## 注意

Scramjet 依赖 Service Worker，必须通过 **HTTPS**（或 localhost）打开应用；用 http 打开时会自动退回轻量直连内核。

## 构建

需要飞牛官方打包工具 fnpack，然后在源码根目录执行：

    ./build.sh

产物为 `dist/fn-browser-arm64.fpk`。构建会下载 ARM64 版 Node.js 运行时并安装服务端依赖（app/runtime 与 app/server/node_modules 不入库，见 .gitignore）。

内部 appname 保持 `fn-browser`（保证老版本覆盖升级），应用中心显示名为「极光」。

## 目录

- `cmd/` — 生命周期脚本（安装/启动/停止/状态）
- `config/` — 权限与资源声明
- `app/server/` — Node.js 服务端（Scramjet/Wisp + 轻量代理 + 书签/历史 API）
- `app/www/` — 前端页面与 Service Worker
- `app/ui/` — 飞牛桌面入口配置
