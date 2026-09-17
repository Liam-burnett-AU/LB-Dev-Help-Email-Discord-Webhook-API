/**
 * =========================================================================
 *  Email -> Discord Forum Post   (Cloudflare Email Worker + Contact API)
 * =========================================================================
 *  Two independent entry points into the same Worker:
 *
 *  1. email() - Cloudflare Email Routing calls this whenever mail arrives
 *     at an address you've pointed at this Worker. It parses the message
 *     with postal-mime, then creates a new post (thread) in a Discord
 *     forum channel via that channel's webhook.
 *
 *  2. fetch() - a small JSON API for a "contact me" form. A POST with
 *     { name, email, subject, message } creates a thread in a *different*
 *     Discord forum channel and emails you a copy, using Cloudflare's
 *     native send_email binding.
 *
 *  Full setup walkthrough is in README.md. Quick version:
 *    Email -> Discord:
 *      1. Create a webhook ON the target Discord forum channel.
 *      2. wrangler secret put DISCORD_WEBHOOK_URL
 *      3. Cloudflare dashboard -> Compute > Email Service > Email Routing >
 *         Routing Rules -> Create routing rule -> Action: Send to a Worker.
 *    Contact form API:
 *      1. Create a webhook ON a (probably different) Discord forum channel.
 *      2. wrangler secret put CONTACT_DISCORD_WEBHOOK_URL
 *      3. Add a [[send_email]] binding in wrangler.toml (see comments there).
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

// Only react to specific recipient address(es), e.g. ['notify@lbdev.tech'].
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
const CONTACT_FORM_FROM_EMAIL = 'contact@lbdev.tech';

// Origins allowed to call the API (CORS), e.g. ['https://lbdev.tech'].
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
    return handleContactForm(request, env);
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
  const subject = (typeof body.subject === 'string' ? body.subject.trim() : '') || '(no subject)';
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
