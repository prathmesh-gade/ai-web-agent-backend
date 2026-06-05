// server.js — AI Web Agent Backend v3
// Uses MongoDB Atlas for permanent storage

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const jwt        = require('jsonwebtoken');
const mongoose   = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MongoDB Connection ────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/aiwebagent')
  .then(() => console.log('[DB] MongoDB connected'))
  .catch(e => console.error('[DB] Connection error:', e.message));

// ── Schemas ───────────────────────────────────────────────
const ConfigSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed,
});
const ConfigModel = mongoose.model('Config', ConfigSchema);

const UserSchema = new mongoose.Schema({
  email:         { type: String, unique: true },
  name:          String,
  first:         String,
  last:          String,
  phone:         String,
  dob:           String,
  street:        String,
  city:          String,
  state:         String,
  zip:           String,
  country:       String,
  company:       String,
  job:           String,
  web:           String,
  formsFilled:   { type: Number, default: 0 },
  lastFormTitle: String,
  lastActivity:  Date,
  lastSeen:      { type: Date, default: Date.now },
  createdAt:     { type: Date, default: Date.now },
});
const UserModel = mongoose.model('User', UserSchema);

// ── Config helpers ────────────────────────────────────────
async function getConfig(key, defaultVal = null) {
  try {
    const doc = await ConfigModel.findOne({ key });
    return doc ? doc.value : defaultVal;
  } catch(e) { return defaultVal; }
}

async function setConfig(key, value) {
  await ConfigModel.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
}

async function getAllConfig() {
  const docs = await ConfigModel.find({});
  const result = {};
  docs.forEach(d => result[d.key] = d.value);
  return result;
}

// ── Default config (only set if not already in DB) ───────
async function initDefaults() {
  const defaults = {
    gmailUser:        process.env.GMAIL_USER         || '',
    gmailAppPassword: process.env.GMAIL_APP_PASSWORD  || '',
    groqApiKey:       process.env.GROQ_API_KEY        || '',
    groqModel:        'llama-3.3-70b-versatile',
    geminiApiKey:     process.env.GEMINI_API_KEY       || '',
    anthropicApiKey:  process.env.ANTHROPIC_API_KEY    || '',
    defaultProvider:  'groq',
    emailSubject:     '✅ Form Submitted — {{form_title}}',
    emailBody:        'Hi {{to_name}},\n\nYour form "{{form_title}}" was successfully filled and submitted by AI Web Agent.\n\n📋 What was filled:\n{{fields_text}}\n\n🔗 Form URL: {{form_url}}\n🕐 Submitted at: {{submitted_at}}\n\n— AI Web Agent',
    agentEnabled:     true,
    maxEmailsPerDay:  100,
    emailsSentToday:  0,
    lastResetDate:    new Date().toDateString(),
  };
  for (const [key, value] of Object.entries(defaults)) {
    const existing = await ConfigModel.findOne({ key });
    if (!existing) await setConfig(key, value);
  }
  console.log('[DB] Defaults initialized');
}

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ── Admin auth ────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(auth.slice(7), process.env.ADMIN_SECRET || 'secret123');
    next();
  } catch (e) { res.status(401).json({ error: 'Invalid token' }); }
}

async function resetDailyCountIfNeeded() {
  const today = new Date().toDateString();
  const lastReset = await getConfig('lastResetDate', '');
  if (lastReset !== today) {
    await setConfig('emailsSentToday', 0);
    await setConfig('lastResetDate', today);
  }
}

// ════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ════════════════════════════════════════════════════════

app.get('/api/health', async (req, res) => {
  const agentEnabled = await getConfig('agentEnabled', true);
  res.json({ status: 'ok', agentEnabled });
});

// Extension fetches AI keys from backend
app.get('/api/agent-config', async (req, res) => {
  const agentEnabled = await getConfig('agentEnabled', true);
  if (!agentEnabled) return res.status(403).json({ error: 'Agent disabled by admin.' });
  res.json({
    groqApiKey:      await getConfig('groqApiKey', ''),
    groqModel:       await getConfig('groqModel', 'llama-3.3-70b-versatile'),
    geminiApiKey:    await getConfig('geminiApiKey', ''),
    anthropicApiKey: await getConfig('anthropicApiKey', ''),
    defaultProvider: await getConfig('defaultProvider', 'groq'),
    agentEnabled:    true,
  });
});

