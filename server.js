require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const jwt        = require('jsonwebtoken');
const mongoose   = require('mongoose');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MongoDB ───────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || '';
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => { console.log('[DB] MongoDB connected'); initDefaults(); })
    .catch(e => console.error('[DB] Error:', e.message));
} else {
  console.warn('[DB] No MONGODB_URI — using in-memory fallback');
}

// ── Schemas ───────────────────────────────────────────────
const ConfigSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed });
const UserSchema   = new mongoose.Schema({
  email: { type: String, unique: true }, name: String, first: String, last: String,
  phone: String, dob: String, street: String, city: String, state: String,
  zip: String, country: String, company: String, job: String, web: String,
  formsFilled: { type: Number, default: 0 }, lastFormTitle: String,
  lastActivity: Date, lastSeen: { type: Date, default: Date.now }, createdAt: { type: Date, default: Date.now }
});
const Config = mongoose.model('Config', ConfigSchema);
const User   = mongoose.model('User', UserSchema);

// ── In-memory fallback ────────────────────────────────────
let memConfig = {
  gmailUser: process.env.GMAIL_USER || '', gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',
  groqApiKey: process.env.GROQ_API_KEY || '', groqModel: 'llama-3.3-70b-versatile',
  geminiApiKey: '', anthropicApiKey: '', defaultProvider: 'groq',
  emailSubject: '✅ Form Submitted — {{form_title}}',
  emailBody: 'Hi {{to_name}},\n\nYour form "{{form_title}}" was successfully filled and submitted by AI Web Agent.\n\n📋 What was filled:\n{{fields_text}}\n\n🔗 Form URL: {{form_url}}\n🕐 Submitted at: {{submitted_at}}\n\n— AI Web Agent',
  agentEnabled: true, maxEmailsPerDay: 100, emailsSentToday: 0, lastResetDate: new Date().toDateString()
};
let memUsers = {};

const isDBConnected = () => mongoose.connection.readyState === 1;

async function getCfg(key, def = '') {
  if (!isDBConnected()) return memConfig[key] !== undefined ? memConfig[key] : def;
  try { const d = await Config.findOne({ key }); return d ? d.value : def; } catch(e) { return def; }
}

async function setCfg(key, value) {
  memConfig[key] = value;
  if (!isDBConnected()) return;
  try { await Config.findOneAndUpdate({ key }, { value }, { upsert: true }); } catch(e) { console.error('[DB setCfg]', e.message); }
}

async function getAllCfg() {
  if (!isDBConnected()) return { ...memConfig };
  try {
    const docs = await Config.find({});
    const result = { ...memConfig };
    docs.forEach(d => result[d.key] = d.value);
    return result;
  } catch(e) { return { ...memConfig }; }
}

async function initDefaults() {
  const defaults = {
    gmailUser: process.env.GMAIL_USER || '', gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',
    groqApiKey: process.env.GROQ_API_KEY || '', groqModel: 'llama-3.3-70b-versatile',
    geminiApiKey: '', anthropicApiKey: '', defaultProvider: 'groq',
    emailSubject: '✅ Form Submitted — {{form_title}}',
    emailBody: 'Hi {{to_name}},\n\nYour form "{{form_title}}" was successfully filled and submitted by AI Web Agent.\n\n📋 What was filled:\n{{fields_text}}\n\n🔗 Form URL: {{form_url}}\n🕐 Submitted at: {{submitted_at}}\n\n— AI Web Agent',
    agentEnabled: true, maxEmailsPerDay: 100, emailsSentToday: 0, lastResetDate: new Date().toDateString()
  };
  for (const [key, value] of Object.entries(defaults)) {
    const existing = await Config.findOne({ key });
    if (!existing) await setCfg(key, value);
    else memConfig[key] = existing.value;
  }
  console.log('[DB] Defaults initialized');
}

async function resetDailyCount() {
  const today = new Date().toDateString();
  const last  = await getCfg('lastResetDate', '');
  if (last !== today) { await setCfg('emailsSentToday', 0); await setCfg('lastResetDate', today); }
}

function createTransporter(user, pass) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user, pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000,
  });
}

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(auth.slice(7), process.env.ADMIN_SECRET || 'secret123'); next(); }
  catch (e) { res.status(401).json({ error: 'Invalid token' }); }
}

// ════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  res.json({ status: 'ok', db: isDBConnected() ? 'connected' : 'disconnected', agentEnabled: await getCfg('agentEnabled', true) });
});

app.get('/api/agent-config', async (req, res) => {
  const enabled = await getCfg('agentEnabled', true);
  if (!enabled) return res.status(403).json({ error: 'Agent disabled by admin.' });
  res.json({
    groqApiKey:      await getCfg('groqApiKey', ''),
    groqModel:       await getCfg('groqModel', 'llama-3.3-70b-versatile'),
    geminiApiKey:    await getCfg('geminiApiKey', ''),
    anthropicApiKey: await getCfg('anthropicApiKey', ''),
    defaultProvider: await getCfg('defaultProvider', 'groq'),
    agentEnabled:    true,
  });
});

