# 极光浏览器 Aurora

飞牛 fnOS 原生网页代理浏览器，提供 **ARM64** 与 **x86_64** 双架构 FPK。

- **外网主力内核**：Scramjet（Service Worker + Epoxy/Wisp），现代站点与视频兼容性最佳
- **内网直连兜底**：局域网 IP、`.local` 等走内置轻量直连代理，可访问路由器 / PVE 等自签名 HTTPS 设备
- **桌面级浏览体验**：多标签页、`Ctrl+Shift+T` 恢复关闭标签、书签/历史侧边栏、页内查找、线性 SVG 工具栏
- **Chrome 风格下载管理**：右上角独立下载气泡浮窗、网页下载接管、NAS 服务端直下、飞牛存储目录选择器
- **HTTPS 与自定义证书**：内置 `18921` HTTPS 入口，支持自动生成本地根 CA 或直接加载外部受信任证书；可选 `AUTH_TOKEN` 鉴权

## FnDepot 外部应用源

本项目已按 [EWEDLCM/FnDepot](https://github.com/EWEDLCM/FnDepot/) **V2 外部应用源规范** 提供根目录索引文件 [fnpack.json](https://github.com/huidegit2/Aurora-Browser/blob/main/fnpack.json)，可在 FnDepot 客户端中直接添加以下任一源地址：

- **GitHub 仓库源（推荐）**：
  ```text
  https://github.com/huidegit2/Aurora-Browser
  ```
- **`fnpack.json` 直链**：
  ```text
  https://raw.githubusercontent.com/huidegit2/Aurora-Browser/main/fnpack.json
  ```

## 内核与证书说明

| 内核 | 依赖 | 适用场景 | 状态 |
|------|------|----------|------|
| Scramjet | HTTPS + Service Worker | 外网现代站点 | 活跃维护，主力 |
| 轻量直连 | 仅 Node.js | 内网设备、HTTP 入口兜底 | 默认可用 |

Scramjet 依赖浏览器的安全上下文（受信任的 HTTPS 或 `http://localhost`）：

1. **已有域名证书（推荐）**：
   - 方式一：在飞牛「反向代理」中将你的 HTTPS 域名反代到 `http://127.0.0.1:18920`（需开启 WebSocket）；
   - 方式二：将证书与私钥放到应用数据目录 `tls/custom.crt.pem` 与 `tls/custom.key.pem`（或设置环境变量 `TLS_CERT_PATH` / `TLS_KEY_PATH`），重启应用即可让 `18921` 端口直接使用你的受信任证书，免装根证书。
2. **局域网 IP 访问**：使用 `18921` 端口并通过菜单「HTTPS 全功能」下载并信任本地根证书。

## NAS 下载与飞牛目录授权

- 点击工具栏下载按钮（或按 `Ctrl+J`）打开独立下载浮窗，支持直链下载到 NAS、实时进度与速度显示、取消、重试、取回本地及删文件。
- 默认下载到应用数据目录 `downloads/`；点击「更改」可浏览飞牛存储目录或直接输入路径。
- 如需写入 `/vol1/...` 等共享文件夹，请在飞牛 **系统设置 -> 应用 -> 极光浏览器 -> 文件夹权限** 中授权目标目录。

## 构建

```bash
./build.sh arm   # -> dist/fn-browser-arm64.fpk   (manifest platform = arm)
./build.sh x86   # -> dist/fn-browser-x86_64.fpk  (manifest platform = x86)
```

内部 `appname` 固定为 `fn-browser`，保证老版本覆盖升级；应用中心显示名为「极光浏览器」。

## 自动构建与发布

推送 `v*` 标签，或在 Actions 页面手动触发 **Build and Release FPK**：

- 自动构建 arm64 与 x86_64 两个 FPK
- 从 `CHANGELOG.md` 对应版本段落提取更新日志
- 创建 GitHub Release 并上传两个安装包
- 自动计算 SHA256 与文件大小并同步更新根目录 `fnpack.json`

## 鉴权（建议）

在应用运行环境设置 `AUTH_TOKEN` 后，`/api/*`、`/lite-proxy/*` 和 `/wisp/` 都需要鉴权。访问外壳时带上一次 token：

```text
https://<nas>:18921/?_aurora_token=<your-token>
```

前端会把它缓存到 `sessionStorage`，后续请求自动携带。不设置 `AUTH_TOKEN` 时保持内网开箱即用，**公网暴露时必须设置**。

## 目录

- `fnpack.json` — FnDepot V2 外部应用源索引
- `cmd/` — 生命周期脚本（安装/启动/停止/状态）
- `config/` — 权限与资源声明
- `wizard/` — fnpack 预检所需目录
- `app/server/` — Node.js 服务端（Scramjet/Wisp + 轻量代理 + 下载/文件 API）
- `app/www/` — 前端页面与 Service Worker
- `app/ui/` — 飞牛桌面入口配置与图标
- `assets/icon.svg` — 图标矢量设计源
- `scripts/` — 图标生成、更新日志提取
- `.github/workflows/release.yml` — 自动构建与发布

## 许可

本项目代码未声明许可证。捆绑的 Scramjet / epoxy-transport 为 AGPL-3.0，wisp-js 为 LGPL-3.0-or-later；分发 FPK 时请履行对应开源义务。
