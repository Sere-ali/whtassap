const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PASSWORD = process.env.APP_PASSWORD || '';
const TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const CC = process.env.DEFAULT_COUNTRY_CODE || '225'; // Côte d'Ivoire
const CONCURRENCY = Math.max(1, parseInt(process.env.SEND_CONCURRENCY || '30', 10));
const MAX_CONTACTS = parseInt(process.env.MAX_CONTACTS || '5000', 10);
const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '';
const DELAY_MS = parseInt(process.env.SEND_DELAY_MS || '1200', 10);

// ---------- Auth ----------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function auth(req, res, next) {
  if (!PASSWORD) return res.status(500).json({ error: "APP_PASSWORD n'est pas défini sur le serveur." });
  if (!safeEqual(req.get('x-app-password') || '', PASSWORD)) {
    return res.status(401).json({ error: 'Mot de passe incorrect.' });
  }
  next();
}

// ---------- Numéros ----------
// Retourne un numéro au format international sans "+" (ex: 2250757059548) ou null.
function normalize(raw) {
  if (!raw) return null;
  const s = String(raw);
  if (/[eE]\+\d/.test(s)) return null; // notation scientifique d'Excel : numéro perdu
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith(CC) && d.length >= CC.length + 8) return d;
  if (CC === '225') {
    if (d.length === 10) return CC + d;          // 07 57 05 95 48
    if (d.length === 9) return CC + '0' + d;     // zéro initial perdu (Excel)
    if (d.length === 8) return null;             // ancien format, ambigu
    return null;
  }
  if (d.startsWith('0')) d = d.slice(1);
  const full = CC + d;
  return full.length >= 10 && full.length <= 15 ? full : null;
}

// Extrait des contacts depuis du texte libre (CSV, copier-coller, etc.)
function parseContacts(text) {
  const seen = new Set();
  const contacts = [];
  const invalid = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const parts = l.split(/[;\t,]/).map(p => p.trim()).filter(Boolean);
    let number = null;
    const nameParts = [];
    for (const p of parts) {
      const n = number ? null : normalize(p);
      if (n) number = n;
      else if (!/^[\d\s.+()\-]+$/.test(p)) nameParts.push(p);
    }
    const name = nameParts.join(' ').replace(/^\d+\s*/, '');
    if (!number) { invalid.push(l); continue; }
    if (seen.has(number)) continue;
    seen.add(number);
    contacts.push({ name, number });
  }
  return { contacts, invalid };
}

