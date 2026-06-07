require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');
const path     = require('path');
const { Resend } = require('resend');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MongoDB ───────────────────────────────────────────────
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => { console.log('[DB] Connected'); initDefaults(); })
    .catch(e => console.error('[DB] Error:', e.message));
}

// ── Schemas ───────────────────────────────────────────────
const Config = mongoose.model('Config', new mongoose.Schema({
  key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed
}));
const User = mongoose.model('User', new mongoose.Schema({
  email: { type: String, unique: true }, name: String, first: String, last: String,
  phone: String, city: String, state: String, country: String, company: String, job: String,
  formsFilled: { type: Number, default: 0 }, lastFormTitle: String,
  lastSeen: { type: Date, default: Date.now }, createdAt: { type: Date, default: Date.now }
}));

// ── In-memory fallback ────────────────────────────────────
let mem = {
  resendApiKey: process.env.RESEND_API_KEY || '',
  fromEmail: process.env.FROM_EMAIL || 'AI Web Agent <onboarding@resend.dev>',
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: 'llama-3.3-70b-versatile',
  geminiApiKey: '', anthropicApiKey: '', defaultProvider: 'groq',
  emailSubject: '✅ Form Submitted — {{form_title}}',
  emailBody: 'Hi {{to_name}},\n\nYour form "{{form_title}}" was successfully filled and submitted by AI Web Agent.\n\n📋 What was filled:\n{{fields_text}}\n\n🔗 Form URL: {{form_url}}\n🕐 Submitted at: {{submitted_at}}\n\n— AI Web Agent',
  agentEnabled: true, maxEmailsPerDay: 100, emailsSentToday: 0,
  lastResetDate: new Date().toDateString()
};

const isDB = () => mongoose.connection.readyState === 1;

async function getCfg(key, def = '') {
  if (mem[key] !== undefined) return mem[key]; // use cache
  if (!isDB()) return def;
  try { const d = await Config.findOne({ key }); return d ? d.value : def; } catch { return def; }
}

async function setCfg(key, value) {
  mem[key] = value;
  if (!isDB()) return;
  try { await Config.findOneAndUpdate({ key }, { value }, { upsert: true }); } catch(e) { console.error('[setCfg]', e.message); }
}

async function getAllCfg() {
  if (!isDB()) return { ...mem };
  try {
    const docs = await Config.find({});
    const result = { ...mem };
    docs.forEach(d => { result[d.key] = d.value; mem[d.key] = d.value; }); // sync to mem cache
    return result;
  } catch { return { ...mem }; }
}

async function initDefaults() {
  const defaults = {
    resendApiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.FROM_EMAIL || '',
    groqApiKey: process.env.GROQ_API_KEY || '',
    groqModel: 'llama-3.3-70b-versatile',
    geminiApiKey: '', anthropicApiKey: '', defaultProvider: 'groq',
    emailSubject: '✅ Form Submitted — {{form_title}}',
    emailBody: 'Hi {{to_name}},\n\nYour form "{{form_title}}" was successfully filled and submitted by AI Web Agent.\n\n📋 What was filled:\n{{fields_text}}\n\n🔗 Form URL: {{form_url}}\n🕐 Submitted at: {{submitted_at}}\n\n— AI Web Agent',
    agentEnabled: true, maxEmailsPerDay: 100, emailsSentToday: 0,
    lastResetDate: new Date().toDateString()
  };
  for (const [key, value] of Object.entries(defaults)) {
    const existing = await Config.findOne({ key });
    if (existing) { mem[key] = existing.value; }
    else { await setCfg(key, value); }
  }
  console.log('[DB] Defaults ready');
}

async function resetDaily() {
  const today = new Date().toDateString();
  if (await getCfg('lastResetDate') !== today) {
    await setCfg('emailsSentToday', 0);
    await setCfg('lastResetDate', today);
  }
}

async function sendEmail(toEmail, subject, text) {
  const apiKey   = await getCfg('resendApiKey', '');
  const fromAddr = await getCfg('fromEmail', '') || 'AI Web Agent <onboarding@resend.dev>';
  if (!apiKey) throw new Error('Resend API key not configured. Please add it in Admin Panel → Email Settings.');
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: fromAddr, to: toEmail, subject,
    text, html: `<pre style="font-family:sans-serif;white-space:pre-wrap;font-size:14px">${text}</pre>`
  });
  if (error) throw new Error(error.message || JSON.stringify(error));
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
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  res.json({ status: 'ok', db: isDB() ? 'connected' : 'disconnected' });
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
  });
});

