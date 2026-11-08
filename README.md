# 题目图像链接识别

从题干、选项和答案里提取图片链接候选，并保留链接前后的文字。源自 ZError 管理后台的题目图像算法，支持超星 LaTeX 公式地址和图片 URL 后粘连的变量、单位或标点。

## 使用

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

使用 Node.js 18 或以上运行以下命令。测试不需要安装依赖或联网。

```sh
npm test
```

[测试集](test/fixtures.json)记录了每个输入的预期文本切分和图片候选。用例覆盖普通网址选项、连续链接、变量粘连、超星公式和括号。后台 U/V/T 用例里的原始图片地址已替换为示例地址。

## 许可证

[MIT](LICENSE)
