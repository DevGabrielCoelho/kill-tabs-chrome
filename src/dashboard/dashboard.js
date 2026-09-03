import { groupKeyOf, splitGroupKey, hostOf } from '../lib/util.js';
import {
  send,
  el,
  applyChrome,
  formatRam,
  relTime,
  liveTime,
  resetClocks,
  highlight,
  faviconNode,
  initTooltips,
  initToast,
  toast,
  withTransition,
  bindKeys,
  openPalette,
  openSheet,
  closeOverlay
} from '../lib/ui.js';

const $ = (id) => document.getElementById(id);

let state = null;
let view = 'open';
let query = '';
let cursor = 0;
let lastPicked = -1;
let rowModel = [];
let ready = false;
const selection = new Set();
const cardOf = new Map();

const VIEWS = {
  open: { title: 'Abas abertas', prefix: 't:' },
  vault: { title: 'Cofre', prefix: 'v:' },
  recent: { title: 'Últimas fechadas', prefix: 'r:' }
};

function prefix() {
  return VIEWS[view].prefix;
}

function matches(text) {
  if (!query) return true;
  return String(text || '').toLowerCase().includes(query);
}

function isProtected(tab) {
  return !!tab.skipReason && tab.skipReason !== 'aba ativa' && tab.skipReason !== 'ja suspensa';
}

function stateMode() {
  return $('filter-state').value;
}

function orderMode() {
  return $('filter-order').value;
}

function passesState(tab) {
  const mode = stateMode();
  if (mode === 'all') return true;
  if (mode === 'suspended') return !!tab.discarded;
  if (mode === 'active') return !tab.discarded;
  if (mode === 'protected') return isProtected(tab);
  return true;
}

function sortBy(list, stampOf) {
  const mode = orderMode();
  const copy = [...list];
  if (mode === 'recent') return copy.sort((a, b) => (stampOf(b) || 0) - (stampOf(a) || 0));
  if (mode === 'stale') return copy.sort((a, b) => (stampOf(a) || 0) - (stampOf(b) || 0));
  if (mode === 'title') return copy.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
  return copy;
}

function saveUi(patch) {
  send('saveUiState', { patch });
}

function describe(data, kind) {
  const done = kind === 'archive' ? data.archived : kind === 'restore' ? data.opened : data.count;
  const skipped = data.skipped || [];
  const noun = done === 1 ? 'aba' : 'abas';
  const verb =
    kind === 'archive' ? 'no cofre' : kind === 'restore' ? (done === 1 ? 'reaberta' : 'reabertas') : done === 1 ? 'suspensa' : 'suspensas';
  if (done) {
    let msg = `${done} ${noun} ${verb}`;
    if (skipped.length) {
      msg += ` · ${skipped.length} de fora: ${skipped[0].reason}`;
    }
    return msg;
  }
  if (skipped.length) {
    const reasons = [...new Set(skipped.map((s) => s.reason))];
    return reasons.length === 1
      ? `Nada mudou: ${reasons[0]}`
      : `Nada mudou: ${reasons[0]} e mais ${reasons.length - 1} motivo(s)`;
  }
  return 'Nada aqui para mudar';
}

async function undoNow() {
  const res = await send('undoLast');
  if (!res.ok || !res.data.ok) {
    toast((res.data && res.data.reason) || 'já não é possível desfazer isso');
  } else {
    toast(res.data.label || 'desfeito');
  }
  await load();
}

async function act(type, payload, options = {}) {
  if (options.optimistic) {
    options.optimistic();
    render();
  }
  const res = await send(type, payload);
  if (!res.ok) {
    toast(res.error || 'o serviço não respondeu');
    await load();
    return res;
  }
  const data = res.data || {};
  const message = options.message ? options.message(data) : null;
  if (message) {
    if (data.undoable) toast(message, { undo: undoNow });
    else toast(message);
  }
  await load();
  return res;
}

function checkbox(key, index) {
  const box = el('input');
  box.type = 'checkbox';
  box.checked = selection.has(key);
  box.setAttribute('aria-label', 'Selecionar');
  box.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (ev.shiftKey && lastPicked !== -1) {
      const [from, to] = index < lastPicked ? [index, lastPicked] : [lastPicked, index];
      for (let i = from; i <= to; i++) selection.add(prefix() + rowModel[i].id);
    } else if (box.checked) {
      selection.add(key);
    } else {
      selection.delete(key);
    }
    lastPicked = index;
    render();
  });
  return box;
}

function actionButton(label, className, handler, tip) {
  const btn = el('button', className, label);
  if (tip) btn.dataset.tip = tip;
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    btn.disabled = true;
    await handler();
    btn.disabled = false;
  });
  return btn;
}

let dragPayload = null;

function clearMarkers() {
  for (const node of document.querySelectorAll('.drop-before, .drop-end')) {
    node.classList.remove('drop-before', 'drop-end');
  }
}

function rowAfterPoint(rows, y) {
  for (const row of rows) {
    if (row.classList.contains('dragging')) continue;
    const box = row.getBoundingClientRect();
    if (y < box.top + box.height / 2) return row;
  }
  return null;
}

function makeDraggable(row, kind, id) {
  row.draggable = true;
  row.dataset.kind = kind;
  row.addEventListener('dragstart', (ev) => {
    const key = (kind === 'tab' ? 't:' : 'v:') + id;
    let ids = [String(id)];
    if (selection.has(key) && selection.size > 1) {
      const picked = [...selection].filter((k) => k.startsWith(kind === 'tab' ? 't:' : 'v:')).map((k) => k.slice(2));
      if (picked.length) ids = picked;
    }
    dragPayload = { kind, ids };
    row.classList.add('dragging');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', ids.join(','));
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    dragPayload = null;
    clearMarkers();
  });
}

