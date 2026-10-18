/** 砖语：照片 + 一句话 -> 乐高模型。页面负责取景、对话和回放，真正的搭建在后端的 BrickAgent 容器里。 */
import { createClassic } from './classic.js';

const $ = id => document.getElementById(id);
const palette = await fetch('./colors.json').then(r => r.json());
const viewer = createClassic($('stage'), {
  onStep(k) { $('stepNo').textContent = k + 1; $('slider').value = k; },
});

let job = null;        // 当前这次对话的任务号
let photo = null;      // 待发送的照片（data URL）
let busy = false;      // 后端正在跑
let source = null;     // SSE 连接
let model = null;      // 当前模型的 { mpd, manifest }

/* ---------- 本机模型历史 ---------- */

const historyKey = 'brickstudio.models.v1';

function savedModels() {
  try {
    const entries = JSON.parse(localStorage.getItem(historyKey) || '[]');
    return Array.isArray(entries) ? entries.filter(entry => /^[\w-]+$/.test(entry?.id || '') && Number.isFinite(Number(entry.savedAt))) : [];
  } catch {
    return [];
  }
}

function renderHistory() {
  const entries = savedModels();
  $('history-count').textContent = `${entries.length} models`;
  $('history-empty').hidden = entries.length > 0;
  $('history-list').hidden = entries.length === 0;
  const list = $('history-list');
  list.replaceChildren();
  for (const entry of entries) {
    const card = document.createElement('article');
    card.className = 'history-item';
    const title = document.createElement('h3');
    title.textContent = entry.title || 'Untitled model';
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const savedAt = document.createElement('span');
    savedAt.textContent = new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(new Date(entry.savedAt));
    const parts = document.createElement('span');
    parts.textContent = `${Number(entry.parts || 0).toLocaleString()} parts`;
    const check = document.createElement('span');
    check.textContent = entry.valid ? 'Check passed' : 'Full check not passed';
    meta.append(savedAt, parts, check);
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Open model';
    const error = document.createElement('div');
    error.className = 'history-error';
    error.setAttribute('aria-live', 'polite');
    open.addEventListener('click', async () => {
      open.disabled = true;
      open.textContent = 'Opening…';
      error.textContent = '';
      try {
        const response = await fetch(`/api/jobs/${entry.id}`);
        if (!response.ok) throw new Error(response.status === 404 ? 'The original job is no longer available on this server.' : 'This job cannot be loaded right now.');
        const url = new URL(location.href);
        url.searchParams.set('job', entry.id);
        url.hash = 'result';
        location.assign(url);
      } catch (reason) {
        error.textContent = reason instanceof TypeError ? 'Cannot connect to this server right now.' : reason.message;
        open.disabled = false;
        open.textContent = 'Open model';
      }
    });
    card.append(title, meta, open, error);
    list.append(card);
  }
}

function rememberModel(event, info) {
  if (!job) return;
  const entries = savedModels();
  const old = entries.find(entry => entry.id === job);
  const entry = {
    id: job,
    title: event.card?.title || old?.title || 'Untitled model',
    parts: info.parts,
    valid: !!event.valid,
    savedAt: old?.savedAt || Date.now(),
  };
  try {
    localStorage.setItem(historyKey, JSON.stringify([entry, ...entries.filter(item => item.id !== job)].slice(0, 30)));
  } catch {
    return;
  }
  renderHistory();
}

renderHistory();

/* ---------- 对话记录 ---------- */

const log = $('log');

function atBottom() {
  return log.scrollTop + log.clientHeight > log.scrollHeight - 60;
}

function append(node) {
  const stick = atBottom();
  log.append(node);
  if (stick) log.scrollTop = log.scrollHeight;
  return node;
}

function bubble(kind, who) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.innerHTML = `<span class="who"></span><div class="body"></div>`;
  el.querySelector('.who').textContent = who;
  return append(el);
}

function say(kind, who, text, image) {
  const el = bubble(kind, who);
  el.querySelector('.body').textContent = text;
  if (image) {
    const img = document.createElement('img');
    img.className = 'shot';
    img.src = image;
    img.addEventListener('click', () => zoom(image));
    el.append(img);
  }
  return el;
}

function stage(text) {
  const el = document.createElement('div');
  el.className = 'stage-line';
  el.textContent = text;
  return append(el);
}

/** 工具调用等过程信息：一行一条，灰色，不喧宾夺主。 */
let trace = null;
function traceLine(text, isError) {
  if (!trace || !trace.isConnected || trace !== log.lastElementChild) {
    trace = append(Object.assign(document.createElement('div'), { className: 'trace' }));
  }
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  line.textContent = text;
  const stick = atBottom();
  trace.append(line);
  while (trace.children.length > 40) trace.firstChild.remove();
  if (stick) log.scrollTop = log.scrollHeight;
}

function shots(urls) {
  const box = append(Object.assign(document.createElement('div'), { className: 'renders' }));
  for (const url of urls) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Model render';
    img.addEventListener('click', () => zoom(url));
    box.append(img);
  }
}

