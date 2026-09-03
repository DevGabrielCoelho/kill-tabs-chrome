import { getRecent, saveRecent, getSettings, getMeta, forgetMeta } from './store.js';
import { openEntriesInGroups, resolveWindow } from './groups.js';
import { newId, urlKey, isBlockedUrl } from './util.js';

const EXPECTED = 'expected-removals';

export async function markExpected(tabIds) {
  const r = await chrome.storage.session.get(EXPECTED);
  const set = new Set(r[EXPECTED] || []);
  for (const id of tabIds) set.add(id);
  await chrome.storage.session.set({ [EXPECTED]: [...set] });
}

async function takeExpected(tabId) {
  const r = await chrome.storage.session.get(EXPECTED);
  const list = r[EXPECTED] || [];
  if (!list.includes(tabId)) return false;
  await chrome.storage.session.set({ [EXPECTED]: list.filter((id) => id !== tabId) });
  return true;
}

export async function captureClosed(tabId) {
  const meta = await getMeta(tabId);
  await forgetMeta(tabId);
  const expected = await takeExpected(tabId);
  if (expected) return null;

  const settings = await getSettings();
  const limit = Math.max(0, Math.min(100, Number(settings.recentLimit) || 0));
  if (!limit) return null;
  if (!meta || !meta.url || isBlockedUrl(meta.url)) return null;

  const entry = {
    id: newId(),
    url: meta.url,
    title: meta.title || meta.url,
    favIconUrl: meta.favIconUrl || '',
    pinned: !!meta.pinned,
    groupTitle: meta.groupTitle || '',
    groupColor: meta.groupColor || '',
    wasDiscarded: !!meta.discarded,
    lastActive: meta.lastActive || null,
    closedAt: Date.now()
  };

  const previous = await getRecent();
  const deduped = previous.filter(
    (e) => urlKey(e.url) !== urlKey(entry.url) || e.groupTitle !== entry.groupTitle
  );
  await saveRecent([entry, ...deduped].slice(0, limit));
  return entry;
}

export async function pruneRecent(limit) {
  const capped = Math.max(0, Math.min(100, Number(limit) || 0));
  if (!capped) {
    await saveRecent([]);
    return { kept: 0 };
  }
  const list = await getRecent();
  if (list.length <= capped) return { kept: list.length };
  await saveRecent(list.slice(0, capped));
  return { kept: capped };
}

export async function removeRecent(ids) {
  const list = await getRecent();
  const next = list.filter((e) => !ids.includes(e.id));
  await saveRecent(next);
  return { removed: list.length - next.length };
}

export async function clearRecent() {
  const list = await getRecent();
  await saveRecent([]);
  return { removed: list.length };
}

export async function reopenRecent(ids, options = {}) {
  const list = await getRecent();
  const wanted = list.filter((e) => ids.includes(e.id));
  if (!wanted.length) return { opened: 0 };

  const windowId = await resolveWindow(options.windowId);
  const openedIds = await openEntriesInGroups(wanted, windowId, options.suspended);

  if (options.keepInList) {
    for (const entry of wanted) {
      if (entry.openedAt) entry.reopenedAt = entry.openedAt;
      delete entry.openedAt;
    }
    await saveRecent(list);
  } else {
    await saveRecent(list.filter((e) => !ids.includes(e.id)));
  }

  return { opened: openedIds.length, openedIds, windowId };
}
