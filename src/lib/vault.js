import { getVault, saveVault, bumpStats } from './store.js';
import { captureGroup, openEntriesInGroups, resolveWindow } from './groups.js';
import { markExpected } from './recent.js';
import { groupKeyOf, splitGroupKey, urlKey, newId, isBlockedUrl } from './util.js';

export async function archiveTabs(tabs, lastSeenMap) {
  const archivable = [];
  const byWindow = new Map();
  for (const t of tabs) {
    if (isBlockedUrl(t.url)) continue;
    const list = byWindow.get(t.windowId) || [];
    list.push(t);
    byWindow.set(t.windowId, list);
  }

  for (const [windowId, list] of byWindow) {
    let total = 0;
    try {
      const all = await chrome.tabs.query({ windowId });
      total = all.length;
    } catch {
      total = list.length;
    }
    const keep = total - list.length <= 0 ? 1 : 0;
    archivable.push(...list.slice(0, list.length - keep));
  }

  if (!archivable.length) return { archived: 0, entries: [] };

  const vault = await getVault();
  const groupCache = new Map();
  const created = [];

  for (const tab of archivable) {
    let g = null;
    if (tab.groupId !== undefined && tab.groupId !== -1) {
      if (!groupCache.has(tab.groupId)) groupCache.set(tab.groupId, await captureGroup(tab.groupId));
      g = groupCache.get(tab.groupId);
    }
    const entry = {
      id: newId(),
      url: tab.url,
      title: tab.title || tab.url,
      favIconUrl: tab.favIconUrl || '',
      pinned: !!tab.pinned,
      groupTitle: g ? g.title : '',
      groupColor: g ? g.color : '',
      groupCollapsed: g ? g.collapsed : false,
      archivedAt: Date.now(),
      lastActive: (lastSeenMap && lastSeenMap[urlKey(tab.url)]) || Date.now()
    };
    const dup = vault.entries.find((e) => urlKey(e.url) === urlKey(entry.url) && e.groupTitle === entry.groupTitle);
    if (dup) {
      dup.archivedAt = entry.archivedAt;
      if (dup.renamedAt) dup.originalTitle = entry.title;
      else dup.title = entry.title;
      dup.favIconUrl = entry.favIconUrl || dup.favIconUrl;
      created.push(dup);
    } else {
      vault.entries.unshift(entry);
      created.push(entry);
    }
  }

  await saveVault(vault);

  const ids = archivable.map((t) => t.id);
  await markExpected(ids);
  try {
    await chrome.tabs.remove(ids);
  } catch {
    for (const id of ids) await chrome.tabs.remove(id).catch(() => {});
  }

  await bumpStats({ archived: created.length });
  return { archived: created.length, entries: created };
}

export async function restoreEntries(entryIds, options = {}) {
  const vault = await getVault();
  const wanted = vault.entries.filter((e) => entryIds.includes(e.id));
  if (!wanted.length) return { opened: 0 };

  const windowId = await resolveWindow(options.windowId);
  const openedIds = await openEntriesInGroups(wanted, windowId, options.suspended);
  for (const entry of wanted) {
    if (entry.openedAt) entry.restoredAt = entry.openedAt;
    delete entry.openedAt;
  }

  if (options.removeFromVault) {
    vault.entries = vault.entries.filter((e) => !entryIds.includes(e.id));
  }
  await saveVault(vault);
  await bumpStats({ restored: openedIds.length });

  return { opened: openedIds.length, openedIds, windowId };
}

export async function addVaultEntries(items) {
  const vault = await getVault();
  let added = 0;
  for (const raw of items) {
    if (!raw || !raw.url || isBlockedUrl(raw.url)) continue;
    const entry = {
      id: newId(),
      url: raw.url,
      title: raw.title || raw.url,
      favIconUrl: raw.favIconUrl || '',
      pinned: !!raw.pinned,
      groupTitle: raw.groupTitle || '',
      groupColor: raw.groupColor || '',
      groupCollapsed: false,
      archivedAt: Date.now(),
      lastActive: raw.lastActive || raw.closedAt || Date.now()
    };
    const dup = vault.entries.find(
      (e) => urlKey(e.url) === urlKey(entry.url) && e.groupTitle === entry.groupTitle
    );
    if (dup) continue;
    vault.entries.unshift(entry);
    added++;
  }
  await saveVault(vault);
  await bumpStats({ archived: added });
  return { added };
}

