# 更新日志

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
