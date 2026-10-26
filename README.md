# Email → Discord Forum (Cloudflare Email Worker + HTTP APIs)

A small [Cloudflare Worker](https://workers.cloudflare.com/) with two independent entry points into the same script:

1. **`email()`** — a [Cloudflare Email Worker](https://developers.cloudflare.com/email-routing/email-workers/) that catches email sent to an address on your domain, parses it, and posts it as a new thread in a Discord **forum channel**. Optionally forwards a copy of the original email to a real inbox too.
2. **`fetch()`** — routes two JSON APIs by path:
   - `POST /api/contact` — a "contact me" form endpoint. Posts a thread to a *different* Discord forum channel, emails you a copy, and auto-replies to the sender.
   - `POST /api/send` — a generic, API-key-authenticated endpoint any of your other apps can call to send a real email through **Gmail's SMTP server**.

Built for `help@lbdev.app` (email in), `worker.lbdev.app/api/contact` (contact form in) and `worker.lbdev.app/api/send` (any app, out via Gmail) — Discord thread out, with copies landing in a normal inbox if you want them.

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
      │  POST /api/contact { name, email, subject, message }
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

### Send email API → Gmail SMTP

```
Any of your apps/services (backend only)
      │  POST /api/send
      │  Authorization: Bearer <SEND_EMAIL_API_KEY>
      │  { to, subject, text/html }
      ▼
this Worker's fetch() handler
      │
      ▼
handleSendEmail()
  1. checks the API key (constant-time compare)
  2. builds a MIME message
  3. SmtpClient opens a raw TCP socket to smtp.gmail.com:587
     EHLO → STARTTLS → (upgrade to TLS) → EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA
  4. authenticates as GMAIL_SMTP_USER with an App Password
```

There's no library doing this — Workers can't run a Node SMTP client like `nodemailer`, so `SmtpClient` is a minimal hand-rolled SMTP/RFC 5321 client built on Cloudflare's native [`cloudflare:sockets`](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) TCP API, which is exactly what Cloudflare recommends for this.

**This is the only endpoint in the project that isn't scoped to your own forms** — it's meant to be called from other backends you control, which is why it's the one place an API key is mandatory. See **Security** below before exposing it anywhere.

---

## Requirements

- A domain on Cloudflare with [Email Routing](https://developers.cloudflare.com/email-routing/) enabled.
- A Discord server with **forum channels** (this only works with forum channels — the webhook needs `thread_name` support). You can use the same forum for both flows, or two different ones.
- A **paid Workers plan** — the `/api/send` endpoint uses raw [TCP Sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), which aren't available on the free plan.
- A Google account with **2-Step Verification enabled** (required to generate an App Password for Gmail SMTP), if you want `/api/send`.
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

### 9. Set up the Gmail SMTP relay (for `/api/send`)

1. On the Gmail account you want to send from, turn on **2-Step Verification**: [myaccount.google.com/signinoptions/two-step-verification](https://myaccount.google.com/signinoptions/two-step-verification).
2. Generate an **App Password**: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). Give it a name like "lbdev worker", copy the 16-character password it gives you — this is **not** your normal Gmail password, and Google won't show it again.
3. Set the secrets:

```bash
wrangler secret put GMAIL_SMTP_USER             # the Gmail address itself, e.g. you@gmail.com
wrangler secret put GMAIL_SMTP_APP_PASSWORD     # the 16-character App Password from step 2
wrangler secret put SEND_EMAIL_API_KEY          # a random shared secret - generate one below
```

Generate a strong random key for `SEND_EMAIL_API_KEY`:

```bash
openssl rand -hex 32
```

Every caller of `/api/send` must send this key back as `Authorization: Bearer <key>`. Treat it like a password — store it in your other apps' own secret manager (env vars, a vault, etc.), never in client-side/browser code, and rotate it (`wrangler secret put SEND_EMAIL_API_KEY` again) if it's ever exposed.

4. Redeploy: `npm run deploy`.

---

## Contact form API

**`POST https://worker.lbdev.app/api/contact`**

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

CORS is handled automatically (including `OPTIONS` preflight) based on `CONTACT_FORM_ALLOWED_ORIGINS` below. This endpoint has no API key — it's meant to be hit directly from a public website's form.

---

## Send email API

**`POST https://worker.lbdev.app/api/send`**

Headers:

```
Content-Type: application/json
Authorization: Bearer <SEND_EMAIL_API_KEY>
```

Request body (JSON):

```json
{
  "to": "someone@example.com",
  "subject": "Deploy finished",
  "text": "The nightly build finished with no errors.",
  "fromName": "Build Bot",
  "replyTo": "you@lbdev.app"
}
```

| Field | Required | Notes |
|---|---|---|
| `to` | yes | A string, or an array of strings, for multiple recipients (max `MAX_SEND_EMAIL_RECIPIENTS`, default 10) |
| `subject` | yes | Plain text |
| `text` and/or `html` | at least one | Plain-text and/or HTML body |
| `fromName` | no | Display name on the "From" header — the address itself is always `GMAIL_SMTP_USER`, Gmail rejects attempts to spoof a different one |
| `replyTo` | no | Sets a `Reply-To` header |

Responses:

| Status | Meaning |
|---|---|
| `200 { "ok": true }` | Sent via Gmail SMTP |
| `400 { "error": "..." }` | Missing/invalid field, or too many recipients |
| `401 { "error": "Unauthorized" }` | Missing/incorrect `Authorization` header, or `SEND_EMAIL_API_KEY` isn't configured |
| `405 { "error": "Method not allowed" }` | Anything other than `POST`/`OPTIONS` |
| `502 { "error": "Failed to send email" }` | The SMTP conversation with Gmail failed — check `wrangler tail` for the real reason |

**Example (Node/any backend):**

```js
await fetch('https://worker.lbdev.app/api/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.LBDEV_SEND_EMAIL_API_KEY}`,
  },
  body: JSON.stringify({
    to: 'someone@example.com',
    subject: 'Hello from another app',
    text: 'This came through the Gmail SMTP relay.',
  }),
});
```

---

## Security

`/api/send` is deliberately the most locked-down endpoint in this project, because unlike `/api/contact` it isn't scoped to one form on one site — it's a general-purpose "send an email as me" capability.

- **Never call `/api/send` from browser/client-side JavaScript.** The `Authorization` header would be visible to anyone who opens dev tools, and `SEND_EMAIL_API_KEY` would effectively become public — turning this into an open relay anyone could use to send mail as your Gmail account. Only call it from code that runs on a server you control.
- **The API key is checked with a constant-time comparison** (`timingSafeEqual` in `worker.js`), not `===`, so a mistimed network attacker can't incrementally guess it character-by-character.
- **Use an App Password, never your real Gmail password.** App Passwords are scoped, revocable independently, and don't work if 2-Step Verification is later disabled — all strictly safer than your account password.
- **Rotate the key** if it's ever committed, logged, or shared somewhere it shouldn't be: `wrangler secret put SEND_EMAIL_API_KEY`.
- **"From" can't be spoofed.** The sender address is always `GMAIL_SMTP_USER` — Gmail enforces this at submission time, so `/api/send` can't be used to send mail *as* an arbitrary address, only *from* your own authenticated account.
- **Header injection is blocked.** `subject` and `fromName` (on both `/api/send` and `/api/contact`) are stripped of `\r\n` before being used in a MIME header, so a caller can't smuggle an extra header (e.g. a fake `Bcc:`) into an outgoing message.
- Consider adding a [Cloudflare Rate Limiting Rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on the `worker.lbdev.app/api/send` route if you're worried about a leaked key being used to send a high volume of mail — this project doesn't implement its own rate limiting.

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
| `GMAIL_SMTP_HOST` | `smtp.gmail.com` | Gmail's SMTP hostname |
| `GMAIL_SMTP_PORT` | `587` | STARTTLS port (not 465/implicit TLS) |
| `SMTP_EHLO_DOMAIN` | `lbdev.app` | Identifies this client in the EHLO greeting - cosmetic, doesn't need to resolve |
| `MAX_SEND_EMAIL_RECIPIENTS` | `10` | Max `to` addresses per `/api/send` request |
| `MAX_SEND_EMAIL_SUBJECT_LENGTH` | `256` | Truncation cap for `/api/send`'s `subject` |
| `MAX_SEND_EMAIL_BODY_LENGTH` | `100000` | Truncation cap for `/api/send`'s `text`/`html` body |

Edit these directly in `worker.js` and redeploy (`npm run deploy`) to apply changes.

---

## Local development

```bash
npm run dev
```

Runs the Worker locally via `wrangler dev`. Email Workers can't easily be triggered with a real inbound email locally — for quick iteration on the `email()` flow, it's usually faster to tweak logic, deploy, and send a real test email. The HTTP APIs work fine against `wrangler dev`:

```bash
curl -X POST http://localhost:8787/api/contact \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","email":"test@example.com","subject":"hi","message":"testing locally"}'