app.post('/api/register-user', async (req, res) => {
  try {
    const { profile } = req.body;
    if (!profile?.email) return res.status(400).json({ error: 'Email required' });
    if (isDB()) await User.findOneAndUpdate({ email: profile.email }, { ...profile, lastSeen: new Date() }, { upsert: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-email', async (req, res) => {
  try {
    await resetDaily();
    const sentToday = await getCfg('emailsSentToday', 0);
    const maxPerDay = await getCfg('maxEmailsPerDay', 100);
    const enabled   = await getCfg('agentEnabled', true);
    if (!enabled)              return res.status(403).json({ error: 'Agent disabled.' });
    if (sentToday >= maxPerDay) return res.status(429).json({ error: 'Daily limit reached.' });

    const { toEmail, toName, formTitle, formUrl, filledFields, submittedAt } = req.body;
    if (!toEmail) return res.status(400).json({ error: 'toEmail required' });

    const fieldsText = Array.isArray(filledFields) ? filledFields.map(f => `• ${f.label}: ${f.value}`).join('\n') : '';
    const vars = {
      '{{to_name}}': toName||toEmail, '{{to_email}}': toEmail,
      '{{form_title}}': formTitle||'Web Form', '{{form_url}}': formUrl||'',
      '{{fields_text}}': fieldsText,
      '{{submitted_at}}': submittedAt || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    };
    let sub = await getCfg('emailSubject', ''), bod = await getCfg('emailBody', '');
    for (const [k,v] of Object.entries(vars)) { sub=sub.replaceAll(k,v); bod=bod.replaceAll(k,v); }

    await sendEmail(toEmail, sub, bod);
    await setCfg('emailsSentToday', sentToday + 1);
    if (isDB()) await User.findOneAndUpdate({ email: toEmail }, { $inc: { formsFilled: 1 }, lastFormTitle: formTitle });
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
    res.json({
      fromEmail:       cfg.fromEmail || '',
      resendSaved:     !!(cfg.resendApiKey && cfg.resendApiKey.length > 5),
      groqSaved:       !!(cfg.groqApiKey && cfg.groqApiKey.length > 5),
      geminiSaved:     !!(cfg.geminiApiKey && cfg.geminiApiKey.length > 5),
      anthropicSaved:  !!(cfg.anthropicApiKey && cfg.anthropicApiKey.length > 5),
      groqModel:       cfg.groqModel || 'llama-3.3-70b-versatile',
      defaultProvider: cfg.defaultProvider || 'groq',
      emailSubject:    cfg.emailSubject || '',
      emailBody:       cfg.emailBody || '',
      agentEnabled:    cfg.agentEnabled !== false,
      maxEmailsPerDay: cfg.maxEmailsPerDay || 100,
      dbConnected:     isDB(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const allowed = ['fromEmail','resendApiKey','emailSubject','emailBody',
      'groqApiKey','groqModel','geminiApiKey','anthropicApiKey','defaultProvider','agentEnabled','maxEmailsPerDay'];
    for (const key of allowed) {
      if (req.body[key] === undefined || req.body[key] === '' || req.body[key] === null) continue;
      await setCfg(key, key === 'maxEmailsPerDay' ? parseInt(req.body[key]) : req.body[key]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try {
    const fromEmail = await getCfg('fromEmail', '');
    const resendKey = await getCfg('resendApiKey', '');
    if (!resendKey) return res.status(400).json({ error: 'Resend API key not set. Add it in Email Settings.' });
    const toAddr = fromEmail.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] || '';
    if (!toAddr) return res.status(400).json({ error: 'From Email address is invalid.' });
    await sendEmail(toAddr, '✅ Test — AI Web Agent email is working!',
      'Congratulations! Your AI Web Agent email system is configured correctly.\n\nUsers will receive confirmation emails after every form submission.');
    res.json({ sent: true });
  } catch(err) {
    console.error('[TEST EMAIL]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    await resetDaily();
    const totalUsers = isDB() ? await User.countDocuments() : 0;
    res.json({
      emailsSentToday: await getCfg('emailsSentToday', 0),
      maxEmailsPerDay: await getCfg('maxEmailsPerDay', 100),
      agentEnabled:    await getCfg('agentEnabled', true),
      totalUsers, dbConnected: isDB(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    res.json(isDB() ? await User.find().sort({ lastSeen: -1 }) : []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:email', requireAdmin, async (req, res) => {
  try {
    if (isDB()) await User.deleteOne({ email: decodeURIComponent(req.params.email) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`AI Web Agent Backend running on port ${PORT}`));
