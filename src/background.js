import {
  getSettings,
  saveSettings,
  resetSettings,
  getVault,
  getSeen,
  saveSeen,
  getStats,
  bumpStats,
  touch,
  forget,
  getActivity,
  seedActivity,
  getRecent,
  setMetaBulk,
  getTouch,
  getUiState,
  saveUiState
} from './lib/store.js';
import { urlKey, isBlockedUrl, groupKeyOf, splitGroupKey } from './lib/util.js';
import { discardTabs, canArchive, stepAsideAndDiscard, staticSkipReason, urgentDiscardTabs } from './lib/tabs.js';
import { captureGroup, tabsOfGroup, expandGroup, resolveGroup } from './lib/groups.js';
import { captureClosed, pruneRecent, removeRecent, clearRecent, reopenRecent } from './lib/recent.js';
import {
  archiveTabs,
  restoreEntries,
  deleteEntries,
  renameEntry,
  moveVaultEntries,
  addVaultEntries,
  importVault
} from './lib/vault.js';
import { pushUndo, runUndo, peekUndo, snapshotVault, snapshotRecent, snapshotTabs } from './lib/undo.js';

const SWEEP_ALARM = 'kill-tabs-sweep';
const DAY = 86400000;

async function ensureAlarm() {
  const existing = await chrome.alarms.get(SWEEP_ALARM);
  if (!existing) await chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
}

async function updateBadge() {
  const settings = await getSettings();
  if (!settings.showBadge) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const tabs = await chrome.tabs.query({});
  const n = tabs.filter((t) => t.discarded).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#a83e17' });
  await chrome.action.setBadgeTextColor({ color: '#fff8f3' }).catch(() => {});
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

async function syncSeen(tabs, activity) {
  const seen = await getSeen();
  const now = Date.now();
  let dirty = false;
  for (const tab of tabs) {
    const key = urlKey(tab.url);
    if (!key || isBlockedUrl(tab.url)) continue;
    const stamp = activity[tab.id];
    if (stamp && (!seen[key] || seen[key] < stamp)) {
      seen[key] = stamp;
      dirty = true;
    } else if (!seen[key]) {
      seen[key] = now;
      dirty = true;
    }
  }
  if (Object.keys(seen).length > 3000) {
    const open = new Set(tabs.map((t) => urlKey(t.url)));
    const vault = await getVault();
    for (const e of vault.entries) open.add(urlKey(e.url));
    for (const key of Object.keys(seen)) {
      if (!open.has(key) && now - seen[key] > 90 * DAY) {
        delete seen[key];
        dirty = true;
      }
    }
  }
  if (dirty) await saveSeen(seen);
  return seen;
}

async function writeMeta(tabs, activity) {
  const groupCache = new Map();
  const map = {};
  for (const tab of tabs) {
    if (isBlockedUrl(tab.url)) continue;
    let g = null;
    if (tab.groupId !== undefined && tab.groupId !== -1) {
      if (!groupCache.has(tab.groupId)) groupCache.set(tab.groupId, await captureGroup(tab.groupId));
      g = groupCache.get(tab.groupId);
    }
    map[tab.id] = {
      url: tab.url,
      title: tab.title || tab.url,
      favIconUrl: tab.favIconUrl || '',
      pinned: !!tab.pinned,
      discarded: !!tab.discarded,
      groupTitle: g ? g.title : '',
      groupColor: g ? g.color : '',
      windowId: tab.windowId,
      lastActive: (activity && activity[tab.id]) || null
    };
  }
  await setMetaBulk(map);
}

async function refreshMeta(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  await writeMeta([tab], { [tabId]: await getTouch(tabId) });
}

async function refreshGroupMeta(groupId) {
  const tabs = await tabsOfGroup(groupId);
  if (!tabs.length) return;
  await writeMeta(tabs, await getActivity());
}

async function filterArchivable(tabs, settings) {
  const allowed = [];
  const skipped = [];
  for (const tab of tabs) {
    const verdict = await canArchive(tab, settings);
    if (verdict.ok) allowed.push(tab);
    else skipped.push({ id: tab.id, title: tab.title || tab.url, reason: verdict.reason });
  }
  return { allowed, skipped };
}

async function sweep() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  await seedActivity(tabs);
  const activity = await getActivity();
  const seen = await syncSeen(tabs, activity);
  await writeMeta(tabs, activity);
  const now = Date.now();

  const idleMs = Math.max(1, settings.idleMinutes) * 60000;
  const idle = tabs.filter((t) => !t.discarded && !t.active && now - (activity[t.id] || now) >= idleMs);
  const report = await discardTabs(idle, settings);
  if (report.count) await bumpStats({ discarded: report.count });

  if (settings.archiveEnabled) {
    const ageMs = Math.max(1, settings.archiveDays) * DAY;
    const stale = tabs.filter((t) => {
      if (t.active || isBlockedUrl(t.url)) return false;
      const stamp = seen[urlKey(t.url)] || now;
      return now - stamp >= ageMs;
    });
    const { allowed } = await filterArchivable(stale, settings);
    if (allowed.length) await archiveTabs(allowed, seen);
  }

  if (settings.maxTabsEnabled && tabs.length > settings.maxTabs) {
    const fresh = await chrome.tabs.query({});
    const excess = fresh.length - settings.maxTabs;
    if (excess > 0) {
      const sorted = fresh
        .filter((t) => !t.active && !isBlockedUrl(t.url))
        .sort((a, b) => (seen[urlKey(a.url)] || 0) - (seen[urlKey(b.url)] || 0));
      const { allowed } = await filterArchivable(sorted, settings);
      if (allowed.length) await archiveTabs(allowed.slice(0, excess), seen);
    }
  }

  await updateBadge();
}

