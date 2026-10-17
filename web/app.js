/** BRICKFORM: a photo plus one line -> a LEGO model. This page frames, talks and replays;
 *  the actual building happens in the BrickAgent container on the server. */
import { createClassic } from './classic.js';

const $ = id => document.getElementById(id);
const palette = await fetch('./colors.json').then(r => r.json());
const viewer = createClassic($('stage'), {
  onStep(k) { $('stepNo').textContent = k + 1; $('slider').value = k; },
});

let job = null;        // the job this conversation belongs to
let photo = null;      // photo waiting to be sent (data URL)
let busy = false;      // the backend is working
let source = null;     // SSE connection
let model = null;      // the current model's { mpd, manifest }

/* ---------- Model history, kept in this browser ---------- */

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
  $('history-count').textContent = `${entries.length} model${entries.length === 1 ? '' : 's'}`;
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
    savedAt.textContent = new Intl.DateTimeFormat('zh-CN', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(new Date(entry.savedAt));
    const parts = document.createElement('span');
    parts.textContent = `${Number(entry.parts || 0).toLocaleString()} parts`;
    const check = document.createElement('span');
    check.textContent = entry.valid ? 'passed the checks' : 'did not pass every check';
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
        if (!response.ok) throw new Error(response.status === 404 ? 'That job is no longer on this server.' : 'Cannot read that job right now.');
        const url = new URL(location.href);
        url.searchParams.set('job', entry.id);
        url.hash = 'result';
        location.assign(url);
      } catch (reason) {
        error.textContent = reason instanceof TypeError ? 'Cannot reach the server right now.' : reason.message;
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

/* ---------- Transcript ---------- */
/** The agent writes Markdown: **bold**, `inline code`, - lists. Escape first, then mark it up. */
function esc(text) {
  return text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

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
      const item = line.match(/^\s*[-*]\s+(.*)$/);     // a block can alternate between prose and list items
      if (item) { flushPara(); list.push(item[1]); } else { flushList(); para.push(line); }
    }
    flushPara(); flushList();
  }
  return out.join('');
}


const log = $('log');

function atBottom() {
  return log.scrollTop + log.clientHeight > log.scrollHeight - 60;
}

