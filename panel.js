// Panel: captures system audio (loopback), cuts it into speech chunks, shows captions.
const $ = (id) => document.getElementById(id);
const api = window.lhc;

const FRAME_MS = 20;
const RATE = 16000;
let stream = null, ctx = null, node = null;
let micOn = false, micStream = null, micSrc = null, micGain = null, micMeter = null, meterRaf = 0;
let micVol = 100; // percent; raise it if the level bar barely moves
try { const v = Number(localStorage.getItem('micVol')); if (v >= 0 && v <= 400 && localStorage.getItem('micVol') !== null) micVol = v; } catch { /* storage blocked */ }
let state = 'idle';
let t0 = null; // first start, for timestamps

// ---------- chunker (energy VAD) ----------
let frames = [];      // {pcm: Float32Array, rms, t}
let preroll = [];     // last 300 ms before speech
let speechMs = 0, silenceMs = 0;
let noise = 0.003;

function rmsOf(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); }

function onFrame(pcm) {
  if (state !== 'live') return;
  const t = (Date.now() - t0) / 1000;
  const rms = rmsOf(pcm);
  const thr = Math.max(0.006, noise * 3);
  const speech = rms > thr;
  if (!speech) noise = noise * 0.98 + rms * 0.02; // track the floor only on quiet frames
  const f = { pcm, rms, t };

  if (!frames.length && !speech) {
    preroll.push(f); if (preroll.length > 15) preroll.shift();
    return;
  }
  if (!frames.length) { frames = preroll; preroll = []; speechMs = 0; silenceMs = 0; }
  frames.push(f);
  if (speech) { speechMs += FRAME_MS; silenceMs = 0; } else silenceMs += FRAME_MS;

  const bufMs = frames.length * FRAME_MS;
  if (speechMs < 140 && silenceMs >= 800) { frames = []; return; }          // a click (a short "Yes." is ~200 ms and is kept)
  if (speechMs >= 200 && silenceMs >= 450 && bufMs >= 700) return cut(frames.length);
  if (bufMs >= 7000) {                                                       // long talk: cut at the quietest spot of the last second
    let best = frames.length - 1;
    for (let i = frames.length - 50; i < frames.length; i++) if (frames[i].rms < frames[best].rms) best = i;
    cut(best + 1);
  }
}

function cut(n) {
  const take = frames.slice(0, n);
  frames = frames.slice(n);
  // carry over the speech already in the leftover so it is not mistaken for a click
  const thr = Math.max(0.006, noise * 3);
  speechMs = frames.filter((f) => f.rms > thr).length * FRAME_MS; silenceMs = 0;
  const wav = encodeWav(take.map((f) => f.pcm));
  api.send('chunk', { wav, start: take[0].t - FRAME_MS / 1000, end: take[take.length - 1].t });
}

function encodeWav(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const p of parts) for (let i = 0; i < p.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, p[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// ---------- capture ----------
async function start() {
  msg('');
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) { msg('Could not start audio capture: ' + e.message); return; }
  const audio = stream.getAudioTracks();
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!audio.length) { msg('No system audio found'); return; }
  ctx = new AudioContext({ sampleRate: RATE });
  await ctx.audioWorklet.addModule('worklet.js');
  const src = ctx.createMediaStreamSource(new MediaStream(audio));
  node = new AudioWorkletNode(ctx, 'tap');
  node.port.onmessage = (e) => onFrame(e.data);
  const mute = ctx.createGain(); mute.gain.value = 0; // keep the graph running, play nothing back
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);
  if (micOn) await micConnect();
  if (t0 === null) t0 = Date.now();
  setState('live');
  if ($('cur').dataset.empty !== '0') $('cur').textContent = 'Listening…';
}

