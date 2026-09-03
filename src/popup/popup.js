import { send, el, applyChrome, formatRam, initTooltips, initToast, toast } from '../lib/ui.js';

const $ = (id) => document.getElementById(id);

let lastUndoable = false;

function renderMatrix(marks) {
  const box = $('matrix');
  box.textContent = '';
  const labels = { s: 'suspensa', l: 'carregada', p: 'protegida' };
  const classes = { s: 'suspended', l: 'loaded', p: 'protected' };
  (marks || []).slice(0, 84).forEach((mark, i) => {
    const cell = el('span', `cell ${classes[mark] || ''}`);
    cell.dataset.tip = labels[mark] || '';
    cell.style.animationDelay = `${Math.min(i * 7, 500)}ms`;
    box.appendChild(cell);
  });
}

function describe(data, kind) {
  const done = kind === 'archive' ? data.archived : data.count;
  const skipped = data.skipped || [];
  if (done) {
    const noun = done === 1 ? 'aba' : 'abas';
    let msg = `${done} ${noun} ${kind === 'archive' ? 'no cofre' : done === 1 ? 'suspensa' : 'suspensas'}`;
    if (skipped.length) msg += ` · ${skipped.length} de fora`;
    return msg;
  }
  if (skipped.length) {
    const reasons = [...new Set(skipped.map((s) => s.reason))];
    return `Nada mudou: ${reasons[0]}`;
  }
  return 'Nada aqui para mudar';
}

async function refresh() {
  const res = await send('getPopupState');
  if (!res.ok) {
    $('head-sub').textContent = 'o serviço não respondeu';
    return;
  }
  const s = res.data;
  applyChrome(s.settings);

  const suspended = s.totals.discarded;
  const offloaded = suspended + s.totals.vault;
  const protectedCount = s.marks.filter((m) => m === 'p').length;

  $('s-saved').textContent = formatRam(offloaded * s.settings.estimatedMbPerTab);
  $('s-saved-sub').textContent = `${offloaded} fora da memória · ${s.settings.estimatedMbPerTab} MB por aba`;
  $('s-discarded').textContent = suspended;
  $('s-loaded').textContent = s.totals.tabs - suspended - protectedCount;
  $('s-protected').textContent = protectedCount;
  $('head-sub').textContent = `${s.totals.tabs} abas · ${s.totals.windows} ${s.totals.windows === 1 ? 'janela' : 'janelas'}`;
  $('foot-note').textContent = `${s.totals.vault} no cofre · ${s.totals.recent} fechadas guardadas`;
  renderMatrix(s.marks);

  if (s.group) {
    $('group-box').classList.remove('hidden');
    $('group-dot').className = `dot ${s.group.color || 'grey'}`;
    $('group-name').textContent = s.group.title || 'grupo sem nome';
    $('group-count').textContent = `${s.group.count} ${s.group.count === 1 ? 'aba' : 'abas'}`;
  } else {
    $('group-box').classList.add('hidden');
  }
}

function bind(id, type, kind) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    const res = await send(type);
    $(id).disabled = false;
    if (!res.ok) return toast(res.error || 'o serviço não respondeu');
    const data = res.data || {};
    lastUndoable = !!data.undoable;
    $('undo').classList.toggle('hidden', !lastUndoable);
    toast(describe(data, kind), lastUndoable ? { undo: undo } : {});
    refresh();
  });
}

async function undo() {
  const res = await send('undoLast');
  if (!res.ok || !res.data.ok) toast((res.data && res.data.reason) || 'já não dá para desfazer');
  else toast(res.data.label || 'desfeito');
  $('undo').classList.add('hidden');
  refresh();
}

bind('suspend-current', 'suspendCurrent', 'suspend');
bind('suspend-window', 'suspendWindow', 'suspend');
bind('suspend-others', 'suspendOthers', 'suspend');
bind('suspend-group', 'suspendGroup', 'suspend');
bind('archive-group', 'archiveGroup', 'archive');
bind('archive-window', 'archiveWindow', 'archive');
bind('archive-others', 'archiveOthers', 'archive');

$('undo').addEventListener('click', undo);

$('dashboard').addEventListener('click', async () => {
  await send('openDashboard');
  window.close();
});

$('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.commands.getAll().then((list) => {
  const item = list.find((c) => c.name === '_execute_action');
  if (item && item.shortcut) $('kbd-dash').textContent = item.shortcut;
  else $('kbd-dash').textContent = 'sem atalho';
});

initTooltips();
initToast();
refresh();
