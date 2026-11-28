# 更新日志

## [1.0.25] - 2026-11-28

### 使用说明

- 将首次 HTTPS 连接和证书指引整理到安装包的应用介绍中；安装或升级后，可直接在 fnOS 应用中心查看。
- 补充不依赖应用界面的局域网证书下载地址，以及 Windows、Android、iPhone/iPad 的信任步骤；同步 FnDepot 应用源介绍。
- 说明 iOS 安装描述文件后还需开启根证书完全信任，飞牛 App 内置页面可能采用不同信任策略。
- 重写 README、实施与验证记录，新增连接排障、开发测试与自动发布指南；补记 v1.0.24 改动并修复历史日志中的本地文件链接。

本版本更新应用介绍与文档，不改变代理或下载行为。新介绍需要安装或升级新版 FPK；真机上的介绍排版、证书信任和手机兼容性仍待验证。

## [1.0.24] - 2026-11-27

### 修复

- 认证失败、超时或响应异常时提供错误提示和重试；书签、历史、设置或代理初始化失败不再阻断主页创建。
- 为连续导航绑定序号与帧归属，拒绝过时页面通知覆盖当前地址和加载状态；关闭标签、返回主页或切换代理时释放帧、监听和计时器。
- 下载增加连接/响应与无数据超时，处理半截响应、网络中断、取消和非法部分响应，任务终态只处理一次。
- 排他创建下载临时文件；启动恢复或结束写入遇到磁盘满、权限错误时，先在当前进程内保留终态，避免阻断应用启动。

### 安全与兼容变化