function wireDropZone(container, target) {
  const accepts = () => dragPayload && dragPayload.kind === target.kind;
  container.addEventListener('dragover', (ev) => {
    if (!accepts()) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    clearMarkers();
    const rows = [...container.querySelectorAll('.item')];
    const after = rowAfterPoint(rows, ev.clientY);
    if (after) after.classList.add('drop-before');
    else container.classList.add('drop-end');
  });
  container.addEventListener('dragleave', (ev) => {
    if (!container.contains(ev.relatedTarget)) clearMarkers();
  });
  container.addEventListener('drop', (ev) => {
    if (!accepts()) return;
    ev.preventDefault();
    const rows = [...container.querySelectorAll('.item')];
    const after = rowAfterPoint(rows, ev.clientY);
    const beforeId = after ? after.dataset.id : null;
    const payload = dragPayload;
    dragPayload = null;
    clearMarkers();
    if (!payload) return;
    if (payload.kind === 'tab') {
      act(
        'moveTabs',
        {
          ids: payload.ids.map(Number),
          windowId: target.windowId,
          targetGroupId: target.groupId,
          beforeTabId: beforeId ? Number(beforeId) : null
        },
        { message: (d) => `${d.moved === 1 ? 'aba movida' : `${d.moved} abas movidas`}` }
      );
    } else {
      act(
        'moveVaultEntries',
        { ids: payload.ids, targetKey: target.groupKey, beforeId },
        { message: () => 'ordem atualizada' }
      );
    }
    selection.clear();
  });
}

function nameNode(text, className) {
  const node = el('div', className);
  node.appendChild(highlight(text, query));
  return node;
}

function baseRow(key, index, entry, opts) {
  const row = el('div', 'item');
  row.dataset.key = key;
  row.dataset.id = entry.id;
  row.setAttribute('role', 'listitem');
  row.tabIndex = -1;
  if (index === cursor) row.classList.add('cursor');
  if (selection.has(key)) row.classList.add('picked');
  if (opts.draggable) makeDraggable(row, opts.draggable, entry.id);
  if (opts.transitionName) row.style.viewTransitionName = opts.transitionName;

  row.addEventListener('pointerdown', () => {
    cursor = index;
  });

  if (opts.draggable) row.appendChild(el('span', 'grip', '⠿'));
  row.appendChild(checkbox(key, index));
  row.appendChild(faviconNode(entry.favIconUrl, entry.url));

  const main = el('div', 'main');
  main.appendChild(nameNode(entry.title || entry.url, `name truncate${opts.editable ? ' editable' : ''}`));
  main.appendChild(nameNode(entry.url, 'url truncate'));
  row.appendChild(main);
  return row;
}

function tabRow(tab, index) {
  const key = `t:${tab.id}`;
  const row = baseRow(key, index, tab, { draggable: 'tab', transitionName: `tab-${tab.id}` });

  if (tab.discarded) row.appendChild(el('span', 'chip on', 'suspensa'));
  else if (isProtected(tab)) row.appendChild(el('span', 'chip mark-state', tab.skipReason));
  if (tab.lastActive) row.appendChild(liveTime(el('span', 'chip'), tab.lastActive));

  const acts = el('div', 'acts');
  acts.appendChild(
    actionButton('Ir', 'tiny', () => act('focusTab', { id: tab.id }), 'Focar esta aba no navegador')
  );
  if (!tab.discarded) {
    acts.appendChild(
      actionButton(
        'Suspender',
        'tiny',
        () =>
          act('suspendTabs', { ids: [tab.id] }, {
            optimistic: () => {
              tab.discarded = true;
            },
            message: (d) => describe(d, 'suspend')
          }),
        'Libera a RAM e mantém a aba na barra'
      )
    );
  }
  acts.appendChild(
    actionButton(
      'Arquivar',
      'tiny warn',
      () => act('archiveTabsById', { ids: [tab.id] }, { message: (d) => describe(d, 'archive') }),
      'Fecha a aba e guarda no cofre com o grupo'
    )
  );
  row.appendChild(acts);
  return row;
}

async function commitRename(entry, value) {
  const res = await send('renameEntry', { id: entry.id, title: value });
  if (!res.ok || !res.data.ok) {
    toast((res.data && res.data.reason) || 'esse nome não deu');
  } else {
    toast(res.data.reverted ? 'nome original de volta' : 'nome atualizado', { undo: undoNow });
  }
  await load();
}