// ---------- Envoi WhatsApp Cloud API ----------
async function sendOne(contact, opts) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}/messages`;
  let body;
  if (opts.mode === 'template') {
    const template = { name: opts.templateName, language: { code: opts.language || 'fr' } };
    if (opts.useNameParam) {
      template.components = [{ type: 'body', parameters: [{ type: 'text', text: contact.name || 'Madame/Monsieur' }] }];
    }
    body = { messaging_product: 'whatsapp', to: contact.number, type: 'template', template };
  } else {
    const text = String(opts.message).replace(/\{nom\}/gi, contact.name || '').replace(/ +,/g, ',').trim();
    body = { messaging_product: 'whatsapp', to: contact.number, type: 'text', text: { body: text, preview_url: false } };
  }
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('NETWORK: ' + (e.cause && (e.cause.code || e.cause.message) || e.message));
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || `HTTP ${r.status}`);
}

const jobs = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const RATE_LIMIT = /rate|too many|throughput|limit|HTTP 429|HTTP 5\d\d|NETWORK/i;
async function sendWithRetry(c, opts) {
  for (let attempt = 0; ; attempt++) {
    try { return await sendOne(c, opts); }
    catch (e) {
      if (attempt >= 6 || !RATE_LIMIT.test(e.message)) throw e;
      await sleep(500 * 2 ** attempt); // 0,5s, 1s, 2s, 4s, 8s
    }
  }
}

async function sendTracked(job, c, opts) {
  try {
    await sendWithRetry(c, opts);
    job.sent++;
    job.results.push({ number: c.number, name: c.name, ok: true });
  } catch (e) {
    job.failed++;
    job.results.push({ number: c.number, name: c.name, ok: false, error: e.message });
  }
}

async function runJob(job, opts) {
  if (opts.parallel) {
    // Envoi simultané : plusieurs messages en même temps (par lots de CONCURRENCY)
    const queue = job.contacts.slice();
    const worker = async () => {
      while (queue.length) await sendTracked(job, queue.shift(), opts);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  } else {
    for (const c of job.contacts) {
      await sendTracked(job, c, opts);
      await sleep(DELAY_MS);
    }
  }
  job.done = true;
}

// ---------- Routes ----------
app.get('/api/config', auth, (req, res) => {
  res.json({ apiConfigured: Boolean(TOKEN && PHONE_ID), countryCode: CC });
});

// Liste de contacts préchargée (variable d'environnement CONTACTS_CSV, jamais dans le dépôt public)
app.get('/api/contacts', auth, (req, res) => {
  res.json({ text: process.env.CONTACTS_CSV || '' });
});

// ---------- Modèles de message (création et suivi chez Meta) ----------
function graphError(data, status) {
  const e = (data && data.error) || {};
  return e.error_user_msg || e.message || `HTTP ${status}`;
}
app.get('/api/templates', auth, async (req, res) => {
  if (!TOKEN || !WABA_ID) return res.status(400).json({ error: 'WHATSAPP_TOKEN / WHATSAPP_BUSINESS_ACCOUNT_ID non configurés.' });
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${WABA_ID}/message_templates?fields=name,status,category,language,components&limit=100`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(400).json({ error: graphError(d, r.status) });
    res.json({ templates: (d.data || []).map(t => ({
      name: t.name, status: t.status, category: t.category, language: t.language,
      text: ((t.components || []).find(c => c.type === 'BODY') || {}).text || '',
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/templates', auth, async (req, res) => {
  if (!TOKEN || !WABA_ID) return res.status(400).json({ error: 'WHATSAPP_TOKEN / WHATSAPP_BUSINESS_ACCOUNT_ID non configurés.' });
  const { name, text, category, language, exampleName } = req.body || {};
  if (!/^[a-z0-9_]{1,100}$/.test(name || '')) return res.status(400).json({ error: 'Nom invalide : minuscules, chiffres et _ uniquement (ex: rappel_rencontre).' });
  if (!text || text.length > 1024) return res.status(400).json({ error: 'Texte requis (1024 caractères maximum).' });
  const body = { type: 'BODY', text };
  if (/\{\{1\}\}/.test(text)) body.example = { body_text: [[exampleName || 'Marie']] };
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${WABA_ID}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, language: language || 'fr', category: category === 'MARKETING' ? 'MARKETING' : 'UTILITY', components: [body] }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(400).json({ error: graphError(d, r.status) });
    res.json({ id: d.id, status: d.status || 'PENDING' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/diagnose', auth, async (req, res) => {
  const out = { phoneId: PHONE_ID, wabaId: WABA_ID, hasToken: Boolean(TOKEN) };
  const g = async p => {
    try {
      const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      return await r.json();
    } catch (e) { return { error: { message: 'NETWORK: ' + (e.cause && (e.cause.code || e.cause.message) || e.message) } }; }
  };
  out.phone = await g(`${PHONE_ID}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`);
  if (WABA_ID) out.waba_phones = await g(`${WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name`);
  res.json(out);
});

app.post('/api/parse', auth, (req, res) => {
  res.json(parseContacts(req.body.text));
});

app.post('/api/send', auth, (req, res) => {
  if (!TOKEN || !PHONE_ID) {
    return res.status(400).json({ error: 'WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID non configurés.' });
  }
  const { contacts, mode, message, templateName, language, useNameParam, parallel } = req.body;
  if (!Array.isArray(contacts) || contacts.length === 0) return res.status(400).json({ error: 'Aucun contact.' });
  if (contacts.length > MAX_CONTACTS) return res.status(400).json({ error: `Maximum ${MAX_CONTACTS} contacts par envoi.` });
  if (mode === 'template' ? !templateName : !message) {
    return res.status(400).json({ error: mode === 'template' ? 'Nom du modèle requis.' : 'Message vide.' });
  }
  const clean = contacts
    .map(c => ({ name: String(c.name || ''), number: normalize(c.number) }))
    .filter(c => c.number);
  const id = crypto.randomUUID();
  const job = { id, total: clean.length, sent: 0, failed: 0, done: false, results: [], contacts: clean };
  jobs.set(id, job);
  runJob(job, { mode, message, templateName, language, useNameParam, parallel: Boolean(parallel) });
  res.json({ jobId: id, total: clean.length });
});

app.get('/api/job/:id', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Envoi introuvable.' });
  const { contacts, ...pub } = job;
  res.json(pub);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