curl -X POST http://localhost:8787/api/send \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $SEND_EMAIL_API_KEY" \
  -d '{"to":"test@example.com","subject":"hi","text":"testing locally"}'
```

`/api/send` needs outbound TCP on port 587 to actually reach Gmail — if your local network blocks that (common on restrictive corporate/office networks), use `wrangler dev --remote` to run against real Cloudflare infrastructure instead of the local simulator.

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
- **`/api/send` returns `401 Unauthorized`** — the `Authorization: Bearer <key>` header is missing, wrong, or `SEND_EMAIL_API_KEY` isn't set on the Worker (`wrangler secret put SEND_EMAIL_API_KEY`).
- **`/api/send` returns `502 Failed to send email`** — check `wrangler tail` for the real SMTP error. Common causes: wrong App Password (regenerate it), 2-Step Verification got turned off (App Passwords stop working), or `GMAIL_SMTP_USER`/`GMAIL_SMTP_APP_PASSWORD` not set.
- **`/api/send` hangs or times out** — TCP Sockets need a paid Workers plan; on the free plan `connect()` will fail outright. Confirm your plan under the Cloudflare dashboard's Workers & Pages section.

---

## Tech stack

- [Cloudflare Workers](https://workers.cloudflare.com/) + [Email Routing](https://developers.cloudflare.com/email-routing/) (inbound email, outbound `send_email` binding)
- [Cloudflare TCP Sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) (`cloudflare:sockets`) for the raw SMTP connection to Gmail
- [`postal-mime`](https://www.npmjs.com/package/postal-mime) for MIME parsing
- [`mimetext`](https://www.npmjs.com/package/mimetext) for building outbound notification emails
- [Discord webhooks](https://discord.com/developers/docs/resources/webhook) (forum-thread creation via `thread_name`)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) for local dev / deploy