function startRename(nameEl, entry) {
  if (nameEl.dataset.editing === '1') return;
  nameEl.dataset.editing = '1';
  const owner = nameEl.closest('.item');
  if (owner) owner.draggable = false;
  const input = el('input', 'rename-input');
  input.type = 'text';
  input.value = entry.title || '';
  input.placeholder = 'nome novo: vazio volta ao título original';
  input.maxLength = 300;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) commitRename(entry, input.value);
    else load();
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function vaultRow(entry, index) {
  const key = `v:${entry.id}`;
  const row = baseRow(key, index, entry, {
    draggable: 'vault',
    editable: true,
    transitionName: `vault-${entry.id}`
  });
  const nameEl = row.querySelector('.name');
  nameEl.dataset.tip = 'Duplo clique renomeia';
  nameEl.addEventListener('dblclick', () => startRename(nameEl, entry));

  if (entry.originalTitle) {
    const chip = el('span', 'chip', 'renomeada');
    chip.dataset.tip = `Original: ${entry.originalTitle}`;
    row.appendChild(chip);
  }
  row.appendChild(liveTime(el('span', 'chip'), entry.archivedAt, 'guardada há'));
  if (entry.restoredAt) row.appendChild(el('span', 'chip on', 'aberta de novo'));

  const acts = el('div', 'acts');
  acts.appendChild(
    actionButton('Renomear', 'tiny', async () => startRename(nameEl, entry))
  );
  acts.appendChild(
    actionButton(
      'Abrir',
      'tiny primary',
      () =>
        act(
          'restore',
          { ids: [entry.id], suspended: $('restore-suspended').checked, removeFromVault: $('restore-remove').checked },
          { message: (d) => describe(d, 'restore') }
        ),
      'Reabre no grupo de origem'
    )
  );
  acts.appendChild(
    actionButton('Excluir', 'tiny warn', () =>
      act('deleteEntries', { ids: [entry.id] }, { message: () => 'removida do cofre' })
    )
  );
  row.appendChild(acts);
  return row;
}

function recentRow(entry, index) {
  const key = `r:${entry.id}`;
  const row = baseRow(key, index, entry, { transitionName: `recent-${entry.id}` });

  row.appendChild(liveTime(el('span', 'chip'), entry.closedAt, 'fechada há'));
  if (entry.lastActive) row.appendChild(liveTime(el('span', 'chip'), entry.lastActive, 'usada há'));
  if (entry.wasDiscarded) row.appendChild(el('span', 'chip mark-state', 'já estava suspensa'));
  if (entry.reopenedAt) row.appendChild(el('span', 'chip on', 'aberta de novo'));

  const acts = el('div', 'acts');
  acts.appendChild(
    actionButton(
      'Reabrir',
      'tiny primary',
      () =>
        act(
          'reopenRecent',
          { ids: [entry.id], suspended: $('recent-suspended').checked, keepInList: $('recent-keep').checked },
          { message: (d) => describe(d, 'restore') }
        ),
      'Volta para o grupo de origem'
    )
  );
  acts.appendChild(
    actionButton('Pro cofre', 'tiny', () =>
      act('archiveRecent', { ids: [entry.id] }, { message: (d) => (d.added ? 'guardada no cofre' : 'já estava no cofre') })
    )
  );
  acts.appendChild(
    actionButton('Excluir', 'tiny warn', () =>
      act('deleteRecent', { ids: [entry.id] }, { message: () => 'fora do histórico' })
    )
  );
  row.appendChild(acts);
  return row;
}

const CHUNK = 50;
const FILL_MARGIN = 420;

function materialize(card) {
  if (card.dataset.filled === '1') return;
  card.dataset.filled = '1';
  const rows = card.querySelector('.rows');
  rows.textContent = '';
  const { list, factory, offset } = card.__payload;

  let at = 0;
  const sentinel = el('div', 'sentinel');
  rows.appendChild(sentinel);

  const step = () => {
    const slice = list.slice(at, at + CHUNK);
    slice.forEach((entry, i) => rows.insertBefore(factory(entry, offset + at + i), sentinel));
    at += slice.length;
    if (at >= list.length) sentinel.remove();
  };

  sentinel.__step = step;
  card.__fillAll = () => {
    while (at < list.length) step();
  };

  step();
}

function reached(node) {
  return node.getBoundingClientRect().top < window.innerHeight + FILL_MARGIN;
}

function fillVisible() {
  for (const card of document.querySelectorAll('.card:not([data-filled="1"])')) {
    if (reached(card)) materialize(card);
  }
  for (let guard = 0; guard < 200; guard++) {
    const sentinel = [...document.querySelectorAll('.sentinel')].find((node) => node.__step && reached(node));
    if (!sentinel) break;
    sentinel.__step();
  }
}

function card(headNodes, list, factory, offset, dropTarget) {
  const box = el('div', 'card');
  const head = el('div', 'card-head');
  for (const node of headNodes) head.appendChild(node);
  box.appendChild(head);

  const rows = el('div', 'rows');
  box.appendChild(rows);
  box.__payload = { list, factory, offset };

  if (list.length > 12) {
    const placeholder = el('div', 'lazy');
    placeholder.style.height = `${Math.min(list.length, CHUNK) * 40}px`;
    rows.appendChild(placeholder);
  } else {
    materialize(box);
  }

  for (const entry of list) cardOf.set(prefix() + entry.id, box);
  if (dropTarget) wireDropZone(box, dropTarget);
  return box;
}

function groupHead(title, color, count, extra) {
  const head = [];
  head.push(el('span', `dot ${color || 'grey'}`));
  head.push(el('span', 'title truncate', title));
  head.push(el('span', 'chip', String(count)));
  if (extra) head.push(extra);
  return head;
}

function windowLabel(tabs, index, groupsById) {
  const counts = new Map();
  for (const tab of tabs) {
    const g = groupsById.get(tab.groupId);
    if (g && g.title) {
      counts.set(g.title, (counts.get(g.title) || 0) + 1);
      continue;
    }
    if (!/^https?:/i.test(tab.url || '')) continue;
    const host = hostOf(tab.url).replace(/^www\./, '');
    if (host) counts.set(host, (counts.get(host) || 0) + 1);
  }
  let best = null;
  for (const [label, n] of counts) {
    if (!best || n > best[1]) best = [label, n];
  }
  const suffix = `${tabs.length} ${tabs.length === 1 ? 'aba' : 'abas'}`;
  if (!best || best[1] < 2) return `Janela ${index} · ${suffix}`;
  return `Janela de ${best[0]} · ${suffix}`;
}

