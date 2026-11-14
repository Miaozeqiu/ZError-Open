const endpoints = {
  'openai-chat': '/chat/completions',
  'openai-response': '/responses',
  anthropic: '/v1/messages',
};

const maxResponseBytes = 128 * 1024;

async function readResponse(response) {
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw new Error('response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function testModel(catalog, input, fetchUpstream) {
  const { platformId, modelId, apiKey } = input || {};
  const platform = catalog.platforms.find(item => item.id === platformId);
  const model = platform?.models.find(item => item.id === modelId);
  if (!model) return { status: 400, body: { error: 'unknown_model' } };
  if (typeof apiKey !== 'string' || !/^[!-~]{1,4096}$/.test(apiKey)) {
    return { status: 400, body: { error: 'invalid_api_key' } };
  }

  const protocol = platform.apiProtocol || model.apiProtocol || 'openai-chat';
  if (!Object.hasOwn(endpoints, protocol)) return { status: 400, body: { error: 'unsupported_protocol' } };
  const base = new URL(platform.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    return { status: 500, body: { error: 'invalid_configured_endpoint' } };
  }

  const text = 'Reply with OK.';
  const body = { model: model.modelId || model.id, stream: false };
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
  if (protocol === 'openai-response') {
    body.input = text;
    body.max_output_tokens = 256;
  } else {
    body.messages = [{ role: 'user', content: text }];
    body.max_tokens = 256;
  }
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';

  const startTime = Date.now();
  const signal = AbortSignal.timeout(15000);
  const baseUrl = base.href.replace(/\/+$/, '');
  const request = endpoint => fetchUpstream(baseUrl + endpoint, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal,
  });
  try {
    let result = await request(endpoints[protocol]);
    if (result.status === 404 && protocol === 'anthropic' && !baseUrl.endsWith('/anthropic')) {
      await result.body?.cancel();
      result = await request('/anthropic/v1/messages');
    }
    const elapsedMs = Date.now() - startTime;
    if (!result.ok) {
      await result.body?.cancel();
      return { status: 502, body: { error: 'upstream_rejected', upstreamStatus: result.status, elapsedMs } };
    }
    const data = await readResponse(result);
    const output = protocol === 'anthropic'
      ? data.content?.filter(item => item.type === 'text').map(item => item.text).join('')
      : protocol === 'openai-response'
        ? data.output_text || data.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('')
        : data.choices?.[0]?.message?.content;
    if (typeof output !== 'string' || !output.trim()) {
      return { status: 502, body: { error: 'empty_model_output', elapsedMs } };
    }
    // Only report status and timing. Upstream output may contain request details.
    return { status: 200, body: { success: true, elapsedMs: Date.now() - startTime } };
  } catch {
    return { status: signal.aborted ? 504 : 502, body: { error: signal.aborted ? 'upstream_timeout' : 'upstream_unavailable' } };
  }
}

module.exports = { testModel };