function append(node) {
  log.querySelector('.empty')?.remove();        // the opening note steps aside once the first message lands
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
  const body = el.querySelector('.body');
  if (kind === 'bot') { body.classList.add('rich'); body.innerHTML = rich(text); } else body.textContent = text;
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

/** Every command it runs is kept, but folded: the summary scrolls the latest line, open it for all of them. */
let raw = null, rawCount = 0;
function traceLine(text, isError) {
  if (!raw || !raw.isConnected) {                  // one per turn; renders landing in between do not split it
    raw = append(Object.assign(document.createElement('details'), { className: 'raw' }));
    raw.innerHTML = '<summary><span class="now"></span><span class="n"></span></summary><div class="trace"></div>';
    rawCount = 0;
  }
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  line.textContent = text;
  const stick = atBottom();
  const body = raw.querySelector('.trace');
  body.append(line);
  while (body.children.length > 200) body.firstChild.remove();
  body.scrollTop = body.scrollHeight;
  raw.querySelector('.now').textContent = text.replace(/^\s*↳\s*/, '');
  raw.querySelector('.n').textContent = `${++rawCount} lines`;
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

/** Until there is a model to turn, show the picture the agent just rendered. */
function peek(url) {
  $('status').hidden = false;
  $('status-shot').src = url;
  $('status-shot').hidden = false;
  $('status').querySelector('b').textContent = 'Building…';
  $('status-note').textContent = 'This is how it looks right now. It is still working.';
}

function zoom(src) {
  $('lightbox-img').src = src;
  $('lightbox').showModal();
}
$('lightbox').addEventListener('click', () => $('lightbox').close());

function working(on, note) {
  busy = on;
  $('progress').hidden = !on;          // while it runs, a progress strip sits above the transcript
  if (!on) runClock(false);
  $('send').disabled = on;
  $('state').textContent = note || (on ? 'Working…' : 'Idle');
  $('state').classList.toggle('live', on);
  $('status-bar').hidden = !on;
  if (!model) {
    $('status').hidden = false;
    $('status').querySelector('b').textContent = on ? 'Building…' : 'Upload a photo and tell me what you want';
    $('status-note').textContent = on
      ? 'You can watch it happen in the chat above.'
      : 'Write one line in the studio above. A model takes about ten minutes, and you can watch it happen.';
  }
}

/** How a turn ends: say plainly what came out, so the page does not look stuck. */
function doneLine(event) {
  const cost = [];
  if (event.turns) cost.push(`${event.turns} turns`);
  if (event.seconds) cost.push(`${Math.max(1, Math.round(event.seconds / 60))} min`);
  if (event.cost) cost.push(`$${event.cost.toFixed(2)}`);
  if (event.changed === false) return ['Nothing changed this time · ' + cost.join(' · '), false];
  if (!event.total) return ['No model came out of this one · ' + cost.join(' · '), false];
  const what = `${event.total} parts · ${event.kinds} kinds` + (event.valid ? ' · no collisions, physically stable' : ' · did not pass every check');
  return [`Built ${what}\u2003${cost.join(' · ')}`, true];
}

/* ---------- The ten minutes you wait ----------
 * It is not stuck. It is searching the part library, writing code, hitting errors and fixing them. Say so. */

const CELL = { look: 'search', search: 'search', write: 'write', build: 'build',
               fix: 'build', render: 'render', verify: 'verify', pack: 'verify' };
let started = 0, ticker = null, builds = 0, fixes = 0;
const seen = new Set();

function phase(name) {
  const cell = CELL[name];
  if (!cell) return;
  seen.add(cell);
  for (const li of document.querySelectorAll('.phases li')) {
    li.classList.toggle('seen', seen.has(li.dataset.cell));
    li.classList.toggle('now', li.dataset.cell === cell);
  }
}

function counts() {
  const bits = [];
  if (builds) bits.push(`assembly attempt ${builds}`);
  if (fixes) bits.push(`${fixes} fix${fixes === 1 ? '' : 'es'}`);
  $('pg-counts').textContent = bits.join(' · ');
}

function clock() {
  const s = Math.max(0, Math.round((Date.now() - started) / 1000));
  $('pg-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function runClock(on, from) {
  clearInterval(ticker);
  ticker = null;
  if (!on) return;
  started = from ? from * 1000 : Date.now();
  clock();
  ticker = setInterval(clock, 1000);
}

function resetProgress() {
  raw = null;
  seen.clear();
  builds = fixes = 0;
  counts();
  for (const li of document.querySelectorAll('.phases li')) li.classList.remove('seen', 'now');
  runClock(false);
}

/* ---------- Events from the backend ---------- */

function listen(id) {
  source?.close();
  source = new EventSource(`/api/jobs/${id}/events`);
  source.onmessage = event => handle(JSON.parse(event.data));
  source.onerror = () => { if (busy) $('state').textContent = 'Connection lost, reconnecting…'; };
}

function handle(event) {
  switch (event.type) {
    case 'user': say('me', 'You', event.text, event.image); break;
    case 'stage': stage(event.text); phase(event.phase); break;
    case 'assistant': say('bot', 'BRICKFORM', event.text); break;
    case 'thinking': traceLine('· ' + event.text); break;
    case 'tool':
      traceLine(event.text, event.error);
      if (event.phase === 'build') builds++;
      if (event.phase === 'fix') fixes++;
      phase(event.phase);
      if (event.phase === 'build' || event.phase === 'fix') counts();
      break;
    case 'renders': shots(event.urls); if (!model) peek(event.urls.at(-1)); break;
    case 'model': showModel(event); break;
    case 'result': stage(`Model written · ${event.turns} turns · ${Math.round(event.seconds / 60)} min · $${event.cost.toFixed(2)}`); break;
    case 'done': { const [text, ok] = doneLine(event); stage(text).classList.add(ok ? 'done' : 'failed'); break; }
    case 'error': say('bot', 'Something broke', event.text); break;
    case 'idle': working(false); break;
    case 'busy': resetProgress(); runClock(true, event.at); working(true); break;
  }
}

/* ---------- Showing the model ---------- */

async function showModel(event) {
  $('status').hidden = false;
  $('status').querySelector('b').textContent = 'Loading parts…';
  $('status-note').textContent = '';
  try {
    const text = await fetch(event.mpd).then(response => {
      if (!response.ok) throw new Error('Could not read the model file');
      return response.text();
    });
    const info = await viewer.load(text, palette.colors);
    viewer.frame(35, 22);
    model = { mpd: event.mpd, manifest: event.manifest };

    $('status').hidden = true;
    $('status-shot').hidden = true;
    $('hint').hidden = $('compass').hidden = $('rail').hidden = false;
    $('compass').textContent = event.valid ? 'Real parts · checked by BrickAgent' : 'Real parts · did not pass every check';
    $('st-parts').textContent = info.parts.toLocaleString();
    $('st-kinds').textContent = event.manifest.kinds;
    const size = event.manifest.size;
    $('st-size').textContent = `${size.studs[0]}×${size.studs[1]}`;
    $('st-size').insertAdjacentHTML('beforeend', ` <span>studs · ${size.height_cm} cm tall</span>`);
    $('st-steps').textContent = info.steps;
    $('stepMax').textContent = info.steps;
    $('slider').max = info.steps - 1;
    $('slider').value = info.steps - 1;

    if (event.card?.title) {
      $('h1').innerHTML = '';
      $('h1').textContent = event.card.title;
      if (event.card.subtitle) $('h1').insertAdjacentHTML('beforeend', `<small>${esc(event.card.subtitle)}</small>`);
    }
    if (event.card?.eyebrow) $('eyebrow').textContent = event.card.eyebrow;
    $('card-sub').textContent = event.card?.summary || '';
    $('card-body').innerHTML = `<span class="badge ${event.valid ? 'ok' : ''}">${event.valid ? 'No collisions · physically stable' : 'Rendered only, checks not passed'}</span>`;
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
    $('text').placeholder = 'Change anything? For example: make the roof red and add a window.';
    rememberModel(event, info);
  } catch (error) {
    $('status').querySelector('b').textContent = 'Could not load the model';
    $('status-note').textContent = error.message;
    console.error(error);
  }
}

/* ---------- Replay controls ---------- */

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

/* ---------- Starting over ---------- */

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
  $('h1').innerHTML = 'BRICKFORM<small>Photo to bricks</small>';
  $('eyebrow').textContent = 'Take a photo, say one line, get a model you can really build';
  $('card-sub').textContent = 'No model yet.';
  $('card-body').innerHTML = '';
  $('ref-shot').hidden = true;
  $('allBody').innerHTML = '';
  $('jobline').textContent = '';
  $('fresh').hidden = true;
  $('text').placeholder = 'What should it build? For example: my cat from this photo, lying down, mostly orange.';
  working(false);
}

$('fresh').onclick = () => { if (!busy || confirm('This one is still running. Leave it and start another?')) reset(); };

/* ---------- Photos ---------- */

/** Down to a 1536px JPEG: enough for the agent to see, small enough to upload. */
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

for (const eg of document.querySelectorAll('.eg')) {
  eg.onclick = () => { $('text').value = eg.textContent; $('text').focus(); };
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

/* ---------- Sending ---------- */

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
  if (!job) say('me', 'You', text, photo);     // the server echoes this back, but show it at once so the page reacts
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
    say('bot', 'Something broke', 'Could not submit: ' + error.message);
    working(false);
  }
});

/* ---------- Picking up after a refresh ----------
 * Only a job still running comes back by itself: that is the one you closed the page on and kept
 * thinking about. A finished one should not replay every time; the page opens clean and leaves
 * one way back into it. */

function resume(id) {
  job = id;
  localStorage.setItem('brickstudio.job', id);
  $('jobline').textContent = `Job ${id}`;
  $('fresh').hidden = false;
  listen(id);
}

/** The last one is finished: do not interrupt, just leave a line that goes back to it. */
function offerResume(id) {
  const empty = log.querySelector('.empty');
  if (!empty) return;
  const line = document.createElement('p');
  line.className = 'fine resume';
  line.innerHTML = 'Your last model is finished · ';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'eg';
  open.textContent = 'Open it';
  open.onclick = () => { log.innerHTML = ''; working(false); resume(id); };
  line.append(open);
  empty.append(line);
}

const asked = new URLSearchParams(location.search).get('job');
const previous = asked || localStorage.getItem('brickstudio.job');
if (previous) {
  const state = await fetch(`/api/jobs/${previous}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!state) {
    localStorage.removeItem('brickstudio.job');
  } else if (asked || state.busy) {
    working(state.busy);
    resume(previous);
  } else {
    offerResume(previous);
  }
}
