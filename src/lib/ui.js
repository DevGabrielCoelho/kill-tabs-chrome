export function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false, error: 'sem resposta do serviço' });
    });
  });
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function applyChrome(settings) {
  const root = document.documentElement;
  const theme = settings && settings.theme ? settings.theme : 'system';
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  root.setAttribute('data-density', (settings && settings.density) || 'cozy');
}

export function formatRam(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

const UNITS = [
  [60, 'agora'],
  [3600, (s) => `${Math.floor(s / 60)} min`],
  [86400, (s) => `${Math.floor(s / 3600)} h`],
  [2592000, (s) => `${Math.floor(s / 86400)} d`],
  [31536000, (s) => `${Math.floor(s / 2592000)} mes`]
];

export function relTime(ts) {
  if (!ts) return '-';
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  for (const [limit, label] of UNITS) {
    if (secs < limit) return typeof label === 'string' ? label : label(secs);
  }
  return `${Math.floor(secs / 31536000)} a`;
}

const clocks = new Set();

export function liveTime(node, ts, prefix) {
  const paint = () => {
    node.textContent = prefix ? `${prefix} ${relTime(ts)}` : relTime(ts);
  };
  paint();
  clocks.add(paint);
  return node;
}

export function resetClocks() {
  clocks.clear();
}

setInterval(() => {
  for (const paint of clocks) {
    try {
      paint();
    } catch {
      clocks.delete(paint);
    }
  }
}, 30000);

export function highlight(text, query) {
  const frag = document.createDocumentFragment();
  const value = String(text || '');
  if (!query) {
    frag.appendChild(document.createTextNode(value));
    return frag;
  }
  const lower = value.toLowerCase();
  let at = 0;
  let hit = lower.indexOf(query);
  if (hit === -1) {
    frag.appendChild(document.createTextNode(value));
    return frag;
  }
  while (hit !== -1) {
    if (hit > at) frag.appendChild(document.createTextNode(value.slice(at, hit)));
    const mark = document.createElement('mark');
    mark.textContent = value.slice(hit, hit + query.length);
    frag.appendChild(mark);
    at = hit + query.length;
    hit = lower.indexOf(query, at);
  }
  if (at < value.length) frag.appendChild(document.createTextNode(value.slice(at)));
  return frag;
}

export function faviconNode(url, pageUrl) {
  if (url) {
    const img = el('img', 'favicon');
    img.src = url;
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(monogram(pageUrl)));
    return img;
  }
  return monogram(pageUrl);
}

function monogram(pageUrl) {
  let letter = '?';
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, '');
    letter = host.charAt(0) || '?';
  } catch {
    letter = '?';
  }
  const node = el('span', 'favicon-fallback', letter);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

let tipNode = null;
let tipTimer = null;

export function initTooltips() {
  tipNode = el('div', 'tip');
  tipNode.setAttribute('role', 'tooltip');
  document.body.appendChild(tipNode);

  document.addEventListener('pointerover', (ev) => {
    const host = ev.target.closest && ev.target.closest('[data-tip]');
    if (!host) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(host), 140);
  });

  document.addEventListener('pointerout', (ev) => {
    const host = ev.target.closest && ev.target.closest('[data-tip]');
    if (!host) return;
    clearTimeout(tipTimer);
    tipNode.classList.remove('show');
  });

  document.addEventListener('focusin', (ev) => {
    const host = ev.target.closest && ev.target.closest('[data-tip]');
    if (host) showTip(host);
  });

  document.addEventListener('focusout', () => tipNode.classList.remove('show'));
  window.addEventListener('scroll', () => tipNode.classList.remove('show'), true);
}

function showTip(host) {
  const text = host.dataset.tip;
  if (!text) return;
  tipNode.textContent = text;
  tipNode.classList.add('show');
  const box = host.getBoundingClientRect();
  const tip = tipNode.getBoundingClientRect();
  let left = box.left + box.width / 2 - tip.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8));
  let top = box.top - tip.height - 7;
  if (top < 8) top = box.bottom + 7;
  tipNode.style.left = `${Math.round(left)}px`;
  tipNode.style.top = `${Math.round(top)}px`;
}

let toastNode = null;
let toastTimer = null;
let toastRaf = null;

export function initToast() {
  toastNode = el('div', 'toast');
  toastNode.setAttribute('role', 'status');
  toastNode.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastNode);
}

export function toast(message, options = {}) {
  if (!toastNode) initToast();
  clearTimeout(toastTimer);
  cancelAnimationFrame(toastRaf);
  toastNode.textContent = '';

  const label = el('span', '', message);
  toastNode.appendChild(label);

  const ms = options.ms || (options.undo ? 9000 : 2600);

  if (options.undo) {
    const btn = el('button', 'tiny', options.undoLabel || 'Desfazer');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      hideToast();
      await options.undo();
    });
    toastNode.appendChild(btn);

    const bar = el('span', 'bar');
    bar.style.width = '100%';
    toastNode.appendChild(bar);
    const started = performance.now();
    const tick = () => {
      const left = Math.max(0, 1 - (performance.now() - started) / ms);
      bar.style.width = `${left * 100}%`;
      if (left > 0) toastRaf = requestAnimationFrame(tick);
    };
    toastRaf = requestAnimationFrame(tick);
  }

  toastNode.classList.add('show');
  toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  cancelAnimationFrame(toastRaf);
  if (toastNode) toastNode.classList.remove('show');
}

