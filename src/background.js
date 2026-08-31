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
  seedActivity
} from './lib/store.js';
import { urlKey, isBlockedUrl, groupKeyOf, splitGroupKey } from './lib/util.js';
import { discardTabs, canArchive, stepAsideAndDiscard, staticSkipReason, urgentDiscardTabs } from './lib/tabs.js';
import { captureGroup, tabsOfGroup, expandGroup, resolveGroup } from './lib/groups.js';
import { archiveTabs, restoreEntries, deleteEntries, renameEntry, moveVaultEntries, importVault } from './lib/vault.js';

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
  await chrome.action.setBadgeBackgroundColor({ color: '#2f6f5e' });
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

async function filterArchivable(tabs, settings) {
  const out = [];
  for (const tab of tabs) {
    const verdict = await canArchive(tab, settings);
    if (verdict.ok) out.push(tab);
  }
  return out;
}

async function sweep() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  await seedActivity(tabs);
  const activity = await getActivity();
  const seen = await syncSeen(tabs, activity);
  const now = Date.now();

  const idleMs = Math.max(1, settings.idleMinutes) * 60000;
  const idle = tabs.filter((t) => !t.discarded && !t.active && now - (activity[t.id] || now) >= idleMs);
  const discarded = await discardTabs(idle, settings);
  if (discarded) await bumpStats({ discarded });

  if (settings.archiveEnabled) {
    const ageMs = Math.max(1, settings.archiveDays) * DAY;
    const stale = tabs.filter((t) => {
      if (t.active || isBlockedUrl(t.url)) return false;
      const stamp = seen[urlKey(t.url)] || now;
      return now - stamp >= ageMs;
    });
    const allowed = await filterArchivable(stale, settings);
    if (allowed.length) await archiveTabs(allowed, seen);
  }

  if (settings.maxTabsEnabled && tabs.length > settings.maxTabs) {
    const fresh = await chrome.tabs.query({});
    const excess = fresh.length - settings.maxTabs;
    if (excess > 0) {
      const sorted = fresh
        .filter((t) => !t.active && !isBlockedUrl(t.url))
        .sort((a, b) => (seen[urlKey(a.url)] || 0) - (seen[urlKey(b.url)] || 0));
      const allowed = await filterArchivable(sorted, settings);
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

async function suspendGroupOf(tab) {
  const settings = await getSettings();
  if (tab.groupId === undefined || tab.groupId === -1) return 0;
  const groupTabs = await tabsOfGroup(tab.groupId);
  const count = await discardTabs(groupTabs.filter((t) => !t.active), settings);
  const active = groupTabs.find((t) => t.active);
  if (active) await stepAsideAndDiscard(active, settings);
  await updateBadge();
  return count;
}

async function archiveGroupOf(tab) {
  const settings = await getSettings();
  if (tab.groupId === undefined || tab.groupId === -1) return { archived: 0 };
  const groupTabs = await tabsOfGroup(tab.groupId);
  const urgent = await urgentDiscardTabs(groupTabs);
  if (urgent) await bumpStats({ discarded: urgent });
  const refreshedGroup = await tabsOfGroup(tab.groupId);
  const seen = await getSeen();
  const allowed = await filterArchivable(refreshedGroup.filter((t) => !t.active), settings);
  const activeInGroup = refreshedGroup.find((t) => t.active);
  if (activeInGroup) {
    const moved = await stepAsideAndDiscard(activeInGroup, settings);
    if (moved) {
      const refreshed = await chrome.tabs.get(activeInGroup.id).catch(() => null);
      if (refreshed) {
        const verdict = await canArchive(refreshed, settings);
        if (verdict.ok) allowed.push(refreshed);
      }
    }
  }
  const result = await archiveTabs(allowed, seen);
  await updateBadge();
  return { ...result, urgentDiscarded: urgent };
}

async function collectTabsState() {
  const [tabs, windows, settings, stats, vault] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    getSettings(),
    getStats(),
    getVault()
  ]);
  const activity = await getActivity();
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
    groups,
    windows: windows.map((w) => ({ id: w.id, focused: w.focused })),
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

async function openDashboard() {
  const url = chrome.runtime.getURL('src/dashboard/dashboard.html');
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
    const [tabs, settings, stats, vault] = await Promise.all([
      chrome.tabs.query({}),
      getSettings(),
      getStats(),
      getVault()
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
    return {
      settings,
      stats,
      totals: {
        tabs: tabs.length,
        discarded: tabs.filter((t) => t.discarded).length,
        windows: new Set(tabs.map((t) => t.windowId)).size,
        vault: vault.entries.length
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
    if (!tab) return { count: 0 };
    const ok = await stepAsideAndDiscard(tab, settings);
    if (ok) await bumpStats({ discarded: 1 });
    await updateBadge();
    return { count: ok ? 1 : 0 };
  },

  async suspendOthers() {
    const settings = await getSettings();
    const tabs = await chrome.tabs.query({ active: false });
    const count = await discardTabs(tabs, settings);
    await bumpStats({ discarded: count });
    await updateBadge();
    return { count };
  },

  async suspendWindow() {
    const settings = await getSettings();
    const tab = await activeTab();
    if (!tab) return { count: 0 };
    const tabs = await chrome.tabs.query({ windowId: tab.windowId, active: false });
    const count = await discardTabs(tabs, settings);
    await bumpStats({ discarded: count });
    await updateBadge();
    return { count };
  },

  async suspendGroup() {
    const tab = await activeTab();
    if (!tab) return { count: 0 };
    const count = await suspendGroupOf(tab);
    await bumpStats({ discarded: count });
    return { count };
  },

  async suspendTabs({ ids }) {
    const settings = await getSettings();
    const tabs = [];
    for (const id of ids || []) {
      const t = await chrome.tabs.get(id).catch(() => null);
      if (t) tabs.push(t);
    }
    const count = await discardTabs(tabs, settings);
    await bumpStats({ discarded: count });
    await updateBadge();
    return { count };
  },

  async archiveGroup() {
    const tab = await activeTab();
    if (!tab) return { archived: 0 };
    return archiveGroupOf(tab);
  },

  async archiveWindow() {
    const settings = await getSettings();
    const tab = await activeTab();
    if (!tab) return { archived: 0 };
    const tabs = await chrome.tabs.query({ windowId: tab.windowId, active: false });
    const allowed = await filterArchivable(tabs, settings);
    const result = await archiveTabs(allowed, await getSeen());
    await updateBadge();
    return result;
  },

  async archiveOthers() {
    const settings = await getSettings();
    const tabs = await chrome.tabs.query({ active: false });
    const allowed = await filterArchivable(tabs, settings);
    const result = await archiveTabs(allowed, await getSeen());
    await updateBadge();
    return result;
  },

  async archiveTabsById({ ids }) {
    const settings = await getSettings();
    const tabs = [];
    for (const id of ids || []) {
      const t = await chrome.tabs.get(id).catch(() => null);
      if (t) tabs.push(t);
    }
    const allowed = await filterArchivable(tabs, settings);
    const result = await archiveTabs(allowed, await getSeen());
    await updateBadge();
    return result;
  },

  async archiveGroupById({ groupId }) {
    const tab = { groupId };
    return archiveGroupOf(tab);
  },

  async suspendGroupById({ groupId }) {
    const settings = await getSettings();
    const groupTabs = await tabsOfGroup(groupId);
    const count = await discardTabs(groupTabs, settings);
    await bumpStats({ discarded: count });
    await updateBadge();
    return { count };
  },

  async restore({ ids, suspended, removeFromVault, windowId }) {
    const settings = await getSettings();
    const result = await restoreEntries(ids || [], {
      suspended: suspended === undefined ? settings.restoreSuspended : suspended,
      removeFromVault: !!removeFromVault,
      windowId
    });
    await updateBadge();
    return result;
  },

  async deleteEntries({ ids }) {
    return deleteEntries(ids || []);
  },

  async renameEntry({ id, title }) {
    return renameEntry(id, title);
  },

  async moveVaultEntries({ ids, targetKey, beforeId }) {
    return moveVaultEntries(ids || [], targetKey || '', beforeId || null);
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
      const before = await chrome.tabs.get(Number(beforeTabId)).catch(() => null);
      if (before && before.windowId === winId) {
        await chrome.tabs.move(tabIds, { index: before.index }).catch(() => {});
        if (groupId !== null) await chrome.tabs.group({ groupId, tabIds }).catch(() => {});
      }
    }

    await updateBadge();
    return { moved: tabIds.length, groupId };
  },

  async importVault({ payload, mode }) {
    return importVault(payload, mode);
  },

  async saveSettings({ patch }) {
    const next = await saveSettings(patch);
    await updateBadge();
    return next;
  },

  async resetSettings() {
    const next = await resetSettings();
    await updateBadge();
    return next;
  },

  async sweepNow() {
    await sweep();
    return { ok: true };
  },

  async focusTab({ id }) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) return { ok: false };
    await chrome.tabs.update(id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { ok: true };
  },

  async openDashboard() {
    await openDashboard();
    return { ok: true };
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

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureAlarm();
  const tabs = await chrome.tabs.query({});
  await seedActivity(tabs);
  await syncSeen(tabs, await getActivity());
  await updateBadge();
  if (details.reason === 'install') await openDashboard();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  const tabs = await chrome.tabs.query({});
  await seedActivity(tabs);
  await discardOnStartup();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SWEEP_ALARM) return;
  await sweep();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await touch(tabId);
  await updateBadge();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await touch(tab.id);
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'complete' || info.url) await touch(tabId);
  if (info.discarded !== undefined) await updateBadge();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await forget(tabId);
  await updateBadge();
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await forget(removedTabId);
  await touch(addedTabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await touch(tab.id);
});

chrome.tabGroups.onUpdated.addListener(async (group) => {
  if (!group.collapsed) return;
  const settings = await getSettings();
  if (!settings.collapsedImmediate) return;
  const tabs = await tabsOfGroup(group.id);
  const count = await discardTabs(tabs, settings);
  if (count) await bumpStats({ discarded: count });
  await updateBadge();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'suspend-others') await handlers.suspendOthers();
  else if (command === 'suspend-current') await handlers.suspendCurrent();
  else if (command === 'suspend-window') await handlers.suspendWindow();
  else if (command === 'archive-group') await handlers.archiveGroup();
  else if (command === 'open-dashboard') await openDashboard();
});

ensureAlarm();
