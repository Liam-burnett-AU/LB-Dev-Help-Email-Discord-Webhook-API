/**
 * =========================================================================
 *  Email -> Discord Forum Post   (Cloudflare Email Worker + HTTP APIs)
 * =========================================================================
 *  Two independent entry points into the same Worker:
 *
 *  1. email() - Cloudflare Email Routing calls this whenever mail arrives
 *     at an address you've pointed at this Worker. It parses the message
 *     with postal-mime, then creates a new post (thread) in a Discord
 *     forum channel via that channel's webhook.
 *
 *  2. fetch() - routes two JSON APIs by path:
 *       POST /api/contact - a "contact me" form endpoint. Takes
 *         { name, email, subject, message }, creates a thread in a
 *         *different* Discord forum channel, emails you a copy (via the
 *         send_email binding) and auto-replies to the sender.
 *       POST /api/send - a generic "send an email" endpoint any of your
 *         other apps can call (with an API key) to send a real email via
 *         Cloudflare's own send_email binding - no raw sockets, so it
 *         works on the free Workers plan too (earlier versions of this
 *         relayed through Gmail's SMTP server directly over a raw TCP
 *         socket, which needs a paid plan - see git history).
 *
 *  Full setup walkthrough is in README.md. Quick version:
 *    Email -> Discord:
 *      1. Create a webhook ON the target Discord forum channel.
 *      2. wrangler secret put DISCORD_WEBHOOK_URL
 *      3. Cloudflare dashboard -> Compute > Email Service > Email Routing >
 *         Routing Rules -> Create routing rule -> Action: Send to a Worker.
 *    Contact form API (/api/contact):
 *      1. Create a webhook ON a (probably different) Discord forum channel.
 *      2. wrangler secret put CONTACT_DISCORD_WEBHOOK_URL
 *      3. Add a [[send_email]] binding in wrangler.toml (see comments there).
 *    Send email API (/api/send):
 *      1. Reuses the same [[send_email]] binding as the contact form - no
 *         extra Cloudflare setup needed.
 *      2. wrangler secret put SEND_EMAIL_API_KEY   (a random shared secret -
 *         every caller must send it; NEVER call this from browser JS, the
 *         key would leak. Backend-to-backend only.)
 *    Then: wrangler deploy
 * =========================================================================
 */

import PostalMime from 'postal-mime';
import { createMimeMessage } from 'mimetext';
import { EmailMessage } from 'cloudflare:email';

// ---------------------------------------------------------------------
// Configuration - tweak these to taste
// ---------------------------------------------------------------------
const EMBED_COLOR = 0x28265c; // LB Dev navy accent - change as you like
const MAX_DESCRIPTION_LENGTH = 3900; // Discord embed description hard cap is 4096
const MAX_THREAD_NAME_LENGTH = 100; // Discord forum post title hard cap
const MAX_FIELD_LENGTH = 256;
const FORWARD_ATTACHMENTS = true; // upload small attachments as real Discord files
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8MB/file - conservative, safe on any server
const MAX_ATTACHMENTS = 10; // Discord's hard cap per message

// Only react to specific recipient address(es), e.g. ['help@lbdev.app'].
// Leave empty to process every address you route to this Worker.
const ALLOWED_RECIPIENTS = [];

// Also forward a copy of the original email to a real inbox, e.g.
// 'you@gmail.com'. Leave blank ('') to skip forwarding and only post to
// Discord. IMPORTANT: this address must be added AND verified first, in
// Compute > Email Service > Email Routing > Destination Addresses -
// forwarding to an unverified address throws an error (caught below, but
// it won't actually forward until that's done).
const FORWARD_TO_EMAIL = 'liamburnett40@gmail.com';

// ---------------------------------------------------------------------
// Contact form API config
// ---------------------------------------------------------------------
const MAX_CONTACT_NAME_LENGTH = 100;
const MAX_CONTACT_SUBJECT_LENGTH = MAX_THREAD_NAME_LENGTH; // Discord forum post title hard cap
const MAX_CONTACT_MESSAGE_LENGTH = MAX_DESCRIPTION_LENGTH; // Discord embed description hard cap

