const createQuestionImageAlgorithm = require('./algorithm.js');

const runtime = {
  createMatchesFromRegex(text, { regex, normalizeUrl }) {
    const flags = regex.global ? regex.flags : regex.flags + 'g';
    return Array.from(String(text ?? '').matchAll(new RegExp(regex.source, flags)), match => {
      const rawUrl = match[0];
      const normalizedUrl = String(normalizeUrl ? normalizeUrl(rawUrl) : rawUrl);
      return {
        rawUrl,
        normalizedUrl,
        start: match.index,
        end: match.index + rawUrl.length,
        trailingText: rawUrl.startsWith(normalizedUrl) ? rawUrl.slice(normalizedUrl.length) : '',
      };
    }).filter(match => match.rawUrl);
  },
};

module.exports = createQuestionImageAlgorithm(runtime);
