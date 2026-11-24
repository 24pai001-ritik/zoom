// Live Hindi Captions: hears whatever plays on this PC (any app), shows Hindi captions, exports the transcript.
// Audio -> our ASR hub (English) -> Gemini (Hindi). No meeting-app API involved.
const { app, BrowserWindow, ipcMain, screen, session, desktopCapturer, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

if (process.env.LHC_PROFILE) app.setPath('userData', process.env.LHC_PROFILE); // test: fresh profile
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ---------- settings ----------
// Public hub gateway (L40S, cloudflare quick tunnel). The URL can change; users fix it in Settings.
const DEFAULTS = { hubUrl: 'https://sugar-rolling-political-sites.trycloudflare.com', geminiModel: 'gemini-2.5-flash', hideFromScreenShare: true };
let cfg = { ...DEFAULTS };
function loadConfig() {
  const p = path.join(app.getPath('userData'), 'config.json');
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* first run */ }
  cfg = { ...DEFAULTS, ...fileCfg };
  if (process.env.HUB_URL) cfg.hubUrl = process.env.HUB_URL;
  if (process.env.GEMINI_MODEL) cfg.geminiModel = process.env.GEMINI_MODEL;
  if (process.env.HIDE_FROM_SHARE === '0') cfg.hideFromScreenShare = false;
}
function saveConfig(patch) {
  const p = path.join(app.getPath('userData'), 'config.json');
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* none yet */ }
  Object.assign(fileCfg, patch);
  fs.writeFileSync(p, JSON.stringify(fileCfg, null, 2));
  Object.assign(cfg, patch);
}

// Key order: the one pasted in Settings (encrypted with Windows DPAPI via safeStorage, this PC + user only),
// then the environment / user env in the registry. Never logged.
const keyFile = () => path.join(app.getPath('userData'), 'gemini.key');
function storedKey() {
  try { return safeStorage.decryptString(fs.readFileSync(keyFile())); } catch { return null; }
}
function storeKey(k) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available on this PC');
  fs.writeFileSync(keyFile(), safeStorage.encryptString(k));
  keyCache = { v: k, at: Date.now() };
}
const hubKeyFile = () => path.join(app.getPath('userData'), 'hub.key');
let hubKeyCache;
function hubKey() {
  if (hubKeyCache !== undefined) return hubKeyCache;
  try { hubKeyCache = safeStorage.decryptString(fs.readFileSync(hubKeyFile())); } catch { hubKeyCache = process.env.HUB_KEY || null; }
  return hubKeyCache;
}
function storeHubKey(k) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available on this PC');
  fs.writeFileSync(hubKeyFile(), safeStorage.encryptString(k));
  hubKeyCache = k;
}
const hubHeaders = (k) => { k = k === undefined ? hubKey() : k; return k ? { 'X-Api-Key': k } : {}; };
let keyCache = { v: null, at: 0 };
function geminiKey() {
  if (Date.now() - keyCache.at < 30000) return keyCache.v;
  keyCache = { v: readKey(), at: Date.now() };
  return keyCache.v;
}
function readKey() {
  const s = storedKey();
  if (s) return s;
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) if (process.env[k]) return process.env[k];
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', k], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(new RegExp(k + '\\s+REG_\\w+\\s+(\\S+)'));
      if (m) return m[1];
    } catch { /* not set */ }
  }
  return null;
}

// ---------- windows ----------
let tabWin = null;
let panelWin = null;
let state = 'idle'; // idle | live | paused

function protect(win) { if (cfg.hideFromScreenShare) win.setContentProtection(true); }

function createWindows() {
  const wa = screen.getPrimaryDisplay().workArea;
  const common = {
    frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true,
    hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  };

  const TAB = 60;
  tabWin = new BrowserWindow({ ...common, width: TAB, height: TAB, x: wa.x + wa.width - TAB - 4, y: wa.y + Math.round(wa.height / 2 - TAB / 2), focusable: false });
  tabWin.setAlwaysOnTop(true, 'screen-saver');
  protect(tabWin);
  tabWin.loadFile('tab.html');
  tabWin.once('ready-to-show', () => tabWin.showInactive());

  const W = Math.min(980, Math.round(wa.width * 0.72));
  const H = 168;
  panelWin = new BrowserWindow({ ...common, width: W, height: H, x: wa.x + Math.round((wa.width - W) / 2), y: wa.y + wa.height - H - 16 });
  panelWin.setAlwaysOnTop(true, 'screen-saver');
  protect(panelWin);
  panelWin.loadFile('panel.html');
}

