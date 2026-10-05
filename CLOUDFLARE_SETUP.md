# Maahi Instagram Worker — one-time Cloudflare setup

The repo is ready for Cloudflare Workers. The Worker reads Maahi's queue directly from this public GitHub repo, serves the queued JPEG to Instagram, publishes through the Instagram API, and stores idempotency/schedule state in Workers KV.

## 1. Create the Worker from this GitHub repo

In Cloudflare Dashboard: **Workers & Pages → Create → Import a repository** and choose `maahisen1996/maahi`.

Use the repository root. Cloudflare will detect `wrangler.jsonc` and deploy `worker/index.js`.

## 2. Create and bind KV

Create a Workers KV namespace named `maahi-instagram-state`.

Bind it to the Worker with binding name exactly:

`MAAHI_STATE`

## 3. Add variables/secrets

Add these Worker settings:

- `INSTAGRAM_ACCESS` — Secret. Use the same Instagram access token already used by the old GitHub workflow. Do not commit it to GitHub.
- `ADMIN_KEY` — Secret. Generate any long random string; it protects manual `/publish` and `/run` endpoints.
- `PUBLIC_BASE_URL` — Variable. Set this to the deployed Worker URL, e.g. `https://maahi-instagram-worker.<your-subdomain>.workers.dev`

`IG_USER_ID=17841424446542500` is already defined in `wrangler.jsonc`.

## 4. Cron

`wrangler.jsonc` already configures:

`*/15 * * * *`

Cloudflare invokes the Worker every 15 minutes. The Worker uses Pacific time internally and creates 1 post/day 70% of the time and 2 posts/day 30% of the time, with randomized windows of 10:00–14:00 and 18:00–21:30.

## 5. Test before turning it loose

Open:

`<PUBLIC_BASE_URL>/health`

It should return `ok: true`.

Then verify the queued image endpoint:

`<PUBLIC_BASE_URL>/image/02_cable_car_candid`

Finally, publish post 02 manually by opening:

`<PUBLIC_BASE_URL>/publish?post_id=02&key=<ADMIN_KEY>`

A successful response contains an Instagram `media_id`.

## Reliability behavior

- KV stores `posted:<post>` so scheduled retries do not republish completed posts.
- Before publishing, the Worker also checks the most recent Instagram media for an identical caption. This closes the crash window where Instagram succeeds but KV was not yet updated.
- A 15-minute lease prevents overlapping Worker invocations from racing on the same post.
- A failed run does not mark the post complete; the next scheduled invocation retries it.
- GitHub is only the content store; GitHub Actions runners are no longer required for scheduled posting.