function emptyState(title, text, actionLabel, action) {
  const box = el('div', 'empty');
  box.appendChild(el('h2', '', title));
  box.appendChild(el('p', '', text));
  if (actionLabel) box.appendChild(actionButton(actionLabel, 'primary', action));
  return box;
}

function renderOpen(content) {
  const groupsById = new Map(state.groups.map((g) => [g.id, g]));
  const visible = state.tabs.filter((t) => {
    if (!passesState(t)) return false;
    const g = groupsById.get(t.groupId);
    return matches(t.title) || matches(t.url) || (g && matches(g.title));
  });

  rowModel = [];
  if (!visible.length) {
    content.appendChild(
      query
        ? emptyState('Nada com esse filtro', `Nenhuma aba aberta casa com "${query}". Limpe o filtro para ver todas.`, 'Limpar filtro', () => {
            $('search').value = '';
            query = '';
            render();
          })
        : emptyState(
            'Nenhuma aba nesse estado',
            'O filtro de estado está escondendo tudo. Volte para "todas" para ver a barra inteira.',
            'Ver todas',
            () => {
              $('filter-state').value = 'all';
              render();
            }
          )
    );
    return;
  }

  const byWindow = new Map();
  for (const tab of visible) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }

  let windowIndex = 0;
  for (const [windowId, tabs] of byWindow) {
    windowIndex++;
    const label = el('div', 'window-label');
    label.appendChild(el('span', '', windowLabel(tabs, windowIndex, groupsById)));
    content.appendChild(label);

    const buckets = new Map();
    for (const tab of tabs) {
      const key = tab.groupId === undefined || tab.groupId === -1 ? 'none' : String(tab.groupId);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(tab);
    }

    for (const [key, raw] of buckets) {
      const list = sortBy(raw, (t) => t.lastActive).sort((a, b) => (orderMode() === 'natural' ? a.index - b.index : 0));
      const g = key === 'none' ? null : groupsById.get(Number(key));
      const acts = el('div', 'acts');
      const ids = list.map((t) => t.id);
      acts.appendChild(
        actionButton('Suspender', 'tiny', () =>
          act('suspendTabs', { ids }, { message: (d) => describe(d, 'suspend') })
        )
      );
      acts.appendChild(
        actionButton('Arquivar', 'tiny warn', () =>
          act('archiveTabsById', { ids }, { message: (d) => describe(d, 'archive') })
        )
      );
      const head = groupHead(
        g ? g.title || 'grupo sem nome' : 'fora de grupo',
        g ? g.color : 'grey',
        list.length,
        g && g.collapsed ? el('span', 'chip', 'colapsado') : null
      );
      head.push(acts);

      const offset = rowModel.length;
      rowModel.push(...list);
      content.appendChild(
        card(head, list, tabRow, offset, { kind: 'tab', windowId, groupId: key === 'none' ? -1 : Number(key) })
      );
    }
  }
}

function bucketByGroup(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    const key = groupKeyOf(entry.groupTitle, entry.groupColor);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  return [...buckets.entries()].sort((a, b) => (a[0] ? (b[0] ? 0 : -1) : 1));
}

function renderVault(content) {
  const entries = sortBy(
    state.vault.entries.filter(
      (e) => matches(e.title) || matches(e.url) || matches(e.groupTitle) || matches(e.originalTitle)
    ),
    (e) => e.archivedAt
  );

  rowModel = [];
  if (!entries.length) {
    content.appendChild(
      query
        ? emptyState('Nada com esse filtro', `O cofre não tem nada com "${query}".`, 'Limpar filtro', () => {
            $('search').value = '';
            query = '';
            render();
          })
        : emptyState(
            'O cofre está vazio',
            `Abas paradas há ${state.settings.archiveDays} dias entram aqui sozinhas, com o grupo de origem. Você também pode mandar um grupo agora.`,
            'Ver as abas abertas',
            () => switchView('open')
          )
    );
    return;
  }

  for (const [key, raw] of bucketByGroup(entries)) {
    const list = raw;
    const { title, color } = splitGroupKey(key);
    const ids = list.map((e) => e.id);
    const acts = el('div', 'acts');
    acts.appendChild(
      actionButton('Restaurar', 'tiny primary', () =>
        act(
          'restore',
          { ids, suspended: $('restore-suspended').checked, removeFromVault: $('restore-remove').checked },
          { message: (d) => describe(d, 'restore') }
        )
      )
    );
    acts.appendChild(
      actionButton('Excluir', 'tiny warn', () =>
        act('deleteEntries', { ids }, { message: (d) => `${d.removed} fora do cofre` })
      )
    );
    const head = groupHead(key ? title || 'grupo sem nome' : 'fora de grupo', key ? color : 'grey', list.length);
    head.push(acts);

    const offset = rowModel.length;
    rowModel.push(...list);
    content.appendChild(card(head, list, vaultRow, offset, { kind: 'vault', groupKey: key }));
  }
}

