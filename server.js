// server.js — AI Web Agent Backend
// Deploy on Render.com (free) — users never need to touch this

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const jwt        = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── In-memory config store (persists as long as server runs)
// For production use a database like MongoDB Atlas (free)
let config = {
  gmailUser:        process.env.GMAIL_USER        || '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',
  emailSubject:     '✅ Form Submitted — {{form_title}}',
  emailBody:        `Hi {{to_name}},\n\nYour form "{{form_title}}" was successfully filled and submitted by AI Web Agent.\n\n📋 What was filled:\n{{fields_text}}\n\n🔗 Form URL: {{form_url}}\n🕐 Submitted at: {{submitted_at}}\n\n— AI Web Agent`,
  agentEnabled:     true,
  maxEmailsPerDay:  100,
  emailsSentToday:  0,
  lastResetDate:    new Date().toDateString(),
};

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public')); // Serves admin panel

// Serve admin panel at root
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ── Middleware: verify admin JWT ──────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.ADMIN_SECRET || 'secret123');
    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Reset daily email count ───────────────────────────────
function resetDailyCountIfNeeded() {
  const today = new Date().toDateString();
  if (config.lastResetDate !== today) {
    config.emailsSentToday = 0;
    config.lastResetDate = today;
  }
}

// ════════════════════════════════════════════════════════════
// PUBLIC ROUTES (used by extension, no auth needed)
// ════════════════════════════════════════════════════════════

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', agentEnabled: config.agentEnabled });
});

// Send confirmation email — called by extension after form submit
app.post('/api/send-email', async (req, res) => {
  try {
    resetDailyCountIfNeeded();

    if (!config.agentEnabled) {
      return res.status(403).json({ error: 'Agent is disabled by admin.' });
    }

    if (config.emailsSentToday >= config.maxEmailsPerDay) {
      return res.status(429).json({ error: 'Daily email limit reached. Try tomorrow.' });
    }

    const { toEmail, toName, formTitle, formUrl, filledFields, submittedAt } = req.body;

    if (!toEmail) return res.status(400).json({ error: 'toEmail is required' });
    if (!config.gmailUser || !config.gmailAppPassword) {
      return res.status(500).json({ error: 'Email not configured by admin yet.' });
    }

    // Build fields text
    const fieldsText = Array.isArray(filledFields)
      ? filledFields.map(f => `• ${f.label}: ${f.value}`).join('\n')
      : '';

    // Replace template variables
    const replacements = {
      '{{to_name}}':      toName    || toEmail,
      '{{to_email}}':     toEmail,
      '{{form_title}}':   formTitle || 'Web Form',
      '{{form_url}}':     formUrl   || '',
      '{{fields_text}}':  fieldsText,
      '{{submitted_at}}': submittedAt || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    };

    let subject = config.emailSubject;
    let body    = config.emailBody;
    for (const [key, val] of Object.entries(replacements)) {
      subject = subject.replaceAll(key, val);
      body    = body.replaceAll(key, val);
    }

    // Send via Gmail
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: config.gmailUser, pass: config.gmailAppPassword },
    });

    await transporter.sendMail({
      from: `"AI Web Agent" <${config.gmailUser}>`,
      to:   toEmail,
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>').replace(/📋/g,'📋').replace(/🔗/g,'🔗').replace(/🕐/g,'🕐'),
    });

    config.emailsSentToday++;
    console.log(`[EMAIL] Sent to ${toEmail} — ${formTitle} (${config.emailsSentToday}/${config.maxEmailsPerDay} today)`);
    res.json({ sent: true, emailsSentToday: config.emailsSentToday });

  } catch (err) {
    console.error('[EMAIL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// ADMIN ROUTES (protected)
// ════════════════════════════════════════════════════════════

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  const token = jwt.sign({ admin: true }, process.env.ADMIN_SECRET || 'secret123', { expiresIn: '7d' });
  res.json({ token });
});

// Get current config
app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({
    gmailUser:        config.gmailUser,
    gmailAppPassword: config.gmailAppPassword ? '••••••••' : '',
    emailSubject:     config.emailSubject,
    emailBody:        config.emailBody,
    agentEnabled:     config.agentEnabled,
    maxEmailsPerDay:  config.maxEmailsPerDay,
    emailsSentToday:  config.emailsSentToday,
    lastResetDate:    config.lastResetDate,
  });
});

// Update config
app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { gmailUser, gmailAppPassword, emailSubject, emailBody, agentEnabled, maxEmailsPerDay } = req.body;
  if (gmailUser        !== undefined) config.gmailUser        = gmailUser;
  if (gmailAppPassword && gmailAppPassword !== '••••••••') config.gmailAppPassword = gmailAppPassword;
  if (emailSubject     !== undefined) config.emailSubject     = emailSubject;
  if (emailBody        !== undefined) config.emailBody        = emailBody;
  if (agentEnabled     !== undefined) config.agentEnabled     = agentEnabled;
  if (maxEmailsPerDay  !== undefined) config.maxEmailsPerDay  = parseInt(maxEmailsPerDay);
  console.log('[ADMIN] Config updated');
  res.json({ success: true });
});

// Send test email
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try {
    if (!config.gmailUser || !config.gmailAppPassword) {
      return res.status(400).json({ error: 'Gmail not configured yet.' });
    }
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: config.gmailUser, pass: config.gmailAppPassword },
    });
    await transporter.sendMail({
      from: `"AI Web Agent" <${config.gmailUser}>`,
      to:   config.gmailUser,
      subject: '✅ Test Email — AI Web Agent is working!',
      text: 'This is a test email from your AI Web Agent backend. Email sending is working correctly!',
    });
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get email stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  resetDailyCountIfNeeded();
  res.json({
    emailsSentToday: config.emailsSentToday,
    maxEmailsPerDay: config.maxEmailsPerDay,
    lastResetDate:   config.lastResetDate,
    agentEnabled:    config.agentEnabled,
  });
});

app.listen(PORT, () => console.log(`AI Web Agent Backend running on port ${PORT}`));
