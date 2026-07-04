# Form — exercise club

**Live:** https://azr-erzr.github.io/form-club/ · open it on your phone →
Share → Add to Home Screen.

A mobile-only, zero-cost fitness PWA. Lives on GitHub Pages, reads its exercise
database from a Google Sheet, writes logs back through Apps Script, and keeps a
full offline copy on your phone.

```
Google Sheet  = database (shared with friends)
GitHub Pages  = host
Apps Script   = write-back endpoint
localStorage  = offline cache + unsynced queue
YouTube       = form videos (links/embeds only)
```

## Tabs

- **Today** — the day's workout, set counters, rest timer, form videos, pain guardrails
- **Library** — 115 searchable exercises with cues, regressions, progressions
- **Run** — distance/time in, pace/speed out, friendly weekly comparison
- **Progress** — weekly stats, streak, push-up ladder, back-pain trend, club table
- **Journal** — weight, sleep, energy, pain, mood, notes

## Setup (once)

1. **Sheet** — open a new Google Sheet → Extensions → Apps Script → paste
   `apps-script/Code.gs` → run `setupSheet()` → authorise. Tabs and seed data
   appear automatically (imported from this repo).
2. **Deploy** — Apps Script → Deploy → New deployment → *Web app* →
   Execute as **Me**, access **Anyone** → copy the `/exec` URL.
3. **Share** — Sheet → Share → *Anyone with the link: Viewer*.
4. **Connect** — put the Sheet ID and `/exec` URL in `config.js` (club default)
   or per-device in the app's Settings.

## For friends

Open the GitHub Pages link on your phone → Share → **Add to Home Screen**.
Set your display name in Settings. Your logs live on your device and (when
online) in the shared club sheet — display names only, nothing sensitive.

## Guardrails

- Pain 5/10 → hold the level, no progression
- Pain 6+/10 → warning + regression suggestion
- Red-flagged exercises hidden by default (Settings → Back-safe)
- Minimum Day always available — consistency beats punishment

## Local dev

Any static server works: `python -m http.server 8123` then open
`http://localhost:8123`. No build step, no dependencies.
