const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false });
    });
  });
}

let toastTimer = null;
function toast(text) {
  $('toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').textContent = ''), 2600);
}

function formatRam(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${Math.round(mb)}MB`;
}

async function refresh() {
  const res = await send('getPopupState');
  if (!res.ok) return;
  const s = res.data;
  $('s-tabs').textContent = s.totals.tabs;
  $('s-discarded').textContent = s.totals.discarded;
  $('s-vault').textContent = s.totals.vault;
  $('s-saved').textContent = formatRam((s.totals.discarded + s.totals.vault) * s.settings.estimatedMbPerTab);

  if (s.group) {
    $('group-box').classList.remove('hidden');
    $('group-dot').className = `dot ${s.group.color || 'grey'}`;
    $('group-name').textContent = s.group.title || '(grupo sem nome)';
    $('group-count').textContent = `${s.group.count} aba${s.group.count === 1 ? '' : 's'}`;
  } else {
    $('group-box').classList.add('hidden');
  }
}

function bind(id, type, message) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    const res = await send(type);
    $(id).disabled = false;
    if (!res.ok) return toast(res.error || 'falhou');
    const n = res.data.count !== undefined ? res.data.count : res.data.archived;
    toast(message(n === undefined ? 0 : n));
    refresh();
  });
}

bind('suspend-current', 'suspendCurrent', (n) => (n ? 'Aba suspensa' : 'Nada a suspender'));
bind('suspend-window', 'suspendWindow', (n) => `${n} aba(s) suspensa(s)`);
bind('suspend-others', 'suspendOthers', (n) => `${n} aba(s) suspensa(s)`);
bind('suspend-group', 'suspendGroup', (n) => `${n} aba(s) do grupo suspensa(s)`);
bind('archive-group', 'archiveGroup', (n) => `${n} aba(s) no cofre`);
bind('archive-window', 'archiveWindow', (n) => `${n} aba(s) no cofre`);
bind('archive-others', 'archiveOthers', (n) => `${n} aba(s) no cofre`);

$('dashboard').addEventListener('click', async () => {
  await send('openDashboard');
  window.close();
});

$('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refresh();
