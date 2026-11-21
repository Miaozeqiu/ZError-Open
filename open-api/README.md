# ZError Open

公开模型目录、题图算法和测试页面部署在 [open.zerrorai.com](https://open.zerrorai.com/)。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/`、`/models` | 查看模型配置、测试连接 |
| GET | `/question-images` | 测试题图链接识别 |
| GET | `/website-experience` | 浏览 ZError Agent 的网站操作经验和导航图谱来源 |
| GET | `/v1/website-experience` | 官方网站经验目录及 GitHub 来源 |
| GET | `/v1/website-experience/<host>` | 读取含编译工具包和资源的完整官方经验快照，支持通过 `revision` 查询增量 |
| GET | `/health` | 健康检查 |
| GET | `/v1/app-updates/releases` | 公开正式发布列表及 Windows、macOS、Linux 安装包 |
| GET、HEAD | `/v1/app-updates/download/:tag/:filename` | 转发正式发布安装包，支持单段字节范围下载 |
| GET | `/v1/app-updates/latest` | 主仓库最新正式版本及各架构的安装包 |
| GET | `/v1/app-updates/native/<target>/<arch>` | 该架构的签名更新清单，无签名包时返回 204 |
| GET | `/v1/config/models` | 公开模型和平台目录 |
| POST | `/v1/config/models/test` | 使用所选平台、模型及用户本次填写的 API Key 发起测试 |
| GET | `/v1/question-images/algorithm` | 返回本仓库 `src/algorithm.js` 的源码，供桌面端加载 |
| GET | `/v1/question-images/fixtures` | 题图识别页与算法测试共用的公开用例 |
| POST | `/v1/question-images/parse` | 接收 `{"text":"题目原文"}`，返回原文切分和去重后的图片链接候选 |

`models.json` 从原公开模型目录迁移。发布目录只存公开配置。图片解析直接使用此仓库的算法。模型测试只向目录指定的 HTTPS 接口发送请求，客户端传入的平台 ID 和模型 ID 用于查找目录配置。测试接口不存储 API Key，也不返回上游响应正文。

供应商图标文件放在 `public/providers/`，文件名登记在 `models.json` 的 `providers_list`。平台通过 `icon` 引用对应文件。模型图标放在 `public/models/`，由 `model_icon_mappings` 按模型名称或 ID 匹配。网站和桌面端从同一份公开目录读取图标配置。

解析接口接受 UTF-8 JSON，文本上限为 8,192 个 JavaScript 字符串单元，请求体上限为 32 KiB。图片识别提取链接候选，不下载图片。

使用 Node.js 24 或以上及 Git，在仓库根目录运行 `npm start`，本地页面为 `http://127.0.0.1:3015`。运行 `npm test` 验证完整应用，包括接口、算法和部署事务。

源站使用 systemd 和 Nginx，统一运行 `npm run deploy -- user@host`。首次安装会下载并校验 Node.js 运行环境，支持 Linux x64 和 arm64；升级复用已有运行环境。脚本测试同一仓库的完整应用，核对官方编译包和发布列表，检查失败时恢复原有文件和配置。旧根目录 API 入口、外部算法依赖和过期锁文件随应用切换清理。现有源站的部署目录、服务名称、域名和缓存目录保持一致。

官方经验从固定的公开 GitHub 仓库读取。Open 按提交下载并校验文件，收到请求时使用十分钟内的缓存，缓存过期后检查新版本。

GitHub REST API 返回配额耗尽或限流时，Open 使用公开 Git 通道浅克隆固定官方仓库，从同一提交的 Git 对象读取文件，仍执行相同的文档、编译产物和资源校验。此路径不使用凭据、不检出工作目录，也不执行仓库脚本。临时仓库在结束后删除；传输限时 20 秒、仓库包限制 64 MiB、结果读取有大小上限。普通上游错误或校验失败不会绕过检查切换来源。

源站 DNS 解析出的 GitHub 节点不可达时，可在仅供源站使用的 `/etc/zerror-open-api-network.env` 配置 `ZERROR_GITHUB_GIT_ADDRESS=<可达的 GitHub 官方 IPv4>`，并通过 systemd `EnvironmentFile` 加载。部署检查读取同一配置。该项只调整 Git 通道连接地址，仓库域名和 TLS 证书校验不变；应用代码不内置固定节点地址。

软件更新读取 [ZError 主仓库的正式发布](https://github.com/Miaozeqiu/ZError/releases/latest)，缓存五分钟。官网使用公开发布列表中安装包的 `downloadUrl` 从 Open 下载，Open 每五分钟读取发布列表并预取最近两个正式版本的安装包。systemd 提供持久缓存目录，预取可续传，文件通过 GitHub 公布的大小和 SHA-256 校验后才启用本地缓存。冷缓存期间使用实时转发。

GitHub 发布元数据也保存在 systemd 缓存目录，避免服务重启期间 GitHub 限流导致安装包列表丢失。只有两个固定公开发布接口会使用此缓存，不存储认证头；网络故障、限流或服务器错误时复用最后有效数据，明确的 404 会清除对应缓存。

本地缓存就绪后，下载地址会指向包含 GitHub 附件 ID 的 CDN 路径。源站对已缓存的完整和范围响应设置 s-maxage=86400，同版本替换附件会使用新路径。需要立即下架已经进入 CDN 缓存的文件时，在 EdgeOne 刷新该附件的完整路径。应用内更新需要同名的 `.sig` 文件。发布包含签名附件但暂时读取失败时，Open 缓存 30 秒后重试。

官方网站仓库在 `skills/<网站 id>/runtime.json` 发布编译工具包，包含 `apiVersion:2`、代码、SHA-256、工具定义及可选资源。Open 从同一 Git 提交读取文档、图谱、图标和运行包，校验 Git blob、执行代码与资源哈希后整体启用快照。运行包通过经验响应的 `runtime` 字段返回，不放进经验正文；接口继续使用现有路径，不新增版本路由或保留旧版脚本清单。执行代码最多 256 KiB、运行包文件最多 2 MiB，资源解码总量最多 1 MiB。客户端负责进一步校验命令和权限，并在隔离沙箱执行。

官网在浏览器中读取发布列表。Open 每五分钟按请求刷新缓存，将 GitHub 标记的最新正式版放在列表首位。历史列表不可用时暂时返回最新正式版，并用 `partial` 标记结果。安装包地址来自 GitHub 正式发布。