// ---------- settings window (Gemini key + server URL) ----------
let settingsWin = null;
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 520, height: 530, resizable: false, minimizable: false, maximizable: false, autoHideMenuBar: true,
    title: 'Hindi Captions: Settings', alwaysOnTop: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.setAlwaysOnTop(true, 'screen-saver');
  settingsWin.loadFile('settings.html');
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

const GEM = 'https://generativelanguage.googleapis.com/v1beta';
async function testHub(url, key) {
  try {
    const base = url.replace(/\/$/, '');
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, msg: 'Server refused (' + r.status + ')' };
    // /health is open; check the key on a real (silent, 0.5 s) transcribe call
    const fd = new FormData();
    fd.append('file', new Blob([silentWav(8000)], { type: 'audio/wav' }), 'test.wav');
    fd.append('language', 'en');
    const t = await fetch(base + '/v1/transcribe', { method: 'POST', body: fd, headers: hubHeaders(key), signal: AbortSignal.timeout(15000) });
    if (t.status === 401 || t.status === 403) return { ok: true, msg: (key ? 'Server key is wrong' : 'No server key') + '; audio will be transcribed with your Gemini key' };
    if (!t.ok) return { ok: false, msg: 'Server refused (' + t.status + ')' };
    return { ok: true, msg: 'Server reachable' };
  } catch { return { ok: false, msg: 'Could not reach the server. Check the URL.' }; }
}
function silentWav(n) {
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
// Checks the key and that the model exists; if the default model is gone, picks the newest Flash text model.
async function testKey(key) {
  const h = { 'x-goog-api-key': key };
  try {
    let r = await fetch(`${GEM}/models/${cfg.geminiModel}`, { headers: h, signal: AbortSignal.timeout(8000) });
    if (r.ok) return { ok: true, msg: 'Key is valid', model: cfg.geminiModel };
    if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, msg: 'Key is wrong or disabled' };
    r = await fetch(`${GEM}/models?pageSize=200`, { headers: h, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, msg: 'Could not check the key (' + r.status + ')' };
    const names = ((await r.json()).models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /flash/.test(n) && !/image|tts|live|audio|embed|lite|thinking|exp/.test(n));
    names.sort((a, b) => (/preview/.test(a) - /preview/.test(b)) || b.localeCompare(a, undefined, { numeric: true }));
    return names.length ? { ok: true, msg: 'Key is valid', model: names[0] } : { ok: false, msg: 'No Flash model is available for this key' };
  } catch { return { ok: false, msg: 'Could not reach Google. Check your internet.' }; }
}

ipcMain.handle('settings-get', () => {
  const k = geminiKey();
  return { hasKey: !!k, keyHint: k ? '••••' + k.slice(-4) : '', hubUrl: cfg.hubUrl, model: cfg.geminiModel, hasHubKey: !!hubKey() };
});
ipcMain.handle('settings-test', async (_e, { key, hubUrl, hubKey: hk }) => {
  const k = (key || '').trim() || geminiKey();
  const [hub, gem] = await Promise.all([testHub(hubUrl || cfg.hubUrl, (hk || '').trim() || hubKey()), k ? testKey(k) : { ok: false, msg: 'Enter a key' }]);
  return { hub, key: gem };
});
ipcMain.handle('settings-save', async (_e, { key, hubUrl, model, hubKey: hk }) => {
  try {
    if (key && key.trim()) storeKey(key.trim());
    if (hk && hk.trim()) storeHubKey(hk.trim());
    const patch = {};
    if (hubUrl && hubUrl.trim()) patch.hubUrl = hubUrl.trim().replace(/\/$/, '');
    if (model) patch.geminiModel = model;
    saveConfig(patch);
    setState(state);
    return { ok: true };
  } catch (e) { return { ok: false, msg: e.message }; }
});
ipcMain.on('open-settings', openSettings);
ipcMain.on('open-url', (_e, u) => { if (u === 'https://aistudio.google.com/apikey') shell.openExternal(u); });
ipcMain.on('close-settings', () => settingsWin?.close());

function setState(s) {
  state = s;
  for (const w of [tabWin, panelWin]) if (w && !w.isDestroyed()) w.webContents.send('state', { state, hasKey: !!geminiKey(), hubUrl: cfg.hubUrl });
}

// Any-app audio: give the renderer the whole-screen source with Windows loopback audio.
function setupCapture() {
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  });
}