function renderRecent(content) {
  rowModel = [];
  if (!state.settings.recentLimit) {
    content.appendChild(
      emptyState(
        'Histórico desligado',
        'O Kill Tabs não está guardando as abas que você fecha. Escolha quantas quer guardar (até 100) nas configurações.',
        'Abrir configurações',
        () => chrome.runtime.openOptionsPage()
      )
    );
    return;
  }

  const entries = sortBy(
    state.recent.filter((e) => matches(e.title) || matches(e.url) || matches(e.groupTitle)),
    (e) => e.closedAt
  );

  if (!entries.length) {
    content.appendChild(
      query
        ? emptyState('Nada com esse filtro', `Nenhuma aba fechada casa com "${query}".`, 'Limpar filtro', () => {
            $('search').value = '';
            query = '';
            render();
          })
        : emptyState(
            'Você ainda não fechou nada',
            `As próximas ${state.settings.recentLimit} abas que você fechar ficam aqui, com o grupo de origem, prontas para voltar.`,
            'Ver as abas abertas',
            () => switchView('open')
          )
    );
    return;
  }

  for (const [key, list] of bucketByGroup(entries)) {
    const { title, color } = splitGroupKey(key);
    const ids = list.map((e) => e.id);
    const acts = el('div', 'acts');
    acts.appendChild(
      actionButton('Reabrir', 'tiny primary', () =>
        act(
          'reopenRecent',
          { ids, suspended: $('recent-suspended').checked, keepInList: $('recent-keep').checked },
          { message: (d) => describe(d, 'restore') }
        )
      )
    );
    acts.appendChild(
      actionButton('Excluir', 'tiny warn', () =>
        act('deleteRecent', { ids }, { message: (d) => `${d.removed} fora do histórico` })
      )
    );
    const head = groupHead(key ? title || 'grupo sem nome' : 'fora de grupo', key ? color : 'grey', list.length);
    head.push(acts);

    const offset = rowModel.length;
    rowModel.push(...list);
    content.appendChild(card(head, list, recentRow, offset));
  }
}

function renderMatrix() {
  const box = $('matrix');
  box.textContent = '';
  const list = state.tabs.slice(0, 160);
  list.forEach((tab, i) => {
    const cell = el('span', 'cell');
    let label;
    if (tab.discarded) {
      cell.classList.add('suspended');
      label = 'suspensa';
    } else if (isProtected(tab)) {
      cell.classList.add('protected');
      label = tab.skipReason;
    } else {
      cell.classList.add('loaded');
      label = 'carregada';
    }
    cell.dataset.tip = `${tab.title || tab.url}: ${label}`;
    if (!ready) cell.style.animationDelay = `${Math.min(i * 8, 700)}ms`;
    else cell.style.animation = 'none';
    box.appendChild(cell);
  });
}

function barRow(row, max, index) {
  const node = el('div', 'bar-row');
  const name = el('div', 'bar-name');
  name.appendChild(el('span', `dot ${row.color}`));
  name.appendChild(el('span', 'truncate', row.label));
  name.dataset.tip = row.label;
  node.appendChild(name);

  const track = el('div', 'bar-track');
  const fill = el('div', 'bar-fill');
  const segs = [
    { cls: 's1', value: row.a, word: 'suspensa(s)' },
    { cls: 's2', value: row.b, word: 'carregada(s)' }
  ];
  for (const seg of segs) {
    if (!seg.value) continue;
    const bar = el('span', `bar-seg ${seg.cls}`);
    bar.style.flex = `0 0 ${(seg.value / max) * 100}%`;
    bar.dataset.tip = `${row.label}: ${seg.value} ${seg.word}`;
    if (!ready) bar.style.animationDelay = `${index * 45}ms`;
    else bar.style.animation = 'none';
    fill.appendChild(bar);
  }
  track.appendChild(fill);
  track.appendChild(el('span', 'bar-count num', String(row.a + row.b)));
  node.appendChild(track);
  return node;
}

