'use strict';

const get = id => document.getElementById(id);

const errors = {
  upstream_rejected: '平台拒绝了请求，请检查 Key、模型权限和额度',
  upstream_unavailable: '暂时无法连接模型平台',
  upstream_timeout: '模型平台响应超时',
  empty_model_output: '平台返回成功状态，但模型没有输出正文',
  unknown_model: '该模型已从目录移除，请刷新页面',
  invalid_api_key: 'API Key 格式无效',
  test_busy: '当前测试较多，请稍后再试',
  text_too_long: '题目最多可输入 8192 个字符',
  body_too_large: '请求内容过长，请缩短文本',
};

function show(id, text, isError = false) {
  const status = get(id);
  status.textContent = text;
  status.dataset.state = isError ? 'error' : '';
}

async function post(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(22000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = errors[result.error] || '请求失败，请稍后重试';
    const upstream = Number.isInteger(result.upstreamStatus) ? '，平台 HTTP ' + result.upstreamStatus : '';
    throw new Error(message + upstream);
  }
  return result;
}

function showIcon(tile, directory, filename, name) {
  const fallback = Array.from(name || '')[0]?.toUpperCase() || '';
  tile.textContent = fallback;
  if (!filename || !/^[a-z0-9_.-]+\.(svg|png|jpe?g|webp|gif|ico)$/i.test(filename)) return;
  const image = document.createElement('img');
  image.alt = '';
  image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
  image.src = '/' + directory + '/' + filename;
  tile.replaceChildren(image);
}

function hasVision(model) {
  return model.hasVision || model.category === 'vision';
}

function initModels(form) {
  const providers = get('platforms');
  const models = get('models');
  const details = get('model-details');
  const jump = document.querySelector('.details-jump');
  const submit = get('model-submit');
  const key = get('key');
  let iconMappings = [];
  let platform;
  let model;

  function iconFile(item) {
    if (item.icon) return item.icon;
    const name = [item.displayName, item.id, item.modelId].join(' ').toLowerCase();
    return iconMappings.find(([, terms]) => terms.some(term => name.includes(term.toLowerCase())))?.[0];
  }

  function makeChoice(item, directory, filename) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'catalog-choice';
    choice.setAttribute('aria-pressed', 'false');
    const tile = document.createElement('span');
    tile.className = 'catalog-icon';
    tile.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'choice-name';
    name.textContent = item.displayName || item.id;
    showIcon(tile, directory, filename, name.textContent);
    choice.append(tile, name);
    return choice;
  }

  function markSelected(list, choice) {
    list.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
    choice.setAttribute('aria-pressed', 'true');
  }

  function selectModel(item, choice) {
    model = item;
    markSelected(models, choice);
    showIcon(get('model-icon'), 'models', iconFile(model), model.displayName || model.id);
    get('selected-model').textContent = model.displayName || model.id;
    get('model-id').textContent = model.modelId || model.id;
    get('vision').textContent = hasVision(model) ? '支持图片输入' : '未标记';
    get('protocol').textContent = platform.apiProtocol || model.apiProtocol || 'openai-chat';
    details.hidden = false;
    show('model-status', '');
  }

  function selectPlatform(item, choice) {
    platform = item;
    model = undefined;
    key.value = '';
    markSelected(providers, choice);
    showIcon(get('provider-icon'), 'providers', platform.icon, platform.displayName || platform.id);
    get('selected-provider').textContent = platform.displayName || platform.id;
    get('base-url').textContent = platform.baseUrl;
    const available = platform.models || [];
    get('model-count').textContent = available.length;
    const choices = available.map(item => {
      const button = makeChoice(item, 'models', iconFile(item));
      const chip = document.createElement('span');
      chip.className = 'model-capability';
      chip.textContent = hasVision(item) ? '视觉' : '文本';
      button.append(chip);
      button.addEventListener('click', () => selectModel(item, button));
      return button;
    });
    models.replaceChildren(...choices);
    submit.disabled = !choices.length;
    details.hidden = !choices.length;
    jump.hidden = !choices.length;
    show('catalog-status', choices.length ? '' : '该供应商暂无可用模型。');
    if (choices.length) selectModel(available[0], choices[0]);
  }

  async function loadCatalog() {
    try {
      const response = await fetch('/v1/config/models', { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!data.platforms?.length) throw new Error();
      iconMappings = Object.entries(data.model_icon_mappings || {});
      const choices = data.platforms.map(item => {
        const choice = makeChoice(item, 'providers', item.icon);
        choice.addEventListener('click', () => {
          if (platform !== item) selectPlatform(item, choice);
        });
        return choice;
      });
      providers.replaceChildren(...choices);
      selectPlatform(data.platforms[0], choices[0]);
    } catch {
      show('catalog-status', '模型目录加载失败，请刷新页面重试。', true);
    }
  }
  void loadCatalog();

  for (const button of details.querySelectorAll('[data-copy]')) {
    const label = button.getAttribute('aria-label');
    let feedback;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(get(button.dataset.copy).textContent);
        button.setAttribute('aria-label', '已复制');
        button.title = '已复制';
        button.dataset.copied = 'true';
        clearTimeout(feedback);
        feedback = setTimeout(() => {
          button.setAttribute('aria-label', label);
          button.title = label;
          delete button.dataset.copied;
        }, 1200);
      } catch {
        show('model-status', '无法访问剪贴板，可选中文本后手动复制。', true);
      }
    });
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || !model) return;
    const payload = { platformId: platform.id, modelId: model.id, apiKey: key.value.trim() };
    const name = model.displayName || model.id;
    key.value = '';
    submit.disabled = providers.inert = models.inert = true;
    show('model-status', '正在测试 ' + name + '…');
    try {
      const result = await post('/v1/config/models/test', payload);
      show('model-status', name + ' 连接成功 · ' + result.elapsedMs + ' ms');
      get('model-status').dataset.state = 'success';
    } catch (error) {
      show('model-status', error.message, true);
    } finally {
      submit.disabled = providers.inert = models.inert = false;
    }
  });
}

