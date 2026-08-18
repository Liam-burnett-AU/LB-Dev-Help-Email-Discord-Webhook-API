/**
 * =========================================================================
 *  Email -> Discord Forum Post   (Cloudflare Email Worker)
 * =========================================================================
 *  Cloudflare Email Routing calls email() below whenever mail arrives at
 *  an address you've pointed at this Worker. It parses the message with
 *  postal-mime, then creates a new post (thread) in a Discord forum
 *  channel via that channel's webhook.
 *
 *  Full setup walkthrough is in README.md. Quick version:
 *    1. Create a webhook ON the target Discord forum channel.
 *    2. wrangler secret put DISCORD_WEBHOOK_URL
 *    3. wrangler deploy
 *    4. Cloudflare dashboard -> Compute > Email Service > Email Routing >
 *       Routing Rules -> Create routing rule -> Action: Send to a Worker.
 * =========================================================================
 */

import PostalMime from 'postal-mime';

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

export default {
  async email(message, env, ctx) {
    if (ALLOWED_RECIPIENTS.length && !ALLOWED_RECIPIENTS.includes(message.to)) {
      return; // not an address we care about - ignore quietly
    }

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

    // We don't call message.forward() or message.setReject() - the email is
    // simply accepted and mirrored into Discord. Add a forward() call here
    // if you also want a copy to land in a real inbox.
  },
};

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