app.post('/api/register-user', async (req, res) => {
  try {
    const { profile } = req.body;
    if (!profile?.email) return res.status(400).json({ error: 'Email required' });
    if (isDBConnected()) {
      await User.findOneAndUpdate({ email: profile.email }, { ...profile, lastSeen: new Date() }, { upsert: true });
    } else {
      memUsers[profile.email] = { ...profile, lastSeen: new Date() };
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-email', async (req, res) => {
  try {
    await resetDailyCount();
    const [enabled, sentToday, maxPerDay, gmailUser, gmailPass, subject, body] = await Promise.all([
      getCfg('agentEnabled', true), getCfg('emailsSentToday', 0), getCfg('maxEmailsPerDay', 100),
      getCfg('gmailUser', ''), getCfg('gmailAppPassword', ''),
      getCfg('emailSubject', ''), getCfg('emailBody', '')
    ]);
    if (!enabled)              return res.status(403).json({ error: 'Agent disabled.' });
    if (sentToday >= maxPerDay) return res.status(429).json({ error: 'Daily email limit reached.' });
    if (!gmailUser || !gmailPass) return res.status(500).json({ error: 'Email not configured by admin yet. Please set Gmail credentials in Admin Panel.' });

    const { toEmail, toName, formTitle, formUrl, filledFields, submittedAt } = req.body;
    if (!toEmail) return res.status(400).json({ error: 'toEmail required' });

    if (isDBConnected()) {
      await User.findOneAndUpdate({ email: toEmail }, { $inc: { formsFilled: 1 }, lastFormTitle: formTitle, lastActivity: new Date() });
    }

    const fieldsText = Array.isArray(filledFields) ? filledFields.map(f => `• ${f.label}: ${f.value}`).join('\n') : '';
    const vars = {
      '{{to_name}}': toName||toEmail, '{{to_email}}': toEmail,
      '{{form_title}}': formTitle||'Web Form', '{{form_url}}': formUrl||'',
      '{{fields_text}}': fieldsText,
      '{{submitted_at}}': submittedAt || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    };

    let sub = subject, bod = body;
    for (const [k,v] of Object.entries(vars)) { sub = sub.replaceAll(k,v); bod = bod.replaceAll(k,v); }

    const t = createTransporter(gmailUser, gmailPass);
    await t.sendMail({ from: `"AI Web Agent" <${gmailUser}>`, to: toEmail, subject: sub, text: bod });
    await setCfg('emailsSentToday', sentToday + 1);
    console.log(`[EMAIL] ✅ Sent to ${toEmail}`);
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
  const { username, password } = req.body;
  if (username !== (process.env.ADMIN_USERNAME||'admin') || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong credentials' });
  const token = jwt.sign({ admin: true }, process.env.ADMIN_SECRET||'secret123', { expiresIn: '7d' });
  res.json({ token });
});

app.get('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const cfg = await getAllCfg();
    // Return boolean flags for saved keys (never return actual values)
    res.json({
      gmailUser:        cfg.gmailUser || '',
      gmailSaved:       !!(cfg.gmailAppPassword && cfg.gmailAppPassword.length > 5),
      groqSaved:        !!(cfg.groqApiKey && cfg.groqApiKey.length > 5),
      geminiSaved:      !!(cfg.geminiApiKey && cfg.geminiApiKey.length > 5),
      anthropicSaved:   !!(cfg.anthropicApiKey && cfg.anthropicApiKey.length > 5),
      groqModel:        cfg.groqModel || 'llama-3.3-70b-versatile',
      defaultProvider:  cfg.defaultProvider || 'groq',
      emailSubject:     cfg.emailSubject || '',
      emailBody:        cfg.emailBody || '',
      agentEnabled:     cfg.agentEnabled !== false,
      maxEmailsPerDay:  cfg.maxEmailsPerDay || 100,
      emailsSentToday:  cfg.emailsSentToday || 0,
      dbConnected:      isDBConnected(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const allowed = ['gmailUser','gmailAppPassword','emailSubject','emailBody',
      'groqApiKey','groqModel','geminiApiKey','anthropicApiKey','defaultProvider','agentEnabled','maxEmailsPerDay'];
    for (const key of allowed) {
      if (req.body[key] === undefined || req.body[key] === '' || req.body[key] === null) continue;
      await setCfg(key, key === 'maxEmailsPerDay' ? parseInt(req.body[key]) : req.body[key]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/force-set', requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    const allowed = ['gmailUser','gmailAppPassword','groqApiKey','geminiApiKey','anthropicApiKey'];
    if (!allowed.includes(key)) return res.status(400).json({ error: 'Key not allowed' });
    await setCfg(key, value);
    console.log('[ADMIN] Force set:', key);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try {
    const gmailUser = await getCfg('gmailUser', '');
    const gmailPass = await getCfg('gmailAppPassword', '');
    if (!gmailUser) return res.status(400).json({ error: 'Gmail address not set. Go to Email Settings.' });
    if (!gmailPass || gmailPass.length < 10) return res.status(400).json({ error: 'Gmail App Password not set or too short. Use Force Reset Password.' });
    const t = createTransporter(gmailUser, gmailPass);
    await t.verify();
    await t.sendMail({
      from: `"AI Web Agent" <${gmailUser}>`, to: gmailUser,
      subject: '✅ Test — AI Web Agent email is working!',
      text: 'Your AI Web Agent email system is configured correctly!\n\nUsers will receive confirmation emails after every form submission.',
    });
    res.json({ sent: true });
  } catch(err) {
    console.error('[TEST EMAIL]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    await resetDailyCount();
    const totalUsers = isDBConnected() ? await User.countDocuments() : Object.keys(memUsers).length;
    res.json({
      emailsSentToday: await getCfg('emailsSentToday', 0),
      maxEmailsPerDay: await getCfg('maxEmailsPerDay', 100),
      lastResetDate:   await getCfg('lastResetDate', ''),
      agentEnabled:    await getCfg('agentEnabled', true),
      totalUsers, dbConnected: isDBConnected(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    if (isDBConnected()) {
      const users = await User.find().sort({ lastSeen: -1 });
      res.json(users);
    } else {
      res.json(Object.values(memUsers).sort((a,b) => new Date(b.lastSeen) - new Date(a.lastSeen)));
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:email', requireAdmin, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    if (isDBConnected()) await User.deleteOne({ email });
    else delete memUsers[email];
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`AI Web Agent Backend v3 running on port ${PORT}`));