// The "From" address used for both the notification email (to you) and the
// auto-reply (to whoever submitted the form). It must be on a domain you've
// enabled Email Routing for (it doesn't need to be a real mailbox), or
// Cloudflare's send_email binding will reject it.
const CONTACT_FORM_FROM_EMAIL = 'help@lbdev.app';

// Origins allowed to call the API (CORS), e.g. ['https://lbdev.app'].
// Leave empty to allow any origin.
const CONTACT_FORM_ALLOWED_ORIGINS = [];

// Send a "thanks, we got it" confirmation email back to whoever submitted
// the form. Set to false to skip this and only notify/post internally.
// NOTE: this sends to an arbitrary address the visitor typed in, so the
// [[send_email]] binding in wrangler.toml must stay unrestricted (no
// destination_address / allowed_destination_addresses) - restricting it
// would silently break this.
const AUTO_REPLY_ENABLED = true;
const AUTO_REPLY_FROM_NAME = 'LB Dev';
const AUTO_REPLY_SUBJECT = 'Thanks for reaching out - message received';
const AUTO_REPLY_TURNAROUND = '2-3 business days';

const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Strips CR/LF so a caller-supplied string can't smuggle extra headers
// (e.g. a fake "Bcc:") into an outgoing MIME message.
function sanitizeHeaderValue(str) {
  return str.replace(/[\r\n]+/g, ' ');
}

// ---------------------------------------------------------------------
// Send email API config
// ---------------------------------------------------------------------
// The "From" address for /api/send, via the same send_email binding the
// contact form uses. Must be on a domain you've enabled Email Routing for.
const SEND_EMAIL_FROM_EMAIL = 'help@lbdev.app';
const MAX_SEND_EMAIL_RECIPIENTS = 10;
const MAX_SEND_EMAIL_SUBJECT_LENGTH = 256;
const MAX_SEND_EMAIL_BODY_LENGTH = 100_000;

export default {
  async email(message, env, ctx) {
    if (ALLOWED_RECIPIENTS.length && !ALLOWED_RECIPIENTS.includes(message.to)) {
      return; // not an address we care about - ignore quietly
    }

    // These two are independent - a problem with one (missing secret,
    // an unverified destination, a weird malformed email) never stops
    // the other from still happening.
    await postToDiscord(message, env);
    await forwardCopy(message);
  },

  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/contact' || pathname === '/api/contact/') {
      return handleContactForm(request, env);
    }
    if (pathname === '/api/send' || pathname === '/api/send/') {
      return handleSendEmail(request, env);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: buildCorsHeaders(request) });
    }
    return jsonResponse({ error: 'Not found' }, 404, buildCorsHeaders(request));
  },
};

async function postToDiscord(message, env) {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.error('Missing DISCORD_WEBHOOK_URL secret - run `wrangler secret put DISCORD_WEBHOOK_URL`');
    return; // don't bounce the email just because Discord isn't configured yet
  }

  let parsed;
  try {
    parsed = await PostalMime.parse(message.raw);
  } catch (err) {
    console.error('Failed to parse incoming email:', err);
    await postParseFailure(env.DISCORD_WEBHOOK_URL, message, err);
    return;
  }

  const subject = (parsed.subject || '(no subject)').replace(/[\r\n]+/g, ' ').trim() || '(no subject)';
  const from = formatAddress(parsed.from) || message.from;
  const to = (parsed.to || []).map(formatAddress).filter(Boolean).join(', ') || message.to;
  const bodyText = (parsed.text && parsed.text.trim()) || htmlToPlainText(parsed.html) || '*(no readable body)*';
  const date = parsed.date ? new Date(parsed.date) : new Date();

  try {
    const response = await postToDiscordForum(env.DISCORD_WEBHOOK_URL, {
      subject,
      from,
      to,
      date,
      bodyText,
      attachments: FORWARD_ATTACHMENTS ? parsed.attachments || [] : [],
    });

    if (!response.ok) {
      console.error(`Discord webhook returned ${response.status}: ${await response.text()}`);
    }
  } catch (err) {
    console.error('Failed to post to Discord:', err);
  }
}

