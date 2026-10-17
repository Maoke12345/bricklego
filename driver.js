
/* ---------------------------------------------------------------- 快照驱动
 * 和线上版同一套界面，只是数据来自文件里的常量：没有后端，对话是只读的。 */

const $ = id => document.getElementById(id);
const esc = text => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const log = $('log');

function append(node) { log.append(node); return node; }

function zoom(src) { $('lightbox-img').src = src; $('lightbox').showModal(); }
$('lightbox').addEventListener('click', () => $('lightbox').close());

/** agent 的回复里有 **粗体** 和 - 列表，快照里顺手排一下版。 */
function rich(text) {
  const html = esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out = [];
  for (const block of html.split(/\n{2,}/)) {
    let para = [], list = [];
    const flushPara = () => { if (para.length) out.push(`<p>${para.join('<br>')}</p>`), para = []; };
    const flushList = () => { if (list.length) out.push(`<ul>${list.map(i => `<li>${i}</li>`).join('')}</ul>`), list = []; };
    for (const line of block.split('\n')) {
      const item = line.match(/^\s*[-*]\s+(.*)$/);     // 段落和列表可以在同一块里交替
      if (item) { flushPara(); list.push(item[1]); } else { flushList(); para.push(line); }
    }
    flushPara(); flushList();
  }
  return out.join('');
}

function say(kind, who, text, image) {
  const el = append(Object.assign(document.createElement('div'), { className: `msg ${kind}` }));
  el.innerHTML = `<span class="who">${esc(who)}</span><div class="body"></div>`;
  const body = el.querySelector('.body');
  if (kind === 'bot') body.innerHTML = rich(text); else body.textContent = text;
  if (image) {
    const img = Object.assign(document.createElement('img'), { className: 'shot', src: image });
    img.addEventListener('click', () => zoom(image));
    el.append(img);
  }
}

function stage(text) {
  append(Object.assign(document.createElement('div'), { className: 'stage-line', textContent: text }));
}

let trace = null;
function traceLine(text, isError) {
  if (trace !== log.lastElementChild) trace = append(Object.assign(document.createElement('div'), { className: 'trace' }));
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  line.textContent = text;
  trace.append(line);
}

function shots(urls) {
  const box = append(Object.assign(document.createElement('div'), { className: 'renders' }));
  for (const url of urls) {
    const img = Object.assign(document.createElement('img'), { src: url, alt: '模型渲染' });
    img.addEventListener('click', () => zoom(url));
    box.append(img);
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

for (const event of __CHAT) {
  switch (event.type) {
    case 'user': say('me', '你', event.text, event.image); break;
    case 'stage': stage(event.text); break;
    case 'assistant': say('bot', '砖语', event.text); break;
    case 'thinking': traceLine('· ' + event.text); break;
    case 'tool': traceLine(event.text, event.error); break;
    case 'renders': shots(event.urls); break;
    case 'done': { const [text, ok] = doneLine(event); stage(text); log.lastElementChild.classList.add(ok ? 'done' : 'failed'); break; }
    case 'error': say('bot', '出错了', event.text); break;
  }
}

/* ---------- 对话框：只读 ---------- */

$('composer').addEventListener('submit', event => event.preventDefault());
for (const id of ['text', 'send', 'pick', 'size']) $(id).disabled = true;
$('text').placeholder = '这是一份离线快照，对话到此为止。要接着改这个模型，得回到在线版。';
$('state').textContent = '离线快照';
$('jobline').textContent = `任务 ${__JOB} · 单文件，可以直接转发`;

/* ---------- 模型 ---------- */

const viewer = createClassic($('stage'), {
  onStep(k) { $('stepNo').textContent = k + 1; $('slider').value = k; },
});

$('status').hidden = false;
$('status').querySelector('b').textContent = '正在载入零件…';
$('status-note').textContent = '';

const info = await viewer.load(__MPD, __COLORS);
viewer.frame(35, 22);

$('status').hidden = true;
$('status-shot').hidden = true;
$('hint').hidden = $('compass').hidden = $('rail').hidden = false;
$('compass').textContent = __VALID ? '真实零件 · 已通过 BrickAgent 检查' : '真实零件 · 未通过完整检查';
$('st-parts').textContent = info.parts.toLocaleString();
$('st-kinds').textContent = __PARTS.kinds;
$('st-size').textContent = `${__PARTS.size.studs[0]}×${__PARTS.size.studs[1]}`;
$('st-size').insertAdjacentHTML('beforeend', ` <span>颗粒 · 高 ${__PARTS.size.height_cm} cm</span>`);
$('st-steps').textContent = info.steps;
$('stepMax').textContent = info.steps;
$('slider').max = info.steps - 1;
$('slider').value = info.steps - 1;

if (__CARD.title) {
  $('h1').textContent = __CARD.title;
  if (__CARD.subtitle) $('h1').insertAdjacentHTML('beforeend', `<small>${esc(__CARD.subtitle)}</small>`);
}
if (__CARD.eyebrow) $('eyebrow').textContent = __CARD.eyebrow;
$('card-sub').textContent = __CARD.summary || '';
$('card-body').innerHTML = `<span class="badge ${__VALID ? 'ok' : ''}">${__VALID ? '无碰撞 · 物理稳定' : '仅渲染，未通过检查'}</span>`;
if (__REF) { $('ref-shot').src = __REF; $('ref-shot').hidden = false; }

const body = $('allBody');
for (const row of __PARTS.rows) {
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

/* ---------- 回放 ---------- */

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
$('dl').onclick = () => {
  const url = URL.createObjectURL(new Blob([__MPD], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${__CARD.title || __JOB}.mpd` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
addEventListener('keydown', event => {
  if (event.target.matches('textarea, input, select')) return;
  if (event.key.toLowerCase() === 'f') viewer.frame(35, 22);
});

log.scrollTop = log.scrollHeight;            // 快照直接停在最后那条回复上
