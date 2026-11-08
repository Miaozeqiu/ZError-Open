function createQuestionImageAlgorithm(runtime) {
  /**
   * 1. 核心正则改进：
   * 使用 (?!https?:\/\/) 负向前瞻。
   * 含义：匹配 URL 字符，但每匹配一个字符前，先检查后面是不是跟着新的 "http"，如果是则停止。
   * 同时移除了逗号 [,]，防止多个链接被逗号粘连。
   */
  const urlRegex = /https?:\/\/(?:(?!https?:\/\/)[A-Za-z0-9\-._~:/?#[\]@!$&()*+;=%])+/g;

  const countChar = (text, ch) => {
    let count = 0;
    for (const char of text) {
      if (char === ch) count++;
    }
    return count;
  };

  const normalizeUrl = (rawUrl) => {
    let url = String(rawUrl || '').trim();

    // --- 规则 A：图片后缀截断 ---
    // 只要匹配到图片后缀就截断，不考虑后面是什么（单位、下划线等由 trailingText 处理）
    const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
    const extPattern = new RegExp(`\\.(${imageExtensions.join('|')})`, 'i');
    const extMatch = url.match(extPattern);

    if (extMatch) {
      return url.substring(0, extMatch.index + extMatch[0].length);
    }

    // --- 规则 B：基础清洗逻辑 ---
    // 移除末尾可能的中文或英文标点
    url = url.replace(/[，。；！？,;!?]+$/g, '');

    // 剥离右侧引号和括号
    while (/["'`》）】』」}>]$/.test(url)) { url = url.slice(0, -1); }

    // 智能处理成对括号（防止 URL 内部带参数的括号被误删）
    while (url.endsWith(')') && countChar(url, ')') > countChar(url, '(')) { url = url.slice(0, -1); }
    while (url.endsWith(']') && countChar(url, ']') > countChar(url, '[')) { url = url.slice(0, -1); }
    while (url.endsWith('}') && countChar(url, '}') > countChar(url, '{')) { url = url.slice(0, -1); }

    return url;
  };

  const findMatches = (text) => {
    const sourceText = String(text || '');
    // 运行时工具根据 regex 找到所有匹配，并调用 normalizeUrl 得到归一化结果
    const matches = runtime.createMatchesFromRegex(sourceText, {
      regex: urlRegex,
      normalizeUrl,
    });

    if (!matches) return [];

    const processedMatches = [];

    for (const match of matches) {
      let url = match.normalizedUrl;
      if (!url) continue;

      /**
       * 关键点：处理粘连字符
       * 如果正则捕获的原始文本比 normalize 后的长，
       * 说明后面跟着 ____ 或 V 这种字符，将其存入 trailingText 供 split 还原。
       */
      if (match.text && match.text.length > url.length) {
        const extra = match.text.substring(url.length);
        match.trailingText = extra + (match.trailingText || '');
      }

      // --- 规则 C：超星 LaTeX 链接深度解析 ---
      const cxPattern = /^(https?:\/\/mooc[a-z0-9-]*\.chaoxing\.com\/ananas\/latex\/p\/)(\d+)(.*)$/i;
      const cxMatch = url.match(cxPattern);

      if (cxMatch) {
        const [, prefix, id, extra] = cxMatch;
        match.normalizedUrl = prefix + id;
        if (extra) {
          match.trailingText = extra + (match.trailingText || '');
        }
      }

      // --- 规则 D：基础过滤 ---
      // 必须是有效的路径链接而非纯域名
      const urlWithoutProtocol = match.normalizedUrl.replace(/^https?:\/\//i, '');
      if (urlWithoutProtocol.includes('/')) {
        processedMatches.push(match);
      }
    }

    return processedMatches;
  };

  return {
    findQuestionImageMatches: (text) => findMatches(text),

    extractQuestionImageUrls: (text) => {
      const matches = findMatches(text);
      return [...new Set(matches.map((item) => item.normalizedUrl))];
    },

    splitQuestionImageParts: (text) => {
      const sourceText = String(text || '');
      const matches = findMatches(sourceText);
      const parts = [];
      let lastIndex = 0;

      for (const match of matches) {
        // 1. 压入图片前的文本节点
        if (match.start > lastIndex) {
          parts.push({
            type: 'text',
            text: sourceText.slice(lastIndex, match.start),
          });
        }

        // 2. 压入图片节点
        parts.push({
          type: 'image',
          url: match.normalizedUrl
        });

        // 3. 压入由于归一化被剥离的“粘连文本”（如 ____ 或单位）
        if (match.trailingText) {
          parts.push({
            type: 'text',
            text: match.trailingText
          });
        }

        lastIndex = match.end;
      }

      // 4. 压入末尾剩余文本
      if (lastIndex < sourceText.length) {
        parts.push({
          type: 'text',
          text: sourceText.slice(lastIndex)
        });
      }

      return parts.length ? parts : [{ type: 'text', text: sourceText }];
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = createQuestionImageAlgorithm;
}