async function forwardCopy(message) {
  if (!FORWARD_TO_EMAIL) {
    console.log('FORWARD_TO_EMAIL is blank - skipping forward, Discord-only');
    return;
  }

  try {
    await message.forward(FORWARD_TO_EMAIL);
    console.log(`Forwarded to ${FORWARD_TO_EMAIL}`);
  } catch (err) {
    const reason = err?.message || String(err);
    if (reason.includes('not verified')) {
      console.error(
        `Can't forward to ${FORWARD_TO_EMAIL} - add and verify it as a Destination Address first: ` +
          'Compute > Email Service > Email Routing > Destination Addresses.'
      );
    } else {
      console.error('Failed to forward email:', err);
    }
  }
}

// ---------------------------------------------------------------------
// Contact form API
// ---------------------------------------------------------------------

async function handleContactForm(request, env) {
  const corsHeaders = buildCorsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const subject = (typeof body.subject === 'string' ? sanitizeHeaderValue(body.subject).trim() : '') || '(no subject)';
  const message = typeof body.message === 'string' ? body.message.trim() : '';

  if (!name || !email || !message) {
    return jsonResponse({ error: 'name, email and message are required' }, 400, corsHeaders);
  }
  if (!EMAIL_ADDRESS_PATTERN.test(email)) {
    return jsonResponse({ error: 'Invalid email address' }, 400, corsHeaders);
  }

  const fields = {
    name: truncate(name, MAX_CONTACT_NAME_LENGTH),
    email: truncate(email, MAX_FIELD_LENGTH),
    subject: truncate(subject, MAX_CONTACT_SUBJECT_LENGTH),
    message: truncate(message, MAX_CONTACT_MESSAGE_LENGTH),
  };

  // Same philosophy as the email handler - a problem with one (missing
  // secret/binding, Discord being down) never stops the others. The
  // auto-reply is a courtesy to the sender, not core delivery, so it's
  // excluded from the pass/fail check below.
  const [discordResult, emailResult, autoReplyResult] = await Promise.allSettled([
    postContactToDiscord(env, fields),
    sendContactNotification(env, fields),
    AUTO_REPLY_ENABLED ? sendAutoReply(env, fields) : Promise.resolve(),
  ]);

  if (discordResult.status === 'rejected') {
    console.error('Contact form Discord post failed:', discordResult.reason);
  }
  if (emailResult.status === 'rejected') {
    console.error('Contact form email notification failed:', emailResult.reason);
  }
  if (autoReplyResult.status === 'rejected') {
    console.error('Contact form auto-reply failed:', autoReplyResult.reason);
  }

  if (discordResult.status === 'rejected' && emailResult.status === 'rejected') {
    return jsonResponse({ error: 'Failed to deliver message' }, 502, corsHeaders);
  }

  return jsonResponse({ ok: true }, 200, corsHeaders);
}

function buildCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  const allowed = CONTACT_FORM_ALLOWED_ORIGINS.length === 0 || CONTACT_FORM_ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

async function postContactToDiscord(env, { name, email, subject, message }) {
  if (!env.CONTACT_DISCORD_WEBHOOK_URL) {
    throw new Error('Missing CONTACT_DISCORD_WEBHOOK_URL secret - run `wrangler secret put CONTACT_DISCORD_WEBHOOK_URL`');
  }

  const embed = {
    title: subject,
    description: message,
    color: EMBED_COLOR,
    fields: [
      { name: 'Name', value: name, inline: true },
      { name: 'Email', value: email, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'via contact form API' },
  };

  const response = await fetch(env.CONTACT_DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_name: subject, embeds: [embed] }),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook returned ${response.status}: ${await response.text()}`);
  }
}

async function sendContactNotification(env, { name, email, subject, message }) {
  if (!env.SEND_EMAIL) {
    throw new Error('Missing SEND_EMAIL binding - add a [[send_email]] block to wrangler.toml and redeploy');
  }
  if (!FORWARD_TO_EMAIL) {
    return; // no notify address configured - Discord-only
  }

  const mime = createMimeMessage();
  mime.setSender({ name: 'LB Dev Contact Form', addr: CONTACT_FORM_FROM_EMAIL });
  mime.setRecipient(FORWARD_TO_EMAIL);
  mime.setSubject(`[Contact Form] ${subject}`);
  mime.setHeader('Reply-To', email);
  mime.addMessage({ contentType: 'text/plain', data: `From: ${name} <${email}>\n\n${message}` });

  const mail = new EmailMessage(CONTACT_FORM_FROM_EMAIL, FORWARD_TO_EMAIL, mime.asRaw());
  await env.SEND_EMAIL.send(mail);
}

async function sendAutoReply(env, { name, email, subject }) {
  if (!env.SEND_EMAIL) {
    throw new Error('Missing SEND_EMAIL binding - add a [[send_email]] block to wrangler.toml and redeploy');
  }

  const mime = createMimeMessage();
  mime.setSender({ name: AUTO_REPLY_FROM_NAME, addr: CONTACT_FORM_FROM_EMAIL });
  mime.setRecipient(email);
  mime.setSubject(AUTO_REPLY_SUBJECT);
  mime.addMessage({
    contentType: 'text/plain',
    data:
      `Hi ${name},\n\n` +
      `Thanks for reaching out${subject && subject !== '(no subject)' ? ` about "${subject}"` : ''} - ` +
      `this is just to confirm your message came through. I'll get back to you within ${AUTO_REPLY_TURNAROUND}.\n\n` +
      `Cheers,\n${AUTO_REPLY_FROM_NAME}`,
  });

  const mail = new EmailMessage(CONTACT_FORM_FROM_EMAIL, email, mime.asRaw());
  await env.SEND_EMAIL.send(mail);
}

