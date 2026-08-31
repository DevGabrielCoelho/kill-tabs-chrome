import { groupKeyOf, splitGroupKey, humanAge } from '../lib/util.js';

const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false });
    });
  });
}

let state = null;
let view = 'open';
let query = '';
const selection = new Set();
let toastTimer = null;

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function formatRam(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function favicon(url, fallbackUrl) {
  const img = el('img', 'favicon');
  img.src = url || '';
  img.alt = '';
  img.addEventListener('error', () => {
    img.style.visibility = 'hidden';
  });
  if (!url) {
    img.style.visibility = 'hidden';
  }
  img.title = fallbackUrl || '';
  return img;
}

function checkbox(key) {
  const box = el('input');
  box.type = 'checkbox';
  box.checked = selection.has(key);
  box.addEventListener('change', () => {
    if (box.checked) selection.add(key);
    else selection.delete(key);
    updateSelectionUi();
  });
  return box;
}

function matches(text) {
  if (!query) return true;
  return String(text || '').toLowerCase().includes(query);
}

function selectedIds(prefix) {
  return [...selection].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

function updateSelectionUi() {
  const n = selection.size;
  $('sel-count').textContent = `${n} selecionada${n === 1 ? '' : 's'}`;
  $('sel-count').classList.toggle('on', n > 0);
}

function actionButton(label, className, handler) {
  const btn = el('button', className, label);
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
  row.dataset.id = String(id);
  row.dataset.kind = kind;
  row.addEventListener('dragstart', (ev) => {
    const prefix = kind === 'tab' ? 't:' : 'v:';
    const key = prefix + id;
    let ids = [String(id)];
    if (selection.has(key) && selection.size > 1) {
      const picked = selectedIds(prefix);
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

async function performDrop(target, beforeId) {
  const payload = dragPayload;
  dragPayload = null;
  clearMarkers();
  if (!payload) return;
  if (payload.kind === 'tab') {
    const res = await send('moveTabs', {
      ids: payload.ids.map(Number),
      windowId: target.windowId,
      targetGroupId: target.groupId,
      beforeTabId: beforeId ? Number(beforeId) : null
    });
    toast(res.ok ? `${res.data.moved} aba(s) movida(s)` : res.error || 'falhou');
  } else {
    const res = await send('moveVaultEntries', {
      ids: payload.ids,
      targetKey: target.groupKey,
      beforeId
    });
    toast(res.ok ? 'Ordem atualizada' : res.error || 'falhou');
  }
  selection.clear();
  load();
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
    performDrop(target, after ? after.dataset.id : null);
  });
}

function renderStats() {
  const tabs = state.tabs;
  const discarded = tabs.filter((t) => t.discarded).length;
  $('s-tabs').textContent = tabs.length;
  $('s-discarded').textContent = discarded;
  $('s-groups').textContent = state.groups.length;
  $('s-vault').textContent = state.vault.entries.length;
  $('s-saved').textContent = formatRam((discarded + state.vault.entries.length) * state.settings.estimatedMbPerTab);
  $('s-archived').textContent = state.stats.archived || 0;
}

function tabRow(tab) {
  const key = `t:${tab.id}`;
  const row = el('div', 'item');
  makeDraggable(row, 'tab', tab.id);
  row.appendChild(el('span', 'grip', '⠿'));
  row.appendChild(checkbox(key));
  row.appendChild(favicon(tab.favIconUrl, tab.url));

  const main = el('div', 'main');
  const name = el('div', 'name truncate', tab.title || tab.url);
  const url = el('div', 'url truncate', tab.url);
  main.appendChild(name);
  main.appendChild(url);
  row.appendChild(main);

  if (tab.discarded) row.appendChild(el('span', 'pill on', 'suspensa'));
  else if (tab.skipReason) row.appendChild(el('span', 'pill', tab.skipReason));
  if (tab.lastActive) row.appendChild(el('span', 'pill', humanAge(tab.lastActive)));

  const acts = el('div', 'acts');
  acts.appendChild(
    actionButton('Ir', '', async () => {
      await send('focusTab', { id: tab.id });
    })
  );
  if (!tab.discarded) {
    acts.appendChild(
      actionButton('Suspender', '', async () => {
        const res = await send('suspendTabs', { ids: [tab.id] });
        toast(res.ok && res.data.count ? 'Aba suspensa' : 'Não foi possível suspender');
        load();
      })
    );
  }
  acts.appendChild(
    actionButton('Arquivar', 'danger', async () => {
      const res = await send('archiveTabsById', { ids: [tab.id] });
      toast(res.ok && res.data.archived ? 'Aba no cofre' : 'Não foi possível arquivar');
      load();
    })
  );
  row.appendChild(acts);
  return row;
}

function card(headNodes, rows, dropTarget) {
  const box = el('div', 'card');
  const head = el('div', 'card-head');
  for (const node of headNodes) head.appendChild(node);
  box.appendChild(head);
  const list = el('div', 'rows');
  for (const r of rows) list.appendChild(r);
  box.appendChild(list);
  if (dropTarget) wireDropZone(box, dropTarget);
  return box;
}

function renderOpen() {
  const content = $('content');
  const groupsById = new Map(state.groups.map((g) => [g.id, g]));
  const visible = state.tabs.filter((t) => {
    const g = groupsById.get(t.groupId);
    return matches(t.title) || matches(t.url) || (g && matches(g.title));
  });

  if (!visible.length) {
    content.appendChild(el('div', 'empty', 'Nenhuma aba encontrada.'));
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
    content.appendChild(el('div', 'window-label', `Janela ${windowIndex} — ${tabs.length} aba(s)`));

    const buckets = new Map();
    for (const tab of tabs) {
      const key = tab.groupId === undefined || tab.groupId === -1 ? 'none' : String(tab.groupId);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(tab);
    }

    for (const [key, list] of buckets) {
      list.sort((a, b) => a.index - b.index);
      const head = [];
      if (key === 'none') {
        head.push(el('span', 'dot grey'));
        head.push(el('span', 'title truncate', 'Sem grupo'));
      } else {
        const g = groupsById.get(Number(key));
        head.push(el('span', `dot ${g ? g.color : 'grey'}`));
        head.push(el('span', 'title truncate', (g && g.title) || '(grupo sem nome)'));
        if (g && g.collapsed) head.push(el('span', 'pill', 'colapsado'));
      }
      head.push(el('span', 'pill', `${list.length}`));

      const ids = list.map((t) => t.id);
      const acts = el('div', 'acts');
      acts.appendChild(
        actionButton('Suspender grupo', '', async () => {
          const res = await send('suspendTabs', { ids });
          toast(res.ok ? `${res.data.count} aba(s) suspensa(s)` : 'falhou');
          load();
        })
      );
      acts.appendChild(
        actionButton('Arquivar grupo', 'danger', async () => {
          const res = await send('archiveTabsById', { ids });
          toast(res.ok ? `${res.data.archived} aba(s) no cofre` : 'falhou');
          load();
        })
      );
      head.push(acts);

      content.appendChild(
        card(head, list.map(tabRow), {
          kind: 'tab',
          windowId,
          groupId: key === 'none' ? -1 : Number(key)
        })
      );
    }
  }
}

async function commitRename(entry, value) {
  const res = await send('renameEntry', { id: entry.id, title: value });
  if (!res.ok || !res.data.ok) {
    toast((res.data && res.data.reason) || res.error || 'não foi possível renomear');
  } else {
    toast(res.data.reverted ? 'Nome original restaurado' : 'Nome atualizado');
  }
  load();
}

function startRename(nameEl, entry) {
  if (nameEl.dataset.editing === '1') return;
  nameEl.dataset.editing = '1';
  const owner = nameEl.closest('.item');
  if (owner) owner.draggable = false;
  const input = el('input', 'rename-input');
  input.type = 'text';
  input.value = entry.title || '';
  input.placeholder = 'Nome da aba (vazio volta ao título original)';
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
  input.addEventListener('click', (ev) => ev.stopPropagation());
}

function vaultRow(entry) {
  const key = `v:${entry.id}`;
  const row = el('div', 'item');
  makeDraggable(row, 'vault', entry.id);
  row.appendChild(el('span', 'grip', '⠿'));
  row.appendChild(checkbox(key));
  row.appendChild(favicon(entry.favIconUrl, entry.url));

  const main = el('div', 'main');
  const nameEl = el('div', 'name truncate editable', entry.title || entry.url);
  nameEl.title = 'Clique duas vezes para renomear';
  nameEl.addEventListener('dblclick', () => startRename(nameEl, entry));
  main.appendChild(nameEl);
  main.appendChild(el('div', 'url truncate', entry.url));
  row.appendChild(main);

  if (entry.originalTitle) {
    const pill = el('span', 'pill', 'renomeada');
    pill.title = `Título original: ${entry.originalTitle}`;
    row.appendChild(pill);
  }
  row.appendChild(el('span', 'pill', `arquivada há ${humanAge(entry.archivedAt)}`));
  if (entry.restoredAt) row.appendChild(el('span', 'pill on', 'já reaberta'));

  const acts = el('div', 'acts');
  acts.appendChild(
    actionButton('Renomear', '', async () => {
      startRename(nameEl, entry);
    })
  );
  acts.appendChild(
    actionButton('Abrir', 'primary', async () => {
      const res = await send('restore', {
        ids: [entry.id],
        suspended: $('restore-suspended').checked,
        removeFromVault: $('restore-remove').checked
      });
      toast(res.ok ? 'Aba restaurada no grupo' : 'falhou');
      load();
    })
  );
  acts.appendChild(
    actionButton('Excluir', 'danger', async () => {
      await send('deleteEntries', { ids: [entry.id] });
      selection.delete(key);
      toast('Removida do cofre');
      load();
    })
  );
  row.appendChild(acts);
  return row;
}

function renderVault() {
  const content = $('content');
  const entries = state.vault.entries.filter(
    (e) => matches(e.title) || matches(e.url) || matches(e.groupTitle) || matches(e.originalTitle)
  );

  if (!entries.length) {
    content.appendChild(
      el('div', 'empty', state.vault.entries.length ? 'Nada encontrado para essa busca.' : 'O cofre está vazio.')
    );
    return;
  }

  const buckets = new Map();
  for (const entry of entries) {
    const key = groupKeyOf(entry.groupTitle, entry.groupColor);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }

  const ordered = [...buckets.entries()].sort((a, b) => {
    if (!a[0]) return 1;
    if (!b[0]) return -1;
    return 0;
  });

  for (const [key, list] of ordered) {
    const { title, color } = splitGroupKey(key);
    const head = [];
    head.push(el('span', `dot ${key ? color : 'grey'}`));
    head.push(el('span', 'title truncate', key ? title || '(grupo sem nome)' : 'Sem grupo'));
    head.push(el('span', 'pill', `${list.length}`));

    const ids = list.map((e) => e.id);
    const acts = el('div', 'acts');
    acts.appendChild(
      actionButton('Restaurar grupo', 'primary', async () => {
        const res = await send('restore', {
          ids,
          suspended: $('restore-suspended').checked,
          removeFromVault: $('restore-remove').checked
        });
        toast(res.ok ? `${res.data.opened} aba(s) restaurada(s)` : 'falhou');
        load();
      })
    );
    acts.appendChild(
      actionButton('Excluir grupo', 'danger', async () => {
        await send('deleteEntries', { ids });
        for (const id of ids) selection.delete(`v:${id}`);
        toast('Grupo removido do cofre');
        load();
      })
    );
    head.push(acts);

    content.appendChild(card(head, list.map(vaultRow), { kind: 'vault', groupKey: key }));
  }
}

function render() {
  const content = $('content');
  content.textContent = '';
  renderStats();
  $('bulk-open').classList.toggle('hidden', view !== 'open');
  $('bulk-vault').classList.toggle('hidden', view !== 'vault');
  $('nav-open').classList.toggle('active', view === 'open');
  $('nav-vault').classList.toggle('active', view === 'vault');
  if (view === 'open') renderOpen();
  else renderVault();
  updateSelectionUi();
}

async function load() {
  const res = await send('getState');
  if (!res.ok) return toast(res.error || 'Falha ao carregar');
  state = res.data;
  for (const key of [...selection]) {
    if (key.startsWith('t:') && !state.tabs.some((t) => String(t.id) === key.slice(2))) selection.delete(key);
    if (key.startsWith('v:') && !state.vault.entries.some((e) => e.id === key.slice(2))) selection.delete(key);
  }
  render();
}

function switchView(next) {
  view = next;
  selection.clear();
  $('sel-all').checked = false;
  render();
}

$('nav-open').addEventListener('click', () => switchView('open'));
$('nav-vault').addEventListener('click', () => switchView('vault'));

$('search').addEventListener('input', (ev) => {
  query = ev.target.value.trim().toLowerCase();
  render();
});

$('sel-all').addEventListener('change', (ev) => {
  selection.clear();
  if (ev.target.checked) {
    if (view === 'open') {
      for (const t of state.tabs) {
        if (matches(t.title) || matches(t.url)) selection.add(`t:${t.id}`);
      }
    } else {
      for (const e of state.vault.entries) {
        if (matches(e.title) || matches(e.url) || matches(e.groupTitle) || matches(e.originalTitle)) {
          selection.add(`v:${e.id}`);
        }
      }
    }
  }
  render();
});

$('bulk-suspend').addEventListener('click', async () => {
  const ids = selectedIds('t:').map(Number);
  if (!ids.length) return toast('Nada selecionado');
  const res = await send('suspendTabs', { ids });
  toast(res.ok ? `${res.data.count} aba(s) suspensa(s)` : 'falhou');
  selection.clear();
  load();
});

$('bulk-archive').addEventListener('click', async () => {
  const ids = selectedIds('t:').map(Number);
  if (!ids.length) return toast('Nada selecionado');
  const res = await send('archiveTabsById', { ids });
  toast(res.ok ? `${res.data.archived} aba(s) no cofre` : 'falhou');
  selection.clear();
  load();
});

$('bulk-restore').addEventListener('click', async () => {
  const ids = selectedIds('v:');
  if (!ids.length) return toast('Nada selecionado');
  const res = await send('restore', {
    ids,
    suspended: $('restore-suspended').checked,
    removeFromVault: $('restore-remove').checked
  });
  toast(res.ok ? `${res.data.opened} aba(s) restaurada(s)` : 'falhou');
  selection.clear();
  load();
});

$('bulk-delete').addEventListener('click', async () => {
  const ids = selectedIds('v:');
  if (!ids.length) return toast('Nada selecionado');
  await send('deleteEntries', { ids });
  selection.clear();
  toast('Removidas do cofre');
  load();
});

$('sweep').addEventListener('click', async () => {
  $('sweep').disabled = true;
  await send('sweepNow');
  $('sweep').disabled = false;
  toast('Varredura concluída');
  load();
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('export').addEventListener('click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    entries: state.vault.entries
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kill-tabs-cofre-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

$('import-btn').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const res = await send('importVault', { payload, mode: 'merge' });
    toast(res.ok ? `${res.data.added} item(ns) importado(s)` : res.error || 'falhou');
  } catch (err) {
    toast('Arquivo inválido');
  }
  ev.target.value = '';
  load();
});

chrome.tabs.onRemoved.addListener(() => view === 'open' && load());
chrome.tabs.onCreated.addListener(() => view === 'open' && load());

load();