function renderBars() {
  const box = $('bars');
  const legend = $('bars-legend');
  box.textContent = '';
  legend.textContent = '';
  const rows = [];

  if (view === 'open') {
    $('bars-title').textContent = 'Grupos na barra';
    const groupsById = new Map(state.groups.map((g) => [g.id, g]));
    const buckets = new Map();
    for (const tab of state.tabs) {
      const key = tab.groupId === undefined || tab.groupId === -1 ? 'none' : String(tab.groupId);
      if (!buckets.has(key)) buckets.set(key, { a: 0, b: 0 });
      const bucket = buckets.get(key);
      if (tab.discarded) bucket.a++;
      else bucket.b++;
    }
    for (const [key, bucket] of buckets) {
      const g = key === 'none' ? null : groupsById.get(Number(key));
      rows.push({
        label: g ? g.title || 'sem nome' : 'fora de grupo',
        color: g ? g.color : 'grey',
        a: bucket.a,
        b: bucket.b
      });
    }
    $('bars-total').textContent = `${state.tabs.length} abas`;
  } else {
    const source = view === 'vault' ? state.vault.entries : state.recent;
    $('bars-title').textContent = view === 'vault' ? 'Grupos no cofre' : 'Grupos no histórico';
    const buckets = new Map();
    for (const entry of source) {
      const key = groupKeyOf(entry.groupTitle, entry.groupColor);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    for (const [key, count] of buckets) {
      const { title, color } = splitGroupKey(key);
      rows.push({ label: key ? title || 'sem nome' : 'fora de grupo', color: key ? color : 'grey', a: count, b: 0 });
    }
    $('bars-total').textContent = `${source.length} ${view === 'vault' ? 'itens' : 'fechadas'}`;
  }

  rows.sort((x, y) => y.a + y.b - (x.a + x.b));
  const shown = rows.slice(0, 7);
  const rest = rows.slice(7);
  if (rest.length) {
    shown.push({
      label: `outros ${rest.length}`,
      color: 'grey',
      a: rest.reduce((n, r) => n + r.a, 0),
      b: rest.reduce((n, r) => n + r.b, 0)
    });
  }

  if (!shown.length) {
    box.appendChild(el('div', 'muted', 'nenhum grupo por aqui ainda'));
    return;
  }

  const max = Math.max(...shown.map((r) => r.a + r.b), 1);
  shown.forEach((row, i) => box.appendChild(barRow(row, max, i)));

  if (view !== 'open') return;
  for (const [cls, label] of [['s1', 'suspensas'], ['s2', 'carregadas']]) {
    const key = el('span', 'key');
    key.appendChild(el('span', `swatch ${cls}`));
    key.appendChild(el('span', '', label));
    legend.appendChild(key);
  }
}

function renderFigures() {
  const suspended = state.tabs.filter((t) => t.discarded).length;
  const protectedCount = state.tabs.filter((t) => !t.discarded && isProtected(t)).length;
  const vaultCount = state.vault.entries.length;
  const perTab = state.settings.estimatedMbPerTab;
  const offloaded = suspended + vaultCount;

  $('s-saved').textContent = formatRam(offloaded * perTab);
  $('s-saved-sub').textContent = `${offloaded} ${offloaded === 1 ? 'aba' : 'abas'} fora da memória · ${perTab} MB por aba`;
  $('s-discarded').textContent = suspended;
  $('s-loaded').textContent = state.tabs.length - suspended - protectedCount;
  $('s-protected').textContent = protectedCount;
  $('s-vault-line').textContent = `${vaultCount} no cofre · ${state.recent.length} fechadas guardadas · ${state.stats.archived || 0} arquivadas no total`;

  const ledes = {
    open: `${state.tabs.length} abas em ${new Set(state.tabs.map((t) => t.windowId)).size} janela(s). Suspender mantém a aba na barra; arquivar tira da barra e guarda o grupo.`,
    vault: `${vaultCount} ${vaultCount === 1 ? 'aba guardada' : 'abas guardadas'}, agrupadas como estavam. Restaurar recria o grupo se ele não existir mais.`,
    recent: `As últimas ${state.settings.recentLimit} abas fechadas ficam aqui. Reabrir devolve cada uma ao grupo de origem.`
  };
  $('view-lede').textContent = ledes[view];

  renderMatrix();
  renderBars();
}

function render() {
  const scroll = window.scrollY;
  const focusKey = document.activeElement && document.activeElement.closest
    ? (document.activeElement.closest('.item') || {}).dataset
    : null;

  resetClocks();
  cardOf.clear();

  const content = $('content');
  content.textContent = '';

  $('view-title').textContent = VIEWS[view].title;
  $('bulk-open').classList.toggle('hidden', view !== 'open');
  $('bulk-vault').classList.toggle('hidden', view !== 'vault');
  $('bulk-recent').classList.toggle('hidden', view !== 'recent');
  for (const id of ['nav-open', 'tab-open']) $(id).classList.toggle('active', view === 'open');
  for (const id of ['nav-vault', 'tab-vault']) $(id).classList.toggle('active', view === 'vault');
  for (const id of ['nav-recent', 'tab-recent']) $(id).classList.toggle('active', view === 'recent');
  for (const [id, name] of [['tab-open', 'open'], ['tab-vault', 'vault'], ['tab-recent', 'recent']]) {
    $(id).setAttribute('aria-selected', view === name ? 'true' : 'false');
  }
  $('fpill-state').classList.toggle('hidden', view !== 'open');

  renderFigures();

  if (view === 'open') renderOpen(content);
  else if (view === 'vault') renderVault(content);
  else renderRecent(content);

  cursor = Math.max(0, Math.min(cursor, rowModel.length - 1));
  const total = view === 'open' ? state.tabs.length : view === 'vault' ? state.vault.entries.length : state.recent.length;
  $('search-count').textContent = query ? `${rowModel.length}/${total}` : '';

  const n = selection.size;
  $('sel-count').textContent = n ? `${n} selecionada${n === 1 ? '' : 's'}` : 'nada selecionado';
  $('sel-count').classList.toggle('on', n > 0);

  window.scrollTo({ top: scroll, behavior: 'instant' });
  fillVisible();
  if (focusKey && focusKey.key) {
    const again = document.querySelector(`.item[data-key="${focusKey.key}"]`);
    if (again) again.focus({ preventScroll: true });
  }
  ready = true;
}

async function load() {
  const res = await send('getState');
  if (!res.ok) {
    toast(res.error || 'não consegui ler o estado das abas');
    return;
  }
  state = res.data;
  applyChrome(state.settings);
  for (const key of [...selection]) {
    if (key.startsWith('t:') && !state.tabs.some((t) => String(t.id) === key.slice(2))) selection.delete(key);
    if (key.startsWith('v:') && !state.vault.entries.some((e) => e.id === key.slice(2))) selection.delete(key);
    if (key.startsWith('r:') && !state.recent.some((e) => e.id === key.slice(2))) selection.delete(key);
  }
  withTransition(render);
}

function switchView(next) {
  if (view === next) return;
  view = next;
  selection.clear();
  cursor = 0;
  lastPicked = -1;
  $('sel-all').checked = false;
  saveUi({ view: next });
  withTransition(render);
}

function focusCursor() {
  const entry = rowModel[cursor];
  if (!entry) return;
  const key = prefix() + entry.id;
  const holder = cardOf.get(key);
  if (holder) {
    materialize(holder);
    if (!document.querySelector(`.item[data-key="${key}"]`) && holder.__fillAll) holder.__fillAll();
  }
  const node = document.querySelector(`.item[data-key="${key}"]`);
  if (node) {
    node.scrollIntoView({ block: 'nearest' });
    node.focus({ preventScroll: true });
  }
}

function moveCursor(delta) {
  if (!rowModel.length) return;
  cursor = Math.max(0, Math.min(rowModel.length - 1, cursor + delta));
  for (const node of document.querySelectorAll('.item.cursor')) node.classList.remove('cursor');
  focusCursor();
  const entry = rowModel[cursor];
  const node = document.querySelector(`.item[data-key="${prefix()}${entry.id}"]`);
  if (node) node.classList.add('cursor');
}

function togglePick() {
  const entry = rowModel[cursor];
  if (!entry) return;
  const key = prefix() + entry.id;
  if (selection.has(key)) selection.delete(key);
  else selection.add(key);
  lastPicked = cursor;
  render();
}

function pickedIds() {
  const p = prefix();
  const picked = [...selection].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length));
  if (picked.length) return picked;
  const entry = rowModel[cursor];
  return entry ? [String(entry.id)] : [];
}

