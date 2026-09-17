# Email → Discord Forum (Cloudflare Email Worker + Contact Form API)

A small [Cloudflare Worker](https://workers.cloudflare.com/) with two independent entry points into the same script:

1. **`email()`** — a [Cloudflare Email Worker](https://developers.cloudflare.com/email-routing/email-workers/) that catches email sent to an address on your domain, parses it, and posts it as a new thread in a Discord **forum channel**. Optionally forwards a copy of the original email to a real inbox too.
2. **`fetch()`** — a small JSON API for a "contact me" form. A `POST` with `{ name, email, subject, message }` posts a thread to a *different* Discord forum channel, and emails you a copy.

Built for `help@lbdev.app` (email in) and `worker.lbdev.app/api/*` (contact form in) — Discord thread out, with a copy landing in a normal inbox if you want one.

---

## How it works

### Email → Discord

```
Incoming email
      │
      ▼
Cloudflare Email Routing  ──►  this Worker's email() handler
                                        │
                        ┌───────────────┴───────────────┐
                        ▼                                ▼
              postToDiscord()                    forwardCopy()
              (parse with postal-mime,           (message.forward()
               build embed, POST to               to a verified
               Discord forum webhook)              destination address)
```

The two actions are independent — if Discord is unreachable or misconfigured, the email forward still happens (and vice versa). Nothing is ever bounced back to the sender because one branch failed.

**Per email, the Worker:**
1. Parses the raw MIME message with [`postal-mime`](https://www.npmjs.com/package/postal-mime).
2. Builds a Discord embed (subject, from, to, body, timestamp).
3. Falls back to a stripped-down plain-text rendering of the HTML body if there's no `text/plain` part.
4. Uploads small attachments as real Discord files (multipart), and lists any it skips.
5. Creates a new forum thread named after the subject line.
6. Forwards a copy of the original email to a real inbox, if configured.

### Contact form → Discord + email

```
Your website's contact form
      │  POST { name, email, subject, message }
      ▼
this Worker's fetch() handler
      │
      ┌───────────────┼───────────────────────┐
      ▼                ▼                       ▼
postContactToDiscord() sendContactNotification() sendAutoReply()
(POST to a SEPARATE   (build a MIME message,     (build a MIME message,
 Discord forum         send via send_email        send via send_email
 webhook)              to FORWARD_TO_EMAIL)       to the submitter's
                                                   own email address)
```

Same independence guarantee as the email flow — a Discord outage doesn't stop the notification email, and vice versa. The auto-reply is a courtesy on top and never affects the response status. The API responds `502` only if **both** the Discord post and your notification email fail.

---

## Requirements

- A domain on Cloudflare with [Email Routing](https://developers.cloudflare.com/email-routing/) enabled.
- A Discord server with **forum channels** (this only works with forum channels — the webhook needs `thread_name` support). You can use the same forum for both flows, or two different ones.
- [Node.js](https://nodejs.org/) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency below).

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the Discord webhook(s)

In Discord, on **each** forum channel you want posts to land in: **Channel Settings → Integrations → Webhooks → New Webhook**, then copy the webhook URL. You need one for email-in and, if you want it separate, another one for the contact form.

> The webhook must be created *on the forum channel itself* — a webhook from a regular text channel won't support forum posts.

### 3. Set the webhook URLs as secrets

Never commit webhook URLs — they're secrets, not variables, and aren't stored in `wrangler.toml`.

```bash
wrangler secret put DISCORD_WEBHOOK_URL           # email → Discord
wrangler secret put CONTACT_DISCORD_WEBHOOK_URL   # contact form → Discord
```

Paste the relevant webhook URL when prompted for each.

### 4. Add the send_email binding (needed for the contact form's email notification + auto-reply)

Already present in [`wrangler.toml`](./wrangler.toml):

```toml
[[send_email]]
name = "SEND_EMAIL"
```

This lets the Worker send email natively — no third-party email API or key needed.

> **Leave this binding unrestricted** — don't add `destination_address` or `allowed_destination_addresses` to it. The notification email only ever goes to your fixed `FORWARD_TO_EMAIL`, but the auto-reply goes to whatever email address each visitor typed into the form, so the binding needs to be able to send to arbitrary addresses.

### 5. Deploy the Worker

```bash
npm run deploy
```

### 6. Point an email address at the Worker (for the email → Discord flow)

Cloudflare dashboard → **Compute → Email Service → Email Routing → Routing Rules → Create routing rule**, then set the action to **Send to a Worker** and pick this Worker.

### 7. Verify the notify/forward-to address

`FORWARD_TO_EMAIL` in `worker.js` is used both to forward a copy of incoming emails **and** to email you contact-form submissions. Either way, it must be added **and verified** first:

**Compute → Email Service → Email Routing → Destination Addresses**

Sending/forwarding to an unverified address throws an error — it's caught so it won't break anything, but nothing will actually arrive until the address is verified.

### 8. Hook up the contact form API

The route is already declared in [`wrangler.toml`](./wrangler.toml):

```toml
[[routes]]
pattern = "worker.lbdev.app/api/*"
zone_name = "lbdev.app"
```

This requires `lbdev.app` to be an active zone on your Cloudflare account, with a DNS record for the `worker` hostname (even a dummy, proxied one — Workers Routes need a matching hostname to attach to). Once that's in place, `npm run deploy` wires it up automatically — no manual dashboard step needed. Then point your form's `fetch()`/`XMLHttpRequest` at it:

```js
await fetch('https://worker.lbdev.app/api/contact', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, email, subject, message }),
});
```

---

## Contact form API

**`POST https://worker.lbdev.app/api/contact`** (any path under `/api/*` works — it's a single endpoint, `/api/*` is just what's routed to this Worker)

Request body (JSON):

```json
{
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "subject": "project / collab / just saying hi",
  "message": "what's up?"
}
```

`name`, `email` and `message` are required; `subject` defaults to `(no subject)` if left blank. Responses:

| Status | Meaning |
|---|---|
| `200 { "ok": true }` | Delivered to Discord and/or email |
| `400 { "error": "..." }` | Missing/invalid field |
| `405 { "error": "Method not allowed" }` | Anything other than `POST`/`OPTIONS` |
| `502 { "error": "Failed to deliver message" }` | Both the Discord post and the email notification failed |

CORS is handled automatically (including `OPTIONS` preflight) based on `CONTACT_FORM_ALLOWED_ORIGINS` below.

---

## Configuration

All configuration lives at the top of [`worker.js`](./worker.js) — there's no separate config file.

| Constant | Default | Description |
|---|---|---|
| `EMBED_COLOR` | `0x28265c` | Discord embed side colour (hex, as a number) |
| `MAX_DESCRIPTION_LENGTH` | `3900` | Truncation cap for the embed body (Discord's hard limit is 4096) |
| `MAX_THREAD_NAME_LENGTH` | `100` | Truncation cap for the forum thread title (Discord's hard limit) |
| `MAX_FIELD_LENGTH` | `256` | Truncation cap for the `From` / `To` embed fields |
| `FORWARD_ATTACHMENTS` | `true` | Whether to upload attachments as real Discord files |
| `MAX_ATTACHMENT_BYTES` | `8 * 1024 * 1024` (8 MB) | Per-file size cap for attachments forwarded to Discord |
| `MAX_ATTACHMENTS` | `10` | Max number of attachments per message (Discord's hard cap) |
| `ALLOWED_RECIPIENTS` | `[]` | Restrict processing to specific `To:` addresses. Leave empty to process every address routed to this Worker |
| `FORWARD_TO_EMAIL` | `liamburnett40@gmail.com` | Where to forward a copy of incoming email, and where contact-form notifications are sent. Leave as `''` to skip both and only post to Discord |
| `MAX_CONTACT_NAME_LENGTH` | `100` | Truncation cap for the contact form's `name` field |
| `MAX_CONTACT_SUBJECT_LENGTH` | `100` | Truncation cap for the contact form's `subject` (reuses the forum title cap) |
| `MAX_CONTACT_MESSAGE_LENGTH` | `3900` | Truncation cap for the contact form's `message` (reuses the embed description cap) |
| `CONTACT_FORM_FROM_EMAIL` | `help@lbdev.app` | "From" address on notification + auto-reply emails. Must be on a domain you've enabled Email Routing for |
| `CONTACT_FORM_ALLOWED_ORIGINS` | `[]` | Origins allowed to call the API (CORS). Leave empty to allow any origin |
| `AUTO_REPLY_ENABLED` | `true` | Whether to email the form submitter a "message received" confirmation |
| `AUTO_REPLY_FROM_NAME` | `LB Dev` | Display name the auto-reply is sent from, and its sign-off |
| `AUTO_REPLY_SUBJECT` | `Thanks for reaching out - message received` | Subject line of the auto-reply |
| `AUTO_REPLY_TURNAROUND` | `2-3 business days` | Turnaround time quoted in the auto-reply body |

Edit these directly in `worker.js` and redeploy (`npm run deploy`) to apply changes.

---

## Local development

```bash
npm run dev
```

Runs the Worker locally via `wrangler dev`. Email Workers can't easily be triggered with a real inbound email locally — for quick iteration on the `email()` flow, it's usually faster to tweak logic, deploy, and send a real test email. The contact form API is a normal HTTP endpoint, so it works fine against `wrangler dev`:

```bash
curl -X POST http://localhost:8787/api/contact \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","email":"test@example.com","subject":"hi","message":"testing locally"}'
```

To watch live logs from the deployed Worker:

```bash
npm run tail
```

---

## Troubleshooting

- **Nothing shows up in Discord** — check `wrangler tail` for `Missing DISCORD_WEBHOOK_URL secret`. Confirm the secret is set with `wrangler secret put DISCORD_WEBHOOK_URL`.
- **Forward copy never arrives** — the destination address almost certainly isn't verified yet. Check logs for `not verified` and confirm it under Email Routing → Destination Addresses.
- **Email parse errors** — a malformed message still posts a fallback thread to Discord noting the parse failure, so you'll see it rather than silently losing the email.
- **Discord webhook 4xx/5xx** — logged via `console.error`, visible in `wrangler tail`. A 404 usually means the webhook was deleted or regenerated; recreate it and update the secret.
- **Contact form returns 502** — both delivery attempts failed; check `wrangler tail` for the two logged errors (one from `postContactToDiscord`, one from `sendContactNotification`).
- **Contact form email never arrives, but Discord post works** — check for `Missing SEND_EMAIL binding` (add `[[send_email]]` to `wrangler.toml` and redeploy) or a rejected "From" address (`CONTACT_FORM_FROM_EMAIL` must be on a domain you've enabled Email Routing for) or an unverified `FORWARD_TO_EMAIL` destination.
- **Contact form request blocked by CORS in the browser** — add your site's origin to `CONTACT_FORM_ALLOWED_ORIGINS`, or leave it empty to allow any origin.
- **Auto-reply never arrives** — check `wrangler tail` for `Contact form auto-reply failed`. If the binding has `destination_address`/`allowed_destination_addresses` set in `wrangler.toml`, remove it — the auto-reply needs to send to arbitrary visitor addresses. Set `AUTO_REPLY_ENABLED = false` to turn it off entirely.

---

## Tech stack

- [Cloudflare Workers](https://workers.cloudflare.com/) + [Email Routing](https://developers.cloudflare.com/email-routing/) (inbound email, outbound `send_email` binding)
- [`postal-mime`](https://www.npmjs.com/package/postal-mime) for MIME parsing
- [`mimetext`](https://www.npmjs.com/package/mimetext) for building outbound notification emails
- [Discord webhooks](https://discord.com/developers/docs/resources/webhook) (forum-thread creation via `thread_name`)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) for local dev / deploy