async function discardOnStartup() {
  const settings = await getSettings();
  if (!settings.discardOnStartup) return;
  const tabs = await chrome.tabs.query({ active: false });
  await discardTabs(tabs, settings);
  await updateBadge();
}

async function recordDiscardUndo(ids, label) {
  if (!ids.length) return;
  await pushUndo({ label, reload: ids });
}

async function archiveWithUndo(tabs, settings, label) {
  const { allowed, skipped } = await filterArchivable(tabs, settings);
  if (!allowed.length) return { archived: 0, skipped, undoable: false };
  const previous = await snapshotVault();
  const result = await archiveTabs(allowed, await getSeen());
  await pushUndo({
    label,
    vault: previous,
    reopen: result.entries.map((e) => ({ ...e }))
  });
  await updateBadge();
  return { ...result, skipped, undoable: true };
}

async function suspendGroupOf(tab) {
  const settings = await getSettings();
  if (tab.groupId === undefined || tab.groupId === -1) {
    return { count: 0, skipped: [{ reason: 'esta aba não está em nenhum grupo' }] };
  }
  const groupTabs = await tabsOfGroup(tab.groupId);
  const report = await discardTabs(groupTabs.filter((t) => !t.active), settings);
  const active = groupTabs.find((t) => t.active);
  if (active) await stepAsideAndDiscard(active, settings);
  await recordDiscardUndo(
    groupTabs.map((t) => t.id),
    `${report.count} aba(s) do grupo suspensas`
  );
  await updateBadge();
  return { ...report, undoable: report.count > 0 };
}

async function archiveGroupOf(tab) {
  const settings = await getSettings();
  if (tab.groupId === undefined || tab.groupId === -1) {
    return { archived: 0, skipped: [{ reason: 'esta aba não está em nenhum grupo' }] };
  }
  const groupTabs = await tabsOfGroup(tab.groupId);
  const urgent = await urgentDiscardTabs(groupTabs);
  if (urgent) await bumpStats({ discarded: urgent });

  const refreshed = await tabsOfGroup(tab.groupId);
  const activeInGroup = refreshed.find((t) => t.active);
  if (activeInGroup) await stepAsideAndDiscard(activeInGroup, settings);

  const finalTabs = await tabsOfGroup(tab.groupId);
  const result = await archiveWithUndo(finalTabs, settings, 'grupo arquivado');
  return { ...result, urgentDiscarded: urgent };
}

