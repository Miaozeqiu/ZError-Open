# ZError Open

公开模型目录、题图算法和测试页面部署在 [open.zerrorai.com](https://open.zerrorai.com/)。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/`、`/models` | 查看模型配置、测试连接 |
| GET | `/question-images` | 测试题图链接识别 |
| GET | `/website-experience` | 浏览 ZError Agent 的网站操作经验和导航图谱来源 |
| GET | `/v1/website-experience` | 官方网站经验目录及 GitHub 来源 |
| GET | `/v1/website-experience/<host>` | 读取指定网站的官方经验快照，支持通过 `revision` 查询增量 |
| GET | `/v1/website-experience/<host>/script-manifest.json` | 网站脚本清单及 SHA-256 |
| GET | `/v1/website-experience/<host>/scripts/<name>.<sha256>.js` | 与站点提交对应的隔离脚本 |
| GET | `/health` | 健康检查 |
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

需要 Node.js 18 或以上。运行 `node open-api/server.js`，本地页面为 `http://127.0.0.1:3015`。运行 `node --test open-api/server.test.js` 验证服务。

现有源站使用 systemd 和 Nginx。在已部署的机器上升级时，运行 `bash open-api/deploy.sh user@host`。该脚本使用现有的 Node 运行环境，保留旧域名入口，升级失败时恢复原有服务文件和配置。

官方经验从固定的公开 GitHub 仓库读取。Open 按提交下载并校验文件，收到请求时使用十分钟内的缓存，缓存过期后检查新版本。

软件更新读取 [ZError 主仓库的正式发布](https://github.com/Miaozeqiu/ZError/releases/latest)，缓存五分钟。安装包的下载地址指向同一 Release。应用内更新需要同名的 `.sig` 文件。

官方网站仓库可在 `site-tools/tools.json` 声明工具，并在同目录发布 JS 适配器。Open 从同一 Git 提交校验并发布文档、工具和脚本。经验响应的 `tools` 为工具定义，`scriptManifest` 指向 Open 同源的清单。
