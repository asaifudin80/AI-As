import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const PROVIDER = (process.env.PROVIDER || 'gemini').toLowerCase();
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const hasKey = PROVIDER === 'gemini' ? !!GEMINI_KEY : !!OPENROUTER_KEY;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

/* ================= SECURITY ================= */
// helmet: header keamanan. CSP dimatikan karena frontend memakai inline script/style.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit endpoint AI: mencegah penyalahgunaan API key
const aiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || '30', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak request. Coba lagi dalam beberapa menit. ⏳' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Percobaan login terlalu banyak. Coba lagi nanti.' }
});

/* ================= AUTH HELPERS ================= */
async function setSession(res, userId) {
  const token = await db.createSession(userId);
  res.cookie('sid', token, {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600 * 1000
  });
}
async function currentUser(req) {
  const s = await db.getSession(req.cookies?.sid);
  return s ? await db.findUserById(s.userId) : null;
}
const requireAuth = async (req, res, next) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Silakan masuk dulu.' });
  req.user = user;
  next();
};
const sanitize = u => ({ id: u.id, username: u.username, provider: u.googleId ? 'google' : 'password' });

/* ================= AUTH ENDPOINTS ================= */
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || ''))
    return res.status(400).json({ error: 'Username 3-20 karakter (huruf/angka/underscore).' });
  if ((password || '').length < 6)
    return res.status(400).json({ error: 'Password minimal 6 karakter.' });
  if (await db.findUserByUsername(username))
    return res.status(409).json({ error: 'Username sudah dipakai.' });
  const user = await db.createUser({ username, passHash: await bcrypt.hash(password, 10) });
  await setSession(res, user.id);
  res.json({ user: sanitize(user) });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const user = await db.findUserByUsername(username || '');
  if (!user || !user.passHash || !(await bcrypt.compare(password || '', user.passHash)))
    return res.status(401).json({ error: 'Username atau password salah.' });
  await setSession(res, user.id);
  res.json({ user: sanitize(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  await db.deleteSession(req.cookies?.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const user = await currentUser(req);
  res.json({ user: user ? sanitize(user) : null });
});

/* ---------- Google OAuth (aktif hanya jika env diisi) ---------- */
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  app.get('/auth/google', (req, res) => {
    const q = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: `${BASE_URL}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online'
    });
    res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q);
  });

  app.get('/auth/google/callback', async (req, res) => {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code, client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: `${BASE_URL}/auth/google/callback`, grant_type: 'authorization_code'
        })
      });
      const token = await tokenRes.json();
      if (!tokenRes.ok) throw new Error('Gagal tukar token Google.');
      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` }
      });
      const info = await infoRes.json();
      let user = await db.findUserByGoogleId(info.sub);
      if (!user) user = await db.createUser({ username: info.email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_'), googleId: info.sub });
      await setSession(res, user.id);
      res.redirect('/');
    } catch (e) {
      res.status(500).send('OAuth gagal: ' + e.message);
    }
  });
}

/* ================= CHAT PER-USER (butuh login) ================= */
app.get('/api/chats', requireAuth, async (req, res) => res.json({ chats: await db.getChats(req.user.id) }));

app.put('/api/chats', requireAuth, async (req, res) => {
  const chats = req.body.chats;
  if (!Array.isArray(chats) || JSON.stringify(chats).length > 5 * 1024 * 1024)
    return res.status(400).json({ error: 'Data chats tidak valid/terlalu besar.' });
  await db.saveChats(req.user.id, chats);
  res.json({ ok: true });
});

/* ================= AI ENDPOINTS ================= */
app.get('/api/status', async (req, res) => {
  const user = await currentUser(req);
  res.json({
    provider: PROVIDER, mode: hasKey ? 'api' : 'demo', streaming: true,
    model: PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'openai/gpt-4o-mini',
    user: user ? sanitize(user) : null,
    googleOAuth: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  });
});

app.post('/api/chat', aiLimiter, async (req, res) => {
  try {
    const messages = req.body.messages;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages wajib diisi.' });
    const last = messages[messages.length - 1];
    if (!hasKey) return res.json({ reply: localReply(last.text || '') });
    res.json({ reply: await callAI(messages) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || 'Terjadi kesalahan server.' }); }
});