async function collectTabsState() {
  const [tabs, windows, settings, stats, vault, recent, ui] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    getSettings(),
    getStats(),
    getVault(),
    getRecent(),
    getUiState()
  ]);
  const activity = await getActivity();
  const undo = await peekUndo();
  let groups = [];
  try {
    const list = await chrome.tabGroups.query({});
    groups = list.map((g) => ({
      id: g.id,
      title: g.title || '',
      color: g.color,
      collapsed: g.collapsed,
      windowId: g.windowId
    }));
  } catch {
    groups = [];
  }
  return {
    settings,
    stats,
    vault,
    recent,
    groups,
    ui,
    undo: undo ? { label: undo.label, at: undo.at } : null,
    windows: windows.map((w) => ({ id: w.id, focused: w.focused, current: w.focused })),
    tabs: tabs.map((t) => ({
      id: t.id,
      windowId: t.windowId,
      groupId: t.groupId,
      index: t.index,
      title: t.title,
      url: t.url,
      favIconUrl: t.favIconUrl,
      pinned: t.pinned,
      audible: t.audible,
      active: t.active,
      discarded: t.discarded,
      lastActive: activity[t.id] || null,
      skipReason: staticSkipReason(t, settings)
    }))
  };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function openPage(path) {
  const url = chrome.runtime.getURL(path);
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

const handlers = {
  async getState() {
    return collectTabsState();
  },

  async getPopupState() {
    const [tabs, settings, stats, vault, recent] = await Promise.all([
      chrome.tabs.query({}),
      getSettings(),
      getStats(),
      getVault(),
      getRecent()
    ]);
    const current = await activeTab();
    let group = null;
    if (current && current.groupId !== undefined && current.groupId !== -1) {
      const g = await captureGroup(current.groupId);
      if (g) {
        const members = await tabsOfGroup(current.groupId);
        group = { ...g, key: groupKeyOf(g.title, g.color), count: members.length };
      }
    }
    const marks = tabs.map((t) => {
      if (t.discarded) return 's';
      const reason = staticSkipReason(t, settings);
      if (reason && reason !== 'aba ativa' && reason !== 'ja suspensa') return 'p';
      return 'l';
    });
    return {
      settings,
      stats,
      marks,
      totals: {
        tabs: tabs.length,
        discarded: tabs.filter((t) => t.discarded).length,
        windows: new Set(tabs.map((t) => t.windowId)).size,
        vault: vault.entries.length,
        recent: recent.length
      },
      current: current
        ? { id: current.id, title: current.title, url: current.url, windowId: current.windowId, groupId: current.groupId }
        : null,
      group
    };
  },

  async suspendCurrent() {
    const settings = await getSettings();
    const tab = await activeTab();
    if (!tab) return { count: 0, skipped: [] };
    const ok = await stepAsideAndDiscard(tab, settings);
    if (ok) {
      await bumpStats({ discarded: 1 });
      await recordDiscardUndo([tab.id], 'aba suspensa');
    }
    await updateBadge();
    return {
      count: ok ? 1 : 0,
      undoable: ok,
      skipped: ok ? [] : [{ id: tab.id, title: tab.title, reason: 'não foi possível liberar esta aba' }]
    };
  },

  async suspendOthers() {
    const settings = await getSettings();
    const tabs = await chrome.tabs.query({ active: false });
    const report = await discardTabs(tabs, settings);
    await bumpStats({ discarded: report.count });
    await recordDiscardUndo(tabs.map((t) => t.id), `${report.count} aba(s) suspensas`);
    await updateBadge();
    return { ...report, undoable: report.count > 0 };
  },

  async suspendWindow() {
    const settings = await getSettings();
    const tab = await activeTab();
    if (!tab) return { count: 0, skipped: [] };
    const tabs = await chrome.tabs.query({ windowId: tab.windowId, active: false });
    const report = await discardTabs(tabs, settings);
    await bumpStats({ discarded: report.count });
    await recordDiscardUndo(tabs.map((t) => t.id), `${report.count} aba(s) suspensas`);
    await updateBadge();
    return { ...report, undoable: report.count > 0 };
  },

  async suspendGroup() {
    const tab = await activeTab();
    if (!tab) return { count: 0, skipped: [] };
    const report = await suspendGroupOf(tab);
    await bumpStats({ discarded: report.count });
    return report;
  },

  async suspendGroupById({ groupId }) {
    const settings = await getSettings();
    const groupTabs = await tabsOfGroup(groupId);
    const report = await discardTabs(groupTabs, settings);
    await bumpStats({ discarded: report.count });
    await recordDiscardUndo(groupTabs.map((t) => t.id), `${report.count} aba(s) suspensas`);
    await updateBadge();
    return { ...report, undoable: report.count > 0 };
  },

  async suspendTabs({ ids }) {
    const settings = await getSettings();
    const tabs = [];
    for (const id of ids || []) {
      const t = await chrome.tabs.get(id).catch(() => null);
      if (t) tabs.push(t);
    }
    const report = await discardTabs(tabs, settings);
    await bumpStats({ discarded: report.count });
    await recordDiscardUndo(
      tabs.map((t) => t.id),
      report.count === 1 ? 'aba suspensa' : `${report.count} abas suspensas`
    );
    await updateBadge();
    return { ...report, undoable: report.count > 0 };
  },

  async archiveGroup() {
    const tab = await activeTab();
    if (!tab) return { archived: 0, skipped: [] };
    return archiveGroupOf(tab);
  },

  async archiveGroupById({ groupId }) {
    return archiveGroupOf({ groupId });
  },

  async archiveWindow() {
    const settings = await getSettings();
    const tab = await activeTab();
    if (!tab) return { archived: 0, skipped: [] };
    const tabs = await chrome.tabs.query({ windowId: tab.windowId, active: false });
    return archiveWithUndo(tabs, settings, 'janela arquivada');
  },

  async archiveOthers() {
    const settings = await getSettings();
    const tabs = await chrome.tabs.query({ active: false });
    return archiveWithUndo(tabs, settings, 'abas arquivadas');
  },

  async archiveTabsById({ ids }) {
    const settings = await getSettings();
    const tabs = [];
    for (const id of ids || []) {
      const t = await chrome.tabs.get(id).catch(() => null);
      if (t) tabs.push(t);
    }
    return archiveWithUndo(tabs, settings, tabs.length === 1 ? 'aba arquivada' : `${tabs.length} abas arquivadas`);
  },

  async moveTabs({ ids, windowId, targetGroupId, targetGroupKey, beforeTabId }) {
    const tabIds = (ids || []).map(Number).filter((n) => Number.isInteger(n));
    if (!tabIds.length) return { moved: 0 };

    let winId = windowId;
    if (!winId) {
      const first = await chrome.tabs.get(tabIds[0]).catch(() => null);
      if (!first) return { moved: 0 };
      winId = first.windowId;
    }

    const before = await snapshotTabs(tabIds, captureGroup);

    let groupId = null;
    let placeholderId = null;
    if (targetGroupId !== undefined && targetGroupId !== null && targetGroupId !== -1) {
      groupId = targetGroupId;
      await expandGroup(groupId);
    } else if (targetGroupKey) {
      const { title, color } = splitGroupKey(targetGroupKey);
      const resolved = await resolveGroup(winId, title, color, { create: true });
      groupId = resolved.groupId;
      placeholderId = resolved.placeholderId || null;
    }

    if (groupId === null) {
      await chrome.tabs.ungroup(tabIds).catch(() => {});
    } else {
      await chrome.tabs.group({ groupId, tabIds }).catch(() => {});
      if (placeholderId) await chrome.tabs.remove(placeholderId).catch(() => {});
      await expandGroup(groupId);
    }

    if (beforeTabId && !tabIds.includes(Number(beforeTabId))) {
      const anchor = await chrome.tabs.get(Number(beforeTabId)).catch(() => null);
      if (anchor && anchor.windowId === winId) {
        await chrome.tabs.move(tabIds, { index: anchor.index }).catch(() => {});
        if (groupId !== null) await chrome.tabs.group({ groupId, tabIds }).catch(() => {});
      }
    }

    await pushUndo({ label: tabIds.length === 1 ? 'aba movida' : `${tabIds.length} abas movidas`, tabs: before });
    await updateBadge();
    return { moved: tabIds.length, groupId, undoable: true };
  },

  async restore({ ids, suspended, removeFromVault, windowId }) {
    const settings = await getSettings();
    const previous = await snapshotVault();
    const result = await restoreEntries(ids || [], {
      suspended: suspended === undefined ? settings.restoreSuspended : suspended,
      removeFromVault: !!removeFromVault,
      windowId
    });
    await pushUndo({ label: 'restauração desfeita', vault: previous, closeTabs: result.openedIds || [] });
    await updateBadge();
    return { ...result, undoable: true };
  },

  async deleteEntries({ ids }) {
    const previous = await snapshotVault();
    const result = await deleteEntries(ids || []);
    await pushUndo({ label: `${result.removed} item(ns) devolvido(s) ao cofre`, vault: previous });
    return { ...result, undoable: result.removed > 0 };
  },

  async renameEntry({ id, title }) {
    const previous = await snapshotVault();
    const result = await renameEntry(id, title);
    if (result.ok) await pushUndo({ label: 'nome anterior restaurado', vault: previous });
    return { ...result, undoable: !!result.ok };
  },

  async moveVaultEntries({ ids, targetKey, beforeId }) {
    const previous = await snapshotVault();
    const result = await moveVaultEntries(ids || [], targetKey || '', beforeId || null);
    if (result.moved) await pushUndo({ label: 'ordem anterior restaurada', vault: previous });
    return { ...result, undoable: result.moved > 0 };
  },

  async reopenRecent({ ids, suspended, keepInList, windowId }) {
    const settings = await getSettings();
    const previous = await snapshotRecent();
    const result = await reopenRecent(ids || [], {
      suspended: suspended === undefined ? settings.restoreSuspended : suspended,
      keepInList: !!keepInList,
      windowId
    });
    await pushUndo({ label: 'reabertura desfeita', recent: previous, closeTabs: result.openedIds || [] });
    await updateBadge();
    return { ...result, undoable: true };
  },

  async archiveRecent({ ids }) {
    const list = await getRecent();
    const wanted = list.filter((e) => (ids || []).includes(e.id));
    if (!wanted.length) return { added: 0 };
    const prevVault = await snapshotVault();
    const prevRecent = await snapshotRecent();
    const result = await addVaultEntries(wanted);
    await removeRecent(wanted.map((e) => e.id));
    await pushUndo({ label: 'movimento desfeito', vault: prevVault, recent: prevRecent });
    return { ...result, undoable: true };
  },

  async deleteRecent({ ids }) {
    const previous = await snapshotRecent();
    const result = await removeRecent(ids || []);
    await pushUndo({ label: `${result.removed} item(ns) de volta no histórico`, recent: previous });
    return { ...result, undoable: result.removed > 0 };
  },

  async clearRecent() {
    const previous = await snapshotRecent();
    const result = await clearRecent();
    await pushUndo({ label: 'histórico restaurado', recent: previous });
    return { ...result, undoable: result.removed > 0 };
  },

  async importVault({ payload, mode }) {
    const previous = await snapshotVault();
    const result = await importVault(payload, mode);
    await pushUndo({ label: 'importação desfeita', vault: previous });
    return { ...result, undoable: true };
  },

  async undoLast() {
    const result = await runUndo();
    await updateBadge();
    return result;
  },

  async saveSettings({ patch }) {
    const next = await saveSettings(patch);
    if (patch && patch.recentLimit !== undefined) await pruneRecent(next.recentLimit);
    await updateBadge();
    return next;
  },

  async resetSettings() {
    const next = await resetSettings();
    await pruneRecent(next.recentLimit);
    await updateBadge();
    return next;
  },

  async getUiState() {
    return getUiState();
  },

  async saveUiState({ patch }) {
    return saveUiState(patch || {});
  },

  async sweepNow() {
    await sweep();
    return { ok: true };
  },

  async focusTab({ id }) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) return { ok: false, reason: 'essa aba já não existe' };
    await chrome.tabs.update(id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { ok: true };
  },

  async openDashboard() {
    await openPage('src/dashboard/dashboard.html');
    return { ok: true };
  },

  async openOnboarding() {
    await openPage('src/onboarding/onboarding.html');
    return { ok: true };
  },

  async openShortcuts() {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    return { ok: true };
  },

  async firstRunPlan() {
    const settings = await getSettings();
    const tabs = await chrome.tabs.query({ active: false });
    const { allowed } = await filterArchivable(tabs, settings);
    return {
      total: (await chrome.tabs.query({})).length,
      suspendable: allowed.length,
      estimate: allowed.length * settings.estimatedMbPerTab
    };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

async function buildMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'kt-suspend-tab', title: 'Suspender esta aba', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'kt-suspend-others', title: 'Suspender as outras abas', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'kt-sep', type: 'separator', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'kt-archive-group', title: 'Arquivar o grupo desta aba', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'kt-dashboard', title: 'Abrir o cofre', contexts: ['page', 'action'] });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'kt-suspend-tab') await handlers.suspendCurrent();
  else if (info.menuItemId === 'kt-suspend-others') await handlers.suspendOthers();
  else if (info.menuItemId === 'kt-archive-group') await handlers.archiveGroup();
  else if (info.menuItemId === 'kt-dashboard') await openPage('src/dashboard/dashboard.html');
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureAlarm();
  await buildMenus();
  const tabs = await chrome.tabs.query({});
  await seedActivity(tabs);
  const activity = await getActivity();
  await syncSeen(tabs, activity);
  await writeMeta(tabs, activity);
  await updateBadge();
  if (details.reason === 'install') await openPage('src/onboarding/onboarding.html');
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await buildMenus();
  const tabs = await chrome.tabs.query({});
  await seedActivity(tabs);
  await writeMeta(tabs, await getActivity());
  await discardOnStartup();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SWEEP_ALARM) return;
  await sweep();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await touch(tabId);
  await refreshMeta(tabId);
  await updateBadge();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await touch(tab.id);
  await refreshMeta(tab.id);
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'complete' || info.url) await touch(tabId);
  await refreshMeta(tabId);
  if (info.discarded !== undefined) await updateBadge();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await captureClosed(tabId);
  await forget(tabId);
  await updateBadge();
});

chrome.tabs.onMoved.addListener(async (tabId) => {
  await refreshMeta(tabId);
});

chrome.tabs.onAttached.addListener(async (tabId) => {
  await refreshMeta(tabId);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await forget(removedTabId);
  await touch(addedTabId);
  await refreshMeta(addedTabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await touch(tab.id);
});

chrome.tabGroups.onUpdated.addListener(async (group) => {
  await refreshGroupMeta(group.id);
  if (!group.collapsed) return;
  const settings = await getSettings();
  if (!settings.collapsedImmediate) return;
  const tabs = await tabsOfGroup(group.id);
  const report = await discardTabs(tabs, settings);
  if (report.count) await bumpStats({ discarded: report.count });
  await updateBadge();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'suspend-others') await handlers.suspendOthers();
  else if (command === 'suspend-current') await handlers.suspendCurrent();
  else if (command === 'suspend-window') await handlers.suspendWindow();
  else if (command === 'archive-group') await handlers.archiveGroup();
  else if (command === 'open-dashboard') await openPage('src/dashboard/dashboard.html');
  else if (command === 'undo-last') await handlers.undoLast();
});

ensureAlarm();