export async function moveVaultEntries(entryIds, targetKey, beforeId) {
  const vault = await getVault();
  const moving = [];
  for (const id of entryIds) {
    const entry = vault.entries.find((e) => e.id === id);
    if (entry) moving.push(entry);
  }
  if (!moving.length) return { moved: 0 };

  const { title, color } = targetKey ? splitGroupKey(targetKey) : { title: '', color: '' };
  for (const entry of moving) {
    entry.groupTitle = targetKey ? title : '';
    entry.groupColor = targetKey ? color : '';
    if (!targetKey) entry.groupCollapsed = false;
  }

  const movingIds = new Set(moving.map((e) => e.id));
  const rest = vault.entries.filter((e) => !movingIds.has(e.id));
  let at = rest.length;
  if (beforeId && !movingIds.has(beforeId)) {
    const idx = rest.findIndex((e) => e.id === beforeId);
    if (idx !== -1) at = idx;
  } else if (!beforeId) {
    let last = -1;
    rest.forEach((e, i) => {
      if (groupKeyOf(e.groupTitle, e.groupColor) === (targetKey || '')) last = i;
    });
    at = last === -1 ? rest.length : last + 1;
  }
  rest.splice(at, 0, ...moving);
  vault.entries = rest;
  await saveVault(vault);
  return { moved: moving.length };
}

export async function deleteEntries(entryIds) {
  const vault = await getVault();
  const before = vault.entries.length;
  vault.entries = vault.entries.filter((e) => !entryIds.includes(e.id));
  await saveVault(vault);
  return { removed: before - vault.entries.length };
}

export async function renameEntry(entryId, title) {
  const vault = await getVault();
  const entry = vault.entries.find((e) => e.id === entryId);
  if (!entry) return { ok: false, reason: 'entrada nao encontrada' };
  const next = String(title || '').trim().slice(0, 300);
  if (!next) {
    if (entry.originalTitle) {
      entry.title = entry.originalTitle;
      delete entry.originalTitle;
      delete entry.renamedAt;
      await saveVault(vault);
      return { ok: true, entry, reverted: true };
    }
    return { ok: false, reason: 'titulo vazio' };
  }
  if (next === entry.title) return { ok: true, entry };
  if (!entry.originalTitle) entry.originalTitle = entry.title;
  entry.title = next;
  entry.renamedAt = Date.now();
  if (entry.originalTitle === entry.title) {
    delete entry.originalTitle;
    delete entry.renamedAt;
  }
  await saveVault(vault);
  return { ok: true, entry };
}

export async function importVault(payload, mode = 'merge') {
  const incoming = Array.isArray(payload) ? payload : payload && payload.entries;
  if (!Array.isArray(incoming)) throw new Error('Arquivo invalido');
  const vault = mode === 'replace' ? { entries: [] } : await getVault();
  let added = 0;
  for (const raw of incoming) {
    if (!raw || !raw.url) continue;
    const entry = {
      id: raw.id || newId(),
      url: raw.url,
      title: raw.title || raw.url,
      favIconUrl: raw.favIconUrl || '',
      pinned: !!raw.pinned,
      groupTitle: raw.groupTitle || '',
      groupColor: raw.groupColor || '',
      groupCollapsed: !!raw.groupCollapsed,
      archivedAt: raw.archivedAt || Date.now(),
      lastActive: raw.lastActive || raw.archivedAt || Date.now()
    };
    if (raw.originalTitle) entry.originalTitle = raw.originalTitle;
    if (raw.renamedAt) entry.renamedAt = raw.renamedAt;
    const dup = vault.entries.find((e) => urlKey(e.url) === urlKey(entry.url) && e.groupTitle === entry.groupTitle);
    if (dup) continue;
    vault.entries.push(entry);
    added++;
  }
  await saveVault(vault);
  return { added, total: vault.entries.length };
}
