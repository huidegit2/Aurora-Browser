# 更新日志

## [Unreleased]

- 图标替换为定稿的「极光球」设计：四张 PNG 全部由 `assets/icon.svg` 内嵌的 256×256 原图生成，直角方形满幅、无圆角。
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