// Register/update user profile
app.post('/api/register-user', async (req, res) => {
  const { profile } = req.body;
  if (!profile?.email) return res.status(400).json({ error: 'Email required' });
  try {
    await UserModel.findOneAndUpdate(
      { email: profile.email },
      { ...profile, lastSeen: new Date() },
      { upsert: true, new: true }
    );
    console.log('[USER] Registered:', profile.email);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Send confirmation email
app.post('/api/send-email', async (req, res) => {
  try {
    await resetDailyCountIfNeeded();

    const agentEnabled    = await getConfig('agentEnabled', true);
    const emailsSentToday = await getConfig('emailsSentToday', 0);
    const maxEmailsPerDay = await getConfig('maxEmailsPerDay', 100);
    const gmailUser       = await getConfig('gmailUser', '');
    const gmailAppPass    = await getConfig('gmailAppPassword', '');
    const emailSubject    = await getConfig('emailSubject', '✅ Form Submitted — {{form_title}}');
    const emailBody       = await getConfig('emailBody', '');

    if (!agentEnabled)                    return res.status(403).json({ error: 'Agent disabled by admin.' });
    if (emailsSentToday >= maxEmailsPerDay) return res.status(429).json({ error: 'Daily email limit reached.' });
    if (!gmailUser || !gmailAppPass)       return res.status(500).json({ error: 'Email not configured by admin yet.' });

    const { toEmail, toName, formTitle, formUrl, filledFields, submittedAt } = req.body;
    if (!toEmail) return res.status(400).json({ error: 'toEmail required' });

    // Update user stats
    await UserModel.findOneAndUpdate(
      { email: toEmail },
      { $inc: { formsFilled: 1 }, lastFormTitle: formTitle, lastActivity: new Date(), lastSeen: new Date() }
    );

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

    let subject = emailSubject, body = emailBody;
    for (const [k, v] of Object.entries(vars)) {
      subject = subject.replaceAll(k, v);
      body    = body.replaceAll(k, v);
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailAppPass },
    });

    await transporter.sendMail({
      from: `"AI Web Agent" <${gmailUser}>`,
      to: toEmail, subject, text: body,
      html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${body}</pre>`,
    });

    await setConfig('emailsSentToday', emailsSentToday + 1);
    console.log(`[EMAIL] ✅ Sent to ${toEmail} — ${formTitle}`);
    res.json({ sent: true });

  } catch (err) {
    console.error('[EMAIL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== (process.env.ADMIN_USERNAME || 'admin') || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong credentials' });
  const token = jwt.sign({ admin: true }, process.env.ADMIN_SECRET || 'secret123', { expiresIn: '7d' });
  res.json({ token });
});

app.get('/api/admin/config', requireAdmin, async (req, res) => {
  const cfg = await getAllConfig();
  // Mask sensitive values
  if (cfg.gmailAppPassword) cfg.gmailAppPassword = '••••••••';
  if (cfg.groqApiKey)       cfg.groqApiKey       = '••••' + cfg.groqApiKey.slice(-6);
  if (cfg.geminiApiKey)     cfg.geminiApiKey     = cfg.geminiApiKey ? '••••' + cfg.geminiApiKey.slice(-4) : '';
  if (cfg.anthropicApiKey)  cfg.anthropicApiKey  = cfg.anthropicApiKey ? '••••' + cfg.anthropicApiKey.slice(-6) : '';
  res.json(cfg);
});

app.post('/api/admin/config', requireAdmin, async (req, res) => {
  const allowed = ['gmailUser','gmailAppPassword','emailSubject','emailBody',
    'groqApiKey','groqModel','geminiApiKey','anthropicApiKey','defaultProvider',
    'agentEnabled','maxEmailsPerDay'];
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    // Skip masked values
    if (['gmailAppPassword','groqApiKey','geminiApiKey','anthropicApiKey'].includes(key)
      && String(req.body[key]).includes('••••')) continue;
    const val = key === 'maxEmailsPerDay' ? parseInt(req.body[key]) : req.body[key];
    await setConfig(key, val);
  }
  console.log('[ADMIN] Config updated');
  res.json({ success: true });
});

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const gmailUser    = await getConfig('gmailUser', '');
  const gmailAppPass = await getConfig('gmailAppPassword', '');
  if (!gmailUser || !gmailAppPass)
    return res.status(400).json({ error: 'Gmail not configured. Go to Email Settings first.' });
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailAppPass },
    });
    await transporter.sendMail({
      from: `"AI Web Agent" <${gmailUser}>`,
      to: gmailUser,
      subject: '✅ Test — AI Web Agent email is working!',
      text: 'Congratulations! Your AI Web Agent email system is configured correctly.\n\nUsers will now receive confirmation emails after every form submission.',
    });
    res.json({ sent: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  await resetDailyCountIfNeeded();
  res.json({
    emailsSentToday: await getConfig('emailsSentToday', 0),
    maxEmailsPerDay: await getConfig('maxEmailsPerDay', 100),
    lastResetDate:   await getConfig('lastResetDate', ''),
    agentEnabled:    await getConfig('agentEnabled', true),
    totalUsers:      await UserModel.countDocuments(),
  });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await UserModel.find().sort({ lastSeen: -1 });
  res.json(users);
});

app.delete('/api/admin/users/:email', requireAdmin, async (req, res) => {
  await UserModel.deleteOne({ email: decodeURIComponent(req.params.email) });
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`AI Web Agent Backend v3 running on port ${PORT}`);
  // Wait for DB then init defaults
  setTimeout(initDefaults, 2000);
});
