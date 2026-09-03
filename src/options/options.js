import { send, applyChrome, initTooltips, initToast, toast } from '../lib/ui.js';

const $ = (id) => document.getElementById(id);

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

const NUMBERS = ['idleMinutes', 'archiveDays', 'maxTabs', 'estimatedMbPerTab', 'recentLimit'];
const CHOICES = ['theme', 'density'];

function minutesLabel(value) {
  const n = Number(value);
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

function daysLabel(value) {
  const n = Number(value);
  if (n < 30) return `${n} ${n === 1 ? 'dia' : 'dias'}`;
  const mo = Math.round(n / 30);
  return `${n} dias · ~${mo} ${mo === 1 ? 'mês' : 'meses'}`;
}

function recentLabel(value) {
  const n = Number(value);
  if (!n) return 'desligado';
  return `${n} ${n === 1 ? 'aba' : 'abas'}`;
}

function paint(settings) {
  for (const key of BOOLS) $(key).checked = !!settings[key];
  for (const key of NUMBERS) $(key).value = settings[key];
  for (const key of CHOICES) $(key).value = settings[key];
  $('whitelist').value = (settings.whitelist || []).join('\n');
  $('idle-label').textContent = minutesLabel(settings.idleMinutes);
  $('days-label').textContent = daysLabel(settings.archiveDays);
  $('recent-label').textContent = recentLabel(settings.recentLimit);
  applyChrome(settings);
}

async function save(patch, note) {
  const res = await send('saveSettings', { patch });
  if (res.ok) {
    applyChrome(res.data);
    toast(note || 'salvo');
  } else {
    toast(res.error || 'não consegui salvar');
  }
  return res.data;
}

async function load() {
  const res = await send('getPopupState');
  if (!res.ok) return toast('o serviço não respondeu');
  paint(res.data.settings);
}

for (const key of BOOLS) {
  $(key).addEventListener('change', () => save({ [key]: $(key).checked }));
}

for (const key of NUMBERS) {
  $(key).addEventListener('change', () => save({ [key]: Number($(key).value) }));
}

for (const key of CHOICES) {
  $(key).addEventListener('change', () => save({ [key]: $(key).value }));
}

$('idleMinutes').addEventListener('input', () => {
  $('idle-label').textContent = minutesLabel($('idleMinutes').value);
});

$('archiveDays').addEventListener('input', () => {
  $('days-label').textContent = daysLabel($('archiveDays').value);
});

$('recentLimit').addEventListener('input', () => {
  $('recent-label').textContent = recentLabel($('recentLimit').value);
});

let whitelistTimer = null;
$('whitelist').addEventListener('input', () => {
  clearTimeout(whitelistTimer);
  whitelistTimer = setTimeout(() => {
    const list = $('whitelist')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    save({ whitelist: list }, `${list.length} ${list.length === 1 ? 'regra' : 'regras'} na lista`);
  }, 600);
});

$('shortcuts').addEventListener('click', () => send('openShortcuts'));
$('dashboard').addEventListener('click', () => send('openDashboard'));
$('onboarding').addEventListener('click', () => send('openOnboarding'));

$('reset').addEventListener('click', async () => {
  const res = await send('resetSettings');
  if (res.ok) {
    paint(res.data);
    toast('tudo de volta ao padrão');
  }
});

initTooltips();
initToast();
load();
