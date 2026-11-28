# 极光浏览器 Aurora

为飞牛 fnOS 提供网页代理、标签管理、书签和浏览历史的原生 FPK 应用，支持 **ARM64** 与 **x86_64**。

Aurora 由 NAS 提供代理转发服务，网页仍由访问设备的浏览器渲染。应用无需 Docker 或远程桌面；网站兼容性取决于代理模式、客户端浏览器和访问环境。

[下载正式版本](https://github.com/huidegit2/Aurora-Browser/releases/latest) · [更新日志](CHANGELOG.md) · [连接与排障](docs/TROUBLESHOOTING.md) · [开发与发布](docs/DEVELOPMENT.md) · [实施与验证记录](IMPLEMENTATION-NOTES.md)

## 下载与安装

正式安装包见 [**最新 Release**](https://github.com/huidegit2/Aurora-Browser/releases/latest)，版本号与发布说明以该页为准。以下地址会指向最新正式版的对应架构附件。

| NAS 架构 | 安装包 |
| --- | --- |
| ARM64 | [fn-browser-arm64.fpk](https://github.com/huidegit2/Aurora-Browser/releases/latest/download/fn-browser-arm64.fpk) |
| x86_64 | [fn-browser-x86_64.fpk](https://github.com/huidegit2/Aurora-Browser/releases/latest/download/fn-browser-x86_64.fpk) |

1. 按 NAS 的实际 CPU 架构选择安装包，在 fnOS 应用中心手动安装。
2. 启动应用后，从 fnOS 桌面入口打开 Aurora。默认入口使用 HTTPS，端口为 `18921`。
3. 如果浏览器提示证书不受信任，先按[证书与访问指南](docs/TROUBLESHOOTING.md#入口证书不受信任)完成配置，再使用完整代理功能。
4. 在应用设置中配置访问密码，并通过“连接自检”确认当前代理条件。

内部应用标识保持为 `fn-browser`，显示名称为“极光浏览器”。升级前请备份应用数据和自行配置的证书；安装后的实际兼容性仍需结合设备与系统版本验证。

## 能做什么

| 功能 | 当前支持情况 |
| --- | --- |
| 网页访问 | Scramjet 为主要代理路径，另有基础代理作为部分场景的回退方案 |
| 标签页 | 多标签、关闭恢复、前进后退及加载状态显示 |
| 日常管理 | 书签、访问历史、搜索引擎、浅色/深色主题、页内查找 |
| 连接设置 | 内置 HTTPS、自定义证书、根证书下载与连接自检 |
| 访问保护 | 可选访问密码、环境变量口令、管理 API 与 WebSocket 来源检查 |

部分网站的登录、视频、验证码、弹窗和存储功能可能受代理及浏览器安全策略影响。Aurora 不承诺与完整桌面浏览器等同的站点兼容性。

### 两种代理模式

| 模式 | 主要用途 | 使用条件与边界 |
| --- | --- | --- |
| Scramjet | 访问需要较完整脚本支持的网站 | 依赖客户端浏览器支持 Service Worker，并处于可信安全上下文；NAS 负责转发网络请求 |
| 基础代理 | 部分内网设备、简单网页及回退访问 | 能力较有限；安全沙箱会限制部分登录、存储、弹窗及父页面操作 |

局域网 IP 的普通 HTTP 页面可以用来检查应用主页是否可达，但不能据此判断 Scramjet 已可用。具体排查方法见[连接与排障](docs/TROUBLESHOOTING.md)。

## 首次连接与证书

推荐使用**有效域名证书和 HTTPS 入口**，减少逐台设备导入根证书的操作。已有受信任证书时，可以通过支持 WebSocket 的反向代理接入，也可以为应用配置自定义证书。

使用内置本地根 CA 时，每台访问设备都需要分别导入并信任。安装后可直接在 **fnOS 应用中心 → 极光浏览器的应用详情 → 应用介绍** 查看证书摘要，不必先进入 Aurora；介绍随新版 FPK 安装或升级更新。

如果 HTTPS 页面打不开，可在自己的可信局域网内先用系统浏览器下载 CA，将示例 IP 替换为 NAS 实际地址：

| 设备 | 证书下载与信任 |
| --- | --- |
| Windows / Android | 下载 `http://192.168.1.10:18920/aurora-ca.crt`；Windows 导入当前用户的“受信任的根证书颁发机构”，Android 选择安装“CA 证书” |
| iPhone / iPad | 用 Safari 下载 `http://192.168.1.10:18920/aurora-ca.mobileconfig`；安装描述文件后，在“关于本机 → 证书信任设置”中开启完全信任 |

完成后重新打开 `https://192.168.1.10:18921`，并查看“连接自检”。分平台完整操作见[证书安装步骤](docs/TROUBLESHOOTING.md#使用内置本地根-ca)。仅忽略证书警告不能保证 Service Worker 可用；飞牛 App 内置页面的信任策略也可能与系统浏览器不同。

还需区分两条连接：

- **访问设备 → Aurora**：入口证书影响是否能打开应用，以及客户端能否启用 Service Worker。
- **Aurora → 目标网站**：基础代理使用 Node 默认 TLS 校验。访问自签名 HTTPS 设备时，应为目标配置正确证书，或为服务端明确添加受信 CA。

配置方式及常见错误见[证书与反向代理说明](docs/TROUBLESHOOTING.md#使用已有域名证书)。

## 文件下载与旧版数据

从 v1.0.26 起，应用移除 NAS 下载管理、任务接口与目录选择功能，聚焦网页代理和日常浏览。网页中的下载链接交由访问设备的浏览器处理；能否下载仍受目标网站、代理及客户端安全策略影响，应用不保证任意站点均可下载。

根证书和安装包下载保留。升级不会主动删除旧版已经保存的文件或下载记录，也不会继续执行旧任务；如需取回或整理旧文件，请通过 fnOS 文件管理器访问原保存目录。

## FnDepot 应用源

仓库通过 [fnpack.json](fnpack.json) 提供 FnDepot V2 外部应用源索引。可使用仓库地址或索引直链添加应用源：

```text
https://github.com/huidegit2/Aurora-Browser
```

```text
https://raw.githubusercontent.com/huidegit2/Aurora-Browser/main/fnpack.json
```

正式发布流程会同步写入版本说明、下载地址、SHA-256 和文件大小。客户端何时显示新版本，还取决于其刷新与缓存策略。

## 自动构建与发布

代码推送或合并到 `main` 后，[发布工作流](.github/workflows/release.yml)会自动执行：

1. 运行语法检查、Node 回归和 Python 版本逻辑测试。
2. 计算版本号，并同步构建目录中的应用版本元数据。
3. 构建 ARM64 与 x86_64 两个 FPK，保存构建产物。
4. 创建正式 GitHub Release、上传安装包。
5. 更新 FnDepot 索引中的下载地址和校验信息。

仅修改 Markdown 或应用源索引不会触发新版本发布。推送版本标签、手动指定版本以及“只构建、不发布”仍受支持。版本规则和手动操作见[开发与发布指南](docs/DEVELOPMENT.md#版本与自动发布)。

## 访问保护

建议在应用设置中启用访问密码；管理员也可通过 `AUTH_TOKEN` 环境变量设置优先口令。不配置密码时，实例仍可能允许未认证访问，并没有强制的首次设置向导或完整多用户隔离。

将应用开放到外网前，应先配置访问保护、受信任的 HTTPS 入口和明确的访问范围。当前加固并不等同于完整安全审计，剩余工作见[实施与验证记录](IMPLEMENTATION-NOTES.md#仍需完成的工作)。

## 开发入口

源码运行、回归测试、双架构构建和发布恢复操作统一放在[开发与发布指南](docs/DEVELOPMENT.md)。后续体验建议见[界面与功能优化路线](docs/UI-ROADMAP.md)，其中建议项尚未实现。

常用目录：

| 路径 | 内容 |
| --- | --- |
| [app/server](app/server) | Node.js 服务、基础代理、TLS 与存储模块 |
| [app/www](app/www) | 浏览器界面与 Service Worker |
| [app/ui](app/ui) | fnOS 桌面入口和图标 |
| [cmd](cmd) / [config](config) | 应用生命周期、权限和资源声明 |
| [scripts](scripts) | 图标生成、更新日志提取与发布版本处理 |
| [tests](tests) | 前端、安全及版本逻辑回归 |

## 许可证

仓库声明采用 **AGPL-3.0**，见 [LICENSE](LICENSE)。第三方组件的许可声明以其上游项目和实际分发包中的许可证为准。
