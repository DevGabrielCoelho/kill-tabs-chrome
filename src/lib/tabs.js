import { isBlockedUrl, isScriptableUrl, matchesWhitelist } from './util.js';

export function protectionReason(tab, settings) {
  if (isBlockedUrl(tab.url || tab.pendingUrl)) return 'pagina interna';
  if (settings.protectPinned && tab.pinned) return 'fixada';
  if (settings.protectAudible && tab.audible) return 'tocando audio';
  if (settings.protectGrouped && tab.groupId !== undefined && tab.groupId !== -1) return 'em grupo';
  if (matchesWhitelist(tab.url, settings.whitelist)) return 'na whitelist';
  return null;
}

export function staticSkipReason(tab, settings) {
  if (!tab) return 'inexistente';
  if (tab.discarded) return 'ja suspensa';
  if (tab.active) return 'aba ativa';
  return protectionReason(tab, settings);
}

function detectForm() {
  const fields = document.querySelectorAll('input, textarea, select');
  for (const el of fields) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked !== el.defaultChecked) return true;
        continue;
      }
      if (el.value && el.value !== el.defaultValue) return true;
      continue;
    }
    if (tag === 'textarea') {
      if (el.value && el.value !== el.defaultValue) return true;
      continue;
    }
    if (tag === 'select') {
      for (const o of el.options) {
        if (o.selected !== o.defaultSelected) return true;
      }
    }
  }
  const active = document.activeElement;
  if (active && active.isContentEditable && active.textContent && active.textContent.trim()) return true;
  return false;
}

export async function hasUnsavedForm(tab) {
  if (!isScriptableUrl(tab.url)) return false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: detectForm
    });
    return results.some((r) => r && r.result === true);
  } catch {
    return false;
  }
}

export async function canDiscard(tab, settings) {
  const reason = staticSkipReason(tab, settings);
  if (reason) return { ok: false, reason };
  if (settings.protectForms && (await hasUnsavedForm(tab))) return { ok: false, reason: 'formulario preenchido' };
  return { ok: true, reason: null };
}

export async function discardTabs(tabs, settings) {
  let count = 0;
  const skipped = [];
  for (const tab of tabs) {
    const verdict = await canDiscard(tab, settings);
    if (!verdict.ok) {
      skipped.push({ id: tab.id, title: tab.title || tab.url, reason: verdict.reason });
      continue;
    }
    try {
      await chrome.tabs.discard(tab.id);
      count++;
    } catch {
      skipped.push({ id: tab.id, title: tab.title || tab.url, reason: 'o Chrome recusou o discard' });
    }
  }
  return { count, skipped };
}

export async function discardIgnoringActive(tabs, settings) {
  const active = tabs.filter((t) => t.active);
  const rest = tabs.filter((t) => !t.active);
  let count = (await discardTabs(rest, settings)).count;
  for (const tab of active) {
    const moved = await stepAsideAndDiscard(tab, settings);
    if (moved) count++;
  }
  return count;
}

export async function stepAsideAndDiscard(tab, settings) {
  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  const target = siblings.find((t) => t.id !== tab.id && !t.discarded) || siblings.find((t) => t.id !== tab.id);
  if (!target) return false;
  try {
    await chrome.tabs.update(target.id, { active: true });
  } catch {
    return false;
  }
  const fresh = await chrome.tabs.get(tab.id).catch(() => null);
  if (!fresh) return false;
  const verdict = await canDiscard(fresh, settings);
  if (!verdict.ok) return false;
  try {
    await chrome.tabs.discard(fresh.id);
    return true;
  } catch {
    return false;
  }
}

export async function canArchive(tab, settings) {
  if (!tab) return { ok: false, reason: 'inexistente' };
  if (tab.active) return { ok: false, reason: 'aba ativa' };
  const reason = protectionReason(tab, settings);
  if (reason) return { ok: false, reason };
  if (settings.protectForms && !tab.discarded && (await hasUnsavedForm(tab))) {
    return { ok: false, reason: 'formulario preenchido' };
  }
  return { ok: true, reason: null };
}

export async function urgentDiscardTabs(tabs) {
  let count = 0;
  for (const tab of tabs) {
    if (!tab || tab.discarded) continue;
    if (isBlockedUrl(tab.url || tab.pendingUrl)) continue;
    if (tab.active) {
      const moved = await stepAsideAndDiscard(tab, { protectForms: false, whitelist: [] });
      if (moved) count++;
      continue;
    }
    try {
      await chrome.tabs.discard(tab.id);
      count++;
    } catch {
      continue;
    }
  }
  return count;
}