function initImages(form) {
  const input = get('image-text');
  const submit = get('image-submit');
  const urls = get('image-urls');
  const details = get('image-details');
  const fixtureList = get('fixture-list');

  const updateCount = () => { get('image-count').textContent = input.value.length + ' / ' + input.maxLength; };
  input.addEventListener('input', updateCount);
  updateCount();

  get('insert-example').addEventListener('click', () => {
    input.value = '求导（https://mooc1.chaoxing.com/ananas/latex/p/123t+1）。\n选项 A：https://example.com/chart.png';
    updateCount();
  });

  async function recognize(text) {
    if (submit.disabled) return;
    submit.disabled = true;
    fixtureList.inert = true;
    get('image-empty').hidden = true;
    urls.hidden = details.hidden = true;
    details.open = false;
    show('image-status', '正在识别…');

    try {
      const result = await post('/v1/question-images/parse', { text });
      show('image-status', result.urls.length ? '找到 ' + result.urls.length + ' 个图片链接候选。' : '未找到图片链接候选。');
      urls.replaceChildren(...result.urls.map(url => {
        const item = document.createElement('li');
        item.textContent = url;
        return item;
      }));
      urls.hidden = !result.urls.length;
      get('image-parts').textContent = JSON.stringify(result.parts, null, 2);
      details.hidden = false;
    } catch (error) {
      show('image-status', error.message, true);
    } finally {
      submit.disabled = false;
      fixtureList.inert = false;
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    void recognize(input.value);
  });

  function fixtureButton(fixture) {
    const button = document.createElement('button');
    button.className = 'fixture-row';
    button.type = 'button';

    const name = document.createElement('span');
    name.className = 'fixture-name';
    name.textContent = fixture.name;
    const status = document.createElement('span');
    status.className = 'fixture-badge';
    status.dataset.state = fixture.passed ? 'success' : 'error';
    status.textContent = fixture.passed ? '通过' : '未通过';
    button.append(name, status);

    button.addEventListener('click', () => {
      if (submit.disabled) return;
      input.value = fixture.input;
      updateCount();
      get('image-output').focus();
      void recognize(fixture.input);
    });
    return button;
  }

  async function loadFixtures() {
    try {
      const response = await fetch('/v1/question-images/fixtures', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const fixtures = await response.json();
      fixtureList.replaceChildren(...fixtures.map(fixtureButton));
      get('fixture-count').textContent = fixtures.length;
      show('fixture-status', '');
    } catch {
      show('fixture-status', '测试集加载失败，请刷新页面重试。', true);
    }
  }
  void loadFixtures();
}

const modelForm = get('model-form');
if (modelForm) initModels(modelForm);

const imageForm = get('image-form');
if (imageForm) initImages(imageForm);