app.post('/api/chat/stream', aiLimiter, async (req, res) => {
  const messages = req.body.messages;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages wajib diisi.' });
  const last = messages[messages.length - 1] || {};
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const sse = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (!hasKey) { sse({ chunk: localReply(last.text || '') }); sse({ done: true }); return res.end(); }
  try {
    if (PROVIDER === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${GEMINI_KEY}&alt=sse`;
      const up = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: toGemini(messages) }) });
      if (!up.ok || !up.body) throw new Error('Error Gemini API: ' + (await up.text()).slice(0, 200));
      await pipeSSE(up.body, raw => {
        try { const j = JSON.parse(raw);
          const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
          if (t) sse({ chunk: t });
        } catch {}
      });
    } else {
      const up = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENROUTER_KEY}` },
        body: JSON.stringify({ model: 'openai/gpt-4o-mini', stream: true,
          messages: messages.map(m => ({ role: m.role, content: m.text })) }) });
      if (!up.ok || !up.body) throw new Error('Error OpenRouter API: ' + (await up.text()).slice(0, 200));
      await pipeSSE(up.body, raw => { if (raw === '[DONE]') return;
        try { const t = JSON.parse(raw).choices?.[0]?.delta?.content || ''; if (t) sse({ chunk: t }); } catch {} });
    }
  } catch (e) { console.error(e); sse({ error: e.message || 'Kesalahan streaming.' }); }
  sse({ done: true }); res.end();
});

async function pipeSSE(body, onData) {
  const dec = new TextDecoder(); let buf = '';
  for await (const c of body) {
    buf += dec.decode(c, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) if (l.startsWith('data: ')) onData(l.slice(6).trim());
  }
}
const toGemini = ms => ms.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, f, cb) => /^image\/(jpeg|png|webp|gif)/.test(f.mimetype)
    ? cb(null, true) : cb(new Error('Hanya gambar JPG/PNG/WebP/GIF.')) });

app.post('/api/chat/image', aiLimiter, upload.single('image'), async (req, res) => {
  try {
    const message = req.body.message || 'Apa yang ada di gambar ini?';
    if (!hasKey) return res.json({ reply: 'Mode demo: analisis gambar butuh API key di server (.env).' });
    if (!req.file) return res.status(400).json({ error: 'Gambar wajib diunggah.' });
    if (PROVIDER !== 'gemini') return res.status(400).json({ error: 'Analisis gambar hanya untuk provider Gemini.' });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [
        { text: message }, { inline_data: { mime_type: req.file.mimetype, data: req.file.buffer.toString('base64') } }] }] }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Error Gemini API');
    res.json({ reply: data.candidates[0].content.parts[0].text });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || 'Terjadi kesalahan server.' }); }
});

async function callAI(messages) {
  if (PROVIDER === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: toGemini(messages) }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Error Gemini API');
    return d.candidates[0].content.parts[0].text;
  }
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENROUTER_KEY}` },
    body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: messages.map(m => ({ role: m.role, content: m.text })) }) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'Error OpenRouter API');
  return d.choices[0].message.content;
}

function localReply(q) {
  q = (q || '').toLowerCase();
  if (/(halo|hai|hello)/.test(q)) return 'Halo! 👋 MODE DEMO tanpa API key. Isi GEMINI_API_KEY di .env untuk jawaban AI penuh.';
  if (q.includes('gambar')) return 'Fitur upload gambar butuh API key Gemini di server (.env). 🖼️';
  if (q.includes('siapa kamu')) return 'Saya KimiBot 🤖 — backend Express dengan streaming, TTS, dan login per-user. API key aman di server.';
  return 'Jawaban demo. Pasang API key di .env server untuk AI sungguhan! 💡';
}

app.listen(PORT, () => {
  console.log(`\n  🤖 KimiBot → http://localhost:${PORT}`);
  console.log(`  Mode: ${hasKey ? 'API (' + PROVIDER + ')' : 'DEMO'} | Streaming: ON | Google OAuth: ${GOOGLE_CLIENT_ID ? 'ON' : 'OFF'}\n`);
});
