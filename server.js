// server.js — AI Web Agent Backend v2
// Admin sets all keys — users just fill their profile

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const jwt        = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Central config (admin controls everything) ────────────
let config = {
  // Email
  gmailUser:        process.env.GMAIL_USER         || '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD  || '',
  emailSubject:     '✅ Form Submitted — {{form_title}}',
  emailBody:        'Hi {{to_name}},\n\nYour form "{{form_title}}" was successfully filled and submitted by AI Web Agent.\n\n📋 What was filled:\n{{fields_text}}\n\n🔗 Form URL: {{form_url}}\n🕐 Submitted at: {{submitted_at}}\n\n— AI Web Agent',
  // AI Keys (admin sets, all users use)
  groqApiKey:       process.env.GROQ_API_KEY        || '',
  groqModel:        process.env.GROQ_MODEL          || 'llama-3.3-70b-versatile',
  geminiApiKey:     process.env.GEMINI_API_KEY       || '',
  anthropicApiKey:  process.env.ANTHROPIC_API_KEY    || '',
  defaultProvider:  'groq',
  // Agent control
  agentEnabled:     true,
  maxEmailsPerDay:  100,
  emailsSentToday:  0,
  lastResetDate:    new Date().toDateString(),
};

// ── User profiles store ───────────────────────────────────
let userProfiles = {}; // keyed by email

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ── Admin auth middleware ─────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(auth.slice(7), process.env.ADMIN_SECRET || 'secret123');
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function resetDailyCountIfNeeded() {
  const today = new Date().toDateString();
  if (config.lastResetDate !== today) {
    config.emailsSentToday = 0;
    config.lastResetDate = today;
  }
}

// ════════════════════════════════════════════════════════
// PUBLIC ROUTES — used by extension
// ════════════════════════════════════════════════════════

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', agentEnabled: config.agentEnabled });
});

// Extension calls this to get AI keys + config
// Users never see the keys — extension just uses them
app.get('/api/agent-config', (req, res) => {
  if (!config.agentEnabled) {
    return res.status(403).json({ error: 'Agent disabled by admin.' });
  }
  res.json({
    groqApiKey:      config.groqApiKey,
    groqModel:       config.groqModel,
    geminiApiKey:    config.geminiApiKey,
    anthropicApiKey: config.anthropicApiKey,
    defaultProvider: config.defaultProvider,
    agentEnabled:    config.agentEnabled,
  });
});

// Extension registers/updates user profile
app.post('/api/register-user', (req, res) => {
  const { profile } = req.body;
  if (!profile?.email) return res.status(400).json({ error: 'Email required' });
  userProfiles[profile.email] = {
    ...profile,
    lastSeen: new Date().toISOString(),
    formsFilled: (userProfiles[profile.email]?.formsFilled || 0),
  };
  console.log('[USER] Registered:', profile.email);
  res.json({ ok: true });
});

// Send confirmation email
app.post('/api/send-email', async (req, res) => {
  try {
    resetDailyCountIfNeeded();
    if (!config.agentEnabled) return res.status(403).json({ error: 'Agent disabled.' });
    if (config.emailsSentToday >= config.maxEmailsPerDay) return res.status(429).json({ error: 'Daily limit reached.' });

    const { toEmail, toName, formTitle, formUrl, filledFields, submittedAt } = req.body;
    if (!toEmail) return res.status(400).json({ error: 'toEmail required' });
    if (!config.gmailUser || !config.gmailAppPassword) return res.status(500).json({ error: 'Email not configured by admin.' });

    // Update user stats
    if (userProfiles[toEmail]) {
      userProfiles[toEmail].formsFilled = (userProfiles[toEmail].formsFilled || 0) + 1;
      userProfiles[toEmail].lastFormTitle = formTitle;
      userProfiles[toEmail].lastActivity = new Date().toISOString();
    }

    const fieldsText = Array.isArray(filledFields)
      ? filledFields.map(f => `• ${f.label}: ${f.value}`).join('\n') : '';

    const replacements = {
      '{{to_name}}': toName || toEmail, '{{to_email}}': toEmail,
      '{{form_title}}': formTitle || 'Web Form', '{{form_url}}': formUrl || '',
      '{{fields_text}}': fieldsText,
      '{{submitted_at}}': submittedAt || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    };

    let subject = config.emailSubject;
    let body    = config.emailBody;
    for (const [k, v] of Object.entries(replacements)) {
      subject = subject.replaceAll(k, v);
      body    = body.replaceAll(k, v);
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: config.gmailUser, pass: config.gmailAppPassword },
    });

    await transporter.sendMail({
      from: `"AI Web Agent" <${config.gmailUser}>`,
      to: toEmail, subject, text: body,
      html: body.replace(/\n/g, '<br>'),
    });

    config.emailsSentToday++;
    console.log(`[EMAIL] Sent to ${toEmail} — ${formTitle}`);
    res.json({ sent: true });

  } catch (err) {
    console.error('[EMAIL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// ADMIN ROUTES — protected
// ════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== (process.env.ADMIN_USERNAME || 'admin') ||
      password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong credentials' });
  }
  const token = jwt.sign({ admin: true }, process.env.ADMIN_SECRET || 'secret123', { expiresIn: '7d' });
  res.json({ token });
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({
    ...config,
    gmailAppPassword: config.gmailAppPassword ? '••••••••' : '',
    groqApiKey:       config.groqApiKey       ? '••••' + config.groqApiKey.slice(-6) : '',
    geminiApiKey:     config.geminiApiKey     ? '••••' + config.geminiApiKey.slice(-4) : '',
    anthropicApiKey:  config.anthropicApiKey  ? '••••' + config.anthropicApiKey.slice(-6) : '',
  });
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
  const fields = ['gmailUser','gmailAppPassword','emailSubject','emailBody',
    'groqApiKey','groqModel','geminiApiKey','anthropicApiKey','defaultProvider',
    'agentEnabled','maxEmailsPerDay'];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      // Don't overwrite masked values
      if (['gmailAppPassword','groqApiKey','geminiApiKey','anthropicApiKey'].includes(f)
        && req.body[f].includes('••••')) continue;
      config[f] = f === 'maxEmailsPerDay' ? parseInt(req.body[f]) : req.body[f];
    }
  }
  console.log('[ADMIN] Config updated');
  res.json({ success: true });
});

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try {
    if (!config.gmailUser || !config.gmailAppPassword)
      return res.status(400).json({ error: 'Gmail not configured.' });
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: config.gmailUser, pass: config.gmailAppPassword },
    });
    await transporter.sendMail({
      from: `"AI Web Agent" <${config.gmailUser}>`,
      to: config.gmailUser,
      subject: '✅ Test Email — AI Web Agent Backend is working!',
      text: 'Email sending is configured correctly!',
    });
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  resetDailyCountIfNeeded();
  res.json({
    emailsSentToday: config.emailsSentToday,
    maxEmailsPerDay: config.maxEmailsPerDay,
    lastResetDate:   config.lastResetDate,
    agentEnabled:    config.agentEnabled,
    totalUsers:      Object.keys(userProfiles).length,
  });
});

// Get all user profiles
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(Object.values(userProfiles).sort((a,b) =>
    new Date(b.lastSeen) - new Date(a.lastSeen)
  ));
});

// Delete a user
app.delete('/api/admin/users/:email', requireAdmin, (req, res) => {
  delete userProfiles[decodeURIComponent(req.params.email)];
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`AI Web Agent Backend v2 running on port ${PORT}`));
