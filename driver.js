
/* ---------------------------------------------------------------- Snapshot driver
 * The same interface as the live page, but the data comes from constants in this file:
 * no backend, and the transcript is read-only. */

const $ = id => document.getElementById(id);
const esc = text => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const log = $('log');

function append(node) {
  log.querySelector('.empty')?.remove();        // a snapshot needs no opening note; the transcript takes its place
  log.append(node);
  return node;
}

function zoom(src) { $('lightbox-img').src = src; $('lightbox').showModal(); }
$('lightbox').addEventListener('click', () => $('lightbox').close());

/** The agent writes **bold**, `inline code` and - lists. Set them properly here too. */
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
    const img = Object.assign(document.createElement('img'), { src: url, alt: 'Model render' });
    img.addEventListener('click', () => zoom(url));
    img.onerror = () => { img.remove(); if (!box.children.length) box.remove(); };  // the agent deletes its scratch renders
    box.append(img);
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

for (const event of __CHAT) {
  switch (event.type) {
    case 'user': say('me', 'You', event.text, event.image); break;
    case 'stage': stage(event.text); break;
    case 'assistant': say('bot', 'BRICKFORM', event.text); break;
    case 'thinking': traceLine('· ' + event.text); break;
    case 'tool': traceLine(event.text, event.error); break;
    case 'renders': shots(event.urls); break;
    case 'done': { const [text, ok] = doneLine(event); stage(text); log.lastElementChild.classList.add(ok ? 'done' : 'failed'); break; }
    case 'error': say('bot', 'Something broke', event.text); break;
  }
}

/* ---------- The composer: read-only ---------- */

$('composer').addEventListener('submit', event => event.preventDefault());
for (const id of ['text', 'send', 'pick', 'size']) $(id).disabled = true;
$('text').placeholder = 'This is an offline snapshot; the conversation ends here. To keep changing this model, go back to the live page.';
$('state').textContent = 'Offline snapshot';
$('jobline').textContent = `Job ${__JOB} · one file, pass it on as it is`;

/* ---------- The model ---------- */

const viewer = createClassic($('stage'), {
  onStep(k) { $('stepNo').textContent = k + 1; $('slider').value = k; },
});

$('status').hidden = false;
$('status').querySelector('b').textContent = 'Loading parts…';
$('status-note').textContent = '';

const info = await viewer.load(__MPD, __COLORS);
viewer.frame(35, 22);

$('status').hidden = true;
$('status-shot').hidden = true;
$('hint').hidden = $('compass').hidden = $('rail').hidden = false;
$('compass').textContent = __VALID ? 'Real parts · checked by BrickAgent' : 'Real parts · did not pass every check';
$('st-parts').textContent = info.parts.toLocaleString();
$('st-kinds').textContent = __PARTS.kinds;
$('st-size').textContent = `${__PARTS.size.studs[0]}×${__PARTS.size.studs[1]}`;
$('st-size').insertAdjacentHTML('beforeend', ` <span>studs · ${__PARTS.size.height_cm} cm tall</span>`);
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
$('card-body').innerHTML = `<span class="badge ${__VALID ? 'ok' : ''}">${__VALID ? 'No collisions · physically stable' : 'Rendered only, checks not passed'}</span>`;

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

/* ---------- Replay ---------- */

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

log.scrollTop = log.scrollHeight;            // a snapshot opens on the last thing it said
