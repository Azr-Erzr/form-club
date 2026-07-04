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
- **Progress** - weekly stats, streak, push-up ladder, back-pain trend, club table, and PR comparison

## Workout Helpers

- Optional warm-up pill adds a simple full-body prep block to today's profile-owned routine.
- Daily pre-workout checklist tracks creatine, pre-workout, caffeine, protein, and supplements with a dated prep note.
- Gym Tools includes plate math and estimated 1RM calculators.
- If the same top set repeats for four sessions, a dismissible nudge suggests adding reps, weight, or a harder variation.
- Personal records are detected from completed set logs and shown in Progress as Today / Week / Overall PR comparisons.

## Device Features

- Rest timers use the screen wake lock when available, haptics when supported,
  and a short local chime if timer sound is enabled.
- AirPods/headset media controls are best-effort: while a timer or motion coach
  owns the browser media session, play/pause/stop-style controls may stop the
  timer or finish the motion set. iOS does not expose AirPods taps directly to a
  web app.
- Motion coach uses phone motion events after permission. It is meant for a
  phone in a pocket/armband during a set, not for a phone sitting on the floor.
- Quick Log supports speech recognition where the browser allows it, with a
  typed fallback such as `bench press 135 eight reps`.
- HealthKit, Apple Watch heart rate/workout sessions, and AirPods sensor data
  require native iOS/watchOS code and are intentionally out of scope for this
  PWA.

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

`Profile_Stats` tracks manual height, weight, resting heart rate, and notes over
time without needing Apple Health or another database.

Most logged rows include both the workout `Date` and an `UpdatedAt` timestamp.
Progress has a small time/history info view for last activity, active days,
daily prep timing, latest profile stats, and recent submission timestamps.

## Guardrails

- Pain 5/10 -> hold the level, no progression
- Pain 6+/10 -> warning + regression suggestion
- Red-flagged exercises hidden by default (Settings -> Back-safe)
- Minimum Day always available - consistency beats punishment

## Local Dev

Any static server works: `python -m http.server 8123` then open
`http://localhost:8123`. No build step, no dependencies.