- 基础代理增加 iframe 与响应 CSP 沙箱，清理代理凭证及影响管理页面状态的上游头。
- 管理 API、WebSocket 与代理帧消息增加来源和归属检查；管理响应不缓存，畸形 Cookie 不再导致请求崩溃。
- 基础代理与 NAS 下载恢复 Node 默认目标 TLS 校验，取代旧版本跳过校验的行为。自签名目标需配置正确证书或受信 CA；详见[目标证书排障](docs/TROUBLESHOOTING.md#目标网站的-https-证书报错)。
- 访问密码在设置保存成功后生效。密码仍为可选，尚无强制首次设置或完整多用户隔离。

### 构建与验证

- 主分支代码推送支持自动计算版本、同步包内元数据、发布双架构 FPK，并校验写回 FnDepot 索引。
- 增加版本冲突和重跑检查，Markdown 或应用源单独更新不再触发新一轮发布。
- 66 项 Node 回归、11 项 Python 版本逻辑回归及双架构构建通过。完整证据与真机验证边界见[实施记录](IMPLEMENTATION-NOTES.md)。

下载失败重试仍为重新下载，不支持 Range 续传；手机白屏和实际 fnOS 安装效果尚未完成本轮真机验收。

## [1.0.23] - 2026-11-25

### 修复

- **彻底解决首次访问内核误跳轻量、刷新才恢复的 Bug**：
  - [sw.js](app/www/sw.js) 新增 `skipWaiting()` 与 `clients.claim()`，安装后免刷新立即接管页面；
  - `navigateTab()` 在安全上下文下会等待 Scramjet 启动完成再分流内核，杜绝抢跑回退。
- **修复地址栏交互 Bug 并新增桌面级行内自动补齐**：支持点击全选、Chrome 同款历史/书签行内自动补全、中文输入法组词防抖及方向键预览。

### 新增

- **标签页右键菜单与加载动画**：右键标签页支持刷新、复制、关闭其他/右侧标签与恢复关闭页；加载网页时标签图标位显示旋转动画。
- **地址栏左侧安全状态图标**：实时显示 HTTPS / Scramjet / 轻量内核状态，点击直达连接自检。

## [1.0.22] - 2026-11-25

### 修复

- **彻底修复轻量代理红 🚫 拦截**：在 `/lite-proxy/*` 响应头中补齐 `Cross-Origin-Embedder-Policy: credentialless`，解决 Edge/Chrome 下内嵌 `iframe` 被 `ERR_BLOCKED_BY_RESPONSE` 拦截的问题。
- **支持 `192.168.1.1` 等内网设备走 Scramjet 满血内核**：为 Wisp 开启 `allow_private_ips`，`http://` 内网设备（如路由器/爱快/OpenWrt）可直接使用 Scramjet 完整渲染与登录；`https://` 自签内网设备（如 PVE）保留走轻量直连跳过证书校验。

## [1.0.21] - 2026-11-25

### 优化

- **菜单二级化与独立「设置」中心**：精简右上角主菜单为常用高频操作，新增二级「设置」弹窗，将搜索引擎、界面主题（跟随系统/浅色/深色）、访问密码保护、NAS 下载目录设置、HTTPS 证书下载与连接自检统一收纳其中。

## [1.0.20] - 2026-11-25

### 新增

- **界面内设置访问密码**：在主菜单直接设置/关闭访问密码（持久化到 `settings.json`），开启后未登录访问自动弹出密码解锁界面，防止公网 DDNS IPv6 暴露时被未授权利用；同时保留 `AUTH_TOKEN` 环境变量最高优先级锁定。

## [1.0.19] - 2026-11-25

### 新增

- **连接自检面板与 `/healthz`**：主菜单新增「连接自检」，一键诊断安全上下文、Service Worker、HTTPS/证书连通性与 `/wisp/` WebSocket 通道。
- **鉴权安全加固**：访问携带的 `?_aurora_token=` 参数读取后立即从地址栏清除，并新增 `POST /api/auth/session` 交换 `HttpOnly` 会话 Cookie。

### 优化

- **服务端模块化重构**：将 `app/server/index.js` 拆分为 `storage.js`、`tls.js`、`downloads.js`、`lite-proxy.js`，提升可维护性。
- **fnOS 权限与日志加固**：权限不足返回明确错误码 `EACCES_SHARE_PATH`；`cmd/main` 启动前自动轮转超过 5 MB 的运行日志。
- **CI/CD 与开源规范**：`release.yml` 增加静态语法/JSON 校验与 `npm` 缓存，`extract_changelog.py` 未匹配段落时自动回退读取 `git log`；补充 `AGPL-3.0` `LICENSE` 与 `.github/dependabot.yml`。

## [1.0.18] - 2026-11-25

### 修复

- 同步提交 `COEP: credentialless` 与轻量代理响应头清洗修复，彻底解决 `ERR_BLOCKED_BY_RESPONSE` 红叉拦截问题。

## [1.0.17] - 2026-11-25

### 修复

- 修复轻量直连内核与部分站点在 `iframe` 内加载时触发 `ERR_BLOCKED_BY_RESPONSE`（页面显示红色禁止图标 🚫）的问题：将外壳 `Cross-Origin-Embedder-Policy` 调整为 `credentialless`，并在轻量代理响应中剥离上游 `cross-origin-*` 限制头、补充 `Cross-Origin-Resource-Policy: cross-origin`。

## [1.0.16] - 2026-11-25

### 新增

- Chrome 风格独立下载气泡浮窗：将下载管理从侧边栏拆出，支持文件类型图标、实时角标计数、一键「下载当前页链接」、失败重试与直接清理 NAS 文件。
- `Ctrl+Shift+T` 恢复最近关闭的标签页（菜单同步新增入口）。
- 适配 [EWEDLCM/FnDepot](https://github.com/EWEDLCM/FnDepot/) V2 外部应用源规范：根目录新增 `fnpack.json`，支持通过 GitHub 仓库或直链订阅更新。

## [1.0.15] - 2026-11-25

### 修复

- 飞牛桌面入口改为新标签页打开（`type: "url"`，`https` 端口 `18921`），彻底解决内嵌 `iframe` 导致的黑屏与红叉拦截。

## [1.0.14] - 2026-11-25

### 优化

- 图标增加平滑抗锯齿圆角遮罩，消除 90° 直角与白边。
- 工具栏按钮全面替换为统一的线性矢量 SVG 图标，主题按钮随深浅色实时切换日月图标。
- 修复飞牛 `/vol1` 根目录 `EACCES` 权限报错，支持手动输入路径与自动探测可访问子目录。
- 非安全 HTTP 上下文访问时顶部显示一键跳转 HTTPS 引导条。

## [1.0.13] - 2026-11-25

### 新增

- 新增应用内 NAS 服务端直下与飞牛存储目录选择器（支持 `/vol1`～`/vol9` 与 `TRIM_DATA_SHARE_PATHS`）。
- 裁剪图标外圈 23px 白边，生成满幅 RGBA 图标。

## [1.0.12] - 2026-11-25

### 变更

- 应用名称正式改为「极光浏览器」，移除 Rammerhead 精简为 Scramjet 主力内核 + 内置轻量直连。
- 支持加载自定义外部 TLS 证书（`TLS_CERT_PATH` / `TLS_KEY_PATH` 或 `DATA_DIR/tls/custom.{crt,key}.pem`）。
- 为 Scramjet 与轻量直连内核统一补充新窗口弹窗拦截，修复视频站点额外弹出独立窗口的问题。
- 主菜单新增「默认搜索引擎」切换与「额外域名」保存反馈。

## [1.0.11] - 2026-11-25

### 新增

- Rammerhead 内核（Ruby Network 维护版 1.3.6）：以 HTTP 方式打开时，外部网站改走服务端代理，视频与复杂页面的兼容性优于轻量直连；HTTPS 打开仍走 Scramjet，内网地址仍走轻量直连。
- 自带 HTTPS：首次启动时在数据目录生成本地根 CA，并为 NAS 的全部 IP 地址自动签发服务器证书，新增 18921 HTTPS 入口——用 IP 直连打开也能激活 Scramjet 内核。菜单「HTTPS 全功能」提供根证书下载（iPhone/iPad 描述文件、Windows/Android 证书）与附加证书域名设置，IP 变化后重启应用自动重签。

### 修复

- Rammerhead 页面中「新窗口打开」的链接会逃出外壳、弹出裸会话地址窗口：注入拦截脚本，此类链接改为在极光内打开新标签页。
- 应用中心图标显示为占位图：四处图标全部改为标准 PNG（补齐 sRGB/gAMA 数据块），图标生成脚本同步修正，后续构建不再复发。
- 打包层与已验证可安装的包对齐，修复 GitHub 构建的包在部分 fnOS 上提示「应用包不符合系统要求」无法安装：manifest 移除 `os_min_version`、`ctl_stop`、`maintainer_url`、`distributor_url`；`config/privilege` 恢复 `username`/`groupname`；`config/resource` 改回 `{}`；打包不再包含 `wizard/` 目录。

## [1.0.6] - 2026-11-24

### 新增

- 全新桌面级浏览器外壳：桌面浏览器式标签栏（真实网站图标、拖拽排序、中键关闭）、地址栏历史/书签补全下拉、历史/书签侧边栏、页内查找（命中计数与高亮跳转）、菜单与快捷键缩放、全套键盘快捷键，底部状态栏常驻内核状态角标。
- 默认书签改为六个常用站点：必应搜索、Bilibili、GitHub、OpenAI、Gemini、Muse（仅首次运行时写入，已有书签不受影响）。

### 优化

- 打包只带一份 Node 运行时（此前同一二进制在包里出现两次）：ARM64 包从约 79.6 MB 降至约 43 MB，x86_64 包同步瘦身。

## [1.0.5] - 2026-11-24

### 修复

- 二次修复 ARM 设备安装被拒：按飞牛官方文档与已可安装的参考包对齐包结构。
  - manifest 补充兼容性字段 `os_min_version = 1.0.0` 与 `checkport = false`（官方定义为兼容性检查字段，缺失会被判不符合系统要求）。
  - `config/resource` 改为官方模板格式：两个 share 仅声明 `name`，去掉上版误加的 `permission` 字段。
  - `wizard/` 补齐 `install` / `upgrade` / `uninstall` / `config` 四个文件（上版只有空的 `install`）。

## [1.0.4] - 2026-11-24

### 修复

- 修复 ARM 设备安装被拒（「应用包不符合系统要求」）：`config/resource` 从空 `{}` 改为含 `fn-browser` 和 `fn-browser/data` 两个 share 的合法 `data-share` 结构；`config/privilege` 改为飞牛模板要求的 4 空格缩进格式。
- 图标替换为定稿的「极光球」设计：四张 PNG 全部由 `assets/icon.svg` 内嵌的 256×256 原图生成，直角方形满幅、无圆角，且为带 alpha 通道的 RGBA（飞牛对 RGB 图标可能拒装）。
- 删除 manifest 中非标准字段 `checkport`，补充 `distributor_url`。
- `scripts/generate_icons.py` 改为直接读取 SVG 内嵌 PNG 并用纯标准库做高质量缩放，构建时不再重新绘制旧图案。

## [1.0.3] - 2026-11-24

### 修复

- 补齐 fnpack 强制校验所需的 `ICON.PNG` (64×64)、`ICON_256.PNG` (256×256) 与桌面图标 `app/ui/images/icon_64.png`、`icon_256.png`，构建不再在打包阶段失败。
- 补齐 `wizard/` 目录，满足 fnpack 预检要求。
- 修复构建脚本按目标架构下载 fnpack 导致 x86 主机无法构建 arm 包的问题；fnpack 现在按构建主机架构选择。
- 修复 npm 安装会带入 `bufferutil` 等 native optional 依赖、导致 arm 包在 x86 主机构建后无法运行的问题。
- 修复轻量代理内点击链接后地址栏不更新的问题。
- 修复 Scramjet 内核下页内导航不进入前进/后退历史的问题。

### 新增

- 支持 ARM64 与 x86_64 双架构构建：`./build.sh arm` / `./build.sh x86`。
- 新增 GitHub Actions：推送 `v*` 标签或在 Actions 手动触发，自动构建两个架构的 FPK 并发布 Release，更新日志从本文件对应版本段落自动提取。
- 服务端可选 `AUTH_TOKEN` 鉴权，用于避免代理端点被公网滥用。
- 新增图标生成脚本 `scripts/generate_icons.py`，图标可复现。

### 变更

- `manifest` 补齐 `ctl_stop`、`maintainer_url`，移除描述中未实现的“会话隔离”和“ARM64 专用”表述。
- 轻量代理默认不再向下游目标转发 `cookie` / `authorization` 等凭证头，错误信息不再回显内部细节。

## [1.0.2] - 2026-11-24

- 初始公开版本：Scramjet + 轻量直连双内核，多标签页、书签、历史记录。
