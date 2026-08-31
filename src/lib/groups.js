import { groupKeyOf } from './util.js';

export const PLACEHOLDER_URL = 'about:blank';

export async function captureGroup(groupId) {
  if (groupId === undefined || groupId === -1) return null;
  try {
    const g = await chrome.tabGroups.get(groupId);
    return { title: g.title || '', color: g.color || 'grey', collapsed: !!g.collapsed };
  } catch {
    return null;
  }
}

export async function findGroup(windowId, title, color) {
  let groups = [];
  try {
    groups = await chrome.tabGroups.query({ windowId });
  } catch {
    return null;
  }
  const wanted = (title || '').trim();
  const exact = groups.find((g) => (g.title || '').trim() === wanted && g.color === color);
  if (exact) return exact;
  return groups.find((g) => (g.title || '').trim() === wanted) || null;
}

export async function expandGroup(groupId) {
  try {
    const g = await chrome.tabGroups.get(groupId);
    if (g.collapsed) await chrome.tabGroups.update(groupId, { collapsed: false });
    return true;
  } catch {
    return false;
  }
}

export async function resolveGroup(windowId, title, color, options = {}) {
  const existing = await findGroup(windowId, title, color);
  if (existing) {
    await expandGroup(existing.id);
    return { groupId: existing.id, created: false };
  }
  if (!options.create) return { groupId: null, created: false };

  let placeholder = null;
  try {
    placeholder = await chrome.tabs.create({ url: PLACEHOLDER_URL, windowId, active: false });
  } catch {
    return { groupId: null, created: false };
  }
  try {
    const groupId = await chrome.tabs.group({ tabIds: placeholder.id, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, {
      title: title || '',
      color: color || 'grey',
      collapsed: false
    });
    return { groupId, created: true, placeholderId: placeholder.id };
  } catch {
    await chrome.tabs.remove(placeholder.id).catch(() => {});
    return { groupId: null, created: false };
  }
}

export async function attachToGroup(tabIds, windowId, title, color) {
  if (!tabIds.length) return null;
  const resolved = await resolveGroup(windowId, title, color, { create: true });
  if (resolved.groupId === null) return null;
  try {
    await chrome.tabs.group({ groupId: resolved.groupId, tabIds });
  } catch {
    if (resolved.placeholderId) await chrome.tabs.remove(resolved.placeholderId).catch(() => {});
    return null;
  }
  if (resolved.placeholderId) {
    await chrome.tabs.remove(resolved.placeholderId).catch(() => {});
  }
  await expandGroup(resolved.groupId);
  return resolved.groupId;
}

export async function tabsOfGroup(groupId) {
  if (groupId === undefined || groupId === -1) return [];
  try {
    return await chrome.tabs.query({ groupId });
  } catch {
    return [];
  }
}

export async function currentGroupKey(tab) {
  const g = await captureGroup(tab.groupId);
  if (!g) return '';
  return groupKeyOf(g.title, g.color);
}
