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
    img.alt = '模型渲染';
    img.addEventListener('click', () => zoom(url));
    box.append(img);
  }
}

/** 还没有可交互的模型时，视口里先放 agent 刚渲出来的那张图。 */
function peek(url) {
  $('status').hidden = false;
  $('status-shot').src = url;
  $('status-shot').hidden = false;
  $('status').querySelector('b').textContent = '正在搭…';
  $('status-note').textContent = '这是它刚刚渲出来的样子，还在改。';
}

function zoom(src) {
  $('lightbox-img').src = src;
  $('lightbox').showModal();
}
$('lightbox').addEventListener('click', () => $('lightbox').close());

function working(on, note) {
  busy = on;
  $('send').disabled = on;
  $('state').textContent = note || (on ? '生成中…' : '闲置');
  $('state').classList.toggle('live', on);
  $('status-bar').hidden = !on;
  if (!model) {
    $('status').hidden = false;
    $('status').querySelector('b').textContent = on ? '正在搭…' : '上传一张照片，告诉我你想要什么';
    $('status-note').textContent = on
      ? '过程在下面的对话框里实时显示。'
      : '下面的对话框里写一句话就行。生成一个模型大约十来分钟，过程会实时显示。';
  }
}

/** 一轮结束时的收尾：说清楚到底出了什么，页面才不像还在跑。 */
function doneLine(event) {
  const cost = [];
  if (event.turns) cost.push(`${event.turns} 轮`);
  if (event.seconds) cost.push(`${Math.max(1, Math.round(event.seconds / 60))} 分钟`);
  if (event.cost) cost.push(`$${event.cost.toFixed(2)}`);
  if (event.changed === false) return ['这一轮没有改动模型 · ' + cost.join(' · '), false];
  if (!event.total) return ['这一轮没能做出模型 · ' + cost.join(' · '), false];
  const what = `${event.total} 个零件 · ${event.kinds} 种` + (event.valid ? ' · 无碰撞、物理稳定' : ' · 未通过完整检查');
  return [`搭好了 ${what}　${cost.join(' · ')}`, true];
}

/* ---------- 后端事件 ---------- */

function listen(id) {
  source?.close();
  source = new EventSource(`/api/jobs/${id}/events`);
  source.onmessage = event => handle(JSON.parse(event.data));
  source.onerror = () => { if (busy) $('state').textContent = '连接中断，正在重连…'; };
}

function handle(event) {
  switch (event.type) {
    case 'user': say('me', '你', event.text, event.image); break;
    case 'stage': stage(event.text); break;
    case 'assistant': say('bot', '砖语', event.text); break;
    case 'thinking': traceLine('· ' + event.text); break;
    case 'tool': traceLine(event.text, event.error); break;
    case 'renders': shots(event.urls); if (!model) peek(event.urls.at(-1)); break;
    case 'model': showModel(event); break;
    case 'result': stage(`模型搭完 · ${event.turns} 轮 · ${Math.round(event.seconds / 60)} 分钟 · $${event.cost.toFixed(2)}`); break;
    case 'done': { const [text, ok] = doneLine(event); stage(text).classList.add(ok ? 'done' : 'failed'); break; }
    case 'error': say('bot', '出错了', event.text); break;
    case 'idle': working(false); break;
    case 'busy': working(true); break;
  }
}

/* ---------- 展示模型 ---------- */

async function showModel(event) {
  $('status').hidden = false;
  $('status').querySelector('b').textContent = '正在载入零件…';
  $('status-note').textContent = '';
  try {
    const text = await fetch(event.mpd).then(response => {
      if (!response.ok) throw new Error('模型文件读不到');
      return response.text();
    });
    const info = await viewer.load(text, palette.colors);
    viewer.frame(35, 22);
    model = { mpd: event.mpd, manifest: event.manifest };

    $('status').hidden = true;
    $('status-shot').hidden = true;
    $('hint').hidden = $('compass').hidden = $('rail').hidden = false;
    $('compass').textContent = event.valid ? '真实零件 · 已通过 BrickAgent 检查' : '真实零件 · 未通过完整检查';
    $('st-parts').textContent = info.parts.toLocaleString();
    $('st-kinds').textContent = event.manifest.kinds;
    const size = event.manifest.size;
    $('st-size').textContent = `${size.studs[0]}×${size.studs[1]}`;
    $('st-size').insertAdjacentHTML('beforeend', ` <span>颗粒 · 高 ${size.height_cm} cm</span>`);
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
    $('card-body').innerHTML = `<span class="badge ${event.valid ? 'ok' : ''}">${event.valid ? '无碰撞 · 物理稳定' : '仅渲染，未通过检查'}</span>`;
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
    $('text').placeholder = '想改点什么？例如：把屋顶换成红色，再加一扇窗。';
  } catch (error) {
    $('status').querySelector('b').textContent = '模型载入失败';
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
function stop() { clearInterval(timer); timer = null; $('play').setAttribute('aria-pressed', 'false'); $('play').textContent = '播放'; }
$('prev').onclick = () => { stop(); viewer.setStep(viewer.step - 1); };
$('next').onclick = () => { stop(); viewer.setStep(viewer.step + 1); };
$('play').onclick = () => {
  if (timer) return stop();
  if (viewer.step >= viewer.maxStep) viewer.setStep(0);
  $('play').setAttribute('aria-pressed', 'true');
  $('play').textContent = '暂停';
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
  $('h1').innerHTML = '砖语<small>BrickStudio</small>';
  $('eyebrow').textContent = '拍一张照片，说一句话，变成真能搭出来的乐高';
  $('card-sub').textContent = '还没有模型。';
  $('card-body').innerHTML = '';
  $('ref-shot').hidden = true;
  $('allBody').innerHTML = '';
  $('jobline').textContent = '';
  $('fresh').hidden = true;
  $('text').placeholder = '想搭什么？例如：按这张照片搭我家的猫，姿势是趴着的，颜色偏橘。';
  working(false);
}

$('fresh').onclick = () => { if (!busy || confirm('这一轮还在跑，确定要丢下它另开一个？')) reset(); };

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
  if (!job) say('me', '你', text, photo);     // 新任务的回显由服务端事件补上，但先让界面立刻有反应
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
      $('jobline').textContent = `任务 ${job}`;
      listen(job);
    }
  } catch (error) {
    say('bot', '出错了', '没能提交：' + error.message);
    working(false);
  }
});

/* ---------- 刷新后接回上一次 ---------- */

const previous = new URLSearchParams(location.search).get('job') || localStorage.getItem('brickstudio.job');
if (previous) {
  const state = await fetch(`/api/jobs/${previous}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (state) {
    job = previous;
    $('jobline').textContent = `任务 ${job}`;
    $('fresh').hidden = false;
    working(state.busy);
    listen(job);
  } else {
    localStorage.removeItem('brickstudio.job');
  }
}
