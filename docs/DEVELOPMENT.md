# 开发、测试与发布

[返回首页](../README.md) · [更新日志](../CHANGELOG.md) · [实施与验证记录](../IMPLEMENTATION-NOTES.md)

本指南对应当前原生 fnOS 应用结构。应用使用 Node.js 服务和浏览器端代理，不需要为开发或打包引入 Docker。

## 开发环境

- Git：获取源码、标签与发布历史。
- Node.js 和 npm：服务声明要求 Node.js 18 及以上，当前 CI 使用 Node.js 20；实际支持边界应以依赖和回归结果为准。
- Python 3.10 及以上：发布版本处理脚本使用现代类型语法，脚本和测试不额外依赖第三方 Python 包。
- Linux 构建环境：需要 Bash、curl、tar、xz、awk 等工具，并能访问 npm、Node.js 和 fnpack 下载地址。

FPK 当前内置运行时的默认版本由[构建脚本](../build.sh)中的 `NODE_VERSION` 定义；它与运行 GitHub Action 本身使用的 Node 版本不是同一个配置。

## 获取源码并运行

```sh
git clone https://github.com/huidegit2/Aurora-Browser.git
cd Aurora-Browser
git fetch --tags
cd app/server
npm ci --omit=dev --omit=optional
HOST=127.0.0.1 DATA_DIR=/tmp/aurora-dev-data npm start
```

以上为 Linux / POSIX Shell 示例。启动后在本机浏览器中打开：

```text
http://localhost:18920
```

本机回环地址可用于开发时的安全上下文；在其他设备上用局域网 IP 访问 HTTP，不具备相同条件。代理依赖没有正确安装时，不能把“基础主页能打开”当作完整代理工作正常。

### 常用运行配置

| 变量 | 默认值或作用 |
| --- | --- |
| `HOST` | 服务端默认监听 `0.0.0.0`；本地开发示例限定为 `127.0.0.1` |
| `PORT` | HTTP 端口，默认 `18920` |
| `HTTPS_PORT` | HTTPS 端口，默认 `18921` |
| `DATA_DIR` | 数据目录；直接运行源码时默认是项目根目录下的 `data/`，FPK 生命周期会传入 fnOS 应用数据位置 |
| `AUTH_TOKEN` | 环境变量访问口令，优先于界面中保存的密码 |
| `ALLOW_PRIVATE_NETWORK_PROXY` | 可选覆盖 Aurora 设置中的内网访问开关；设为 `1` 强制开启、设为 `0` 强制关闭并锁定界面，未设置时使用已保存设置 |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | 自定义入口证书链与私钥路径 |
| `NODE_EXTRA_CA_CERTS` | Node 进程启动时额外信任的 CA 文件，不能代替客户端入口证书信任 |

FPK 的数据位置由[生命周期脚本](../cmd/main)按 `TRIM_DATA_SHARE_PATHS` 首个条目或应用变量目录确定。排障时应查看实际启动日志和环境，不要把源码开发目录当作已安装应用的数据目录。

## 测试

在仓库根目录运行：

```sh
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_release_version.py' -v
```

也可以进入[服务端目录](../app/server)执行 `npm test`，运行 Node 回归。Python 版本逻辑测试需要单独运行。

当前测试分工：

| 范围 | 关注点 |
| --- | --- |
| [前端回归](../tests/frontend-regression.test.js) | 启动与导航、帧归属、原生下载链接和浏览器快捷键 |
| [安全回归](../tests/security-regression.test.js) | API / WebSocket 来源检查、代理安全、设置写入失败与已移除接口 |
| [版本回归](../tests/test_release_version.py) | 自动递增、标签排序、同提交重跑、输入校验和构建元数据同步 |

Node 回归通过本机临时 HTTP 服务、实际函数和轻量 DOM 模拟进行验证，不会连接用户 NAS；它们不等同于真实手机或完整浏览器端到端测试。

使用支持该选项的 Node.js 版本时，可在不支持测试子进程的受限环境中显式关闭测试隔离：

```sh
node --test --test-isolation=none tests/frontend-regression.test.js tests/security-regression.test.js
```

此选项不是所有受支持 Node 版本都具备，常规环境优先使用上面的标准测试命令。

## 本地构建 FPK

在 Linux 的仓库根目录执行：

```sh
bash ./build.sh arm
bash ./build.sh x86
```