export function withTransition(fn) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !document.startViewTransition) {
    fn();
    return Promise.resolve();
  }
  const transition = document.startViewTransition(fn);
  return transition.finished.catch(() => {});
}

function typing(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function bindKeys(handlers) {
  document.addEventListener('keydown', (ev) => {
    const printable = ev.key.length === 1;
    const combo = [
      ev.ctrlKey || ev.metaKey ? 'mod' : '',
      ev.shiftKey && !printable ? 'shift' : '',
      ev.altKey ? 'alt' : '',
      printable ? ev.key.toLowerCase() : ev.key
    ]
      .filter(Boolean)
      .join('+');

    const handler = handlers[combo];
    if (!handler) return;
    if (typing(ev.target) && !combo.startsWith('mod') && ev.key !== 'Escape') return;
    const consumed = handler(ev);
    if (consumed !== false) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  });
}

let overlay = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = el('div', 'overlay hidden');
  overlay.addEventListener('pointerdown', (ev) => {
    if (ev.target === overlay) closeOverlay();
  });
  document.body.appendChild(overlay);
  return overlay;
}

export function closeOverlay() {
  if (!overlay) return;
  overlay.classList.add('hidden');
  overlay.textContent = '';
  if (overlay.dataset.restore) {
    const node = document.getElementById(overlay.dataset.restore);
    if (node) node.focus();
    delete overlay.dataset.restore;
  }
}

export function openPalette(items, options = {}) {
  const host = ensureOverlay();
  host.textContent = '';
  host.classList.remove('hidden');
  if (document.activeElement && document.activeElement.id) host.dataset.restore = document.activeElement.id;

  const box = el('div', 'palette');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', options.label || 'Comandos');

  const field = el('input', 'palette-input');
  field.type = 'text';
  field.placeholder = options.placeholder || 'Digite um comando…';
  field.setAttribute('aria-label', options.placeholder || 'Comando');
  box.appendChild(field);

  const list = el('div', 'palette-list');
  list.setAttribute('role', 'listbox');
  box.appendChild(list);

  const footer = el('div', 'palette-foot');
  footer.appendChild(el('span', '', 'navegar'));
  footer.appendChild(el('kbd', '', '↑↓'));
  footer.appendChild(el('span', '', 'executar'));
  footer.appendChild(el('kbd', '', '↵'));
  footer.appendChild(el('span', '', 'fechar'));
  footer.appendChild(el('kbd', '', 'esc'));
  box.appendChild(footer);

  host.appendChild(box);

  let filtered = items;
  let cursor = 0;

  const paint = () => {
    list.textContent = '';
    if (!filtered.length) {
      list.appendChild(el('div', 'palette-empty', 'Nenhum comando com esse nome.'));
      return;
    }
    let lastGroup = null;
    filtered.forEach((item, index) => {
      if (item.group && item.group !== lastGroup) {
        lastGroup = item.group;
        list.appendChild(el('div', 'palette-group eyebrow', item.group));
      }
      const row = el('div', `palette-item${index === cursor ? ' active' : ''}`);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === cursor ? 'true' : 'false');
      const label = el('span', 'palette-label truncate');
      label.appendChild(highlight(item.label, field.value.trim().toLowerCase()));
      row.appendChild(label);
      if (item.hint) row.appendChild(el('span', 'palette-hint mono', item.hint));
      if (item.keys) row.appendChild(el('kbd', '', item.keys));
      row.addEventListener('pointerenter', () => {
        cursor = index;
        paint();
      });
      row.addEventListener('click', () => run(item));
      list.appendChild(row);
    });
    const active = list.querySelector('.palette-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  };

  const run = async (item) => {
    closeOverlay();
    await item.run();
  };

  field.addEventListener('input', () => {
    const q = field.value.trim().toLowerCase();
    filtered = q
      ? items.filter((i) => `${i.label} ${i.hint || ''} ${i.group || ''}`.toLowerCase().includes(q))
      : items;
    cursor = 0;
    paint();
  });

  field.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      cursor = Math.min(cursor + 1, filtered.length - 1);
      paint();
      ev.preventDefault();
    } else if (ev.key === 'ArrowUp') {
      cursor = Math.max(cursor - 1, 0);
      paint();
      ev.preventDefault();
    } else if (ev.key === 'Enter') {
      if (filtered[cursor]) run(filtered[cursor]);
      ev.preventDefault();
    } else if (ev.key === 'Escape') {
      closeOverlay();
      ev.preventDefault();
    }
    ev.stopPropagation();
  });

  paint();
  field.focus();
}

export function openSheet(title, rows) {
  const host = ensureOverlay();
  host.textContent = '';
  host.classList.remove('hidden');

  const box = el('div', 'sheet');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', title);
  box.appendChild(el('div', 'eyebrow', title));

  const table = el('div', 'sheet-rows');
  for (const [keys, label] of rows) {
    const row = el('div', 'sheet-row');
    const kb = el('div', 'sheet-keys');
    for (const key of keys.split(' ')) kb.appendChild(el('kbd', '', key));
    row.appendChild(kb);
    row.appendChild(el('span', '', label));
    table.appendChild(row);
  }
  box.appendChild(table);

  const close = el('button', 'tiny', 'Fechar');
  close.addEventListener('click', closeOverlay);
  box.appendChild(close);

  host.appendChild(box);
  close.focus();
}
