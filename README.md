# ZError Open

打开 [ZError Open](https://open.zerrorai.com/)，查看模型配置、测试模型连接、验证题图识别算法，也可以浏览 Agent 的网站经验。

本仓库是 Open 网站和服务端的统一应用。`open-api/server.js` 同时提供页面和接口，`open-api/public/` 存放页面资源，`src/` 是应用内的题图解析模块。网站包分发、发布列表和安装包缓存也由此服务处理，不需要单独的 API 工程或外部算法包。

## 贡献

| 功能 | 在线测试 | 在 GitHub 编辑 |
| --- | --- | --- |
| 模型配置 | [模型配置](https://open.zerrorai.com/models) | [模型目录](https://github.com/Miaozeqiu/ZError-Open/edit/main/open-api/models.json) |
| 题图识别 | [题图识别](https://open.zerrorai.com/question-images) | [识别算法](https://github.com/Miaozeqiu/ZError-Open/edit/main/src/algorithm.js) · [测试用例](https://github.com/Miaozeqiu/ZError-Open/edit/main/test/fixtures.json) |

登录 GitHub 后可以在网页编辑。按 GitHub 提示在自己的分支或 Fork 中提交，然后创建 Pull Request。请在 PR 说明要修复的场景和验证结果。模型目录仅包含公开的模型和供应商信息，API Key 请只填在连接测试表单内。

在线站点展示已部署的版本。使用 Node.js 24 或以上及 Git 启动本地应用，无需安装依赖。

```sh
npm start
```

访问 [本地预览](http://127.0.0.1:3015/)。提交前运行 `npm test`，GitHub Actions 使用同一测试入口。模型图标和接口说明见 [Open 服务文档](open-api/README.md)。

## 部署

在已准备好 systemd、Nginx、Git 和 curl 的 Linux 源站运行：

```sh
npm run deploy -- user@host
```

首次部署会下载并核对独立的 Node.js 运行环境；后续部署复用已有环境。脚本部署同一仓库的完整应用，验证测试、网站工具包和发布列表后完成切换，失败时恢复旧版本。推送仓库会运行检查，生产部署仍通过此入口执行。

现有实例沿用 `/opt/zerror-open-api` 和 `zerror-open-api.service`，这些是部署标识。线上只启动本仓库的 `open-api/server.js`。旧的独立 API 入口和外部算法依赖会在部署检查通过后清理。

## 题目图像链接识别

从题干、选项和答案里提取图片链接候选，并保留链接前后的文字。源自 ZError 管理后台的题目图像算法，支持超星 LaTeX 公式地址和图片 URL 后粘连的变量、单位或标点。

### 使用

在 Node.js 中调用 `splitQuestionImageParts` 获取按原文顺序排列的文本和图片候选。

```js
const { splitQuestionImageParts } = require('./src');

splitQuestionImageParts('求导 https://mooc1.chaoxing.com/ananas/latex/p/123t+1');
// [
//   { type: 'text', text: '求导 ' },
//   { type: 'image', url: 'https://mooc1.chaoxing.com/ananas/latex/p/123' },
//   { type: 'text', text: 't+1' }
// ]
```

- `findQuestionImageMatches(text)` 返回匹配范围、规范化链接和粘连文本。范围使用 JavaScript 字符串偏移，结束位置不包含在范围内。
- `extractQuestionImageUrls(text)` 按首次出现顺序返回去重后的候选链接。
- 在 ZError 管理后台使用时，可将 [src/algorithm.js](src/algorithm.js) 的完整内容粘贴到「题目图像算法」。

算法只做文本解析。仅含域名的链接保留为文本，带路径的普通网页也可能被列为图片候选。需要展示图片时，由调用方下载并验证返回的图片内容。

## 测试

运行以下命令。测试不需要安装依赖或联网。

```sh
npm test
```

[测试集](test/fixtures.json)记录了每个输入的预期文本切分和图片候选。用例覆盖普通网址选项、连续链接、变量粘连、超星公式和括号。后台 U/V/T 用例里的原始图片地址已替换为示例地址。

## 许可证

[MIT](LICENSE)