// ---------- transcript ----------
let log = [];            // {start, end, en, hi}
let sessionStartedAt = null;
let autosavePath = null;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${hms(ms / 1000)},${String(ms % 1000).padStart(3, '0')}`;
}
function toTxt() {
  const head = `Meeting translation (Hindi + English)\nStarted: ${sessionStartedAt ? sessionStartedAt.toLocaleString('en-IN') : '-'}\n\n`;
  return '﻿' + head + log.map((e) => `[${hms(e.start)}] ${e.hi || '(translation missing)'}\n           ${e.en}\n`).join('\n');
}
function toSrt() {
  return '﻿' + log.map((e, i) => {
    const next = log[i + 1];
    let end = Math.max(e.end, e.start + 1);
    if (next && end > next.start) end = Math.max(e.start + 0.3, next.start);
    const text = e.hi ? `${e.hi}\n${e.en}` : e.en;
    return `${i + 1}\n${srtTime(e.start)} --> ${srtTime(end)}\n${text}\n`;
  }).join('\n');
}
function autosave() {
  if (!autosavePath) return;
  try { fs.writeFileSync(autosavePath, toTxt()); } catch { /* keep going */ }
}

// ---------- ASR (sequential, keeps order) ----------
let asrChain = Promise.resolve();
let asrWaiting = 0;          // chunks queued for ASR; capped so a dead server never builds a stale backlog
const ASR_QUEUE_MAX = 4;
// When our hub refuses (it now needs a key we may not have), the user's own Gemini key turns audio into text.
let hubDenied = false;
const dbg = (m) => { if (process.env.LHC_DEBUG) try { fs.appendFileSync(process.env.LHC_DEBUG, `${new Date().toISOString().slice(11, 23)} ${m}
`); } catch { /* test only */ } };
async function geminiTranscribe(wav) {
  const key = geminiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent`;
  const body = (thinking) => JSON.stringify({
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'audio/wav', data: Buffer.from(wav).toString('base64') } },
      { text: 'Transcribe the English speech in this audio clip exactly as spoken. Output only the spoken words, with punctuation. If there is no clear speech, output nothing.' },
    ] }],
    generationConfig: { temperature: 0, ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
  });
  let thinking = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      const t = Date.now();
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: body(thinking), signal: AbortSignal.timeout(12000) });
      dbg(`gemini-asr ${r.status} ${Date.now() - t}ms bytes=${wav.byteLength}`);
    } catch (e) { dbg('gemini-asr fail ' + e.name); await new Promise((res) => setTimeout(res, 500)); continue; }
    if (r.ok) {
      const j = await r.json();
      return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    }
    const errText = await r.text().catch(() => '');
    if (r.status === 400 && thinking && /thinking/i.test(errText)) { thinking = false; continue; }
    if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 800 * (attempt + 1))); continue; }
    throw new Error('Gemini could not transcribe the audio (' + r.status + ')');
  }
  throw new Error('Gemini is busy. Some speech may be missed.');
}

async function transcribe(wav) {
  if (hubDenied && geminiKey()) return geminiTranscribe(wav);
  for (let attempt = 0; attempt < 2; attempt++) {
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
    fd.append('language', 'en');
    let r;
    try {
      r = await fetch(cfg.hubUrl.replace(/\/$/, '') + '/v1/transcribe', { method: 'POST', body: fd, headers: hubHeaders(), signal: AbortSignal.timeout(8000) });
    } catch (e) {
      if (attempt === 1) throw new Error('Lost connection to the server. Some speech may be missed.');
      await new Promise((res) => setTimeout(res, 400));
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      if (geminiKey()) { hubDenied = true; return geminiTranscribe(wav); } // no hub key: let Gemini hear the audio
      throw new Error('Server key missing or wrong. Add it under ⚙ → Server.');
    }
    if (r.status === 503 && attempt === 0) { await new Promise((res) => setTimeout(res, 500)); continue; }
    if (!r.ok) throw new Error('Server is busy. Some speech may be missed.');
    const j = await r.json();
    return (j.text || '').trim();
  }
  throw new Error('Server is busy. Some speech may be missed.');
}

function markGap(start, end) {
  const last = log[log.length - 1];
  if (last && last.gap) { last.end = end; return; }
  downloaded = false;
  log.push({ start, end, en: '[audio missed]', hi: '[यहाँ की आवाज़ छूट गई]', gap: true });
  autosave();
}

