require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');
const path     = require('path');
const { Resend } = require('resend');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── In-memory config (always works, DB syncs on top) ──────
const mem = {
  resendApiKey:    process.env.RESEND_API_KEY    || '',
  fromEmail:       process.env.FROM_EMAIL        || 'AI Web Agent <onboarding@resend.dev>',
  groqApiKey:      process.env.GROQ_API_KEY      || '',
  groqModel:       'llama-3.3-70b-versatile',
  geminiApiKey:    process.env.GEMINI_API_KEY    || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  defaultProvider: 'groq',
  emailSubject:    '✅ Form Submitted — {{form_title}}',
  emailBody:       'Hi {{to_name}},\n\nYour form "{{form_title}}" was successfully filled and submitted by AI Web Agent.\n\n📋 What was filled:\n{{fields_text}}\n\n🔗 Form URL: {{form_url}}\n🕐 Submitted at: {{submitted_at}}\n\n— AI Web Agent',
  agentEnabled:    true,
  maxEmailsPerDay: 100,
  emailsSentToday: 0,
  lastResetDate:   new Date().toDateString(),
};

// ── MongoDB (optional — enhances persistence) ─────────────
let dbReady = false;
let Config, User;

function setupModels() {
  Config = mongoose.model('Config', new mongoose.Schema({
    key:   { type: String, unique: true, required: true },
    value: mongoose.Schema.Types.Mixed,
  }));
  User = mongoose.model('User', new mongoose.Schema({
    email:         { type: String, unique: true, required: true },
    name:          String, first: String, last: String,
    phone:         String, city: String, state: String, country: String,
    company:       String, job: String,
    formsFilled:   { type: Number, default: 0 },
    lastFormTitle: String,
    lastSeen:      { type: Date, default: Date.now },
    createdAt:     { type: Date, default: Date.now },
  }));
}

async function connectDB() {
  if (!process.env.MONGODB_URI) return;
  try {
    setupModels();
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    dbReady = true;
    console.log('[DB] Connected ✅');
    await syncFromDB();
  } catch(e) {
    console.error('[DB] Failed to connect:', e.message);
    dbReady = false;
  }
}

async function syncFromDB() {
  if (!dbReady) return;
  try {
    const docs = await Config.find({}).lean();
    docs.forEach(d => { if (d.key && d.value !== undefined) mem[d.key] = d.value; });
    console.log('[DB] Memory synced ✅');
  } catch(e) { console.error('[DB] Sync error:', e.message); }
}

async function saveToDB(key, value) {
  if (!dbReady) return;
  try {
    await Config.findOneAndUpdate({ key }, { key, value }, { upsert: true });
  } catch(e) { console.error('[DB] Save error:', key, e.message); }
}

async function saveUserToDB(profile) {
  if (!dbReady || !profile?.email) return;
  try {
    await User.findOneAndUpdate(
      { email: profile.email },
      { ...profile, lastSeen: new Date() },
      { upsert: true }
    );
  } catch(e) { console.error('[DB] User save error:', e.message); }
}

// Config helpers — always use mem, async save to DB
function getCfg(key, def = '') {
  const val = mem[key];
  if (val === undefined || val === null) return def;
  return val;
}

async function setCfg(key, value) {
  mem[key] = value;
  await saveToDB(key, value);
}

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (mem.lastResetDate !== today) {
    mem.emailsSentToday = 0;
    mem.lastResetDate   = today;
    saveToDB('emailsSentToday', 0);
    saveToDB('lastResetDate', today);
  }
}

async function sendResendEmail(toEmail, subject, text) {
  const apiKey = getCfg('resendApiKey');
  if (!apiKey) throw new Error('Resend API key not configured in Admin Panel → Email Settings.');
  const fromAddr = getCfg('fromEmail') || 'AI Web Agent <onboarding@resend.dev>';
  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from: fromAddr, to: toEmail, subject,
    text, html: `<pre style="font-family:sans-serif;white-space:pre-wrap;font-size:14px;line-height:1.6">${text}</pre>`,
  });
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result;
}

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(auth.slice(7), process.env.ADMIN_SECRET || 'secret123');
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: dbReady ? 'connected' : 'memory-only' });
});

app.get('/api/agent-config', (req, res) => {
  if (!getCfg('agentEnabled', true)) return res.status(403).json({ error: 'Agent disabled.' });
  res.json({
    groqApiKey:      getCfg('groqApiKey'),
    groqModel:       getCfg('groqModel', 'llama-3.3-70b-versatile'),
    geminiApiKey:    getCfg('geminiApiKey'),
    anthropicApiKey: getCfg('anthropicApiKey'),
    defaultProvider: getCfg('defaultProvider', 'groq'),
  });
});

