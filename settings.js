const $ = (id) => document.getElementById(id);
const api = window.lhc;
let model = null;

function show(el, r) { el.textContent = r ? (r.ok ? '✓ ' : '✗ ') + r.msg : ''; el.className = 'res ' + (r ? (r.ok ? 'ok' : 'err') : ''); }

api.invoke('settings-get').then((s) => {
  $('hub').value = s.hubUrl;
  if (s.hasHubKey) $('hkey').placeholder = 'Server key saved (enter a new one to replace it)';
  if (s.hasKey) { $('key').placeholder = 'Saved key ' + s.keyHint + ' (enter a new one to replace it)'; $('khint').textContent = 'A key is already saved.'; }
});

async function test() {
  $('test').disabled = $('save').disabled = true;
  $('kres').textContent = 'Checking…'; $('kres').className = 'res';
  const r = await api.invoke('settings-test', { key: $('key').value, hubUrl: $('hub').value, hubKey: $('hkey').value });
  show($('kres'), r.key); show($('hres'), r.hub);
  if (!r.hub.ok) $('adv').open = true;
  model = r.key.ok ? r.key.model : null;
  $('test').disabled = $('save').disabled = false;
  return r;
}

$('test').onclick = test;
$('save').onclick = async () => {
  const r = await test();
  if (!r.key.ok) return;
  const s = await api.invoke('settings-save', { key: $('key').value, hubUrl: $('hub').value, model, hubKey: $('hkey').value });
  if (s.ok) { $('kres').textContent = '✓ Saved. Now click the हि button on the side of the screen.'; setTimeout(() => api.send('close-settings'), 1400); }
  else show($('kres'), { ok: false, msg: s.msg });
};
$('ai').onclick = (e) => { e.preventDefault(); api.send('open-url', 'https://aistudio.google.com/apikey'); };
