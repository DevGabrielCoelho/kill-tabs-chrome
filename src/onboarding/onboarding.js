import { send, applyChrome, formatRam, initTooltips, initToast, toast } from '../lib/ui.js';

const $ = (id) => document.getElementById(id);

async function load() {
  const [plan, popup] = await Promise.all([send('firstRunPlan'), send('getPopupState')]);
  if (popup.ok) applyChrome(popup.data.settings);
  if (!plan.ok) return;
  const data = plan.data;
  $('count').textContent = data.total;
  $('suspendable').textContent = data.suspendable;
  $('estimate').textContent = data.suspendable
    ? `libera cerca de ${formatRam(data.estimate)} agora`
    : 'nada elegível neste momento';
  $('go').disabled = data.suspendable === 0;
}

$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  const res = await send('suspendOthers');
  if (!res.ok) {
    toast(res.error || 'o serviço não respondeu');
    $('go').disabled = false;
    return;
  }
  const data = res.data || {};
  const n = data.count || 0;
  toast(
    n ? `${n} ${n === 1 ? 'aba suspensa' : 'abas suspensas'}: a barra continua igual` : 'nada elegível neste momento',
    data.undoable
      ? {
          undo: async () => {
            await send('undoLast');
            toast('abas recarregadas');
            load();
          }
        }
      : {}
  );
  load();
});

$('dashboard').addEventListener('click', () => send('openDashboard'));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

initTooltips();
initToast();
load();