async function suspendPicked() {
  if (view !== 'open') return;
  const ids = pickedIds().map(Number);
  if (!ids.length) return;
  selection.clear();
  await act('suspendTabs', { ids }, { message: (d) => describe(d, 'suspend') });
}

async function archivePicked() {
  const ids = pickedIds();
  if (!ids.length) return;
  selection.clear();
  if (view === 'open') await act('archiveTabsById', { ids: ids.map(Number) }, { message: (d) => describe(d, 'archive') });
  else if (view === 'recent') await act('archiveRecent', { ids }, { message: (d) => `${d.added} no cofre` });
}

async function primaryAction() {
  const entry = rowModel[cursor];
  if (!entry) return;
  if (view === 'open') await act('focusTab', { id: entry.id });
  else if (view === 'vault')
    await act('restore', { ids: [entry.id], suspended: $('restore-suspended').checked }, { message: (d) => describe(d, 'restore') });
  else
    await act('reopenRecent', { ids: [entry.id], suspended: $('recent-suspended').checked }, { message: (d) => describe(d, 'restore') });
}

function paletteItems() {
  const items = [
    { group: 'Ir para', label: 'Abas abertas', keys: '1', run: () => switchView('open') },
    { group: 'Ir para', label: 'Cofre', keys: '2', run: () => switchView('vault') },
    { group: 'Ir para', label: 'Últimas fechadas', keys: '3', run: () => switchView('recent') },
    { group: 'Ir para', label: 'Configurações', run: () => chrome.runtime.openOptionsPage() },
    {
      group: 'Memória',
      label: 'Suspender todas as abas menos a atual',
      keys: 'alt+shift+o',
      run: () => act('suspendOthers', {}, { message: (d) => describe(d, 'suspend') })
    },
    {
      group: 'Memória',
      label: 'Suspender esta janela',
      run: () => act('suspendWindow', {}, { message: (d) => describe(d, 'suspend') })
    },
    {
      group: 'Memória',
      label: 'Rodar a varredura agora',
      run: () => act('sweepNow', {}, { message: () => 'varredura concluída' })
    },
    {
      group: 'Cofre',
      label: 'Arquivar esta janela no cofre',
      run: () => act('archiveWindow', {}, { message: (d) => describe(d, 'archive') })
    },
    {
      group: 'Cofre',
      label: 'Exportar o cofre em JSON',
      run: exportVault
    },
    { group: 'Cofre', label: 'Importar um cofre', run: () => $('import-file').click() },
    { group: 'Histórico', label: 'Reabrir a última aba fechada', run: reopenLast },
    { group: 'Geral', label: 'Desfazer a última ação', keys: 'ctrl+z', run: undoNow },
    { group: 'Geral', label: 'Alternar densidade da lista', run: toggleDensity },
    { group: 'Geral', label: 'Ver os atalhos', keys: '?', run: showSheet }
  ];

  for (const g of state.groups) {
    const label = g.title || 'grupo sem nome';
    items.push({
      group: 'Grupos',
      label: `Suspender o grupo ${label}`,
      hint: `${label}`,
      run: () => act('suspendGroupById', { groupId: g.id }, { message: (d) => describe(d, 'suspend') })
    });
    items.push({
      group: 'Grupos',
      label: `Arquivar o grupo ${label}`,
      hint: `${label}`,
      run: () => act('archiveGroupById', { groupId: g.id }, { message: (d) => describe(d, 'archive') })
    });
  }

  for (const tab of state.tabs.slice(0, 60)) {
    items.push({
      group: 'Abas',
      label: tab.title || tab.url,
      hint: hostOf(tab.url),
      run: () => act('focusTab', { id: tab.id })
    });
  }

  return items;
}

async function reopenLast() {
  const first = state.recent[0];
  if (!first) return toast('o histórico está vazio');
  await act('reopenRecent', { ids: [first.id] }, { message: (d) => describe(d, 'restore') });
}

function toggleDensity() {
  const next = state.settings.density === 'compact' ? 'cozy' : 'compact';
  state.settings.density = next;
  applyChrome(state.settings);
  send('saveSettings', { patch: { density: next } });
  toast(next === 'compact' ? 'lista compacta' : 'lista confortável');
}