// ---------- translation (sequential) ----------
const SYSTEM = [
  'You are a live meeting interpreter.',
  'Translate the English speech-recognition text into natural, simple spoken Hindi written in Devanagari script, the way a fluent Indian professional would say it in a meeting.',
  'Keep names, numbers, product names and English words that are normally used in Hindi speech (email, budget, laptop, meeting, project) as they are, in Devanagari or Latin as is natural.',
  'The text comes from speech recognition and may have small errors or missing punctuation; fix them silently.',
  'Live speech is cut into pieces, so the text may start or end in the middle of a sentence (a stray capital letter or full stop at the edges means nothing). Use the earlier context to understand it, and translate the piece so it reads as a natural continuation of the previous Hindi; never re-translate the context.',
  'Output only the Hindi translation, nothing else.',
].join(' ');

async function translate(text, context) {
  const key = geminiKey();
  if (!key) return '';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent`;
  const user = (context ? `Earlier in the meeting (context only, do not translate):\n${context}\n\n` : '') + `Translate:\n${text}`;
  const body = (thinking) => JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0.2, ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
  });
  let thinking = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      const t = Date.now();
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: body(thinking), signal: AbortSignal.timeout(10000) });
      dbg(`translate ${r.status} ${Date.now() - t}ms`);
    } catch { await new Promise((res) => setTimeout(res, 500)); continue; }
    if (r.ok) {
      const j = await r.json();
      return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    }
    const errText = await r.text().catch(() => '');
    if (r.status === 400 && thinking && /thinking/i.test(errText)) { thinking = false; continue; } // model without thinkingConfig
    if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 800 * (attempt + 1))); continue; }
    throw new Error('Translation setup problem (' + r.status + ')');
  }
  throw new Error('Translation failed for this part');
}

// Short fragments wait briefly for the next chunk so a sentence is not split in two.
let pending = null; // {start, end, en}
let pendingTimer = null;
let trChain = Promise.resolve();

function flushPending() {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  if (!pending) return;
  const seg = pending; pending = null;
  const context = log.slice(-2).map((e) => e.en).join(' ');
  trChain = trChain.then(async () => {
    let hi = '';
    let err = null;
    try { hi = await translate(seg.en, context); } catch (e) { err = e.message; }
    const entry = { ...seg, hi };
    log.push(entry);
    downloaded = false;
    autosave();
    panelWin?.webContents.send('segment', { ...entry, err });
  });
}

function addEnglish(seg) {
  if (!seg.en) return;
  if (pending) { pending.en += ' ' + seg.en; pending.end = seg.end; } else pending = { ...seg };
  panelWin?.webContents.send('english', pending.en);
  const words = pending.en.split(/\s+/).length;
  const ended = /[.?!]["')]?$/.test(pending.en);
  if ((ended && words >= 3) || words >= 18) return flushPending();
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushPending, 1800);
}

// ---------- IPC ----------
ipcMain.on('tab-click', () => {
  if (state === 'idle') {
    if (!sessionStartedAt) {
      sessionStartedAt = new Date();
      const dir = path.join(app.getPath('userData'), 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      autosavePath = path.join(dir, `Meeting-Hindi-${stamp(sessionStartedAt)}.txt`);
    }
    panelWin.showInactive();
    panelWin.webContents.send('cmd', 'start');
  } else if (panelWin.isVisible()) panelWin.hide();
  else panelWin.showInactive();
});

ipcMain.on('state', (_e, s) => setState(s));
ipcMain.on('pause', () => panelWin.webContents.send('cmd', 'pause'));
ipcMain.on('resume', () => panelWin.webContents.send('cmd', 'resume'));
// The panel sends its last chunk before 'stop'/'pause' (IPC keeps order), so wait for ASR, then flush.
async function drain() { await asrChain; flushPending(); await trChain; }
ipcMain.on('stop', () => { drain().then(() => panelWin?.webContents.send('stopped', { count: log.length, downloaded })); });
ipcMain.on('paused', () => { drain(); });
ipcMain.on('hide', () => panelWin.hide());

let downloaded = false;
let quitting = false;
async function safeQuit() {
  if (quitting) return;
  quitting = true;
  panelWin?.webContents.send('cmd', 'stop');
  await new Promise((r) => setTimeout(r, 400)); // let the panel's last chunk reach the ASR queue
  await Promise.race([drain(), new Promise((r) => setTimeout(r, 10000))]);
  autosave();
  if (log.length && !downloaded) {
    panelWin.setAlwaysOnTop(false);
    const r = await dialog.showMessageBox(panelWin, {
      type: 'question', buttons: ['Download and quit', 'Quit without downloading', 'Go back'], defaultId: 0, cancelId: 2,
      title: 'Hindi Captions', message: 'The translation has not been downloaded yet.', detail: 'A copy is saved automatically in:\n' + autosavePath,
    });
    panelWin.setAlwaysOnTop(true, 'screen-saver');
    if (r.response === 2) { quitting = false; return; }
    if (r.response === 0) { const d = await saveFile(); if (!d.ok) { quitting = false; return; } }
  }
  app.exit(0);
}
ipcMain.on('quit', safeQuit);

ipcMain.on('chunk', (_e, { wav, start, end }) => {
  dbg(`chunk ${start.toFixed(1)}-${end.toFixed(1)} waiting=${asrWaiting}`);
  if (asrWaiting >= ASR_QUEUE_MAX) { markGap(start, end); panelWin?.webContents.send('error', 'Too slow to keep up. Some speech is being missed.'); return; }
  asrWaiting++;
  asrChain = asrChain.then(async () => {
    try {
      const en = await transcribe(Buffer.from(wav));
      addEnglish({ start, end, en });
      panelWin?.webContents.send('hub-ok');
    } catch (e) {
      markGap(start, end);
      panelWin?.webContents.send('error', e.message);
    } finally { asrWaiting--; }
  });
});

async function saveFile() {
  await drain();
  if (!log.length) return { ok: false, msg: 'Nothing has been translated yet' };
  panelWin.setAlwaysOnTop(false); // keep the Save dialog in front
  const r = await dialog.showSaveDialog(panelWin, {
    title: 'Save translation',
    defaultPath: path.join(app.getPath('documents'), `Meeting-Hindi-${stamp(sessionStartedAt || new Date())}.txt`),
    filters: [{ name: 'Text, Hindi + English', extensions: ['txt'] }, { name: 'Subtitles (SRT)', extensions: ['srt'] }],
  });
  panelWin.setAlwaysOnTop(true, 'screen-saver');
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, r.filePath.toLowerCase().endsWith('.srt') ? toSrt() : toTxt());
  downloaded = true;
  shell.showItemInFolder(r.filePath);
  return { ok: true, path: r.filePath };
}
ipcMain.handle('download', saveFile);

ipcMain.handle('info', () => ({ state, hasKey: !!geminiKey(), hubUrl: cfg.hubUrl, count: log.length }));

// ---------- lifecycle ----------
app.whenReady().then(() => {
  loadConfig();
  setupCapture();
  createWindows();
  if (!geminiKey() && !process.env.LHC_AUTOSTART) openSettings(); // first run: ask for the key
  if (process.env.LHC_SETTINGS_TEST && settingsWin) settingsWin.webContents.once('did-finish-load', () => setTimeout(() => settingsWin.webContents.executeJavaScript("document.getElementById('test').click()"), 500));
  // Test hooks (dev only): auto-start capture, and dump the transcript on quit.
  if (process.env.LHC_AUTOSTART === '1') panelWin.webContents.once('did-finish-load', () => setTimeout(() => ipcMain.emit('tab-click'), 800));
});
// Test hook: save PNGs of the app's own windows only (never the whole screen).
ipcMain.on('dev-shot', async (_e, name) => {
  const dir = process.env.LHC_SHOT;
  if (!dir) return;
  for (const [w, tag] of [[panelWin, 'panel'], [tabWin, 'tab'], [settingsWin, 'settings']]) {
    if (!w || w.isDestroyed()) continue;
    try { const img = await w.webContents.capturePage(); fs.writeFileSync(path.join(dir, `${name}_${tag}.png`), img.toPNG()); } catch { /* test only */ }
  }
});
if (process.env.LHC_SHOT) app.whenReady().then(() => setTimeout(() => {
  if (process.env.LHC_DEMO_HI) {
    panelWin.webContents.send('segment', { en: 'Good morning everyone.', hi: 'सभी को सुप्रभात।' });
    panelWin.webContents.send('segment', { en: 'Today we will discuss the quarterly budget and the new school timetable, and then we will take questions from the parents.', hi: 'आज हम तिमाही बजट और स्कूल के नए टाइमटेबल पर बात करेंगे, और उसके बाद अभिभावकों के सवाल लेंगे।' });
  }
  setTimeout(() => ipcMain.emit('dev-shot', null, process.env.LHC_DEMO_HI ? 'demo' : 'live'), 600);
}, Number(process.env.LHC_SHOT_AFTER || 14000)));
app.on('before-quit', () => {
  if (process.env.LHC_DUMP) { flushPending(); try { fs.writeFileSync(process.env.LHC_DUMP, toTxt()); } catch { /* test only */ } }
});
app.on('window-all-closed', () => app.quit());