// ---------- mic (optional: also hear the user's own voice) ----------
async function micConnect() {
  if (!ctx || micSrc) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    micSrc = ctx.createMediaStreamSource(micStream);
    micGain = ctx.createGain(); micGain.gain.value = micVol / 100;
    micMeter = ctx.createAnalyser(); micMeter.fftSize = 512;
    micSrc.connect(micGain); micGain.connect(node); micGain.connect(micMeter);
    drawMeter();
  } catch (e) { msg('Microphone not available: ' + e.message); micOn = false; showMic(); }
}
function micDisconnect() {
  try { micSrc?.disconnect(); micGain?.disconnect(); } catch { /* already gone */ }
  micStream?.getTracks().forEach((t) => t.stop());
  micSrc = null; micStream = null; micGain = null; micMeter = null;
  cancelAnimationFrame(meterRaf); $('miclvl').style.width = '0%';
}
// Live mic level (after the volume), so the user can see the mic is hearing them.
const meterBuf = new Float32Array(512);
function drawMeter() {
  if (!micMeter) return;
  micMeter.getFloatTimeDomainData(meterBuf);
  let s = 0; for (let i = 0; i < meterBuf.length; i++) s += meterBuf[i] * meterBuf[i];
  const rms = Math.sqrt(s / meterBuf.length);
  $('miclvl').style.width = Math.min(100, rms * 600) + '%';
  $('miclvl').dataset.ok = rms > 0.006 ? '1' : '0'; // same floor as the speech detector
  meterRaf = requestAnimationFrame(drawMeter);
}
function setVol(v) {
  micVol = v;
  $('micvol').value = v; $('micpct').textContent = v + '%';
  if (micGain) micGain.gain.value = v / 100;
  try { localStorage.setItem('micVol', String(v)); } catch { /* storage blocked */ }
}
$('micvol').oninput = (e) => setVol(Number(e.target.value));
setVol(micVol);

function showMic() {
  $('mic').classList.toggle('on', micOn);
  $('micbox').hidden = !micOn;
  $('mic').title = micOn ? 'Mic is on: your own voice is translated too. Click to turn off.' : 'Mic is off: only speaker audio is translated. Click to include your own voice.';
}
$('mic').onclick = async () => { micOn = !micOn; showMic(); if (micOn) await micConnect(); else micDisconnect(); };
showMic();

function pause() {
  if (frames.length && speechMs >= 140) cut(frames.length); // send what was already said
  frames = []; preroll = [];
  ctx?.suspend();
  setState('paused');
  api.send('paused');
}
function resume() { ctx?.resume(); setState('live'); }
function stop() {
  if (state === 'idle') return;
  if (frames.length && speechMs >= 140) cut(frames.length);
  frames = []; preroll = [];
  micDisconnect();
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close(); ctx = null; stream = null; node = null;
  setState('idle');
}

// ---------- UI ----------
function msg(t, kind) { $('msg').textContent = t; $('msg').dataset.kind = kind || 'err'; }
function setState(s) {
  state = s;
  document.body.dataset.s = s;
  $('st').textContent = { idle: 'Off', live: 'Listening', paused: 'Paused' }[s];
  $('start').hidden = s !== 'idle';
  $('pause').hidden = s !== 'live';
  $('resume').hidden = s !== 'paused';
  $('stop').hidden = s === 'idle';
  api.send('state', s);
}

$('start').onclick = () => api.send('tab-click');
$('pause').onclick = pause;
$('resume').onclick = resume;
$('stop').onclick = () => { stop(); api.send('stop'); msg('Meeting ended. Click "Download" to save it.', 'ok'); };
api.on('stopped', ({ count, downloaded }) => { if (count && !downloaded) msg('Meeting ended. Click "Download" to save it.', 'ok'); });
$('hide').onclick = () => api.send('hide');
$('gear').onclick = () => api.send('open-settings');
$('quit').onclick = () => api.send('quit');
$('dl').onclick = async () => {
  const r = await api.invoke('download');
  if (r && r.ok) msg('Saved: ' + r.path, 'ok');
  else if (r && r.msg) msg(r.msg);
};

api.on('cmd', (c) => ({ start, pause, resume, stop })[c]?.());
api.on('english', (t) => { $('en').textContent = t; });
api.on('segment', (e) => {
  const cur = $('cur');
  if (cur.dataset.empty === '0') $('prev').textContent = cur.textContent;
  cur.dataset.empty = '0';
  cur.textContent = e.hi || e.en;
  $('en').textContent = e.hi ? e.en : '';
  if (e.err) msg(e.err);
  else if ($('msg').dataset.kind === 'err') msg('');
});
api.on('error', (m) => msg(m));
const NOKEY = 'No Gemini key, so English only. Click ⚙ to add a key.';
api.on('state', ({ hasKey }) => { if (!hasKey && !$('msg').textContent) msg(NOKEY); });
api.invoke('info').then(({ hasKey }) => { if (!hasKey) msg(NOKEY); });