产物：

```text
dist/fn-browser-arm64.fpk
dist/fn-browser-x86_64.fpk
```

构建脚本会准备目标架构 Node 运行时、安装服务端生产依赖、下载适用于构建主机的 fnpack，并在隔离目录中打包。首次构建需要网络。

直接运行构建脚本时，版本默认来自[manifest](../manifest)，也可用 `VERSION` 覆盖 FPK 的版本。若需要同时同步服务端版本元数据，应像发布流程一样先运行[版本脚本](../scripts/release_version.py)。该脚本会修改当前检出目录的 manifest、服务端 package 和 lock 元数据，建议在干净、可丢弃的构建检出中执行。

例如，以下版本号仅为示例，执行前应选择尚未占用的版本：

```sh
REQUESTED_VERSION=1.0.25 python3 scripts/release_version.py
bash ./build.sh arm
bash ./build.sh x86
```

仅设置 `VERSION` 不等同于同步所有包内版本字段。自动发布流程已经统一处理此步骤。

## 版本与自动发布

[发布工作流](../.github/workflows/release.yml)支持三类入口：

| 入口 | 行为 |
| --- | --- |
| 代码推送或合并到 `main` | 自动选择版本，检查通过后正式发布双架构安装包并更新应用源 |
| 推送 `v*` 标签 | 按标签中的有效三段式版本号构建发布 |
| Actions 手动运行 | 版本可留空自动计算，也可明确指定；`dry_run` 默认关闭 |

### 自动版本规则

- 版本使用 `主版本.次版本.修订号`，例如 `1.0.24`。
- 同一源码提交已有有效版本标签时，重跑复用该版本。
- 新提交中，若声明版本高于已有有效标签，采用声明版本；否则对最高有效版本的修订号加一。
- 无法解析的历史标签和预发布格式不参与自动数字版本计算。
- 指定的版本若已绑定其他源码提交，流程会拒绝覆盖。

版本标签绑定到**本次实际构建的提交**。应用源更新会生成后续提交，因此主分支最新提交与版本标签不同，并不必然表示打包用错了源码。

### 一次正式发布会做什么

1. 检查 JavaScript、应用源 JSON 与前端内联脚本。
2. 运行 Node 和 Python 回归。
3. 计算版本并同步构建目录中的 manifest、服务端 package 与 lock 元数据。
4. 生成并检查两个 FPK，上传 Actions 构建产物，保留 14 天。
5. 从[更新日志](../CHANGELOG.md)提取对应版本说明；没有匹配段落时回退到 Git 提交日志。
6. 创建正式 Release、上传双架构安装包。
7. 计算 SHA-256 和文件大小，并用文件版本校验更新[应用源索引](../fnpack.json)。

发布流程串行执行。应用源写回只修改索引，并带有跳过 CI 标记；仅修改 Markdown 或应用源索引的普通主分支推送，不会再触发一轮发布。

### 只构建，不发布

在 Actions 中选择 **Build and Release FPK**，勾选 `dry_run`。检查和打包仍会执行，安装包保存在该次任务的 Artifacts 中；不会创建正式 Release，也不会更新应用源。

Artifacts 是有保留期的构建产物，不应代替正式版本下载地址。首次排障时要先确认自己查看的是验证构建还是正式发布。

### 失败与重跑

- 先检查失败步骤：测试、某个架构打包、附件上传，还是应用源写入。
- 同一次运行重跑会尝试复用同提交标签；已有版本属于其他提交时会停止，避免覆盖错误源码。
- Release 已存在时，只有确认标签属于相同源码提交，流程才会重新上传对应附件。
- Release 成功但应用源更新失败时，应修复原因后重跑原任务，并核对索引中的 URL、SHA-256 和大小。
- 不要通过关闭测试、忽略证书验证或强制移动已发布标签来掩盖失败。

## 文档与发布说明

功能或行为发生变化时，应同步更新[首页](../README.md)、[更新日志](../CHANGELOG.md)与相关指南。排障步骤放在[连接与排障](TROUBLESHOOTING.md)，实现边界与验证结论放在[实施记录](../IMPLEMENTATION-NOTES.md)。

已发布版本的仓库文档发生勘误后，可同步修订 Release 说明；这不会改变已上传的安装包。文档改动不能作为新功能已通过真机测试的证明。