function showSheet() {
  openSheet('Atalhos', [
    ['ctrl k', 'paleta de comandos'],
    ['/', 'filtrar'],
    ['j k', 'navegar pelas linhas'],
    ['↵', 'ação principal da linha'],
    ['x', 'marcar a linha'],
    ['s', 'suspender o que está marcado'],
    ['a', 'arquivar o que está marcado'],
    ['1 2 3', 'trocar de seção'],
    ['ctrl z', 'desfazer'],
    ['esc', 'limpar filtro e seleção']
  ]);
}

function exportVault() {
  const payload = { exportedAt: new Date().toISOString(), version: 1, entries: state.vault.entries };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kill-tabs-cofre-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`${state.vault.entries.length} itens exportados`);
}

for (const [id, name] of [
  ['nav-open', 'open'],
  ['tab-open', 'open'],
  ['nav-vault', 'vault'],
  ['tab-vault', 'vault'],
  ['nav-recent', 'recent'],
  ['tab-recent', 'recent']
]) {
  $(id).addEventListener('click', () => switchView(name));
}

let searchTimer = null;
$('search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  const value = ev.target.value.trim().toLowerCase();
  searchTimer = setTimeout(() => {
    query = value;
    cursor = 0;
    render();
  }, 110);
});

for (const id of ['filter-state', 'filter-order']) {
  $(id).addEventListener('change', () => {
    saveUi({ [id === 'filter-state' ? 'stateFilter' : 'order']: $(id).value });
    render();
  });
}

$('density').addEventListener('click', toggleDensity);
$('palette').addEventListener('click', () => openPalette(paletteItems(), { placeholder: 'O que você quer fazer?' }));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('sweep').addEventListener('click', () => act('sweepNow', {}, { message: () => 'varredura concluída' }));

$('sel-all').addEventListener('change', (ev) => {
  selection.clear();
  if (ev.target.checked) for (const entry of rowModel) selection.add(prefix() + entry.id);
  render();
});

$('bulk-suspend').addEventListener('click', suspendPicked);
$('bulk-archive').addEventListener('click', archivePicked);

$('bulk-restore').addEventListener('click', async () => {
  const ids = pickedIds();
  if (!ids.length) return toast('marque pelo menos uma linha');
  selection.clear();
  await act(
    'restore',
    { ids, suspended: $('restore-suspended').checked, removeFromVault: $('restore-remove').checked },
    { message: (d) => describe(d, 'restore') }
  );
});

$('bulk-delete').addEventListener('click', async () => {
  const ids = pickedIds();
  if (!ids.length) return toast('marque pelo menos uma linha');
  selection.clear();
  await act('deleteEntries', { ids }, { message: (d) => `${d.removed} fora do cofre` });
});

$('bulk-reopen').addEventListener('click', async () => {
  const ids = pickedIds();
  if (!ids.length) return toast('marque pelo menos uma linha');
  selection.clear();
  await act(
    'reopenRecent',
    { ids, suspended: $('recent-suspended').checked, keepInList: $('recent-keep').checked },
    { message: (d) => describe(d, 'restore') }
  );
});

$('bulk-recent-archive').addEventListener('click', archivePicked);

$('bulk-recent-delete').addEventListener('click', async () => {
  const ids = pickedIds();
  if (!ids.length) return toast('marque pelo menos uma linha');
  selection.clear();
  await act('deleteRecent', { ids }, { message: (d) => `${d.removed} fora do histórico` });
});

$('clear-recent').addEventListener('click', () =>
  act('clearRecent', {}, { message: (d) => `${d.removed} fora do histórico` })
);

$('export').addEventListener('click', exportVault);
$('import-btn').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    await act('importVault', { payload, mode: 'merge' }, { message: (d) => `${d.added} item(ns) importado(s)` });
  } catch {
    toast('esse arquivo não é um cofre válido');
  }
  ev.target.value = '';
});

bindKeys({
  'mod+k': () => openPalette(paletteItems(), { placeholder: 'O que você quer fazer?' }),
  'mod+z': undoNow,
  '/': () => $('search').focus(),
  '?': showSheet,
  j: () => moveCursor(1),
  k: () => moveCursor(-1),
  ArrowDown: () => moveCursor(1),
  ArrowUp: () => moveCursor(-1),
  x: togglePick,
  s: suspendPicked,
  a: archivePicked,
  Enter: primaryAction,
  1: () => switchView('open'),
  2: () => switchView('vault'),
  3: () => switchView('recent'),
  Escape: () => {
    closeOverlay();
    if ($('search').value) {
      $('search').value = '';
      query = '';
      render();
    } else if (selection.size) {
      selection.clear();
      render();
    }
  }
});

chrome.tabs.onRemoved.addListener(() => view === 'open' && load());
chrome.tabs.onCreated.addListener(() => view === 'open' && load());

async function boot() {
  initTooltips();
  initToast();
  const res = await send('getUiState');
  const ui = (res.ok && res.data) || {};
  if (ui.view && VIEWS[ui.view]) view = ui.view;
  if (ui.order) $('filter-order').value = ui.order;
  if (ui.stateFilter) $('filter-state').value = ui.stateFilter;
  await load();
  if (ui.scroll) window.scrollTo({ top: ui.scroll, behavior: 'instant' });
}

let scrollTimer = null;
let filling = false;

function onViewportChange() {
  if (filling || !state) return;
  filling = true;
  try {
    fillVisible();
  } finally {
    filling = false;
  }
}

window.addEventListener('scroll', () => {
  onViewportChange();
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => saveUi({ scroll: window.scrollY }), 400);
});

window.addEventListener('resize', onViewportChange);

boot();