// ---------------------------------------------------------------------
// Send email API - a generic endpoint any of your own backend services
// can call to send a real email, authenticated with a shared API key.
// Goes through the same send_email binding as the contact form, so
// unlike the raw-SMTP approach this previously used, it works on the
// free Workers plan (no TCP Sockets needed).
// ---------------------------------------------------------------------

async function handleSendEmail(request, env) {
  const corsHeaders = buildCorsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  if (!isAuthorized(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const to = normalizeRecipients(body.to);
  const subject = typeof body.subject === 'string' ? sanitizeHeaderValue(body.subject).trim() : '';
  const text = typeof body.text === 'string' ? body.text : '';
  const html = typeof body.html === 'string' ? body.html : '';
  const replyTo = typeof body.replyTo === 'string' ? body.replyTo.trim() : '';
  const fromName = typeof body.fromName === 'string' ? sanitizeHeaderValue(body.fromName).trim() : '';

  if (!to.length || !subject || (!text && !html)) {
    return jsonResponse({ error: 'to, subject and text or html are required' }, 400, corsHeaders);
  }
  if (!to.every((addr) => EMAIL_ADDRESS_PATTERN.test(addr))) {
    return jsonResponse({ error: 'One or more recipient addresses are invalid' }, 400, corsHeaders);
  }
  if (to.length > MAX_SEND_EMAIL_RECIPIENTS) {
    return jsonResponse({ error: `Too many recipients (max ${MAX_SEND_EMAIL_RECIPIENTS})` }, 400, corsHeaders);
  }
  if (replyTo && !EMAIL_ADDRESS_PATTERN.test(replyTo)) {
    return jsonResponse({ error: 'Invalid replyTo address' }, 400, corsHeaders);
  }

  try {
    await sendOutboundEmail(env, {
      to,
      subject: truncate(subject, MAX_SEND_EMAIL_SUBJECT_LENGTH),
      text: truncate(text, MAX_SEND_EMAIL_BODY_LENGTH),
      html: truncate(html, MAX_SEND_EMAIL_BODY_LENGTH),
      replyTo,
      fromName,
    });
  } catch (err) {
    console.error('send-email failed:', err);
    return jsonResponse({ error: 'Failed to send email' }, 502, corsHeaders);
  }

  return jsonResponse({ ok: true }, 200, corsHeaders);
}

// Constant-time-ish API key check via Authorization: Bearer <key>.
function isAuthorized(request, env) {
  if (!env.SEND_EMAIL_API_KEY) {
    console.error('Missing SEND_EMAIL_API_KEY secret - run `wrangler secret put SEND_EMAIL_API_KEY`');
    return false;
  }
  const auth = request.headers.get('Authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return timingSafeEqual(provided, env.SEND_EMAIL_API_KEY);
}

function timingSafeEqual(a, b) {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  const length = Math.max(bufA.length, bufB.length, 1);
  let diff = bufA.length === bufB.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return diff === 0;
}

function normalizeRecipients(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? [input] : [];
  return list.map((addr) => (typeof addr === 'string' ? addr.trim() : '')).filter(Boolean);
}

async function sendOutboundEmail(env, { to, subject, text, html, replyTo, fromName }) {
  if (!env.SEND_EMAIL) {
    throw new Error('Missing SEND_EMAIL binding - add a [[send_email]] block to wrangler.toml and redeploy');
  }

  const mime = createMimeMessage();
  mime.setSender({ name: fromName || AUTO_REPLY_FROM_NAME, addr: SEND_EMAIL_FROM_EMAIL });
  to.forEach((addr) => mime.setRecipient(addr));
  if (replyTo) mime.setHeader('Reply-To', replyTo);
  mime.setSubject(subject);
  if (html) mime.addMessage({ contentType: 'text/html', data: html });
  if (text || !html) mime.addMessage({ contentType: 'text/plain', data: text || '' });

  const raw = mime.asRaw();
  // One send per recipient (the send_email binding takes a single envelope
  // "to"), all sharing the same message - everyone still sees the full
  // recipient list in the "To" header above.
  await Promise.all(to.map((addr) => env.SEND_EMAIL.send(new EmailMessage(SEND_EMAIL_FROM_EMAIL, addr, raw))));
}

// ---------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------

async function postToDiscordForum(webhookUrl, { subject, from, to, date, bodyText, attachments }) {
  const embed = {
    title: truncate(subject, 256),
    description: truncate(bodyText, MAX_DESCRIPTION_LENGTH),
    color: EMBED_COLOR,
    fields: [
      { name: 'From', value: truncate(from, MAX_FIELD_LENGTH) || 'Unknown', inline: true },
      { name: 'To', value: truncate(to, MAX_FIELD_LENGTH) || 'Unknown', inline: true },
    ],
    timestamp: date.toISOString(),
    footer: { text: 'via Cloudflare Email Routing' },
  };

  const usable = (attachments || [])
    .filter((a) => a.content && byteLength(a.content) <= MAX_ATTACHMENT_BYTES)
    .slice(0, MAX_ATTACHMENTS);

  if (attachments && attachments.length) {
    const listed = attachments
      .map((a) => `${a.filename || 'unnamed'} (${formatBytes(byteLength(a.content))})`)
      .join('\n');
    embed.fields.push({ name: `Attachments (${attachments.length})`, value: truncate(listed, 1024) });
  }

  const payload = { thread_name: truncate(subject, MAX_THREAD_NAME_LENGTH), embeds: [embed] };

  // Plain JSON post - no attachments to upload
  if (usable.length === 0) {
    return fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  // Multipart post - payload_json + files[0..n], per Discord's file upload spec
  payload.attachments = usable.map((a, i) => ({ id: i, filename: a.filename || `attachment-${i}` }));
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  usable.forEach((a, i) => {
    form.append(
      `files[${i}]`,
      new Blob([a.content], { type: a.mimeType || 'application/octet-stream' }),
      a.filename || `attachment-${i}`
    );
  });

  return fetch(webhookUrl, { method: 'POST', body: form });
}

async function postParseFailure(webhookUrl, message, err) {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_name: truncate(`Email from ${message.from}`, MAX_THREAD_NAME_LENGTH),
        content: `Got an email from **${message.from}** but couldn't parse it (\`${err.message}\`). Check the Worker logs.`,
      }),
    });
  } catch (_) {
    // Discord being down shouldn't break email delivery - fail quietly
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function byteLength(content) {
  if (!content) return 0;
  return content.byteLength ?? content.length ?? 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// postal-mime addresses look like { name, address } or a group { name, group: [...] }
function formatAddress(addr) {
  if (!addr) return '';
  if (Array.isArray(addr)) return addr.map(formatAddress).filter(Boolean).join(', ');
  if (addr.group) return addr.group.map(formatAddress).filter(Boolean).join(', ');
  const name = addr.name?.trim();
  const address = addr.address?.trim();
  if (name && address) return `${name} <${address}>`;
  return address || name || '';
}

// Discord embeds don't render HTML, so fall back to a plain-text rendering
// when an email has no text/plain part.
function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
