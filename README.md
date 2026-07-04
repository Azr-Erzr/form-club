# Form - exercise club

**Live:** https://azr-erzr.github.io/form-club/ - open it on your phone, then
Share -> Add to Home Screen.

A mobile-only, zero-cost fitness PWA. Lives on GitHub Pages, reads its exercise
database from a Google Sheet, writes logs and profile/routine edits back through
Apps Script, and keeps a full offline copy on your phone.

```
Google Sheet  = database (shared with friends)
GitHub Pages  = host
Apps Script   = write-back endpoint
localStorage  = offline cache + unsynced queue
YouTube       = form videos (links/embeds only)
```

## Tabs

- **Today** - the day's workout, set counters, rest timer, form videos, pain guardrails, workout notes, and add-to-routine search
- **Library** - 950 searchable exercises with cues, regressions, progressions, machine/cable filters, and form videos
- **Run** - distance/time in, pace/speed out, friendly weekly comparison
- **Progress** - weekly stats, streak, push-up ladder, back-pain trend, club table

## Setup (once)

1. **Sheet** - open a new Google Sheet -> Extensions -> Apps Script -> paste
   `apps-script/Code.gs` -> run `setupSheet()` -> authorise. Tabs and seed data
   appear automatically (imported from this repo).
2. **Deploy** - Apps Script -> Deploy -> New deployment -> *Web app* ->
   Execute as **Me**, access **Anyone** -> copy the `/exec` URL.
3. **Share** - Sheet -> Share -> *Anyone with the link: Viewer*.
4. **Connect** - put the Sheet ID and `/exec` URL in `config.js` (club default)
   or per-device in the app's Settings.

## For friends

Open the GitHub Pages link on your phone -> Share -> **Add to Home Screen**.
Pick or add your profile in Settings. Your logs live on your device and, when
online, in the shared club sheet.

## Profiles and Routines

Workout plans are profile-specific: set `Workouts.UserName` to a profile name,
or use `Club` only for a shared template everyone should see. The app can add
new profiles from Settings and create a per-profile "Today" routine from the
Today screen. Those writes require the deployed Apps Script to include the
current `apps-script/Code.gs`.

## Sync Cadence

Phones retry queued writes every 30 seconds, refresh recent club logs every
2 minutes, and refresh plans/profiles every 10 minutes or when the app comes
back into focus. Apps Script de-dupes by `LogID`, `EntryID`, `UserName`,
`WorkoutID`, and `WorkoutDayID`, so flaky retries should not duplicate logs,
profiles, routines, or routine exercise rows.

## Sheet Scale

The original `Run_Log`, `Exercise_Log`, and `Journal` tabs stay in place as
legacy/backward-compatible tabs. New log writes go into monthly tabs like
`Run_Log_2026_07`, `Exercise_Log_2026_07`, and `Journal_2026_07`. The app
prefers the Apps Script `readLogs` endpoint, which returns a bounded recent
window instead of forcing phones to download every historical log row.

## Guardrails

- Pain 5/10 -> hold the level, no progression
- Pain 6+/10 -> warning + regression suggestion
- Red-flagged exercises hidden by default (Settings -> Back-safe)
- Minimum Day always available - consistency beats punishment

## Local Dev

Any static server works: `python -m http.server 8123` then open
`http://localhost:8123`. No build step, no dependencies.
