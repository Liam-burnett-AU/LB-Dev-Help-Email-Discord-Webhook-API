# Email → Discord Forum (Cloudflare Email Worker)

A small [Cloudflare Email Worker](https://developers.cloudflare.com/email-routing/email-workers/) that catches email sent to an address on your domain, parses it, and posts it as a new thread in a Discord **forum channel** via that channel's webhook. Optionally forwards a copy of the original email to a real inbox at the same time.

Built for `help.lbdev.tech` — email in, Discord thread out, with a copy landing in a normal inbox if you want one.

---

## How it works

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

---

## Requirements

- A domain on Cloudflare with [Email Routing](https://developers.cloudflare.com/email-routing/) enabled.
- A Discord server with a **forum channel** (this only works with forum channels — the webhook needs `thread_name` support).
- [Node.js](https://nodejs.org/) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency below).

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Discord webhook on the target forum channel

In Discord: **Channel Settings → Integrations → Webhooks → New Webhook**, then copy the webhook URL.

> The webhook must be created *on the forum channel itself* — a webhook from a regular text channel won't support forum posts.

### 3. Set the webhook URL as a secret

Never commit the webhook URL — it's a secret, not a variable, and isn't stored in `wrangler.toml`.

```bash
wrangler secret put DISCORD_WEBHOOK_URL
```

Paste the webhook URL when prompted.

### 4. Deploy the Worker

```bash
npm run deploy
```

### 5. Point an email address at the Worker

Cloudflare dashboard → **Compute → Email Service → Email Routing → Routing Rules → Create routing rule**, then set the action to **Send to a Worker** and pick this Worker.

### 6. (Optional) Verify a forward-to address

If you want a copy of every email to also land in a real inbox, that address must be added **and verified** first:

**Compute → Email Service → Email Routing → Destination Addresses**

Forwarding to an unverified address throws an error — it's caught so it won't break anything, but the copy won't actually arrive until the address is verified.

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
| `FORWARD_TO_EMAIL` | `liamburnett40@gmail.com` | Where to forward a copy of the original email. Leave as `''` to skip forwarding and post to Discord only |

Edit these directly in `worker.js` and redeploy (`npm run deploy`) to apply changes.

---

## Local development

```bash
npm run dev
```

Runs the Worker locally via `wrangler dev`. Email Workers can't easily be triggered with a real inbound email locally — for quick iteration, it's usually faster to tweak logic, deploy, and send a real test email.

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

---

## Tech stack

- [Cloudflare Workers](https://workers.cloudflare.com/) + [Email Routing](https://developers.cloudflare.com/email-routing/)
- [`postal-mime`](https://www.npmjs.com/package/postal-mime) for MIME parsing
- [Discord webhooks](https://discord.com/developers/docs/resources/webhook) (forum-thread creation via `thread_name`)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) for local dev / deploy