app.post('/api/register-user', async (req, res) => {
  try {
    const { profile } = req.body || {};
    if (!profile?.email) return res.status(400).json({ error: 'Email required' });
    await saveUserToDB(profile);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-email', async (req, res) => {
  try {
    resetDailyIfNeeded();
    if (!getCfg('agentEnabled', true)) return res.status(403).json({ error: 'Agent disabled.' });
    if (getCfg('emailsSentToday', 0) >= getCfg('maxEmailsPerDay', 100))
      return res.status(429).json({ error: 'Daily email limit reached.' });

    const { toEmail, toName, formTitle, formUrl, filledFields, submittedAt } = req.body || {};
    if (!toEmail) return res.status(400).json({ error: 'toEmail required' });

    const fieldsText = Array.isArray(filledFields)
      ? filledFields.map(f => `• ${f.label}: ${f.value}`).join('\n') : '';
    const vars = {
      '{{to_name}}':      toName || toEmail,
      '{{to_email}}':     toEmail,
      '{{form_title}}':   formTitle || 'Web Form',
      '{{form_url}}':     formUrl || '',
      '{{fields_text}}':  fieldsText,
      '{{submitted_at}}': submittedAt || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    };

    let subject = getCfg('emailSubject', '✅ Form Submitted — {{form_title}}');
    let body    = getCfg('emailBody', '');
    for (const [k, v] of Object.entries(vars)) {
      subject = subject.replaceAll(k, v);
      body    = body.replaceAll(k, v);
    }

    await sendResendEmail(toEmail, subject, body);
    await setCfg('emailsSentToday', getCfg('emailsSentToday', 0) + 1);

    if (dbReady) {
      User.findOneAndUpdate(
        { email: toEmail },
        { $inc: { formsFilled: 1 }, lastFormTitle: formTitle, lastSeen: new Date() }
      ).catch(() => {});
    }

    console.log('[EMAIL] ✅ Sent to', toEmail);
    res.json({ sent: true });
  } catch(err) {
    console.error('[EMAIL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== (process.env.ADMIN_USERNAME || 'admin') || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong credentials' });
  const token = jwt.sign({ admin: true }, process.env.ADMIN_SECRET || 'secret123', { expiresIn: '7d' });
  res.json({ token });
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({
    fromEmail:       getCfg('fromEmail'),
    resendSaved:     getCfg('resendApiKey').length > 5,
    groqSaved:       getCfg('groqApiKey').length > 5,
    geminiSaved:     getCfg('geminiApiKey').length > 5,
    anthropicSaved:  getCfg('anthropicApiKey').length > 5,
    groqModel:       getCfg('groqModel', 'llama-3.3-70b-versatile'),
    defaultProvider: getCfg('defaultProvider', 'groq'),
    emailSubject:    getCfg('emailSubject'),
    emailBody:       getCfg('emailBody'),
    agentEnabled:    getCfg('agentEnabled', true),
    maxEmailsPerDay: getCfg('maxEmailsPerDay', 100),
    dbConnected:     dbReady,
  });
});

app.post('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const allowed = ['fromEmail','resendApiKey','emailSubject','emailBody',
      'groqApiKey','groqModel','geminiApiKey','anthropicApiKey',
      'defaultProvider','agentEnabled','maxEmailsPerDay'];
    for (const key of allowed) {
      const val = req.body[key];
      if (val === undefined || val === null || val === '') continue;
      await setCfg(key, key === 'maxEmailsPerDay' ? parseInt(val) : val);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try {
    const apiKey = getCfg('resendApiKey');
    if (!apiKey) return res.status(400).json({ error: 'Resend API key not set. Add it in Email Settings first.' });
    const fromEmail = getCfg('fromEmail', 'AI Web Agent <onboarding@resend.dev>');
    // Extract email address from "Name <email>" format
    const emailMatch = fromEmail.match(/<([^>]+@[^>]+)>/);
    const toAddr = emailMatch ? emailMatch[1] : fromEmail;
    await sendResendEmail(
      toAddr,
      '✅ Test — AI Web Agent email is working!',
      'Congratulations!\n\nYour AI Web Agent email system is configured correctly.\n\nUsers will now receive confirmation emails after every form submission.\n\n— AI Web Agent'
    );
    res.json({ sent: true, to: toAddr });
  } catch(err) {
    console.error('[TEST EMAIL]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  // Allow without auth for status check
  resetDailyIfNeeded();
  const totalUsers = dbReady ? await User.countDocuments().catch(() => 0) : 0;
  res.json({
    emailsSentToday: getCfg('emailsSentToday', 0),
    maxEmailsPerDay: getCfg('maxEmailsPerDay', 100),
    agentEnabled:    getCfg('agentEnabled', true),
    totalUsers, dbConnected: dbReady,
  });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = dbReady ? await User.find().sort({ lastSeen: -1 }).lean() : [];
    res.json(users);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:email', requireAdmin, async (req, res) => {
  try {
    if (dbReady) await User.deleteOne({ email: decodeURIComponent(req.params.email) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AI Web Agent Backend running on port ${PORT}`);
  connectDB(); // connect DB in background — server starts immediately
});
