const assert = require('node:assert/strict');
const test = require('node:test');
const algorithm = require('../src');
const fixtures = require('./fixtures.json');

for (const { name, input, template, urls } of fixtures) {
  test(name, () => {
    const parts = algorithm.splitQuestionImageParts(input);
    assert.equal(parts.map(part => part.type === 'image' ? '{{img}}' : part.text).join(''), template);
    assert.deepEqual(parts.filter(part => part.type === 'image').map(part => part.url), urls);
    assert.deepEqual(algorithm.extractQuestionImageUrls(input), [...new Set(urls)]);

    const matches = algorithm.findQuestionImageMatches(input);
    assert.deepEqual(matches.map(match => match.normalizedUrl), urls);
    for (const { start, end, rawUrl } of matches) {
      assert.equal(input.slice(start, end), rawUrl);
    }
  });
}
