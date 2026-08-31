const BLOCKED_SCHEMES = ['chrome:', 'chrome-extension:', 'devtools:', 'about:', 'edge:', 'brave:', 'opera:', 'vivaldi:', 'moz-extension:'];

const SEP = String.fromCharCode(31);

export function urlKey(url) {
  if (!url) return '';
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isBlockedUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  if (BLOCKED_SCHEMES.some((s) => lower.startsWith(s))) return true;
  if (lower.startsWith('https://chromewebstore.google.com')) return true;
  if (lower.startsWith('https://chrome.google.com/webstore')) return true;
  return false;
}

export function isScriptableUrl(url) {
  if (isBlockedUrl(url)) return false;
  const lower = (url || '').toLowerCase();
  return lower.startsWith('http:') || lower.startsWith('https:');
}

export function matchesWhitelist(url, list) {
  if (!url || !Array.isArray(list) || !list.length) return false;
  const host = hostOf(url);
  const lower = url.toLowerCase();
  for (const raw of list) {
    const item = String(raw || '').trim().toLowerCase();
    if (!item) continue;
    if (item.length > 2 && item.startsWith('/') && item.endsWith('/')) {
      try {
        if (new RegExp(item.slice(1, -1), 'i').test(url)) return true;
      } catch {
        continue;
      }
      continue;
    }
    if (item.includes('/')) {
      if (lower.includes(item)) return true;
      continue;
    }
    if (item.startsWith('*.')) {
      const base = item.slice(2);
      if (host === base || host.endsWith('.' + base)) return true;
      continue;
    }
    if (host === item || host.endsWith('.' + item)) return true;
  }
  return false;
}

export function groupKeyOf(title, color) {
  if (!title && !color) return '';
  return `${title || ''}${SEP}${color || 'grey'}`;
}

export function splitGroupKey(key) {
  if (!key) return { title: '', color: 'grey' };
  const idx = key.indexOf(SEP);
  if (idx === -1) return { title: key, color: 'grey' };
  return { title: key.slice(0, idx), color: key.slice(idx + 1) || 'grey' };
}

export function humanAge(ts) {
  if (!ts) return 'desconhecido';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mes`;
  return `${Math.floor(mo / 12)}a`;
}

export function newId() {
  return `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
