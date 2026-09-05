# RFL Standings — Season 1

Manual-entry standings site for the Revolutionary Football League. There is
**no more auto-reporting from an in-game bot** — every result and record is
entered by an admin through the admin panel in `index.html`.

## What changed from the old (basketball) version

- Persistence moved entirely to **Upstash Redis** (Supabase support removed).
- The old `/rpl/standings` POST auto-report endpoint now returns `410 Gone`
  instead of accepting scores — it's kept only so nothing silently 404s.
- Default roster seeded with all 32 **NFL teams** (real abbreviations, ESPN
  logos, and AFC/NFC conference split) so the admin panel is ready to use
  immediately — no need to manually add every team before your first game.
- All branding/copy updated to RFL, Season 1.

## Deploying the backend (`rpl_server.js`)

This is a long-running Node process (it holds SSE connections for live
updates), so it needs a host that runs Node continuously — **Render,
Railway, Fly.io, a VPS, etc. — not Vercel serverless functions.**

Environment variables to set on that host:

| Variable | Required | Notes |
|---|---|---|
| `ADMIN_SECRET` | **Yes** | The password you'll type into the site's admin panel. Pick something long/random. |
| `UPSTASH_REDIS_REST_URL` | Recommended | `https://hot-chamois-165243.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | Recommended | Your Upstash REST token |
| `PORT` | No | Defaults to 3000; most hosts set this for you |
| `RPL_SECRET` | No | Legacy, unused now that auto-report is disabled — safe to leave unset |

Without the Upstash variables the server still runs, but standings reset to
empty every time the process restarts — so set them.

## Deploying the frontend (`index.html`)

Static file, deploy anywhere (Vercel, Netlify, GitHub Pages, etc). Before
deploying, open `index.html` and update this line near the top of the
`<script>` block to point at wherever you deployed `rpl_server.js`:

```js
const CFG={API:'https://rflstandings.onrender.com/rpl/standings', ...}
```

## Using the admin panel

1. Open the site → click the admin/settings icon → enter your `ADMIN_SECRET`.
2. **Add Game** — enter the away/home team abbreviations, final score, and
   status. Records + standings update automatically.
3. **Team Override** — directly set any team's W/L/streak/logo if you need to
   correct something without adding a full game.
4. **Void / Remove** a game by its ID if it was entered by mistake.
5. **Zero Records** wipes every team back to 0-0 but keeps the roster/logos.
6. **Archive & Advance** snapshots the current season as a final-standings
   archive page, then wipes the board clean for the next season.

No other setup is needed — the 32 NFL teams are already seeded on first boot.
