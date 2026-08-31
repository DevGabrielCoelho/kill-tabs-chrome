const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false });
    });
  });
}

const BOOLS = [
  'collapsedImmediate',
  'discardOnStartup',
  'showBadge',
  'archiveEnabled',
  'maxTabsEnabled',
  'restoreSuspended',
  'protectPinned',
  'protectAudible',
  'protectForms',
  'protectGrouped'
];

const NUMBERS = ['idleMinutes', 'archiveDays', 'maxTabs', 'estimatedMbPerTab'];

let statusTimer = null;
function status(text) {
  const el = $('status');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

function minutesLabel(value) {
  const n = Number(value);
  if (n < 60) return `${n} minuto${n === 1 ? '' : 's'}`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h} hora${h === 1 ? '' : 's'}`;
}

function daysLabel(value) {
  const n = Number(value);
  if (n < 30) return `${n} dia${n === 1 ? '' : 's'}`;
  const mo = Math.round(n / 30);
  return `${n} dias (~${mo} ${mo === 1 ? 'mês' : 'meses'})`;
}

function paint(settings) {
  for (const key of BOOLS) $(key).checked = !!settings[key];
  for (const key of NUMBERS) $(key).value = settings[key];
  $('whitelist').value = (settings.whitelist || []).join('\n');
  $('idle-label').textContent = minutesLabel(settings.idleMinutes);
  $('days-label').textContent = daysLabel(settings.archiveDays);
}

async function save(patch) {
  const res = await send('saveSettings', { patch });
  if (res.ok) status('Salvo');
  return res.data;
}

async function load() {
  const res = await send('getPopupState');
  if (!res.ok) return;
  paint(res.data.settings);
}

for (const key of BOOLS) {
  $(key).addEventListener('change', () => save({ [key]: $(key).checked }));
}

for (const key of NUMBERS) {
  $(key).addEventListener('change', () => save({ [key]: Number($(key).value) }));
}

$('idleMinutes').addEventListener('input', () => {
  $('idle-label').textContent = minutesLabel($('idleMinutes').value);
});

$('archiveDays').addEventListener('input', () => {
  $('days-label').textContent = daysLabel($('archiveDays').value);
});

let whitelistTimer = null;
$('whitelist').addEventListener('input', () => {
  clearTimeout(whitelistTimer);
  whitelistTimer = setTimeout(() => {
    const list = $('whitelist')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    save({ whitelist: list });
  }, 600);
});

$('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

$('dashboard').addEventListener('click', () => send('openDashboard'));

$('reset').addEventListener('click', async () => {
  const res = await send('resetSettings');
  if (res.ok) {
    paint(res.data);
    status('Padrões restaurados');
  }
});

load();