/** 还没有可交互的模型时，视口里先放 agent 刚渲出来的那张图。 */
function peek(url) {
  $('status').hidden = false;
  $('status-shot').src = url;
  $('status-shot').hidden = false;
  $('status').querySelector('b').textContent = 'Building…';
  $('status-note').textContent = 'This is the latest render. The model is still being refined.';
}

function zoom(src) {
  $('lightbox-img').src = src;
  $('lightbox').showModal();
}
$('lightbox').addEventListener('click', () => $('lightbox').close());

function working(on, note) {
  busy = on;
  $('send').disabled = on;
  $('state').textContent = note || (on ? 'Generating…' : 'Ready');
  $('state').classList.toggle('live', on);
  $('status-bar').hidden = !on;
  if (!model) {
    $('status').hidden = false;
    $('status').querySelector('b').textContent = on ? 'Building…' : 'Upload a photo and describe what you want to build';
    $('status-note').textContent = on
      ? 'Progress appears below the input as it happens.'
      : 'Add a photo or a short description above. Building may take about ten minutes; progress appears live.';
  }
}

/* ---------- 后端事件 ---------- */

function listen(id) {
  source?.close();
  source = new EventSource(`/api/jobs/${id}/events`);
  source.onmessage = event => handle(JSON.parse(event.data));
  source.onerror = () => { if (busy) $('state').textContent = 'Connection lost. Reconnecting…'; };
}

function handle(event) {
  switch (event.type) {
    case 'user': say('me', 'You', event.text, event.image); break;
    case 'stage': stage(event.text); break;
    case 'assistant': say('bot', 'BRICKFORM', event.text); break;
    case 'thinking': traceLine('· ' + event.text); break;
    case 'tool': traceLine(event.text, event.error); break;
    case 'renders': shots(event.urls); if (!model) peek(event.urls.at(-1)); break;
    case 'model': showModel(event); break;
    case 'result': stage(`Completed · ${event.turns} turns · ${Math.round(event.seconds / 60)} min · $${event.cost.toFixed(2)}`); break;
    case 'error': say('bot', 'Error', event.text); break;
    case 'idle': working(false); break;
    case 'busy': working(true); break;
  }
}

/* ---------- 展示模型 ---------- */

