# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Deployment

This project deploys to **Vercel**. Every `git push` to `main` triggers an automatic redeployment (~30s). There is no local dev server — test changes by pushing and checking the live URL.

## Architecture

```
index.html        — entire frontend (vanilla HTML/CSS/JS, no framework, no build step)
api/check.js      — single Vercel serverless function (Node.js, ES modules)
package.json      — declares @anthropic-ai/sdk and @upstash/redis (used by api/ only)
vercel.json       — sets maxDuration: 30s for the function
```

**Request flow:**
1. Browser converts image to base64 and POSTs `{ image, mediaType, lang }` to `/api/check`
2. `api/check.js` validates input → checks IP rate limit (Upstash Redis) → runs Haiku bouncer → calls Sonnet for full rating
3. Claude returns strict JSON, passed straight back to the browser
4. Frontend animates score ring, category bars, and renders result with the submitted photo at the top

## Key constants (api/check.js)

- `DAILY_LIMIT` — max requests per IP per day (default: `20`)
- `MAX_BYTES` — max image size (default: `5MB`)
- Bouncer model: `claude-haiku-4-5-20251001` (cheap YES/NO outfit check before main call)
- Rating model: `claude-sonnet-4-20250514`

## Environment variables (set in Vercel dashboard only — never in code)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API access |
| `UPSTASH_REDIS_REST_URL` | Rate limit store |
| `UPSTASH_REDIS_REST_TOKEN` | Rate limit store auth |

## Rate limiting

Uses Upstash Redis with keys `ratelimit:{ip}:{YYYY-MM-DD}`, TTL 86400s. Counter increments before validation — rejected requests still count against the limit.

## Language toggle

Frontend has `lang` state (`'en'` | `'zh'`), toggled by EN/中文 buttons in the header. Passed in the POST body to `/api/check`. Backend appends a language instruction to `SYSTEM_PROMPT` before calling Sonnet — no separate translation step. The entire JSON response (verdict, roast, tips, category names/comments) comes back in the chosen language.

**Frontend i18n:** All interactive UI strings (tabs, buttons, upload labels, camera controls, loading messages, error messages, results section titles) live in a `UI_TEXT = { en: {...}, zh: {...} }` object in `index.html`. `setLang(l)` applies them to the DOM by element ID. Decorative/banner text (ticker, `h1`, badge, footer, `drip_scanner_9000.app`) stays in English regardless of lang. When adding new user-facing strings, add them to both `UI_TEXT.en` and `UI_TEXT.zh` and give the element an `id` so `setLang` can update it.

## Bouncer

Before the Sonnet call, a cheap Haiku call checks `"Does this image contain clothing or an outfit?"` with `max_tokens: 10`. Returns `YES`/`NO`. If NO → returns `{ error: "no_outfit" }` immediately. If the bouncer itself errors, the request is allowed through (fail open).

## Claude API response schema

System prompt instructs Claude to return strict JSON only (no markdown fences):
```json
{
  "score": 7.5,
  "verdict": "CERTIFIED DRIP",
  "verdictSub": "...",
  "emoji": "🔥",
  "categories": [
    { "name": "Colour Coordination", "score": 8, "comment": "..." },
    { "name": "Fit & Silhouette", "score": 7, "comment": "..." },
    { "name": "Drip Factor", "score": 8, "comment": "..." },
    { "name": "Originality", "score": 7, "comment": "..." }
  ],
  "roast": "...",
  "tips": ["...", "...", "..."]
}
```
If no outfit visible: `{ "error": "no_outfit" }`

## Frontend state (index.html)

Key JS state variables:
- `currentImage` — `{ base64, mediaType, dataUrl }` — set on file upload or camera capture
- `lang` — `'en'` | `'zh'` — drives both UI text and API response language
- `facingMode` — `'user'` (front) or `'environment'` (back) — toggled by flip button
- `stream` — active `MediaStream`, stopped on capture/reset

Camera notes:
- Front camera display is CSS-mirrored (`scaleX(-1)`); canvas draw is also mirrored so the saved image looks correct
- Back camera: no mirroring applied to either display or canvas
- Flip button appears only while camera is active, hidden after capture
