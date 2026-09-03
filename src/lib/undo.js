import { getVault, saveVault, getRecent, saveRecent } from './store.js';
import { openEntriesInGroups, resolveWindow, attachToGroup } from './groups.js';
import { markExpected } from './recent.js';

const KEY = 'undo-record';

export async function pushUndo(record) {
  await chrome.storage.session.set({ [KEY]: { ...record, at: Date.now() } });
}

export async function peekUndo() {
  const r = await chrome.storage.session.get(KEY);
  return r[KEY] || null;
}

export async function dropUndo() {
  await chrome.storage.session.remove(KEY);
}

export async function runUndo() {
  const record = await peekUndo();
  if (!record) return { ok: false, reason: 'nada recente para desfazer' };
  await dropUndo();

  if (Array.isArray(record.vault)) {
    await saveVault({ entries: record.vault });
  }
  if (Array.isArray(record.recent)) {
    await saveRecent(record.recent);
  }
  if (Array.isArray(record.closeTabs) && record.closeTabs.length) {
    await markExpected(record.closeTabs);
    await chrome.tabs.remove(record.closeTabs).catch(() => {});
  }
  if (Array.isArray(record.reload) && record.reload.length) {
    for (const id of record.reload) await chrome.tabs.reload(id).catch(() => {});
  }
  if (Array.isArray(record.reopen) && record.reopen.length) {
    const windowId = await resolveWindow(record.windowId);
    await openEntriesInGroups(record.reopen.map((e) => ({ ...e })), windowId, record.reopenSuspended);
  }
  if (Array.isArray(record.tabs) && record.tabs.length) {
    for (const snap of record.tabs) {
      const tab = await chrome.tabs.get(snap.id).catch(() => null);
      if (!tab) continue;
      if (snap.groupTitle) {
        await attachToGroup([snap.id], snap.windowId, snap.groupTitle, snap.groupColor);
      } else {
        await chrome.tabs.ungroup([snap.id]).catch(() => {});
      }
      await chrome.tabs.move(snap.id, { index: snap.index }).catch(() => {});
    }
  }

  return { ok: true, label: record.label || 'ação desfeita' };
}

export async function snapshotVault() {
  const vault = await getVault();
  return vault.entries.map((e) => ({ ...e }));
}

export async function snapshotRecent() {
  const list = await getRecent();
  return list.map((e) => ({ ...e }));
}

export async function snapshotTabs(tabIds, groupOf) {
  const out = [];
  for (const id of tabIds) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) continue;
    const g = await groupOf(tab.groupId);
    out.push({
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      groupTitle: g ? g.title : '',
      groupColor: g ? g.color : ''
    });
  }
  return out;
}