async function showModel(event) {
  $('status').hidden = false;
  $('status').querySelector('b').textContent = 'Loading parts…';
  $('status-note').textContent = '';
  try {
    const text = await fetch(event.mpd).then(response => {
      if (!response.ok) throw new Error('Model file could not be loaded');
      return response.text();
    });
    const info = await viewer.load(text, palette.colors);
    viewer.frame(35, 22);
    model = { mpd: event.mpd, manifest: event.manifest };

    $('status').hidden = true;
    $('status-shot').hidden = true;
    $('hint').hidden = $('compass').hidden = $('rail').hidden = false;
    $('compass').textContent = event.valid ? 'Real parts · BrickAgent check passed' : 'Real parts · full check not passed';
    $('st-parts').textContent = info.parts.toLocaleString();
    $('st-kinds').textContent = event.manifest.kinds;
    const size = event.manifest.size;
    $('st-size').textContent = `${size.studs[0]}×${size.studs[1]}`;
    $('st-size').insertAdjacentHTML('beforeend', ` <span>studs · height ${size.height_cm} cm</span>`);
    $('st-steps').textContent = info.steps;
    $('stepMax').textContent = info.steps;
    $('slider').max = info.steps - 1;
    $('slider').value = info.steps - 1;

    if (event.card?.title) {
      $('h1').innerHTML = '';
      $('h1').textContent = event.card.title;
      if (event.card.subtitle) $('h1').insertAdjacentHTML('beforeend', `<small>${escape(event.card.subtitle)}</small>`);
    }
    if (event.card?.eyebrow) $('eyebrow').textContent = event.card.eyebrow;
    $('card-sub').textContent = event.card?.summary || '';
    $('card-body').innerHTML = `<span class="badge ${event.valid ? 'ok' : ''}">${event.valid ? 'No collisions · physically stable' : 'Rendered only · check not passed'}</span>`;
    if (event.reference) { $('ref-shot').src = event.reference; $('ref-shot').hidden = false; }

    const body = $('allBody');
    body.innerHTML = '';
    for (const row of event.manifest.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td></td><td class="id"></td><td><span class="sw"></span><span></span></td><td class="num"></td>`;
      const cells = tr.children;
      cells[0].textContent = row.name;
      cells[1].textContent = row.id;
      cells[2].querySelector('.sw').style.background = row.hex;
      cells[2].querySelector('span:last-child').textContent = row.color;
      cells[3].textContent = row.n;
      body.append(tr);
    }
    $('text').placeholder = 'Want to change something? For example: make the roof red and add a window.';
    rememberModel(event, info);
  } catch (error) {
    $('status').querySelector('b').textContent = 'Model failed to load';
    $('status-note').textContent = error.message;
    console.error(error);
  }
}

function escape(text) {
  return text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- 回放控制 ---------- */

$('slider').addEventListener('input', () => viewer.setStep(+$('slider').value));
let timer = null;
function stop() { clearInterval(timer); timer = null; $('play').setAttribute('aria-pressed', 'false'); $('play').textContent = 'Play'; }
$('prev').onclick = () => { stop(); viewer.setStep(viewer.step - 1); };
$('next').onclick = () => { stop(); viewer.setStep(viewer.step + 1); };
$('play').onclick = () => {
  if (timer) return stop();
  if (viewer.step >= viewer.maxStep) viewer.setStep(0);
  $('play').setAttribute('aria-pressed', 'true');
  $('play').textContent = 'Pause';
  timer = setInterval(() => (viewer.step >= viewer.maxStep ? stop() : viewer.setStep(viewer.step + 1)), 380);
};
$('hl').onclick = () => {
  const on = $('hl').getAttribute('aria-pressed') !== 'true';
  $('hl').setAttribute('aria-pressed', on);
  viewer.setHighlight(on);
};
$('dl').onclick = () => model && window.open(model.mpd, '_blank');
addEventListener('keydown', event => {
  if (event.target.matches('textarea, input, select')) return;
  if (event.key.toLowerCase() === 'f') viewer.frame(35, 22);
});

/* ---------- 从头开始 ---------- */

function reset() {
  source?.close();
  source = null;
  job = null;
  model = null;
  localStorage.removeItem('brickstudio.job');
  log.innerHTML = '';
  viewer.clear();
  $('status-shot').hidden = true;
  for (const id of ['hint', 'compass', 'rail']) $(id).hidden = true;
  for (const id of ['st-parts', 'st-kinds', 'st-size', 'st-steps']) $(id).textContent = '–';
  $('h1').innerHTML = 'BRICKFORM<small>Brick Studio</small>';
  $('eyebrow').textContent = 'A photo and an idea become a brick model you can build.';
  $('card-sub').textContent = 'No model yet.';
  $('card-body').innerHTML = '';
  $('ref-shot').hidden = true;
  $('allBody').innerHTML = '';
  $('jobline').textContent = '';
  $('fresh').hidden = true;
  $('text').placeholder = 'What would you like to build? For example: my orange cat curled up in this photo.';
  working(false);
}

$('fresh').onclick = () => { if (!busy || confirm('This model is still being built. Start a new project anyway?')) reset(); };

/* ---------- 照片 ---------- */

/** 缩到长边 1536 像素的 JPEG：够 agent 看清，又不会把上传撑大。 */
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function take(file) {
  if (!file || !file.type.startsWith('image/')) return;
  photo = await shrink(file);
  $('thumb-img').src = photo;
  $('thumb').hidden = false;
}

$('pick').onclick = () => $('file').click();
$('file').addEventListener('change', event => take(event.target.files[0]));
$('thumb-x').onclick = () => { photo = null; $('thumb').hidden = true; $('file').value = ''; };
addEventListener('paste', event => {
  const item = [...(event.clipboardData?.files || [])][0];
  if (item) take(item);
});
for (const type of ['dragenter', 'dragover']) {
  addEventListener(type, event => { event.preventDefault(); document.body.classList.add('drop'); });
}
for (const type of ['dragleave', 'drop']) {
  addEventListener(type, event => { event.preventDefault(); document.body.classList.remove('drop'); });
}
addEventListener('drop', event => take(event.dataTransfer?.files[0]));

/* ---------- 发送 ---------- */

$('text').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('composer').requestSubmit();
});

$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const text = $('text').value.trim();
  if (!text && !photo) return;

  const body = { text, image: photo, size: $('size').value };
  const url = job ? `/api/jobs/${job}/messages` : '/api/jobs';
  working(true);
  $('text').value = '';
  if (!job) say('me', 'You', text, photo);     // 新任务的回显由服务端事件补上，但先让界面立刻有反应
  photo = null;
  $('thumb').hidden = true;
  $('file').value = '';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    if (!job) {
      job = data.id;
      localStorage.setItem('brickstudio.job', job);
      $('fresh').hidden = false;
      log.innerHTML = '';
      $('jobline').textContent = `Job ${job}`;
      listen(job);
    }
  } catch (error) {
    say('bot', 'Error', 'Could not submit: ' + error.message);
    working(false);
  }
});

/* ---------- 刷新后接回上一次 ---------- */

const previous = new URLSearchParams(location.search).get('job') || localStorage.getItem('brickstudio.job');
if (previous) {
  const state = await fetch(`/api/jobs/${previous}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (state) {
    job = previous;
    $('jobline').textContent = `Job ${job}`;
    $('fresh').hidden = false;
    working(state.busy);
    listen(job);
  } else {
    localStorage.removeItem('brickstudio.job');
  }
}
