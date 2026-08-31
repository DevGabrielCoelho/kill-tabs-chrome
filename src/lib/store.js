export const DEFAULTS = {
  idleMinutes: 30,
  discardOnStartup: true,
  collapsedImmediate: true,
  archiveEnabled: true,
  archiveDays: 30,
  maxTabsEnabled: false,
  maxTabs: 120,
  protectPinned: true,
  protectAudible: true,
  protectForms: true,
  protectGrouped: false,
  whitelist: ['localhost', '127.0.0.1'],
  restoreSuspended: false,
  estimatedMbPerTab: 60,
  showBadge: true
};

const SETTINGS = 'settings';
const VAULT = 'vault';
const SEEN = 'seen';
const STATS = 'stats';

export async function getSettings() {
  const r = await chrome.storage.local.get(SETTINGS);
  return { ...DEFAULTS, ...(r[SETTINGS] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ [SETTINGS]: { ...DEFAULTS } });
  return { ...DEFAULTS };
}

export async function getVault() {
  const r = await chrome.storage.local.get(VAULT);
  const v = r[VAULT];
  if (!v || !Array.isArray(v.entries)) return { entries: [] };
  return v;
}

export async function saveVault(vault) {
  await chrome.storage.local.set({ [VAULT]: vault });
}

export async function getSeen() {
  const r = await chrome.storage.local.get(SEEN);
  return r[SEEN] || {};
}

export async function saveSeen(seen) {
  await chrome.storage.local.set({ [SEEN]: seen });
}

export async function getStats() {
  const r = await chrome.storage.local.get(STATS);
  return { discarded: 0, archived: 0, restored: 0, ...(r[STATS] || {}) };
}

export async function bumpStats(patch) {
  const cur = await getStats();
  for (const k of Object.keys(patch)) cur[k] = (cur[k] || 0) + patch[k];
  await chrome.storage.local.set({ [STATS]: cur });
  return cur;
}

const ACT = 'act:';

export async function touch(tabId) {
  await chrome.storage.session.set({ [ACT + tabId]: Date.now() });
}

export async function forget(tabId) {
  await chrome.storage.session.remove(ACT + tabId);
}

export async function getActivity() {
  const all = await chrome.storage.session.get(null);
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(ACT)) out[Number(k.slice(ACT.length))] = v;
  }
  return out;
}

export async function seedActivity(tabs) {
  const now = Date.now();
  const patch = {};
  const existing = await chrome.storage.session.get(null);
  for (const t of tabs) {
    if (existing[ACT + t.id] === undefined) patch[ACT + t.id] = now;
  }
  if (Object.keys(patch).length) await chrome.storage.session.set(patch);
}
