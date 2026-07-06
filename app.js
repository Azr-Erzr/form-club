/* ============================================================
   FORM — exercise club
   Vanilla JS, no build step. Google Sheet = database,
   Apps Script = write-back, localStorage = offline cache.
   ============================================================ */

(function () {
  'use strict';

  /* ---------------- config + storage ---------------- */

  const DEFAULTS = {
    sheetId: '', scriptUrl: '', user: 'Azhar', backSafe: true,
    timerSound: true, timerVibrate: true, motionCoach: true,
  };
  const DEFAULT_USERS = ['Azhar', 'Koby', 'Gianluca', 'Patrick', 'Adriano']
    .map(name => ({ UserName: name, DisplayName: name, Goal: '', TrainingLocation: '', ExperienceLevel: '', Active: 'Yes' }));
  const READ_REFRESH_MS = 2 * 60 * 1000;
  const CORE_REFRESH_MS = 10 * 60 * 1000;
  const WRITE_RETRY_MS = 30 * 1000;
  const FOCUS_REFRESH_MS = 45 * 1000;
  const LOG_READ_DAYS = 180;
  const WARMUP_BLOCK = [
    ['EX0014', '1 min', 0, 'Easy pulse raiser'],
    ['FE_Arm_Circles', '30 sec', 15, 'Shoulders easy'],
    ['EX0013', '8 reps', 15, 'Spine through comfortable range'],
    ['EX0005', '10 reps', 30, 'Warm squat pattern'],
    ['EX0008', '10 reps', 30, 'Glutes on'],
    ['EX0021', '30 sec/side', 15, 'Hips open'],
    ['FE_Hamstring_Stretch', '30 sec/side', 15, 'Easy hamstrings'],
    ['FE_Calf_Stretch_Elbows_Against_Wall', '30 sec/side', 15, 'Ankles and calves'],
  ];
  const PREP_ITEMS = [
    ['creatine', 'Creatine'],
    ['preworkout', 'Pre-workout'],
    ['caffeine', 'Caffeine'],
    ['protein', 'Protein shake'],
    ['vitamins', 'Vitamins / supplements'],
  ];

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('ef_settings') || '{}'); } catch (e) {}
    return Object.assign({}, DEFAULTS, window.APP_CONFIG || {}, s);
  }
  function saveSettings(patch) {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('ef_settings') || '{}'); } catch (e) {}
    Object.assign(s, patch);
    localStorage.setItem('ef_settings', JSON.stringify(s));
    CFG = loadSettings();
  }

  let CFG = loadSettings();
  let syncTimersStarted = false;

  function lsGet(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
  }
  function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  /* ---------------- utils ---------------- */

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const TABS = ['today', 'library', 'run', 'progress'];

  function initialTab() {
    const h = String(location.hash || '').replace('#', '').toLowerCase();
    return TABS.includes(h) ? h : 'today';
  }

  function markRuntimeClasses() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    document.documentElement.classList.toggle('standalone', !!standalone);
    document.documentElement.classList.toggle('ios', /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function todayStr(d) {
    const t = d || new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }
  function niceDate(d) {
    return (d || new Date()).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }
  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    if (isNaN(d)) return String(iso).slice(0, 10);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function uid(prefix) {
    return prefix + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  }
  function compactId(s) {
    return String(s || '').trim().replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  }
  function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
  function weekStart() {
    const d = new Date(); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day);
    return todayStr(d);
  }

  function parseCSV(text) {
    const rows = []; let row = []; let cur = ''; let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    if (!rows.length) return [];
    const head = rows[0].map(h => h.trim());
    return rows.slice(1).filter(r => r.some(v => v && v.trim() !== '')).map(r => {
      const o = {};
      head.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
      return o;
    });
  }

  function videoIdOf(ex) {
    if (ex.YouTubeVideoID) return ex.YouTubeVideoID.trim();
    const url = ex.PreferredVideoURL || ex.EmbedURL || '';
    const m = String(url).match(/(?:embed\/|watch\?v=|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : '';
  }

  /* privacy-friendly player that stays inside the PWA on iOS */
  function embedUrl(vid) {
    return 'https://www.youtube-nocookie.com/embed/' + vid + '?playsinline=1&rel=0';
  }

  /* anatomical focus diagram: silhouette + muscle patches in the card colorway */
  const BODY_SIL =
    '<g class="sil">' +
      '<circle cx="60" cy="21" r="12.5"/>' +
      '<path d="M44 38 Q60 33 76 38 L80 52 Q83 68 78 86 L76 108 Q75 116 72 118 L48 118 Q45 116 44 108 L42 86 Q37 68 40 52 Z"/>' +
      '<path d="M40 44 Q30 52 28 72 L26 100 Q26 107 29 113" stroke-width="11" fill="none" stroke-linecap="round"/>' +
      '<path d="M80 44 Q90 52 92 72 L94 100 Q94 107 91 113" stroke-width="11" fill="none" stroke-linecap="round"/>' +
      '<path d="M51 118 L48 152 Q47 168 49 186" stroke-width="14" fill="none" stroke-linecap="round"/>' +
      '<path d="M69 118 L72 152 Q73 168 71 186" stroke-width="14" fill="none" stroke-linecap="round"/>' +
    '</g>';
  /* [cx, cy, rx, ry] ellipses on the front-view silhouette */
  const MUSCLE_PATCHES = {
    chest: [[51, 57, 8.5, 6.5], [69, 57, 8.5, 6.5]],
    shoulders: [[40, 45, 6, 5], [80, 45, 6, 5]],
    traps: [[60, 43, 15, 5.5]],
    neck: [[60, 34, 7, 4]],
    biceps: [[31, 67, 4.5, 9], [89, 67, 4.5, 9]],
    triceps: [[30, 71, 4.5, 9], [90, 71, 4.5, 9]],
    forearms: [[27.5, 99, 4.5, 12], [92.5, 99, 4.5, 12]],
    core: [[60, 94, 9, 12]],
    obliques: [[48, 92, 4, 10], [72, 92, 4, 10]],
    back: [[60, 72, 14, 17]],
    lats: [[45, 78, 5, 14], [75, 78, 5, 14]],
    lowerback: [[60, 106, 10, 7]],
    glutes: [[60, 116, 13, 8]],
    quads: [[50, 143, 6.5, 16], [70, 143, 6.5, 16]],
    hamstrings: [[50, 150, 6, 14], [70, 150, 6, 14]],
    adductors: [[55, 138, 4, 12], [65, 138, 4, 12]],
    abductors: [[45, 132, 4, 11], [75, 132, 4, 11]],
    calves: [[48.5, 172, 5, 11], [71.5, 172, 5, 11]],
  };
  const MUSCLE_KEYS = [
    ['quadricep', 'quads'], ['quad', 'quads'], ['glute', 'glutes'], ['hamstring', 'hamstrings'],
    ['calf', 'calves'], ['calv', 'calves'], ['pector', 'chest'], ['chest', 'chest'],
    ['delt', 'shoulders'], ['shoulder', 'shoulders'], ['trap', 'traps'], ['neck', 'neck'],
    ['bicep', 'biceps'], ['tricep', 'triceps'], ['forearm', 'forearms'], ['grip', 'forearms'],
    ['wrist', 'forearms'], ['abdominal', 'core'], ['abs', 'core'], ['core', 'core'],
    ['oblique', 'obliques'], ['lower back', 'lowerback'], ['low back', 'lowerback'],
    ['lat', 'lats'], ['middle back', 'back'], ['upper back', 'back'], ['rhomboid', 'back'],
    ['back', 'back'], ['adductor', 'adductors'], ['abductor', 'abductors'],
    ['hip', 'glutes'], ['leg', 'quads'], ['full body', 'core'],
  ];
  function figSvg(ex) {
    const txt = String(ex.PrimaryMuscles || '').toLowerCase();
    const found = new Set();
    MUSCLE_KEYS.forEach(([kw, patch]) => { if (txt.includes(kw)) found.add(patch); });
    let patches = '';
    found.forEach((p) => {
      (MUSCLE_PATCHES[p] || []).forEach(([cx, cy, rx, ry]) => {
        patches += '<ellipse class="mus" cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '"/>';
      });
    });
    return '<div class="fig"><svg class="body" viewBox="0 0 120 200" aria-hidden="true">' +
      BODY_SIL + patches + '</svg><div class="tiles"></div></div>';
  }

  const IMG_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';
  function imagesOf(ex) {
    return String(ex.Images || '').split('|').filter(Boolean).map(p => IMG_BASE + p);
  }

  /* ---------------- data layer ---------------- */

  const state = {
    tab: initialTab(),
    exercises: [], workouts: [], days: [], users: DEFAULT_USERS.slice(),
    remote: { runs: [], sets: [], journal: [], profileStats: [], loaded: false },
    source: 'local',
    lib: { q: '', cat: 'All', place: 'All', diff: 'All' },
    routine: { q: '' },
    workoutId: null,
    restEnd: 0, restTimer: null,
    audioCtx: null, wakeLock: null, mediaSessionMode: '',
    motion: { active: false, exId: '', wdId: '', reps: 0, lastPeakAt: 0, lastCueAt: 0, avgTempo: 0, samples: [] },
    voiceDraft: null,
    voice: { listening: false, recognition: null },
    sync: { reading: false, writing: false, lastReadAt: 0, lastWriteAt: 0, lastCoreAt: 0, lastError: '' },
    scheduleEdit: false,
    scheduleDragId: '',
  };

  function currentUser() { return (CFG.user || 'Azhar').trim() || 'Azhar'; }
  function userKey(name) { return String(name || 'Azhar').replace(/[^\w-]+/g, '_'); }
  function todayWorkoutId() { return 'DAY_' + compactId(currentUser() || 'USER') + '_' + todayStr().replace(/-/g, ''); }
  function isTodayWorkout(id) { return id === todayWorkoutId(); }
  function normalizeUserRows(rows) {
    const seen = new Set();
    return (rows && rows.length ? rows : DEFAULT_USERS).concat(DEFAULT_USERS).filter(u => {
      const name = String(u.UserName || u.DisplayName || '').trim();
      if (!name || seen.has(name)) return false;
      seen.add(name);
      u.UserName = name;
      u.DisplayName = String(u.DisplayName || name).trim();
      u.Active = u.Active || 'Yes';
      return String(u.Active).toLowerCase() !== 'no';
    });
  }
  function displayNameFor(name) {
    const u = state.users.find(x => x.UserName === name);
    return (u && u.DisplayName) || name || 'Azhar';
  }
  function switchProfile(userName, opts) {
    const name = String(userName || '').trim() || 'Azhar';
    if (name === currentUser()) return false;
    stopRest();
    stopMotionSet(false);
    stopVoiceInput(false);
    saveSettings({ user: name });
    state.workoutId = null;
    updateProfileBadge();
    closeModal();
    if (opts && opts.toast !== false) toast('Switched to ' + displayNameFor(name) + '.', 'user-round');
    render();
    refreshRemoteLogs(false);
    return true;
  }
  function workoutOwner(w) {
    return String(w.UserName || w.Profile || w.Owner || w.OwnerUserName || '').trim();
  }
  function workoutSortValue(w) {
    const n = Number(w.SortOrder || w.ScheduleOrder || w.Order || 0);
    return isFinite(n) && n > 0 ? n : 9999;
  }
  function scheduleOrderKey(name) { return 'ef_schedule_order_' + userKey(name || currentUser()); }
  function profileOrder(name) { return lsGet(scheduleOrderKey(name || currentUser()), []); }
  function setProfileOrder(ids, name) { lsSet(scheduleOrderKey(name || currentUser()), ids.filter(Boolean)); }
  function profileWorkouts() {
    const me = currentUser();
    const order = profileOrder(me);
    const orderIndex = new Map(order.map((id, i) => [id, i]));
    const seen = new Set();
    return state.workouts.filter(w => {
      if (String(w.Active || 'Yes').toLowerCase() === 'no') return false;
      const owner = workoutOwner(w);
      const shared = ['club', 'shared', 'all'].includes(owner.toLowerCase());
      return shared || owner === me || (!owner && me === 'Azhar');
    }).filter(w => {
      const id = String(w.WorkoutID || '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).sort((a, b) => {
      const ai = orderIndex.has(a.WorkoutID) ? orderIndex.get(a.WorkoutID) : workoutSortValue(a);
      const bi = orderIndex.has(b.WorkoutID) ? orderIndex.get(b.WorkoutID) : workoutSortValue(b);
      return ai - bi || String(a.WorkoutName || '').localeCompare(String(b.WorkoutName || ''));
    });
  }
  function updateProfileBadge() {
    const el = $('#profileName');
    if (el) el.textContent = displayNameFor(currentUser());
  }
  function timeAgo(ts) {
    if (!ts) return 'not yet';
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + ' sec ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    return Math.round(m / 60) + ' hr ago';
  }

  function sheetCsvUrl(tab) {
    return 'https://docs.google.com/spreadsheets/d/' + CFG.sheetId +
      '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(tab);
  }

  function scriptReadUrl(params) {
    const url = new URL(CFG.scriptUrl);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    url.searchParams.set('_', Date.now());
    return url.toString();
  }

  async function fetchScriptJson(params) {
    if (!CFG.scriptUrl) return null;
    const r = await fetch(scriptReadUrl(params), { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j && j.ok ? j : null;
  }

  async function fetchBoundedLogs() {
    const j = await fetchScriptJson({ action: 'readLogs', days: LOG_READ_DAYS });
    if (!j || !Array.isArray(j.runs) || !Array.isArray(j.sets) || !Array.isArray(j.journal)) return null;
    return { runs: j.runs, sets: j.sets, journal: j.journal, profileStats: Array.isArray(j.profileStats) ? j.profileStats : [], since: j.since };
  }

  async function fetchTable(tab, localFile) {
    if (CFG.sheetId) {
      try {
        const r = await fetch(sheetCsvUrl(tab), { cache: 'no-store' });
        if (r.ok) {
          const rows = parseCSV(await r.text());
          if (rows.length) { state.source = 'sheet'; return rows; }
        }
      } catch (e) { /* fall through to local */ }
    }
    if (localFile) {
      try {
        const r = await fetch(localFile);
        if (r.ok) return parseCSV(await r.text());
      } catch (e) {}
    }
    return [];
  }

  async function loadLocalCsv(file) {
    try {
      const r = await fetch(file);
      if (r.ok) return parseCSV(await r.text());
    } catch (e) {}
    return [];
  }

  async function loadCore() {
    /* Exercises ship with the app (950 rows — too heavy to pull from the
       sheet each open); workouts and logs stay live from the sheet. */
    const [ex, w, d, users] = await Promise.all([
      loadLocalCsv('data/exercises.csv'),
      fetchTable('Workouts', 'data/workouts.csv'),
      fetchTable('Workout_Days', 'data/workout_days.csv'),
      fetchTable('Users'),
    ]);
    state.exercises = ex.length ? ex : await fetchTable('Exercises');
    state.workouts = w.filter(x => (x.Active || 'Yes') !== 'No'); state.days = d;
    state.users = normalizeUserRows(users);
    state.sync.lastCoreAt = Date.now();
  }

  async function loadRemoteLogs() {
    if (!CFG.sheetId && !CFG.scriptUrl) { state.remote.loaded = true; return false; }
    try {
      const bounded = await fetchBoundedLogs();
      if (bounded) {
        state.remote = { runs: bounded.runs, sets: bounded.sets, journal: bounded.journal, profileStats: bounded.profileStats, loaded: true };
      } else {
        const [runs, sets, journal, profileStats] = await Promise.all([
          fetchTable('Run_Log'), fetchTable('Exercise_Log'), fetchTable('Journal'), fetchTable('Profile_Stats'),
        ]);
        state.remote = { runs, sets, journal, profileStats, loaded: true };
      }
      state.sync.lastReadAt = Date.now();
      state.sync.lastError = '';
      updateSyncBadge();
      return true;
    } catch (e) {
      state.remote.loaded = true;
      state.sync.lastError = 'Read failed';
      updateSyncBadge();
      return false;
    }
  }

  function exById(id) { return state.exercises.find(e => e.ExerciseID === id); }

  /* merged views of logs: local first, then remote rows we didn't write ourselves */
  function mergedLogs(localKey, remoteRows, idField) {
    const local = lsGet(localKey, []);
    const ids = new Set(local.map(l => l[idField]));
    return local.concat((remoteRows || []).filter(r => r[idField] && !ids.has(r[idField])));
  }
  const allRuns = () => mergedLogs('ef_runlogs', state.remote.runs, 'LogID');
  const allSets = () => mergedLogs('ef_setlogs', state.remote.sets, 'LogID');
  const allJournal = () => mergedLogs('ef_journal', state.remote.journal, 'EntryID');
  const allProfileStats = () => mergedLogs('ef_profile_stats', state.remote.profileStats, 'StatID');

  /* ---------------- write-back + queue ---------------- */

  function queue() { return lsGet('ef_queue', []); }
  function normalizeQueueItem(item) {
    return {
      action: item.action,
      payload: item.payload || {},
      queuedAt: item.queuedAt || new Date().toISOString(),
      attempts: Number(item.attempts || 0),
      lastAttemptAt: item.lastAttemptAt || '',
      lastError: item.lastError || '',
    };
  }
  function itemId(item) {
    const p = (item && item.payload) || {};
    return item.action + ':' + (p.LogID || p.EntryID || p.WorkoutDayID || p.WorkoutID || p.UserName || p.id || JSON.stringify(p));
  }
  function dedupeQueue(q) {
    const seen = new Set();
    return (q || []).filter(item => {
      const id = itemId(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).map(normalizeQueueItem);
  }
  function setQueue(q) { lsSet('ef_queue', dedupeQueue(q)); updateSyncBadge(); }
  function enqueue(action, payload, error) {
    const next = normalizeQueueItem({ action, payload });
    next.lastError = error || '';
    setQueue(queue().concat([next]));
  }

  async function writeItem(item, timeoutMs) {
    const controller = window.AbortController ? new AbortController() : null;
    const t = controller ? setTimeout(() => controller.abort(), timeoutMs || 14000) : null;
    try {
      const r = await fetch(CFG.scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: item.action, payload: item.payload || {} }),
        signal: controller ? controller.signal : undefined,
      });
      const text = await r.text();
      let j = {};
      try { j = text ? JSON.parse(text) : {}; } catch (e) { throw new Error('Server returned non-JSON response'); }
      if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    } finally {
      if (t) clearTimeout(t);
    }
  }

  async function post(action, payload) {
    if (!CFG.scriptUrl) { enqueue(action, payload, 'Missing Apps Script URL'); return false; }
    try {
      await writeItem({ action, payload }, 14000);
      state.sync.lastWriteAt = Date.now();
      state.sync.lastError = '';
      updateSyncBadge();
      setTimeout(() => refreshRemoteLogs(false), 1500);
      return true;
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? 'Write timed out' : (e && e.message ? e.message : 'Write failed');
      enqueue(action, payload, msg);
      state.sync.lastError = msg;
      updateSyncBadge();
      return false;
    }
  }

  async function syncQueue(showToast) {
    if (state.sync.writing) return false;
    const q = queue();
    if (!q.length) { if (showToast) toast('Everything is synced.', 'check-circle-2'); updateSyncBadge(); return true; }
    if (!CFG.scriptUrl) { if (showToast) toast('Add your Apps Script URL in settings first.', 'plug-zap', true); return false; }
    state.sync.writing = true;
    updateSyncBadge();
    let remaining = [];
    try {
      for (const item of q) {
        const next = normalizeQueueItem(item);
        next.attempts += 1;
        next.lastAttemptAt = new Date().toISOString();
        try {
          await writeItem(next, 14000);
        } catch (e) {
          next.lastError = e && e.name === 'AbortError' ? 'Write timed out' : (e && e.message ? e.message : 'Write failed');
          remaining.push(next);
        }
      }
    } finally {
      state.sync.writing = false;
    }
    setQueue(remaining);
    if (remaining.length) state.sync.lastError = remaining[0].action + ': ' + (remaining[0].lastError || 'Write retry pending');
    else { state.sync.lastWriteAt = Date.now(); state.sync.lastError = ''; setTimeout(() => refreshRemoteLogs(false), 1200); }
    if (showToast) {
      if (remaining.length) toast(remaining.length + ' writes still queued: ' + (remaining[0].lastError || 'will retry'), 'cloud-off', true);
      else toast('All logs synced to the club sheet.', 'check-circle-2');
    }
    return remaining.length === 0;
  }

  async function refreshRemoteLogs(showToast) {
    if (state.sync.reading) return false;
    state.sync.reading = true;
    updateSyncBadge();
    const ok = await loadRemoteLogs();
    state.sync.reading = false;
    updateSyncBadge();
    if (ok && ['today', 'run', 'progress'].includes(state.tab)) render();
    if (showToast) toast(ok ? 'Club data refreshed.' : 'Could not refresh club data.', ok ? 'refresh-cw' : 'cloud-off', !ok);
    return ok;
  }

  async function refreshCoreData(showToast) {
    await loadCore();
    if (!profileWorkouts().some(w => w.WorkoutID === state.workoutId)) state.workoutId = null;
    render();
    if (showToast) toast('Plans and profiles refreshed.', 'refresh-cw');
  }

  async function fullSync(showToast) {
    const wrote = await syncQueue(showToast);
    if (wrote) await refreshRemoteLogs(false);
    if (Date.now() - state.sync.lastCoreAt > FOCUS_REFRESH_MS) await refreshCoreData(false);
  }

  function beaconQueue() {
    if (!CFG.scriptUrl || !navigator.sendBeacon) return;
    queue().forEach(item => {
      try {
        navigator.sendBeacon(CFG.scriptUrl, new Blob([JSON.stringify(item)], { type: 'text/plain;charset=utf-8' }));
      } catch (e) {}
    });
  }

  function updateSyncBadge() {
    const n = queue().length;
    const b = $('#syncBadge');
    if (b) { b.hidden = n === 0 && !state.sync.reading && !state.sync.writing; b.textContent = n || '•'; }
    const btn = $('#syncBtn');
    if (btn) {
      btn.classList.toggle('synced', n === 0 && !!CFG.scriptUrl && !state.sync.lastError);
      btn.classList.toggle('busy', state.sync.reading || state.sync.writing);
      btn.title = n ? n + ' queued' + (state.sync.lastError ? ' - ' + state.sync.lastError : '') : 'Last read ' + timeAgo(state.sync.lastReadAt);
    }
    try {
      if (navigator.setAppBadge && navigator.clearAppBadge) {
        if (n) navigator.setAppBadge(n);
        else navigator.clearAppBadge();
      }
    } catch (e) {}
  }

  /* ---------------- toasts ---------------- */

  function toast(msg, icon, warn) {
    const el = document.createElement('div');
    el.className = 'toast' + (warn ? ' warn' : '');
    el.innerHTML = '<i data-lucide="' + (icon || 'info') + '"></i><div>' + esc(msg) + '</div>';
    $('#toasts').appendChild(el);
    lucide.createIcons({ nodes: [el] });
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, 3400);
    setTimeout(() => el.remove(), 3800);
  }

  /* ---------------- device helpers ---------------- */

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return false;
    try {
      if (state.wakeLock) return true;
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
      return true;
    } catch (e) { return false; }
  }
  async function releaseWakeLock() {
    try {
      if (state.wakeLock) await state.wakeLock.release();
    } catch (e) {}
    state.wakeLock = null;
  }
  function vibrate(pattern) {
    if (CFG.timerVibrate && navigator.vibrate) navigator.vibrate(pattern);
  }
  function ensureAudio() {
    if (!CFG.timerSound) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!state.audioCtx) state.audioCtx = new AC();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
    return state.audioCtx;
  }
  function playTone(type) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = type === 'cue' ? [660] : [523, 659, 784];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.08, now + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.13);
    });
  }
  function setupMediaSession(mode, title) {
    if (!('mediaSession' in navigator)) return;
    state.mediaSessionMode = mode || '';
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title || 'Form timer',
        artist: 'Form exercise club',
        album: mode === 'rest' ? 'Rest timer' : 'Set coach',
      });
      const stop = () => {
        if (state.mediaSessionMode === 'rest') stopRest(true);
        else if (state.mediaSessionMode === 'motion') finishMotionSet();
      };
      ['pause', 'stop', 'previoustrack', 'nexttrack'].forEach(action => {
        try { navigator.mediaSession.setActionHandler(action, stop); } catch (e) {}
      });
      try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
    } catch (e) {}
  }
  function clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    state.mediaSessionMode = '';
    try {
      ['pause', 'stop', 'previoustrack', 'nexttrack'].forEach(action => {
        try { navigator.mediaSession.setActionHandler(action, null); } catch (e) {}
      });
      navigator.mediaSession.playbackState = 'none';
    } catch (e) {}
  }

  /* ---------------- modal ---------------- */

  function openModal(html) {
    $('#modalSheet').innerHTML = '<button class="sheet-handle" data-action="close-modal" aria-label="Close sheet"></button>' + html;
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';
    lucide.createIcons({ nodes: [$('#modalSheet')] });
  }
  function closeModal() {
    stopVoiceInput(false);
    $('#modal').hidden = true;
    $('#modalSheet').innerHTML = '';
    $('#modalSheet').style.transform = '';
    document.body.style.overflow = '';
  }

  /* ---------------- rest timer ---------------- */

  function startRest(seconds, label) {
    ensureAudio();
    requestWakeLock();
    state.restEnd = Date.now() + seconds * 1000;
    state.restLabel = label || 'rest';
    $('.restbar-label').textContent = state.restLabel;
    $('#restbar').hidden = false;
    setupMediaSession('rest', state.restLabel === 'walk' ? 'Walk timer' : 'Rest timer');
    if (state.restTimer) clearInterval(state.restTimer);
    state.restTimer = setInterval(tickRest, 250);
    tickRest();
  }
  function tickRest() {
    const left = Math.max(0, Math.ceil((state.restEnd - Date.now()) / 1000));
    const m = Math.floor(left / 60), s = left % 60;
    $('#restTime').textContent = m + ':' + String(s).padStart(2, '0');
    if (left <= 0) {
      stopRest();
      playTone('done');
      vibrate([140, 70, 140, 70, 220]);
      toast(state.restLabel === 'walk' ? 'Walk done — log it in the Run tab.' : 'Rest is over — next set.', 'timer');
    }
  }
  function stopRest(fromRemote) {
    if (state.restTimer) clearInterval(state.restTimer);
    state.restTimer = null;
    $('#restbar').hidden = true;
    clearMediaSession();
    releaseWakeLock();
    if (fromRemote) toast('Timer stopped from audio controls.', 'headphones');
  }

  /* ---------------- session (Today) ---------------- */

  function sessionKey(wid) { return 'ef_session_' + userKey(currentUser()) + '_' + todayStr() + '_' + wid; }
  function getSession(wid) { return lsGet(sessionKey(wid), { sets: {}, details: {} }); }
  function setSession(wid, sess) { lsSet(sessionKey(wid), sess); }
  function prepKey(date) { return 'ef_prep_' + userKey(currentUser()) + '_' + (date || todayStr()); }
  function getPrep(date) { return lsGet(prepKey(date), { items: {}, updatedAt: '' }); }
  function setPrep(prep, date) { lsSet(prepKey(date), prep); }

  function suggestedWorkoutId() {
    const mine = profileWorkouts();
    const dow = new Date().getDay(); // 0 Sun
    const map = { 1: 'HOME_A', 2: 'MIN_DAY', 3: 'HOME_B', 4: 'BACK_RESET', 5: 'HOME_A', 6: 'HOME_B', 0: 'MIN_DAY' };
    const id = map[dow];
    return mine.some(w => w.WorkoutID === id) ? id : (mine[0] || {}).WorkoutID;
  }

  function repsDefault(target) {
    const m = String(target || '').match(/(\d+)/g);
    if (!m) return 10;
    return m.length > 1 ? Number(m[1]) : Number(m[0]);
  }

  /* progression: completed >= target sets on 2+ separate days with pain <= 4 */
  function progressionReady(exId, targetSets) {
    const sets = allSets().filter(s => s.UserName === currentUser() && s.ExerciseID === exId && s.Completed);
    const byDate = {};
    sets.forEach(s => {
      byDate[s.Date] = byDate[s.Date] || { n: 0, pain: 0 };
      byDate[s.Date].n++;
      byDate[s.Date].pain = Math.max(byDate[s.Date].pain, Number(s.Pain_0_10 || 0));
    });
    const good = Object.values(byDate).filter(d => d.n >= (Number(targetSets) || 2) && d.pain <= 4);
    return good.length >= 2;
  }

  function setScore(s) {
    const w = Number(s.Weight_lb || 0);
    const r = Number(s.ActualReps || 0);
    if (w > 0 && r > 0) return w * (1 + r / 30);
    return r;
  }

  function formatSetLine(s) {
    if (!s) return '-';
    const w = Number(s.Weight_lb || 0), r = Number(s.ActualReps || 0);
    return w > 0 ? (w + ' x ' + (r || '?')) : ((r || '?') + ' reps');
  }

  function bestSet(rows) {
    return rows.filter(s => s.Completed && Number(s.ActualReps || 0) > 0)
      .sort((a, b) => setScore(b) - setScore(a))[0] || null;
  }

  function bestSetByExercise(exId, rows) {
    return bestSet(rows.filter(s => s.ExerciseID === exId));
  }

  function previousBestFor(exId) {
    return bestSetByExercise(exId, allSets().filter(s => s.UserName === currentUser()));
  }

  function progressionNudgeFor(exId) {
    const mine = allSets().filter(s => s.UserName === currentUser() && s.ExerciseID === exId && s.Completed);
    const byDate = {};
    mine.forEach(s => {
      const d = String(s.Date || '').slice(0, 10);
      if (!d) return;
      byDate[d] = byDate[d] || [];
      byDate[d].push(s);
    });
    const recent = Object.keys(byDate).sort().slice(-4).map(d => bestSet(byDate[d])).filter(Boolean);
    if (recent.length < 4) return null;
    const sig = recent.map(formatSetLine).join('|');
    if (new Set(recent.map(formatSetLine)).size !== 1) return null;
    const dismissKey = currentUser() + ':' + exId + ':' + sig;
    const dismissed = lsGet('ef_nudge_dismissed', {});
    if (dismissed[dismissKey]) return null;
    const last = recent[recent.length - 1];
    const hasWeight = Number(last.Weight_lb || 0) > 0;
    return {
      key: dismissKey,
      text: 'Same top set for 4 sessions: ' + formatSetLine(last) + '. Try ' + (hasWeight ? '+5 lb or +1-2 reps.' : '+1-2 reps or a harder variation.'),
    };
  }

  function dismissNudge(key) {
    const dismissed = lsGet('ef_nudge_dismissed', {});
    dismissed[key] = Date.now();
    lsSet('ef_nudge_dismissed', dismissed);
  }

  function prBoards() {
    const sets = allSets().filter(s => s.Completed && s.ExerciseID && Number(s.ActualReps || 0) > 0);
    const today = todayStr();
    const ws = weekStart();
    const exerciseIds = [...new Set(
      sets.filter(s => String(s.Date || '').slice(0, 10) >= ws || s.UserName === currentUser()).map(s => s.ExerciseID)
    )].slice(0, 10);
    return exerciseIds.map(id => {
      const ex = exById(id) || { ExerciseName: id };
      const bestToday = bestSet(sets.filter(s => s.ExerciseID === id && String(s.Date || '').slice(0, 10) === today));
      const bestWeek = bestSet(sets.filter(s => s.ExerciseID === id && String(s.Date || '').slice(0, 10) >= ws));
      const bestOverall = bestSet(sets.filter(s => s.ExerciseID === id));
      return { ex, bestToday, bestWeek, bestOverall };
    }).filter(row => row.bestToday || row.bestWeek || row.bestOverall);
  }

  function prCell(s) {
    if (!s) return '-';
    return (s.UserName === currentUser() ? 'You ' : displayNameFor(s.UserName) + ' ') + formatSetLine(s);
  }

  function nextSetIndex(wid, exId, row) {
    const sess = getSession(wid);
    const arr = sess.sets[exId] || [];
    const planned = Math.max(Number(row && row.TargetSets) || 1, arr.length || 1);
    for (let i = 0; i < planned; i++) {
      if (!arr[i] || !arr[i].done) return i;
    }
    return planned;
  }

  async function requestMotionAccess() {
    const DME = window.DeviceMotionEvent;
    if (!DME) return false;
    if (typeof DME.requestPermission === 'function') {
      try { return await DME.requestPermission() === 'granted'; } catch (e) { return false; }
    }
    return true;
  }

  async function startMotionSet(exId, wdId) {
    if (!CFG.motionCoach) { toast('Motion coach is off in Settings.', 'activity', true); return; }
    const ok = await requestMotionAccess();
    if (!ok) { toast('Motion access was not allowed on this phone.', 'activity', true); return; }
    stopMotionSet(false);
    const ex = exById(exId) || { ExerciseName: exId };
    state.motion = { active: true, exId, wdId, reps: 0, lastPeakAt: 0, lastCueAt: 0, avgTempo: 0, samples: [] };
    $('#motionMain').textContent = ex.ExerciseName;
    $('#motionSub').textContent = 'Motion coach on - waiting for rhythm';
    $('#motionbar').hidden = false;
    $('#motionbar').classList.add('active');
    window.addEventListener('devicemotion', handleMotionSample);
    requestWakeLock();
    setupMediaSession('motion', 'Motion set coach');
    playTone('cue');
    vibrate(35);
  }

  function handleMotionSample(ev) {
    if (!state.motion.active) return;
    const a = ev.acceleration || ev.accelerationIncludingGravity || {};
    const x = Number(a.x || 0), y = Number(a.y || 0), z = Number(a.z || 0);
    const mag = Math.sqrt(x * x + y * y + z * z);
    if (!isFinite(mag)) return;
    const samples = state.motion.samples;
    samples.push(mag);
    if (samples.length > 16) samples.shift();
    const avg = samples.reduce((n, v) => n + v, 0) / samples.length;
    const now = Date.now();
    const pulse = Math.abs(mag - avg);
    if (pulse < 2.4 || now - state.motion.lastPeakAt < 420) return;
    const gap = state.motion.lastPeakAt ? now - state.motion.lastPeakAt : 0;
    state.motion.lastPeakAt = now;
    state.motion.reps += 1;
    if (gap) state.motion.avgTempo = state.motion.avgTempo ? (state.motion.avgTempo * 0.7 + gap * 0.3) : gap;
    const pace = state.motion.avgTempo ? Math.round(state.motion.avgTempo / 100) / 10 : 0;
    let cue = 'good tempo';
    if (gap && gap < 750) cue = 'slow it down';
    else if (gap && gap > 2600) cue = 'keep steady';
    $('#motionSub').textContent = state.motion.reps + ' pulses - ' + cue + (pace ? ' - ' + pace + 's rhythm' : '');
    if (now - state.motion.lastCueAt > 5000) {
      state.motion.lastCueAt = now;
      if (cue !== 'good tempo') { playTone('cue'); vibrate(45); }
    }
  }

  function stopMotionSet(showToast) {
    if (state.motion.active) window.removeEventListener('devicemotion', handleMotionSample);
    state.motion.active = false;
    $('#motionbar').hidden = true;
    $('#motionbar').classList.remove('active');
    clearMediaSession();
    releaseWakeLock();
    if (showToast) toast('Motion coach stopped.', 'activity');
  }

  function finishMotionSet() {
    if (!state.motion.active) return;
    const wid = state.workoutId;
    const row = state.days.find(r => r.WorkoutID === wid && (r.WorkoutDayID === state.motion.wdId || r.ExerciseID === state.motion.exId));
    const exId = state.motion.exId;
    const i = nextSetIndex(wid, exId, row);
    const sess = getSession(wid);
    sess.sets[exId] = sess.sets[exId] || [];
    sess.sets[exId][i] = sess.sets[exId][i] || { count: Math.max(state.motion.reps, repsDefault(row && row.TargetRepsOrTime)), done: false };
    sess.sets[exId][i].count = Math.max(state.motion.reps || 0, sess.sets[exId][i].count || 0);
    sess.sets[exId][i].done = true;
    setSession(wid, sess);
    const reps = state.motion.reps;
    stopMotionSet(false);
    logSet(exId, i, row);
    const rest = Number((row && row.RestSeconds) || 60);
    if (rest > 0) startRest(rest);
    toast('Set logged' + (reps ? ' from motion: ' + reps + ' pulses.' : '.'), 'check-circle-2');
    render();
  }

  function rowsForWorkout(wid) {
    return state.days.filter(d => d.WorkoutID === wid).sort((a, b) => Number(a.Order) - Number(b.Order));
  }

  function appendAndPost(action, localList, row) {
    localList.push(row);
    post(action, row).then(() => updateSyncBadge());
  }

  function saveWorkoutOrder(ids) {
    const clean = ids.filter(Boolean);
    setProfileOrder(clean);
    clean.forEach((id, i) => {
      const w = state.workouts.find(x => x.WorkoutID === id);
      if (w) w.SortOrder = String(i + 1);
    });
    post('reorderWorkouts', {
      UserName: currentUser(),
      WorkoutIDs: clean.join('|'),
      UpdatedAt: new Date().toISOString(),
    }).then(() => updateSyncBadge());
  }

  function moveWorkoutInSchedule(dragId, targetId) {
    if (!dragId || dragId === targetId) return false;
    const ids = profileWorkouts().map(w => w.WorkoutID);
    const from = ids.indexOf(dragId);
    if (from < 0) return false;
    ids.splice(from, 1);
    const to = targetId ? ids.indexOf(targetId) : -1;
    ids.splice(to >= 0 ? to : ids.length, 0, dragId);
    saveWorkoutOrder(ids);
    return true;
  }

  function removeWorkoutFromSchedule(id) {
    const w = state.workouts.find(x => x.WorkoutID === id);
    if (!w) return false;
    w.Active = 'No';
    state.days = state.days.filter(row => row.WorkoutID !== id);
    saveWorkoutOrder(profileWorkouts().filter(x => x.WorkoutID !== id).map(x => x.WorkoutID));
    post('deleteWorkout', { WorkoutID: id, UserName: currentUser(), UpdatedAt: new Date().toISOString() }).then(() => updateSyncBadge());
    if (state.workoutId === id) {
      const next = profileWorkouts()[0];
      state.workoutId = next ? next.WorkoutID : null;
    }
    return true;
  }

  function createBlankWorkout(name, opts) {
    const mine = profileWorkouts();
    const rec = {
      WorkoutID: uid('WO'),
      WorkoutName: name || 'New routine',
      Goal: (opts && opts.goal) || 'Custom',
      Level: (opts && opts.level) || 'Any',
      Location: (opts && opts.location) || 'Gym/Home',
      EstimatedMinutes: (opts && opts.minutes) || '45',
      Description: (opts && opts.description) || 'Profile-owned routine for ' + displayNameFor(currentUser()),
      BackWarning: 'Use the pain rule: stop any movement that feels wrong.',
      Active: 'Yes',
      UserName: currentUser(),
      SortOrder: String(mine.length + 1),
    };
    appendAndPost('appendWorkout', state.workouts, rec);
    saveWorkoutOrder(mine.map(w => w.WorkoutID).concat(rec.WorkoutID));
    state.workoutId = rec.WorkoutID;
    return rec;
  }

  function ensureTodayRoutine(seedWid) {
    const dayId = todayWorkoutId();
    let workout = state.workouts.find(w => w.WorkoutID === dayId);
    const seed = seedWid && seedWid !== dayId ? state.workouts.find(w => w.WorkoutID === seedWid) : null;
    if (!workout) {
      const beforeOrder = profileWorkouts().map(w => w.WorkoutID);
      workout = {
        WorkoutID: dayId,
        WorkoutName: 'Today - ' + shortDate(todayStr()),
        Goal: (seed && seed.Goal) || 'Custom',
        Level: (seed && seed.Level) || 'Any',
        Location: (seed && seed.Location) || 'Gym/Home',
        EstimatedMinutes: (seed && seed.EstimatedMinutes) || '45',
        Description: 'Editable routine for ' + displayNameFor(currentUser()),
        BackWarning: (seed && seed.BackWarning) || 'Use the pain rule: stop any movement that feels wrong.',
        Active: 'Yes',
        UserName: currentUser(),
        SortOrder: String(profileWorkouts().length + 1),
      };
      appendAndPost('appendWorkout', state.workouts, workout);
      saveWorkoutOrder(beforeOrder.concat(workout.WorkoutID));
    }
    if (seed && !rowsForWorkout(dayId).length) {
      rowsForWorkout(seedWid).forEach((row, i) => {
        const clone = Object.assign({}, row, {
          WorkoutDayID: uid('WD'),
          WorkoutID: dayId,
          Order: String(i + 1),
          Notes: row.Notes || 'Copied into today',
        });
        appendAndPost('appendWorkoutDay', state.days, clone);
      });
    }
    state.workoutId = dayId;
    return dayId;
  }

  function addExerciseToRoutine(exId) {
    const ex = exById(exId);
    if (!ex) return false;
    const wid = ensureTodayRoutine(state.workoutId);
    if (rowsForWorkout(wid).some(row => row.ExerciseID === exId)) {
      toast('Already in today\'s routine.', 'check-circle-2');
      return false;
    }
    const order = rowsForWorkout(wid).length + 1;
    const row = {
      WorkoutDayID: uid('WD'),
      WorkoutID: wid,
      Order: String(order),
      ExerciseID: exId,
      TargetSets: ex.DefaultSets || '2',
      TargetRepsOrTime: ex.DefaultRepsOrTime || '8-12 reps',
      RestSeconds: ex.RestSeconds || '60',
      Optional: 'No',
      Notes: 'Added in app',
    };
    appendAndPost('appendWorkoutDay', state.days, row);
    return true;
  }

  function isWarmupRow(row) {
    return String((row && row.Notes) || '').toLowerCase().startsWith('warm-up:');
  }

  function warmupKey(wid) { return 'ef_warmup_collapsed_' + userKey(currentUser()) + '_' + wid; }
  function warmupCollapsed(wid) { return !!lsGet(warmupKey(wid), false); }
  function setWarmupCollapsed(wid, value) { lsSet(warmupKey(wid), !!value); }

  function addWarmupBlock() {
    const wid = ensureTodayRoutine(state.workoutId);
    const existing = new Set(rowsForWorkout(wid).map(r => r.ExerciseID));
    let order = rowsForWorkout(wid).length + 1;
    let added = 0;
    WARMUP_BLOCK.forEach(([exId, target, rest, note]) => {
      if (existing.has(exId) || !exById(exId)) return;
      const row = {
        WorkoutDayID: uid('WD'),
        WorkoutID: wid,
        Order: String(order++),
        ExerciseID: exId,
        TargetSets: '1',
        TargetRepsOrTime: target,
        RestSeconds: String(rest),
        Optional: 'Yes',
        Notes: 'Warm-up: ' + note,
      };
      appendAndPost('appendWorkoutDay', state.days, row);
      added++;
    });
    setWarmupCollapsed(wid, false);
    return added;
  }

  function removeWarmupBlock() {
    const wid = ensureTodayRoutine(state.workoutId);
    const rows = rowsForWorkout(wid).filter(isWarmupRow);
    if (!rows.length) return 0;
    const ids = new Set(rows.map(r => r.WorkoutDayID));
    state.days = state.days.filter(r => !(r.WorkoutID === wid && ids.has(r.WorkoutDayID)));
    rows.forEach(row => post('deleteWorkoutDay', { WorkoutDayID: row.WorkoutDayID, WorkoutID: wid }));
    setWarmupCollapsed(wid, false);
    return rows.length;
  }

  function latestDayNote() {
    return allJournal().filter(j => j.UserName === currentUser() && String(j.Date).slice(0, 10) === todayStr() && j.Journal && j.Mood === 'Note')
      .sort((a, b) => String(b.UpdatedAt || '').localeCompare(String(a.UpdatedAt || '')))[0];
  }

  function profileStatsFor(name) {
    return allProfileStats().filter(s => s.UserName === (name || currentUser()))
      .sort((a, b) => String(b.Date || '').localeCompare(String(a.Date || '')) || String(b.UpdatedAt || '').localeCompare(String(a.UpdatedAt || '')));
  }

  /* ---------------- views ---------------- */

  function flagClass(f) {
    const v = String(f || '').toLowerCase();
    return v === 'red' ? 'flag-red' : v === 'amber' || v === 'yellow' ? 'flag-amber' : 'flag-green';
  }

  function scheduleSelectorHtml(mine, wid, sugg) {
    const title = '<div class="schedule-head"><div><span class="section-label">Schedule</span>' +
      '<div class="resultcount">Profile-owned routines for ' + esc(displayNameFor(currentUser())) + '</div></div>' +
      '<button class="chip schedule-edit-toggle' + (state.scheduleEdit ? ' active' : '') + '" data-action="toggle-schedule-edit">' +
        (state.scheduleEdit ? 'Done' : 'Edit') + '</button></div>';
    if (!state.scheduleEdit) {
      return title + '<div class="chiprow schedule-row">' + mine.map(w =>
        '<button class="chip' + (w.WorkoutID === wid ? ' active' : '') + '" data-action="pick-workout" data-id="' + esc(w.WorkoutID) + '">' +
        esc(w.WorkoutName) + (w.WorkoutID === sugg && w.WorkoutID !== wid ? '<span class="sug">suggested</span>' : '') + '</button>'
      ).join('') + '</div>';
    }
    return title + '<div class="schedule-edit-list">' + mine.map((w, i) =>
      '<div class="schedule-edit-item' + (w.WorkoutID === wid ? ' active' : '') + '" draggable="true" data-workout-id="' + esc(w.WorkoutID) + '">' +
        '<button class="ios-delete" data-action="delete-workout" data-id="' + esc(w.WorkoutID) + '" aria-label="Delete ' + esc(w.WorkoutName) + '"><span></span></button>' +
        '<button class="schedule-edit-main" data-action="pick-workout" data-id="' + esc(w.WorkoutID) + '">' +
          '<span class="schedule-edit-name">' + esc(w.WorkoutName) + '</span>' +
          '<span class="schedule-edit-meta">' + esc([w.Location, w.EstimatedMinutes && w.EstimatedMinutes + ' min'].filter(Boolean).join(' - ') || 'Custom routine') + '</span>' +
        '</button>' +
        '<button class="drag-handle" data-action="drag-workout" aria-label="Hold and drag ' + esc(w.WorkoutName) + '"><i data-lucide="grip-vertical"></i></button>' +
      '</div>'
    ).join('') +
      '<button class="schedule-add-row" data-action="open-new-workout"><span class="ios-add"><i data-lucide="plus"></i></span><span>Add routine</span></button>' +
    '</div>';
  }

  function renderToday() {
    const mine = profileWorkouts();
    if (state.workoutId && !mine.some(w => w.WorkoutID === state.workoutId)) state.workoutId = null;
    const wid = state.workoutId || suggestedWorkoutId();
    state.workoutId = wid;
    const workout = mine.find(w => w.WorkoutID === wid);
    const sugg = suggestedWorkoutId();
    const sess = getSession(wid);
    const prep = getPrep();

    if (!mine.length) {
      return '<div class="eyebrow">' + esc(displayNameFor(currentUser())) + '</div>' +
        '<h1 class="pagetitle">No workout plan yet</h1>' +
        '<p class="pagesub">This profile is a clean slate. Build today as you go, or create a reusable profile-owned routine from the exercises you add.</p>' +
        '<button class="bigbtn" data-action="create-today-routine"><i data-lucide="plus"></i>Create blank today</button>' +
        '<button class="bigbtn subtle mt16" data-action="open-add-exercise"><i data-lucide="search"></i>Add first exercise</button>' +
        '<button class="bigbtn ghost mt16" data-action="open-new-workout"><i data-lucide="calendar-plus"></i>Create repeatable routine</button>';
    }

    let cards = '';
    if (workout) {
      const rows = rowsForWorkout(wid);
      const renderExerciseCard = (row, idx) => {
        const num = typeof idx === 'number' && idx >= 0 ? idx + 1 : 0;
        const cw = num > 0 ? ['', ' cw-terra', ' cw-pool'][(num - 1) % 3] : '';
        const ex = exById(row.ExerciseID) || { ExerciseName: row.ExerciseID, BackFlag: 'Green' };
        const nSets = Number(row.TargetSets) || 1;
        const done = sess.sets[row.ExerciseID] || [];
        const vid = videoIdOf(ex);
        const ready = progressionReady(row.ExerciseID, nSets) && ex.Progression;
        const nudge = progressionNudgeFor(row.ExerciseID);
        let setRows = '';
        for (let i = 0; i < Math.max(nSets, done.length); i++) {
          const st = done[i] || { count: repsDefault(row.TargetRepsOrTime), done: false };
          setRows +=
            '<div class="setrow">' +
              '<span class="setrow-label">Set ' + (i + 1) + '</span>' +
              '<div class="stepper">' +
                '<button data-action="dec" data-ex="' + esc(row.ExerciseID) + '" data-i="' + i + '">−</button>' +
                '<span class="count">' + st.count + '</span>' +
                '<button data-action="inc" data-ex="' + esc(row.ExerciseID) + '" data-i="' + i + '">+</button>' +
              '</div>' +
              '<button class="setdone' + (st.done ? ' done' : '') + '" data-action="complete-set" data-ex="' + esc(row.ExerciseID) + '" data-i="' + i + '" data-wd="' + esc(row.WorkoutDayID) + '" aria-label="Complete set">' +
                '<i data-lucide="check"></i></button>' +
            '</div>';
        }
        const det = sess.details[row.ExerciseID] || {};
        return (
        '<div class="card excard' + cw + '" id="ex-' + esc(row.ExerciseID) + '">' +
          (num > 0 ? '<div class="ex-num">' + num + '</div>' : '') +
          '<div class="excard-head">' +
            figSvg(ex) +
            '<span class="flag ' + flagClass(ex.BackFlag) + '"></span>' +
            '<div style="flex:1">' +
              '<div class="excard-name">' + esc(ex.ExerciseName) + '</div>' +
              (ready ? '<div class="badge badge-gold mt8"><i data-lucide="arrow-up-right"></i> ready to try: ' + esc(ex.Progression) + '</div>' : '') +
            '</div>' +
            '<span class="excard-target">' + esc(row.TargetSets) + ' × ' + esc(row.TargetRepsOrTime) + '</span>' +
          '</div>' +
          (ex.CoachingCues ? '<div class="excard-cues">' + esc(ex.CoachingCues) + '</div>' : '') +
          (nudge ? '<div class="nudge"><span><i data-lucide="trending-up"></i>' + esc(nudge.text) + '</span><button data-action="dismiss-nudge" data-key="' + esc(nudge.key) + '" aria-label="Dismiss suggestion">x</button></div>' : '') +
          (ex.StopIf ? '<div class="excard-stopif"><i data-lucide="octagon-alert"></i>Stop if: ' + esc(ex.StopIf) + '</div>' : '') +
          '<div class="setrows">' + setRows + '</div>' +
          '<div class="videowrap" id="vid-' + esc(row.ExerciseID) + '" hidden></div>' +
          '<div class="detailgrid" id="det-' + esc(row.ExerciseID) + '" hidden>' +
            '<label><span class="lbl">Weight lb</span><input type="number" inputmode="decimal" data-detail="weight" data-ex="' + esc(row.ExerciseID) + '" value="' + esc(det.weight || '') + '"></label>' +
            '<label><span class="lbl">Effort 1-10</span><input type="number" inputmode="numeric" min="1" max="10" data-detail="rpe" data-ex="' + esc(row.ExerciseID) + '" value="' + esc(det.rpe || '') + '"></label>' +
            '<label><span class="lbl">Pain 0-10</span><input type="number" inputmode="numeric" min="0" max="10" data-detail="pain" data-ex="' + esc(row.ExerciseID) + '" value="' + esc(det.pain || '') + '"></label>' +
          '</div>' +
          '<div class="excard-tools">' +
            '<button class="toolbtn" data-action="toggle-video" data-ex="' + esc(row.ExerciseID) + '" data-vid="' + esc(vid) + '" data-name="' + esc(ex.ExerciseName) + '" data-search="' + esc(ex.YouTubeSearchURL || '') + '">' +
              '<i data-lucide="' + (vid ? 'play' : 'youtube') + '"></i>' + (vid ? 'Form video' : 'Find video') + '</button>' +
            '<button class="toolbtn" data-action="toggle-details" data-ex="' + esc(row.ExerciseID) + '"><i data-lucide="sliders-horizontal"></i>Details</button>' +
            '<button class="toolbtn" data-action="motion-set" data-ex="' + esc(row.ExerciseID) + '" data-wd="' + esc(row.WorkoutDayID) + '"><i data-lucide="activity"></i>Motion</button>' +
            '<button class="toolbtn" data-action="add-set" data-ex="' + esc(row.ExerciseID) + '"><i data-lucide="plus"></i>Add set</button>' +
            '<button class="toolbtn" data-action="rest" data-sec="' + esc(row.RestSeconds || ex.RestSeconds || 60) + '"><i data-lucide="timer"></i>' + esc(row.RestSeconds || ex.RestSeconds || 60) + 's</button>' +
          '</div>' +
        '</div>');
      };
      const warmupRows = rows.filter(isWarmupRow);
      const mainRows = rows.filter(row => !isWarmupRow(row));
      const collapsed = warmupCollapsed(wid);
      const warmupHtml = warmupRows.length ? (
        '<div class="warmup-panel">' +
          '<div class="warmup-head">' +
            '<div><div class="minihead"><span>Warm-up block</span><span>' + warmupRows.length + ' moves</span></div>' +
              '<p class="warmup-sub">Simple mobility and full-body prep before the main work.</p></div>' +
            '<div class="warmup-actions">' +
              '<button class="infobtn" data-action="toggle-warmup-collapse" aria-label="' + (collapsed ? 'Expand warm-up' : 'Collapse warm-up') + '"><i data-lucide="' + (collapsed ? 'chevron-down' : 'chevron-up') + '"></i></button>' +
              '<button class="infobtn danger" data-action="remove-warmup" aria-label="Remove warm-up"><i data-lucide="x"></i></button>' +
            '</div>' +
          '</div>' +
          (collapsed ? '<div class="resultcount">Collapsed - tap the chevron to show exercises.</div>' : '<div class="warmup-list">' + warmupRows.map((r) => renderExerciseCard(r, -1)).join('') + '</div>') +
        '</div>'
      ) : '';
      cards = warmupHtml + mainRows.map(renderExerciseCard).join('');
    }

    /* session progress: done sets vs planned sets */
    let planned = 0, doneSets = 0;
    rowsForWorkout(wid).forEach(row => {
      const arr = sess.sets[row.ExerciseID] || [];
      planned += Math.max(Number(row.TargetSets) || 1, arr.length);
      doneSets += arr.filter(s => s && s.done).length;
    });
    const pct = planned ? Math.round((doneSets / planned) * 100) : 0;

    return (
      '<div class="eyebrow">' + esc(niceDate()) + ' for ' + esc(displayNameFor(currentUser())) + '</div>' +
      '<div class="titlerow"><h1 class="pagetitle">' + esc(workout ? workout.WorkoutName : 'No workout') + '</h1>' +
        (doneSets ? '<span class="excard-target">' + doneSets + ' / ' + planned + ' sets</span>' : '') + '</div>' +
      (doneSets ? '<div class="hairbar"><span style="width:' + pct + '%"></span></div>' : '') +
      '<p class="pagesub">' + esc(workout ? (workout.Description + ' · about ' + workout.EstimatedMinutes + ' min') : 'Pick a plan below.') + '</p>' +
      scheduleSelectorHtml(mine, wid, sugg) +
      '<div class="actionrow">' +
        '<button class="toolbtn actiontool" data-action="customize-today"><i data-lucide="copy-plus"></i>' + (isTodayWorkout(wid) ? 'Today routine' : 'Customize today') + '</button>' +
        '<button class="toolbtn actiontool" data-action="add-warmup"><i data-lucide="sparkles"></i>' + (rowsForWorkout(wid).some(isWarmupRow) ? 'Remove warm-up' : 'Warm-up') + '</button>' +
        '<button class="toolbtn actiontool" data-action="open-add-exercise"><i data-lucide="search"></i>Add exercise</button>' +
        '<button class="toolbtn actiontool" data-action="open-voice-log"><i data-lucide="mic"></i>Quick log</button>' +
        '<button class="toolbtn actiontool" data-action="open-tools"><i data-lucide="calculator"></i>Tools</button>' +
      '</div>' +
      (workout && workout.BackWarning ? '<div class="guardbar"><i data-lucide="shield-check"></i><span>' + esc(workout.BackWarning) + '</span></div>' : '') +
      cards +
      '<div class="card mt16 prep-card"><div class="minihead"><span>Pre-workout checklist</span>' +
        (prep.updatedAt ? '<button class="infobtn" data-action="open-time-info" aria-label="Time info"><i data-lucide="info"></i></button>' : '') + '</div>' +
        '<div class="prepgrid">' + PREP_ITEMS.map(([key, label]) =>
          '<button class="prepitem' + (prep.items[key] ? ' checked' : '') + '" data-action="toggle-prep" data-key="' + key + '">' +
            '<i data-lucide="' + (prep.items[key] ? 'check-circle-2' : 'circle') + '"></i><span>' + esc(label) + '</span></button>'
        ).join('') + '</div>' +
        '<div class="resultcount mt8">' + (prep.dirty ? 'Unsaved changes' : (prep.updatedAt ? 'Updated ' + esc(timeAgo(new Date(prep.updatedAt).getTime())) : 'Optional - tap what you took today')) + '</div>' +
        '<button class="bigbtn subtle mt16" data-action="save-prep"><i data-lucide="save"></i>Save checklist</button></div>' +
      '<div class="card mt16"><label class="full"><span class="formlabel">Today\'s notes</span>' +
        '<textarea id="dayNotes" rows="3" placeholder="How this workout felt, swaps, reminders for next time...">' + esc((latestDayNote() || {}).Journal || '') + '</textarea></label>' +
        '<button class="bigbtn subtle mt16" data-action="save-day-note"><i data-lucide="notebook-pen"></i>Save note</button></div>' +
      '<button class="bigbtn mt16" data-action="finish"><i data-lucide="flag"></i>Finish workout</button>'
    );
  }

  function renderLibrary() {
    const L = state.lib;
    const cats = ['All'].concat([...new Set(state.exercises.map(e => e.Category).filter(Boolean))].sort());
    const places = ['All', 'Home', 'Gym', 'Machine', 'Cable'];
    const diffs = ['All', 'Beginner', 'Intermediate', 'Advanced'];

    let list = state.exercises.filter(e => {
      if (CFG.backSafe && String(e.BackFlag).toLowerCase() === 'red') return false;
      if (L.q && !(e.ExerciseName + ' ' + e.PrimaryMuscles + ' ' + e.Equipment + ' ' + e.MovementPattern).toLowerCase().includes(L.q.toLowerCase())) return false;
      if (L.cat !== 'All' && e.Category !== L.cat) return false;
      if (L.place !== 'All') {
        const hay = (e.ExerciseName + ' ' + e.Equipment + ' ' + e.BestFor).toLowerCase();
        if (L.place === 'Machine' && !hay.includes('machine')) return false;
        else if (L.place === 'Cable' && !hay.includes('cable')) return false;
        else if (!['Machine', 'Cable'].includes(L.place) && !(String(e.BestFor || '').includes(L.place))) return false;
      }
      if (L.diff !== 'All' && e.Difficulty !== L.diff) return false;
      return true;
    });

    const chipRow = (items, key, active) => '<div class="chiprow">' + items.map(v =>
      '<button class="chip' + (v === active ? ' active' : '') + '" data-action="lib-filter" data-key="' + key + '" data-v="' + esc(v) + '">' + esc(v) + '</button>'
    ).join('') + '</div>';

    return (
      '<div class="eyebrow">The collection</div>' +
      '<h1 class="pagetitle">Exercise library</h1>' +
      '<p class="pagesub">' + state.exercises.length + ' movements, each with a form video one tap away.</p>' +
      '<div class="searchwrap"><i data-lucide="search"></i>' +
        '<input id="libSearch" type="search" placeholder="Search name, muscle, equipment…" value="' + esc(L.q) + '"></div>' +
      chipRow(cats, 'cat', L.cat) +
      chipRow(places, 'place', L.place) +
      chipRow(diffs, 'diff', L.diff) +
      '<div class="resultcount">' + list.length + ' result' + (list.length === 1 ? '' : 's') +
        (CFG.backSafe ? ' · back-safe mode on' : '') + '</div>' +
      list.slice(0, state.lib.limit || 120).map(e =>
        '<button class="libitem" data-action="open-exercise" data-id="' + esc(e.ExerciseID) + '">' +
          '<span class="flag ' + flagClass(e.BackFlag) + '"></span>' +
          '<span class="libitem-body">' +
            '<div class="libitem-name">' + esc(e.ExerciseName) + '</div>' +
            '<div class="libitem-meta">' + esc([e.PrimaryMuscles, e.Equipment, e.Difficulty].filter(Boolean).join(' · ')) + '</div>' +
          '</span><i data-lucide="chevron-right"></i>' +
        '</button>'
      ).join('') +
      (list.length > (state.lib.limit || 120) ?
        '<button class="bigbtn ghost mt16" data-action="lib-more">Show ' + Math.min(200, list.length - (state.lib.limit || 120)) + ' more</button>' : '') +
      (list.length ? '' : '<div class="empty"><i data-lucide="search-x"></i><div>Nothing matches — loosen the filters.</div></div>')
    );
  }

  function paceStr(minPerKm) {
    if (!isFinite(minPerKm) || minPerKm <= 0) return '—';
    const m = Math.floor(minPerKm), s = Math.round((minPerKm - m) * 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function renderRun() {
    const runs = allRuns().filter(r => r.UserName === currentUser())
      .sort((a, b) => String(b.Date).localeCompare(String(a.Date))).slice(0, 12);
    const ws = weekStart();
    const byUser = {};
    state.users.forEach(u => { byUser[u.UserName] = { km: 0, best: Infinity, runs: 0 }; });
    allRuns().forEach(r => {
      const u = r.UserName || '?';
      byUser[u] = byUser[u] || { km: 0, best: Infinity, runs: 0 };
      const km = Number(r.Distance_km || 0), pace = Number(r.Pace_min_per_km || 0);
      if (String(r.Date) >= ws) { byUser[u].km += km; byUser[u].runs++; }
      if (pace > 0 && km >= 0.5) byUser[u].best = Math.min(byUser[u].best, pace);
    });
    const board = Object.entries(byUser).sort((a, b) => b[1].km - a[1].km);

    return (
      '<div class="eyebrow">Out the door</div>' +
      '<h1 class="pagetitle">Run &amp; walk</h1>' +
      '<p class="pagesub">Distance in, pace out. Saved for ' + esc(displayNameFor(currentUser())) + '.</p>' +
      '<div class="card card-gold"><div class="formgrid">' +
        '<label><span class="formlabel">Distance km</span><input id="runDist" type="number" inputmode="decimal" step="0.01" placeholder="1.43"></label>' +
        '<label><span class="formlabel">Minutes</span><input id="runMin" type="number" inputmode="decimal" step="0.5" placeholder="23"></label>' +
        '<label><span class="formlabel">Route</span><input id="runRoute" type="text" placeholder="Neighbourhood"></label>' +
        '<label><span class="formlabel">Effort 1-10</span><input id="runRpe" type="number" inputmode="numeric" min="1" max="10" placeholder="5"></label>' +
        '<label class="full"><span class="formlabel">Notes</span><input id="runNotes" type="text" placeholder="Optional"></label>' +
      '</div>' +
      '<div class="calc-result" id="runCalc" hidden>' +
        '<div class="calc-box"><div class="v" id="calcPace">—</div><div class="l">min / km</div></div>' +
        '<div class="calc-box"><div class="v" id="calcSpeed">—</div><div class="l">km / h</div></div>' +
      '</div>' +
      '<button class="bigbtn mt16" data-action="save-run"><i data-lucide="footprints"></i>Save run</button></div>' +

      '<div class="section-label">Walk timer</div>' +
      '<div class="card"><div class="chiprow" style="margin:0">' +
        [20, 30, 45, 60].map(m => '<button class="chip" data-action="walk-timer" data-min="' + m + '">' + m + ' min</button>').join('') +
      '</div><p class="pagesub" style="margin:10px 0 0">Counts down in the bar below and keeps true time even if the screen locks.</p></div>' +

      (board.length ? '<div class="section-label">This week, between friends</div>' +
        '<table class="datatable"><tr><th>Who</th><th class="num">km</th><th class="num">outings</th><th class="num">best pace</th></tr>' +
        board.map(([u, s]) =>
          '<tr' + (u === currentUser() ? ' class="me"' : '') + '><td>' + esc(displayNameFor(u)) + '</td><td class="num">' + s.km.toFixed(2) + '</td><td class="num">' + s.runs + '</td>' +
          '<td class="num">' + (s.best < Infinity ? paceStr(s.best) : '—') + '</td></tr>').join('') +
        '</table>' : '') +

      '<div class="section-label">Recent outings for ' + esc(displayNameFor(currentUser())) + '</div>' +
      (runs.length ?
        '<table class="datatable"><tr><th>Date</th><th class="num">km</th><th class="num">pace</th></tr>' +
        runs.map(r =>
          '<tr><td>' + esc(shortDate(r.Date)) + '</td>' +
          '<td class="num">' + Number(r.Distance_km || 0).toFixed(2) + '</td>' +
          '<td class="num">' + paceStr(Number(r.Pace_min_per_km || 0)) + '</td></tr>').join('') + '</table>'
        : '<div class="empty"><i data-lucide="footprints"></i><div>No outings yet. The first one counts double (emotionally).</div></div>')
    );
  }

  function sparkline(values, warnAt) {
    if (values.length < 2) return '<div class="empty" style="padding:14px">Not enough entries yet for a trend.</div>';
    const w = 320, h = 56, max = Math.max(...values, warnAt || 1), min = 0;
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * (w - 8) + 4;
      const y = h - 6 - ((v - min) / (max - min || 1)) * (h - 12);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg class="sparkline" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts + '" fill="none" stroke="#35845A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  const BACK_CIRCUIT_IDS = ['EX0012', 'EX0013', 'EX0022', 'EX0010', 'EX0021'];

  function renderChallenges(mySets, myRuns, ws) {
    const weekSets = mySets.filter(s => String(s.Date) >= ws);
    const workouts = new Set(weekSets.map(s => s.Date)).size;
    const walkMin = myRuns.filter(r => String(r.Date) >= ws).reduce((a, r) => a + Number(r.Duration_min || 0), 0);
    const gentleDays = new Set(weekSets.filter(s =>
      BACK_CIRCUIT_IDS.includes(s.ExerciseID) && Number(s.Pain_0_10 || 0) <= 4).map(s => s.Date)).size;

    const items = [
      { label: 'Three workouts', now: workouts, goal: 3, unit: '' },
      { label: '100 walking minutes', now: Math.round(walkMin), goal: 100, unit: ' min' },
      { label: 'Two gentle back circuits', now: gentleDays, goal: 2, unit: '' },
    ];
    return '<div class="card">' + items.map(c => {
      const pct = Math.min(100, Math.round((c.now / c.goal) * 100));
      const done = c.now >= c.goal;
      return '<div class="challenge' + (done ? ' done' : '') + '">' +
        '<div class="challenge-row"><span>' + esc(c.label) + '</span>' +
        '<span class="challenge-count">' + (done ? '<i data-lucide="check"></i>' : c.now + c.unit + ' / ' + c.goal + c.unit) + '</span></div>' +
        '<div class="hairbar"><span style="width:' + pct + '%"></span></div></div>';
    }).join('') + '</div>';
  }

  function renderProgress() {
    const ws = weekStart();
    const sets = allSets();
    const runs = allRuns();
    const me = currentUser();

    const mySets = sets.filter(s => s.UserName === me);
    const myRuns = runs.filter(r => r.UserName === me);
    const setsWeek = mySets.filter(s => String(s.Date) >= ws).length;
    const kmWeek = myRuns.filter(r => String(r.Date) >= ws).reduce((a, r) => a + Number(r.Distance_km || 0), 0);
    const workoutsWeek = new Set(mySets.filter(s => String(s.Date) >= ws).map(s => s.Date)).size;
    const statRows = profileStatsFor(me);
    const latestStats = statRows[0] || {};

    /* streak: consecutive days ending today/yesterday with any activity */
    const activeDays = new Set(mySets.map(s => String(s.Date).slice(0, 10)).concat(myRuns.map(r => String(r.Date).slice(0, 10))));
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const d = todayStr(daysAgo(i));
      if (activeDays.has(d)) streak++;
      else if (i > 0) break;
    }

    /* push-up level */
    const ladder = [['EX0001', 'Wall'], ['EX0002', 'Counter'], ['EX0003', 'Knee'], ['EX0044', 'Full']];
    let level = 'Not started';
    ladder.forEach(([id, name]) => { if (mySets.some(s => s.ExerciseID === id && s.Completed)) level = name; });

    /* pain trend from journal + set logs, last 14 dated values */
    const painPts = allJournal().filter(j => j.UserName === me && j.BackPain_0_10 !== '' && j.BackPain_0_10 != null)
      .map(j => ({ d: String(j.Date).slice(0, 10), v: Number(j.BackPain_0_10) }))
      .sort((a, b) => a.d.localeCompare(b.d)).slice(-14);

    /* friends this week */
    const users = {};
    state.users.forEach(u => { users[u.UserName] = { sets: 0, km: 0 }; });
    sets.forEach(s => { if (String(s.Date) >= ws) { users[s.UserName] = users[s.UserName] || { sets: 0, km: 0 }; users[s.UserName].sets++; } });
    runs.forEach(r => { if (String(r.Date) >= ws) { users[r.UserName] = users[r.UserName] || { sets: 0, km: 0 }; users[r.UserName].km += Number(r.Distance_km || 0); } });
    const friends = Object.entries(users).sort((a, b) => (b[1].sets + b[1].km) - (a[1].sets + a[1].km));
    const prs = prBoards();

    return (
      '<div class="eyebrow">Quiet momentum</div>' +
      '<div class="titlerow"><h1 class="pagetitle">Progress</h1><button class="infobtn" data-action="open-time-info" aria-label="Time and history info"><i data-lucide="info"></i></button></div>' +
      '<p class="pagesub">Consistency beats intensity. Here is ' + esc(displayNameFor(me)) + '\'s.</p>' +
      '<div class="statgrid">' +
        '<div class="stat"><div class="stat-num">' + workoutsWeek + '</div><div class="stat-label">workouts this week</div></div>' +
        '<div class="stat"><div class="stat-num">' + setsWeek + '</div><div class="stat-label">sets this week</div></div>' +
        '<div class="stat"><div class="stat-num">' + kmWeek.toFixed(1) + '<small> km</small></div><div class="stat-label">distance this week</div></div>' +
        '<div class="stat"><div class="stat-num">' + streak + '<small> day' + (streak === 1 ? '' : 's') + '</small></div><div class="stat-label">streak</div></div>' +
      '</div>' +
      (latestStats.StatID ? '<div class="section-label">Profile stats</div>' +
        '<div class="card"><div class="kv"><span class="k">Latest</span><span class="v">' + esc(shortDate(latestStats.Date)) + '</span></div>' +
        '<div class="kv"><span class="k">Height</span><span class="v">' + esc(latestStats.Height_in ? latestStats.Height_in + ' in' : 'not set') + '</span></div>' +
        '<div class="kv"><span class="k">Weight</span><span class="v">' + esc(latestStats.BodyWeight_lb ? latestStats.BodyWeight_lb + ' lb' : 'not set') + '</span></div>' +
        '<div class="kv"><span class="k">Rest HR</span><span class="v">' + esc(latestStats.RestingHR_bpm ? latestStats.RestingHR_bpm + ' bpm' : 'not set') + '</span></div>' +
        (statRows.length > 1 ? '<div class="resultcount mt8">' + statRows.length + ' updates saved</div>' : '') + '</div>' : '') +
      '<div class="section-label">This week’s challenges</div>' +
      renderChallenges(mySets, myRuns, ws) +
      '<div class="section-label">Push-up ladder</div>' +
      '<div class="card"><div class="chiprow" style="margin:0">' +
        ladder.map(([id, name]) => '<span class="chip' + (level === name ? ' active' : '') + '">' + name + '</span>').join('') +
      '</div></div>' +
      '<div class="section-label">Back pain trend</div>' +
      '<div class="card">' + sparkline(painPts.map(p => p.v), 10) +
        (painPts.length ? '<div class="resultcount mt8">' + esc(shortDate(painPts[0].d)) + ' → ' + esc(shortDate(painPts[painPts.length - 1].d)) + '</div>' : '') +
      '</div>' +
      (friends.length ? '<div class="section-label">The club, this week</div>' +
        '<table class="datatable"><tr><th>Who</th><th class="num">sets</th><th class="num">km</th></tr>' +
        friends.map(([u, s]) => '<tr' + (u === me ? ' class="me"' : '') + '><td>' + esc(displayNameFor(u)) + '</td><td class="num">' + s.sets + '</td><td class="num">' + s.km.toFixed(1) + '</td></tr>').join('') +
        '</table>' : '') +
      (prs.length ? '<div class="section-label">PR compare</div>' +
        '<table class="datatable prtable"><tr><th>Exercise</th><th class="num">today</th><th class="num">week</th><th class="num">overall</th></tr>' +
        prs.map(row => '<tr><td>' + esc(row.ex.ExerciseName) + '</td><td class="num">' + esc(prCell(row.bestToday)) + '</td><td class="num">' + esc(prCell(row.bestWeek)) + '</td><td class="num">' + esc(prCell(row.bestOverall)) + '</td></tr>').join('') +
        '</table>' : '') +
      (state.source === 'local' && !CFG.sheetId ?
        '<div class="card mt24"><div class="badge"><i data-lucide="plug"></i>Local mode</div>' +
        '<p class="pagesub mt8" style="margin-bottom:0">Connect the Google Sheet in settings to compare with friends.</p></div>' : '')
    );
  }

  function renderJournal() {
    const entries = allJournal().filter(j => j.UserName === currentUser())
      .sort((a, b) => String(b.Date).localeCompare(String(a.Date))).slice(0, 10);
    return (
      '<div class="eyebrow">' + esc(niceDate()) + ' for ' + esc(displayNameFor(currentUser())) + '</div>' +
      '<h1 class="pagetitle">Journal</h1>' +
      '<p class="pagesub">Thirty honest seconds a day.</p>' +
      '<div class="card card-gold"><div class="formgrid">' +
        '<label><span class="formlabel">Weight lb</span><input id="jWeight" type="number" inputmode="decimal" placeholder="245"></label>' +
        '<label><span class="formlabel">Sleep hours</span><input id="jSleep" type="number" inputmode="decimal" step="0.5" placeholder="7"></label>' +
        '<label><span class="formlabel">Energy 1-10</span><input id="jEnergy" type="number" inputmode="numeric" min="1" max="10" placeholder="5"></label>' +
        '<label><span class="formlabel">Back pain 0-10</span><input id="jPain" type="number" inputmode="numeric" min="0" max="10" placeholder="0"></label>' +
        '<label class="full"><span class="formlabel">Mood</span><select id="jMood">' +
          ['—', 'Great', 'Good', 'Fine', 'Meh', 'Rough'].map(m => '<option>' + m + '</option>').join('') + '</select></label>' +
        '<label class="full"><span class="formlabel">Notes</span><textarea id="jNotes" rows="2" placeholder="What made today easier or harder?"></textarea></label>' +
      '</div>' +
      '<button class="bigbtn mt16" data-action="save-journal"><i data-lucide="notebook-pen"></i>Save entry</button></div>' +
      '<div class="section-label">Recent entries</div>' +
      (entries.length ? entries.map(j =>
        '<div class="card">' +
          '<div class="eyebrow">' + esc(shortDate(j.Date)) + (j.Mood && j.Mood !== '—' ? ' · ' + esc(j.Mood) : '') + '</div>' +
          '<div style="font-size:0.88rem;color:var(--taupe)">' +
            [j.BodyWeight_lb && j.BodyWeight_lb + ' lb', j.SleepHours && j.SleepHours + ' h sleep',
             j.Energy_1_10 && 'energy ' + j.Energy_1_10, (j.BackPain_0_10 !== '' && j.BackPain_0_10 != null) && 'pain ' + j.BackPain_0_10]
            .filter(Boolean).join(' · ') + '</div>' +
          (j.Journal ? '<div class="mt8" style="font-size:0.92rem">' + esc(j.Journal) + '</div>' : '') +
        '</div>').join('')
        : '<div class="empty"><i data-lucide="notebook"></i><div>No entries yet.</div></div>')
    );
  }

  /* ---------------- modals ---------------- */

  function openExercise(id) {
    const e = exById(id);
    if (!e) return;
    const vid = videoIdOf(e);
    const imgs = imagesOf(e);
    openModal(
      '<div style="display:flex;gap:10px;align-items:baseline">' +
        '<span class="flag ' + flagClass(e.BackFlag) + '"></span>' +
        '<div class="sheet-title">' + esc(e.ExerciseName) + '</div></div>' +
      '<div class="sheet-sub">' + esc([e.Category, e.MovementPattern, e.Difficulty].filter(Boolean).join(' · ')) + '</div>' +
      (vid ? '<div class="videowrap" style="padding:0 0 14px"><iframe src="' + esc(embedUrl(vid)) + '" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>'
           : (e.YouTubeSearchURL ? '<a class="bigbtn ghost" style="margin-bottom:14px;text-decoration:none" href="' + esc(e.YouTubeSearchURL) + '" target="_blank" rel="noopener"><i data-lucide="youtube"></i>Search form videos</a>' : '')) +
      (imgs.length ? '<div class="imgstrip">' + imgs.slice(0, 2).map(u =>
        '<img src="' + esc(u) + '" alt="' + esc(e.ExerciseName) + ' demonstration" loading="lazy">').join('') + '</div>' : '') +
      (e.Instructions ? '<div class="kv"><span class="k">How to</span><span class="v">' + esc(e.Instructions) + '</span></div>' : '') +
      '<div class="kv"><span class="k">Muscles</span><span class="v">' + esc([e.PrimaryMuscles, e.SecondaryMuscles].filter(Boolean).join(' · ')) + '</span></div>' +
      '<div class="kv"><span class="k">Equipment</span><span class="v">' + esc(e.Equipment || '—') + '</span></div>' +
      '<div class="kv"><span class="k">Default</span><span class="v">' + esc((e.DefaultSets || '?') + ' × ' + (e.DefaultRepsOrTime || '?') + ' · rest ' + (e.RestSeconds || '60') + 's' + (e.Tempo ? ' · tempo ' + e.Tempo : '')) + '</span></div>' +
      (e.CoachingCues ? '<div class="kv"><span class="k">Cues</span><span class="v">' + esc(e.CoachingCues) + '</span></div>' : '') +
      (e.StopIf ? '<div class="kv"><span class="k">Stop if</span><span class="v" style="color:var(--terracotta)">' + esc(e.StopIf) + '</span></div>' : '') +
      (e.Regression ? '<div class="kv"><span class="k">Easier</span><span class="v">' + esc(e.Regression) + '</span></div>' : '') +
      (e.Progression ? '<div class="kv"><span class="k">Harder</span><span class="v">' + esc(e.Progression) + '</span></div>' : '') +
      (e.Notes ? '<div class="kv"><span class="k">Notes</span><span class="v">' + esc(e.Notes) + '</span></div>' : '') +
      '<button class="bigbtn subtle mt24" data-action="close-modal">Close</button>'
    );
  }

  function exercisePickerHtml(q) {
    const needle = String(q || '').toLowerCase();
    const list = state.exercises.filter(e => {
      if (CFG.backSafe && String(e.BackFlag).toLowerCase() === 'red') return false;
      const hay = (e.ExerciseName + ' ' + e.PrimaryMuscles + ' ' + e.Equipment + ' ' + e.MovementPattern).toLowerCase();
      return !needle || hay.includes(needle);
    }).slice(0, 36);
    return '<div class="searchwrap"><i data-lucide="search"></i>' +
        '<input id="routineSearch" type="search" placeholder="Search exercises, machines, cables..." value="' + esc(q || '') + '" autofocus></div>' +
      '<div class="resultcount">' + list.length + ' shown from ' + state.exercises.length + '</div>' +
      '<div class="pickerlist">' + list.map(e =>
        '<div class="pickeritem">' +
          '<button class="libitem picker-main" data-action="open-exercise" data-id="' + esc(e.ExerciseID) + '">' +
            '<span class="flag ' + flagClass(e.BackFlag) + '"></span>' +
            '<span class="libitem-body"><div class="libitem-name">' + esc(e.ExerciseName) + '</div>' +
              '<div class="libitem-meta">' + esc([e.PrimaryMuscles, e.Equipment, e.Difficulty].filter(Boolean).join(' - ')) + '</div></span>' +
          '</button>' +
          '<button class="miniadd" data-action="add-routine-exercise" data-id="' + esc(e.ExerciseID) + '" aria-label="Add ' + esc(e.ExerciseName) + '"><i data-lucide="plus"></i></button>' +
        '</div>').join('') + '</div>' +
      (list.length ? '' : '<div class="empty"><i data-lucide="search-x"></i><div>No exercise matches that search.</div></div>');
  }

  function openAddExercise() {
    state.routine.q = state.routine.q || '';
    openModal(
      '<div class="sheet-title">Add exercise</div>' +
      '<div class="sheet-sub">Adds to ' + esc(displayNameFor(currentUser())) + '\'s routine for today.</div>' +
      '<div id="exercisePicker">' + exercisePickerHtml(state.routine.q) + '</div>'
    );
    const input = $('#routineSearch');
    if (input) input.focus();
  }

  function openNewWorkout() {
    openModal(
      '<div class="sheet-title">New routine</div>' +
      '<div class="sheet-sub">Create a repeatable routine for ' + esc(displayNameFor(currentUser())) + ', then add exercises to it.</div>' +
      '<div class="formgrid">' +
        '<label class="full"><span class="formlabel">Routine name</span><input id="newWorkoutName" type="text" placeholder="Upper body day"></label>' +
        '<label><span class="formlabel">Location</span><select id="newWorkoutLocation"><option>Gym</option><option>Home</option><option>Home + Gym</option></select></label>' +
        '<label><span class="formlabel">Minutes</span><input id="newWorkoutMinutes" type="number" inputmode="numeric" value="45"></label>' +
        '<label class="full"><span class="formlabel">Focus</span><input id="newWorkoutGoal" type="text" placeholder="Strength, machines, conditioning"></label>' +
        '<label class="full"><span class="formlabel">Description</span><input id="newWorkoutDescription" type="text" placeholder="Optional note for this routine"></label>' +
      '</div>' +
      '<button class="bigbtn mt16" data-action="save-new-workout"><i data-lucide="calendar-plus"></i>Create routine</button>'
    );
    const input = $('#newWorkoutName');
    if (input) input.focus();
  }

  function openAddProfile() {
    openModal(
      '<div class="sheet-title">Add profile</div>' +
      '<div class="sheet-sub">Creates a separate profile row in the club sheet.</div>' +
      '<div class="formgrid">' +
        '<label class="full"><span class="formlabel">Name</span><input id="newProfileName" type="text" autocomplete="name" placeholder="Maya"></label>' +
        '<label class="full"><span class="formlabel">Goal</span><input id="newProfileGoal" type="text" placeholder="Strength, fat loss, running"></label>' +
        '<label><span class="formlabel">Location</span><select id="newProfileLocation"><option>Gym</option><option>Home</option><option>Home + Gym</option></select></label>' +
        '<label><span class="formlabel">Level</span><select id="newProfileLevel"><option>Beginner</option><option>Novice</option><option>Intermediate</option><option>Advanced</option></select></label>' +
      '</div>' +
      '<button class="bigbtn mt16" data-action="save-new-profile"><i data-lucide="user-plus"></i>Add profile</button>'
    );
    const input = $('#newProfileName');
    if (input) input.focus();
  }

  function spokenNumberText(text) {
    const words = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
      eighteen: 18, nineteen: 19, twenty: 20,
    };
    return String(text || '').toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g, m => words[m]);
  }

  function bestExerciseMatch(text) {
    const phrase = spokenNumberText(text).replace(/[^a-z0-9 ]+/g, ' ');
    const tokens = new Set(phrase.split(/\s+/).filter(t => t.length > 2 && !['reps', 'rep', 'pounds', 'pound', 'lbs', 'sets', 'set'].includes(t)));
    let best = null, bestScore = 0;
    state.exercises.forEach(e => {
      const name = String(e.ExerciseName || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
      const parts = name.split(/\s+/).filter(t => t.length > 2);
      const score = parts.reduce((n, t) => n + (tokens.has(t) ? 1 : 0), 0);
      if (score > bestScore && score >= Math.min(2, parts.length)) { best = e; bestScore = score; }
    });
    return best;
  }

  function parseVoiceLog(text) {
    const clean = spokenNumberText(text);
    const nums = (clean.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    const weightMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:lb|lbs|pound|pounds)/i) || clean.match(/(?:at|with)\s*(\d+(?:\.\d+)?)/i);
    const repsMatch = clean.match(/(\d+)\s*(?:rep|reps)/i);
    const ex = bestExerciseMatch(clean);
    return {
      raw: text,
      exercise: ex,
      weight: weightMatch ? Number(weightMatch[1]) : '',
      reps: repsMatch ? Number(repsMatch[1]) : (nums.length ? nums[nums.length - 1] : ''),
    };
  }

  function voicePreviewHtml(draft) {
    const d = draft || parseVoiceLog((($('#voiceText') || {}).value || ''));
    return '<div class="kv"><span class="k">Exercise</span><span class="v">' + esc(d.exercise ? d.exercise.ExerciseName : 'No match yet') + '</span></div>' +
      '<div class="kv"><span class="k">Weight</span><span class="v">' + esc(d.weight ? d.weight + ' lb' : 'not found') + '</span></div>' +
      '<div class="kv"><span class="k">Reps</span><span class="v">' + esc(d.reps || 'not found') + '</span></div>';
  }

  function openVoiceLog() {
    state.voiceDraft = null;
    const speechOk = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    openModal(
      '<div class="sheet-title">Quick log</div>' +
      '<div class="sheet-sub">Say or type something like "bench press 135 eight reps".</div>' +
      '<label class="full"><span class="formlabel">Phrase</span><textarea id="voiceText" rows="3" placeholder="bench press 135 eight reps"></textarea></label>' +
      '<div id="voicePreview" class="mt16">' + voicePreviewHtml(null) + '</div>' +
      '<div id="voiceStatus" class="listen-status idle"><span></span>Ready to listen.</div>' +
      '<button id="voiceListenBtn" class="bigbtn mt16" data-action="listen-voice"' + (speechOk ? '' : ' disabled') + '><i data-lucide="mic"></i>' + (speechOk ? 'Listen' : 'Mic not supported') + '</button>' +
      '<button class="bigbtn ghost" data-action="save-voice-log"><i data-lucide="check"></i>Save quick log</button>'
    );
    const input = $('#voiceText'); if (input) input.focus();
  }

  function openTools() {
    openModal(
      '<div class="sheet-title">Gym tools</div>' +
      '<div class="sheet-sub">Fast calculators for machine, barbell, or home work.</div>' +
      '<div class="section-label" style="margin-top:4px">Plate math</div>' +
      '<div class="formgrid">' +
        '<label><span class="formlabel">Target lb</span><input id="toolTarget" type="number" inputmode="decimal" value="135"></label>' +
        '<label><span class="formlabel">Bar lb</span><input id="toolBar" type="number" inputmode="decimal" value="45"></label>' +
      '</div>' +
      '<div class="calc-result"><div class="calc-box"><div class="v" id="plateSide">45</div><div class="l">per side</div></div>' +
      '<div class="calc-box"><div class="v" id="plateHint">45</div><div class="l">simple load</div></div></div>' +
      '<div class="section-label">Strength estimate</div>' +
      '<div class="formgrid">' +
        '<label><span class="formlabel">Weight lb</span><input id="toolWeight" type="number" inputmode="decimal" value="135"></label>' +
        '<label><span class="formlabel">Reps</span><input id="toolReps" type="number" inputmode="numeric" value="8"></label>' +
      '</div>' +
      '<div class="calc-result"><div class="calc-box"><div class="v" id="oneRm">171</div><div class="l">est. 1RM</div></div>' +
      '<div class="calc-box"><div class="v" id="nextSet">140 x 8</div><div class="l">small jump</div></div></div>' +
      '<button class="bigbtn subtle mt16" data-action="close-modal">Close</button>'
    );
    updateToolsCalc();
  }

  function openTimeInfo() {
    const sets = allSets().filter(s => s.UserName === currentUser()).sort((a, b) => String(b.UpdatedAt || b.Date || '').localeCompare(String(a.UpdatedAt || a.Date || '')));
    const runs = allRuns().filter(r => r.UserName === currentUser()).sort((a, b) => String(b.UpdatedAt || b.Date || '').localeCompare(String(a.UpdatedAt || a.Date || '')));
    const stats = profileStatsFor(currentUser());
    const prep = getPrep();
    const activeDays = new Set(sets.map(s => String(s.Date).slice(0, 10)).concat(runs.map(r => String(r.Date).slice(0, 10))));
    const lastActivity = [sets[0], runs[0]].filter(Boolean).sort((a, b) => String(b.Date || '').localeCompare(String(a.Date || '')))[0];
    const daysSince = lastActivity ? Math.max(0, Math.round((Date.now() - new Date(String(lastActivity.Date).slice(0, 10) + 'T12:00:00').getTime()) / 86400000)) : null;
    const recent = sets.slice(0, 6);
    openModal(
      '<div class="sheet-title">Time & history</div>' +
      '<div class="sheet-sub">Dates come from the workout day; submitted time comes from UpdatedAt when the row was saved.</div>' +
      '<div class="kv"><span class="k">Last activity</span><span class="v">' + esc(lastActivity ? shortDate(lastActivity.Date) + (daysSince ? ' - ' + daysSince + ' days ago' : ' - today') : 'none yet') + '</span></div>' +
      '<div class="kv"><span class="k">Active days</span><span class="v">' + activeDays.size + ' logged day' + (activeDays.size === 1 ? '' : 's') + '</span></div>' +
      '<div class="kv"><span class="k">Prep today</span><span class="v">' + esc(prep.dirty ? 'edited, not saved' : (prep.updatedAt ? 'saved ' + timeAgo(new Date(prep.updatedAt).getTime()) : 'not saved yet')) + '</span></div>' +
      '<div class="kv"><span class="k">Latest stats</span><span class="v">' + esc(stats[0] ? shortDate(stats[0].Date) + ' - ' + [stats[0].BodyWeight_lb && stats[0].BodyWeight_lb + ' lb', stats[0].RestingHR_bpm && stats[0].RestingHR_bpm + ' bpm'].filter(Boolean).join(', ') : 'none yet') + '</span></div>' +
      '<div class="section-label">Recent submissions</div>' +
      (recent.length ? '<table class="datatable"><tr><th>Date</th><th>Exercise</th><th class="num">Set</th></tr>' +
        recent.map(s => '<tr><td>' + esc(shortDate(s.Date)) + '</td><td>' + esc(s.ExerciseName || s.ExerciseID) + '</td><td class="num">' + esc(formatSetLine(s)) + '</td></tr>').join('') + '</table>' :
        '<div class="empty"><i data-lucide="clock"></i><div>No set submissions yet.</div></div>') +
      '<button class="bigbtn subtle mt16" data-action="close-modal">Close</button>'
    );
  }

  function updateToolsCalc() {
    const target = Number((($('#toolTarget') || {}).value) || 0);
    const bar = Number((($('#toolBar') || {}).value) || 0);
    const side = Math.max(0, (target - bar) / 2);
    const plates = [45, 35, 25, 10, 5, 2.5];
    let rem = side, load = [];
    plates.forEach(p => {
      const n = Math.floor((rem + 0.001) / p);
      if (n) { load.push(n + 'x' + p); rem -= n * p; }
    });
    if ($('#plateSide')) $('#plateSide').textContent = side ? side.toFixed(side % 1 ? 1 : 0) : '-';
    if ($('#plateHint')) $('#plateHint').textContent = load.length ? load.join(' + ') : 'empty';
    const w = Number((($('#toolWeight') || {}).value) || 0);
    const reps = Number((($('#toolReps') || {}).value) || 0);
    const est = w && reps ? Math.round(w * (1 + reps / 30)) : 0;
    if ($('#oneRm')) $('#oneRm').textContent = est || '-';
    if ($('#nextSet')) $('#nextSet').textContent = w ? (Math.round((w + 5) * 10) / 10) + ' x ' + (reps || '?') : '-';
  }

  function setVoiceListening(on, text) {
    state.voice.listening = !!on;
    const btn = $('#voiceListenBtn');
    const status = $('#voiceStatus');
    if (btn) {
      btn.classList.toggle('listening', !!on);
      btn.innerHTML = '<i data-lucide="' + (on ? 'mic-off' : 'mic') + '"></i>' + (on ? 'Stop listening' : 'Listen');
    }
    if (status) {
      status.className = 'listen-status ' + (on ? 'active' : 'idle');
      status.innerHTML = '<span></span>' + esc(text || (on ? 'Listening now...' : 'Ready to listen.'));
    }
    if ($('#modalSheet')) lucide.createIcons({ nodes: [$('#modalSheet')] });
  }

  function stopVoiceInput(showToast) {
    if (state.voice && state.voice.recognition) {
      try { state.voice.recognition.stop(); } catch (e) {}
      state.voice.recognition = null;
    }
    if (state.voice && state.voice.listening) setVoiceListening(false, showToast === false ? 'Stopped listening.' : 'Listening stopped.');
  }

  function startVoiceInput() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Voice recognition is not available here. Type it instead.', 'mic-off', true); return; }
    if (state.voice.listening) { stopVoiceInput(true); return; }
    const rec = new SR();
    state.voice.recognition = rec;
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setVoiceListening(true, 'Listening now... tap again to stop.');
    rec.onresult = (ev) => {
      const text = ev.results && ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : '';
      if ($('#voiceText')) $('#voiceText').value = text;
      state.voiceDraft = parseVoiceLog(text);
      const preview = $('#voicePreview'); if (preview) preview.innerHTML = voicePreviewHtml(state.voiceDraft);
      setVoiceListening(false, text ? 'Heard: "' + text + '"' : 'No speech captured.');
      lucide.createIcons({ nodes: [$('#modalSheet')] });
    };
    rec.onerror = () => { setVoiceListening(false, 'Could not hear that. Typing works too.'); toast('Could not hear that. Typing works too.', 'mic-off', true); };
    rec.onend = () => {
      state.voice.recognition = null;
      if (state.voice.listening) setVoiceListening(false, 'Listening stopped.');
    };
    try { rec.start(); }
    catch (e) { setVoiceListening(false, 'Mic could not start. Typing works too.'); toast('Mic could not start. Typing works too.', 'mic-off', true); }
  }

  function saveVoiceLog() {
    const phrase = (($('#voiceText') || {}).value || '').trim();
    const draft = parseVoiceLog(phrase);
    if (!draft.exercise) { toast('I could not match an exercise. Try a clearer exercise name.', 'circle-alert', true); return; }
    if (!draft.reps) { toast('Add reps, like "eight reps".', 'circle-alert', true); return; }
    const priorBest = previousBestFor(draft.exercise.ExerciseID);
    const rec = {
      LogID: uid('SET'), UserName: currentUser(), Date: todayStr(),
      ExerciseID: draft.exercise.ExerciseID, ExerciseName: draft.exercise.ExerciseName,
      SetNumber: '', TargetRepsOrTime: '', ActualReps: draft.reps,
      Weight_lb: draft.weight || '', RPE_1_10: '', Pain_0_10: 0,
      Completed: true, Notes: 'Quick log: ' + phrase, UpdatedAt: new Date().toISOString(),
    };
    if (!priorBest || setScore(rec) > setScore(priorBest)) rec.Notes += ' PR';
    const logs = lsGet('ef_setlogs', []); logs.push(rec); lsSet('ef_setlogs', logs);
    post('appendExerciseLog', rec).then(() => updateSyncBadge());
    closeModal();
    toast((rec.Notes.includes('PR') ? 'New PR: ' : 'Quick logged: ') + draft.exercise.ExerciseName + '.', rec.Notes.includes('PR') ? 'trophy' : 'mic');
    render();
  }

  function openFinish() {
    const wid = state.workoutId;
    openModal(
      '<div class="sheet-title">How did it go?</div>' +
      '<div class="sheet-sub">Honest answers steer next week.</div>' +
      '<span class="formlabel">Effort</span>' +
      '<div class="effortrow" id="effortRow">' +
        ['Easy', 'Good', 'Hard'].map(v => '<button data-effort="' + v + '"' + (v === 'Good' ? ' class="sel"' : '') + '>' + v + '</button>').join('') + '</div>' +
      '<span class="formlabel mt16" style="display:block;margin-top:16px">Back pain right now</span>' +
      '<div class="painscale" id="painScale">' +
        Array.from({ length: 11 }, (_, i) => '<button data-pain="' + i + '"' + (i === 0 ? ' class="sel"' : '') + '>' + i + '</button>').join('') + '</div>' +
      '<label class="full mt16" style="display:block;margin-top:16px"><span class="formlabel">Notes</span>' +
        '<textarea id="finishNotes" rows="2" placeholder="Optional"></textarea></label>' +
      '<button class="bigbtn mt24" data-action="save-finish" data-wid="' + esc(wid) + '"><i data-lucide="flag"></i>Log it</button>'
    );
  }

  function openSettings() {
    const queued = queue();
    const q = queued.length;
    const firstQueued = q ? normalizeQueueItem(queued[0]) : null;
    const latestStats = profileStatsFor(currentUser())[0] || {};
    const profileOptions = state.users.map(u =>
      '<option value="' + esc(u.UserName) + '"' + (u.UserName === currentUser() ? ' selected' : '') + '>' + esc(u.DisplayName || u.UserName) + '</option>'
    ).join('');
    openModal(
      '<div class="sheet-title">Settings</div>' +
      '<div class="sheet-sub">Data source: ' + (state.source === 'sheet' ? 'club Google Sheet' : 'bundled library (local mode)') + '</div>' +
      '<div class="kv" style="margin-bottom:12px"><span class="k">Sync</span><span class="v">Read ' + esc(timeAgo(state.sync.lastReadAt)) +
        ' · write ' + esc(timeAgo(state.sync.lastWriteAt)) + (q ? ' · ' + q + ' queued' : '') +
        (state.sync.lastError ? ' · ' + esc(state.sync.lastError) : '') + '</span></div>' +
      (firstQueued ? '<div class="kv" style="margin-bottom:12px"><span class="k">First queued</span><span class="v">' + esc(firstQueued.action) +
        ' · tries ' + firstQueued.attempts + (firstQueued.lastError ? ' · ' + esc(firstQueued.lastError) : '') + '</span></div>' : '') +
      '<div class="kv" style="margin-bottom:12px"><span class="k">Timers</span><span class="v">Writes retry every 30 sec. Recent logs read every 2 min. Plans and profiles read every 10 min.</span></div>' +
      '<label><span class="formlabel">Profile</span><select id="setUser">' + profileOptions + '</select></label>' +
      '<button class="bigbtn subtle mt16" data-action="open-add-profile"><i data-lucide="user-plus"></i>Add profile</button>' +
      '<label class="mt16" style="display:block;margin-top:14px"><span class="formlabel">Google Sheet ID</span><input id="setSheet" placeholder="1AbC…" value="' + esc(CFG.sheetId) + '"></label>' +
      '<label class="mt16" style="display:block;margin-top:14px"><span class="formlabel">Apps Script web app URL</span><input id="setScript" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(CFG.scriptUrl) + '"></label>' +
      '<div class="kv mt16" style="border-bottom:none;align-items:center;margin-top:10px"><span class="k">Back-safe</span>' +
        '<span class="v"><button class="chip' + (CFG.backSafe ? ' active' : '') + '" data-action="toggle-backsafe">' + (CFG.backSafe ? 'Hiding red-flag exercises' : 'Showing everything') + '</button></span></div>' +
      '<div class="chiprow" style="margin:6px 0 0">' +
        '<button class="chip' + (CFG.timerSound ? ' active' : '') + '" data-action="toggle-setting" data-key="timerSound"><i data-lucide="volume-2"></i>Sound</button>' +
        '<button class="chip' + (CFG.timerVibrate ? ' active' : '') + '" data-action="toggle-setting" data-key="timerVibrate"><i data-lucide="smartphone"></i>Haptics</button>' +
        '<button class="chip' + (CFG.motionCoach ? ' active' : '') + '" data-action="toggle-setting" data-key="motionCoach"><i data-lucide="activity"></i>Motion</button>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="sheet-sub" style="margin-bottom:10px">Profile stats for ' + esc(displayNameFor(currentUser())) + '</div>' +
      '<div class="formgrid">' +
        '<label><span class="formlabel">Height in</span><input id="statHeight" type="number" inputmode="decimal" step="0.25" value="' + esc(latestStats.Height_in || '') + '"></label>' +
        '<label><span class="formlabel">Weight lb</span><input id="statWeight" type="number" inputmode="decimal" step="0.1" value="' + esc(latestStats.BodyWeight_lb || '') + '"></label>' +
        '<label><span class="formlabel">Rest HR</span><input id="statHr" type="number" inputmode="numeric" value="' + esc(latestStats.RestingHR_bpm || '') + '"></label>' +
        '<label><span class="formlabel">Date</span><input id="statDate" type="date" value="' + esc(todayStr()) + '"></label>' +
        '<label class="full"><span class="formlabel">Stats note</span><input id="statNotes" type="text" placeholder="Optional" value=""></label>' +
      '</div>' +
      '<button class="bigbtn subtle mt16" data-action="save-profile-stats"><i data-lucide="line-chart"></i>Save stats update</button>' +
      '<button class="bigbtn mt16" data-action="save-settings"><i data-lucide="save"></i>Save settings</button>' +
      '<button class="bigbtn ghost" data-action="sync-now"><i data-lucide="refresh-cw"></i>Sync now' + (q ? ' (' + q + ' queued)' : '') + '</button>' +
      '<button class="bigbtn subtle" data-action="export-data"><i data-lucide="download"></i>Export backup</button>' +
      '<button class="bigbtn subtle" data-action="import-data"><i data-lucide="upload"></i>Import backup</button>' +
      '<input type="file" id="importFile" accept="application/json" hidden>'
    );
  }

  /* ---------------- actions ---------------- */

  function logSet(exId, i, wdRow) {
    const wid = state.workoutId;
    const sess = getSession(wid);
    const ex = exById(exId) || {};
    const det = sess.details[exId] || {};
    const st = (sess.sets[exId] || [])[i] || { count: 0 };
    const pain = Number(det.pain || 0);
    const priorBest = previousBestFor(exId);
    const rec = {
      LogID: uid('SET'), UserName: currentUser(), Date: todayStr(),
      ExerciseID: exId, ExerciseName: ex.ExerciseName || exId,
      SetNumber: i + 1, TargetRepsOrTime: wdRow ? wdRow.TargetRepsOrTime : '',
      ActualReps: st.count, Weight_lb: det.weight || '', RPE_1_10: det.rpe || '',
      Pain_0_10: det.pain || 0, Completed: true, Notes: '', UpdatedAt: new Date().toISOString(),
    };
    const isPr = Number(rec.ActualReps || 0) > 0 && (!priorBest || setScore(rec) > setScore(priorBest));
    if (isPr) rec.Notes = 'PR';
    const logs = lsGet('ef_setlogs', []); logs.push(rec); lsSet('ef_setlogs', logs);
    post('appendExerciseLog', rec).then(ok => updateSyncBadge());
    if (isPr) toast('New PR: ' + (ex.ExerciseName || exId) + ' - ' + formatSetLine(rec), 'trophy');
    if (pain >= 6) {
      toast('Pain ' + pain + '/10 — stop this movement. Try ' + (ex.Regression || 'an easier version') + ' instead.', 'octagon-alert', true);
    } else if (pain === 5) {
      toast('Pain 5/10 — hold this level, no progression today.', 'shield', true);
    }
  }

  function saveRun() {
    const dist = Number($('#runDist').value);
    const mins = Number($('#runMin').value);
    if (!dist || !mins) { toast('Distance and minutes first.', 'circle-alert', true); return; }
    const pace = mins / dist, speed = dist / (mins / 60);
    $('#runCalc').hidden = false;
    $('#calcPace').textContent = paceStr(pace);
    $('#calcSpeed').textContent = speed.toFixed(2);
    const rec = {
      LogID: uid('RUN'), UserName: currentUser(), Date: todayStr(),
      Distance_km: Number(dist.toFixed(2)), Duration_min: mins,
      Pace_min_per_km: Number(pace.toFixed(2)), Speed_km_per_h: Number(speed.toFixed(2)),
      'Route/Location': $('#runRoute').value || '', RPE_1_10: $('#runRpe').value || '',
      Notes: $('#runNotes').value || '', UpdatedAt: new Date().toISOString(),
    };
    const logs = lsGet('ef_runlogs', []); logs.push(rec); lsSet('ef_runlogs', logs);
    post('appendRunLog', rec).then(() => updateSyncBadge());
    toast('Saved: ' + paceStr(pace) + ' min/km · ' + speed.toFixed(2) + ' km/h', 'footprints');
    setTimeout(() => { render(); }, 1200);
  }

  function saveJournal() {
    const rec = {
      EntryID: uid('JRN'), UserName: currentUser(), Date: todayStr(),
      Mood: $('#jMood').value === '—' ? '' : $('#jMood').value,
      Energy_1_10: $('#jEnergy').value || '', SleepHours: $('#jSleep').value || '',
      BackPain_0_10: $('#jPain').value || '', BodyWeight_lb: $('#jWeight').value || '',
      CaloriesEstimate: '', ProteinEstimate_g: '',
      Journal: $('#jNotes').value || '', UpdatedAt: new Date().toISOString(),
    };
    const logs = lsGet('ef_journal', []); logs.push(rec); lsSet('ef_journal', logs);
    post('appendJournal', rec).then(() => updateSyncBadge());
    toast('Journal saved.', 'notebook-pen');
    render();
  }

  function saveDayNote() {
    const text = (($('#dayNotes') || {}).value || '').trim();
    if (!text) { toast('Add a note first.', 'circle-alert', true); return; }
    const rec = {
      EntryID: uid('JRN'), UserName: currentUser(), Date: todayStr(),
      Mood: 'Note', Energy_1_10: '', SleepHours: '', BackPain_0_10: '', BodyWeight_lb: '',
      CaloriesEstimate: '', ProteinEstimate_g: '',
      Journal: text, UpdatedAt: new Date().toISOString(),
    };
    const logs = lsGet('ef_journal', []); logs.push(rec); lsSet('ef_journal', logs);
    post('appendJournal', rec).then(() => updateSyncBadge());
    toast('Workout note saved.', 'notebook-pen');
    render();
  }

  function savePrepChecklist() {
    const prep = getPrep();
    const taken = PREP_ITEMS.filter(([key]) => prep.items[key]).map(([, label]) => label);
    prep.updatedAt = new Date().toISOString();
    prep.dirty = false;
    setPrep(prep);
    if (taken.length) {
      const rec = {
        EntryID: uid('JRN'), UserName: currentUser(), Date: todayStr(),
        Mood: 'Prep', Energy_1_10: '', SleepHours: '', BackPain_0_10: '', BodyWeight_lb: '',
        CaloriesEstimate: '', ProteinEstimate_g: '',
        Journal: 'Pre-workout: ' + taken.join(', '), UpdatedAt: prep.updatedAt,
      };
      const logs = lsGet('ef_journal', []); logs.push(rec); lsSet('ef_journal', logs);
      post('appendJournal', rec).then(() => updateSyncBadge());
    }
    toast('Pre-workout checklist saved.', 'check-circle-2');
    render();
  }

  function saveNewProfile() {
    const display = (($('#newProfileName') || {}).value || '').trim();
    if (!display) { toast('Profile name first.', 'circle-alert', true); return; }
    const userName = compactId(display).split('_').map(part => part ? part[0] + part.slice(1).toLowerCase() : '').join('') || display;
    if (state.users.some(u => u.UserName.toLowerCase() === userName.toLowerCase())) {
      toast('That profile already exists.', 'circle-alert', true);
      return;
    }
    const rec = {
      UserName: userName,
      DisplayName: display,
      Goal: (($('#newProfileGoal') || {}).value || '').trim(),
      TrainingLocation: (($('#newProfileLocation') || {}).value || ''),
      ExperienceLevel: (($('#newProfileLevel') || {}).value || ''),
      Active: 'Yes',
    };
    appendAndPost('appendUser', state.users, rec);
    toast('Profile added for ' + rec.DisplayName + '.', 'user-plus');
    switchProfile(rec.UserName, { toast: false });
  }

  function saveProfileStats() {
    const rec = {
      StatID: uid('STAT'), UserName: currentUser(), Date: ($('#statDate') || {}).value || todayStr(),
      Height_in: ($('#statHeight') || {}).value || '',
      BodyWeight_lb: ($('#statWeight') || {}).value || '',
      RestingHR_bpm: ($('#statHr') || {}).value || '',
      Notes: ($('#statNotes') || {}).value || '',
      UpdatedAt: new Date().toISOString(),
    };
    if (!rec.Height_in && !rec.BodyWeight_lb && !rec.RestingHR_bpm && !rec.Notes) {
      toast('Add at least one stat first.', 'circle-alert', true);
      return;
    }
    const logs = lsGet('ef_profile_stats', []); logs.push(rec); lsSet('ef_profile_stats', logs);
    post('appendProfileStats', rec).then(() => updateSyncBadge());
    toast('Profile stats saved.', 'line-chart');
    closeModal();
    render();
  }

  function saveNewWorkout() {
    const name = (($('#newWorkoutName') || {}).value || '').trim();
    if (!name) { toast('Routine name first.', 'circle-alert', true); return; }
    const rec = createBlankWorkout(name, {
      goal: (($('#newWorkoutGoal') || {}).value || '').trim(),
      location: (($('#newWorkoutLocation') || {}).value || '').trim(),
      minutes: (($('#newWorkoutMinutes') || {}).value || '').trim(),
      description: (($('#newWorkoutDescription') || {}).value || '').trim(),
    });
    state.scheduleEdit = false;
    closeModal();
    toast('Routine created for ' + displayNameFor(currentUser()) + '.', 'calendar-plus');
    render();
    setTimeout(openAddExercise, 180);
    return rec;
  }

  function exportData() {
    const data = {};
    ['ef_settings', 'ef_setlogs', 'ef_runlogs', 'ef_journal', 'ef_profile_stats', 'ef_queue'].forEach(k => { data[k] = lsGet(k, null); });
    Object.keys(localStorage).forEach(k => { if (k.startsWith('ef_session_')) data[k] = lsGet(k, null); });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'form-backup-' + todayStr() + '.json';
    a.click();
    toast('Backup downloaded.', 'download');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        Object.entries(data).forEach(([k, v]) => { if (k.startsWith('ef_') && v != null) lsSet(k, v); });
        CFG = loadSettings();
        toast('Backup restored.', 'check-circle-2');
        closeModal(); boot();
      } catch (e) { toast('That file did not look like a Form backup.', 'circle-alert', true); }
    };
    reader.readAsText(file);
  }

  /* ---------------- render + events ---------------- */

  function render() {
    const views = { today: renderToday, library: renderLibrary, run: renderRun, progress: renderProgress };
    $('#view').innerHTML = (views[state.tab] || renderToday)();
    lucide.createIcons({ nodes: [$('#view')] });
    updateProfileBadge();
    updateSyncBadge();
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
  }

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action], .tab');
    if (!btn) return;

    if (btn.classList.contains('tab')) {
      state.tab = btn.dataset.tab;
      if (location.hash !== '#' + state.tab) history.replaceState(null, '', '#' + state.tab);
      window.scrollTo(0, 0);
      render();
      return;
    }

    const a = btn.dataset.action;
    const wid = state.workoutId;

    if (a === 'pick-workout') { state.workoutId = btn.dataset.id; render(); }
    else if (a === 'toggle-schedule-edit') { state.scheduleEdit = !state.scheduleEdit; render(); }
    else if (a === 'open-new-workout') { openNewWorkout(); }
    else if (a === 'save-new-workout') { saveNewWorkout(); }
    else if (a === 'delete-workout') {
      const removed = removeWorkoutFromSchedule(btn.dataset.id);
      toast(removed ? 'Routine removed from this schedule.' : 'Could not remove that routine.', removed ? 'minus-circle' : 'circle-alert', !removed);
      render();
    }
    else if (a === 'create-today-routine' || a === 'customize-today') {
      ensureTodayRoutine(state.workoutId);
      toast('Today\'s routine is ready for ' + displayNameFor(currentUser()) + '.', 'copy-plus');
      render();
    }
    else if (a === 'add-warmup') {
      if (rowsForWorkout(wid).some(isWarmupRow)) {
        const removed = removeWarmupBlock();
        toast(removed ? 'Warm-up removed from today.' : 'No warm-up to remove.', removed ? 'x' : 'check-circle-2');
      } else {
        const added = addWarmupBlock();
        toast(added ? 'Warm-up added to today.' : 'Warm-up is already in today.', added ? 'sparkles' : 'check-circle-2');
      }
      render();
    }
    else if (a === 'toggle-warmup-collapse') {
      setWarmupCollapsed(wid, !warmupCollapsed(wid));
      render();
    }
    else if (a === 'remove-warmup') {
      const removed = removeWarmupBlock();
      toast(removed ? 'Warm-up removed from today.' : 'No warm-up to remove.', removed ? 'x' : 'check-circle-2');
      render();
    }
    else if (a === 'open-add-exercise') { openAddExercise(); }
    else if (a === 'open-voice-log') { openVoiceLog(); }
    else if (a === 'open-tools') { openTools(); }
    else if (a === 'open-time-info') { openTimeInfo(); }
    else if (a === 'add-routine-exercise') {
      if (addExerciseToRoutine(btn.dataset.id)) {
        closeModal();
        toast('Exercise added to today.', 'plus');
        render();
      }
    }

    else if (a === 'inc' || a === 'dec') {
      const sess = getSession(wid); const exId = btn.dataset.ex; const i = Number(btn.dataset.i);
      sess.sets[exId] = sess.sets[exId] || [];
      const row = state.days.find(r => r.WorkoutID === wid && r.ExerciseID === exId);
      sess.sets[exId][i] = sess.sets[exId][i] || { count: repsDefault(row && row.TargetRepsOrTime), done: false };
      sess.sets[exId][i].count = Math.max(0, sess.sets[exId][i].count + (a === 'inc' ? 1 : -1));
      setSession(wid, sess);
      btn.parentElement.querySelector('.count').textContent = sess.sets[exId][i].count;
    }

    else if (a === 'complete-set') {
      const sess = getSession(wid); const exId = btn.dataset.ex; const i = Number(btn.dataset.i);
      sess.sets[exId] = sess.sets[exId] || [];
      const row = state.days.find(r => r.WorkoutID === wid && r.ExerciseID === exId);
      sess.sets[exId][i] = sess.sets[exId][i] || { count: repsDefault(row && row.TargetRepsOrTime), done: false };
      if (!sess.sets[exId][i].done) {
        sess.sets[exId][i].done = true;
        setSession(wid, sess);
        btn.classList.add('done');
        logSet(exId, i, row);
        const rest = Number((row && row.RestSeconds) || 60);
        if (rest > 0) startRest(rest);
        vibrate(30);
      } else {
        sess.sets[exId][i].done = false;
        setSession(wid, sess);
        btn.classList.remove('done');
      }
    }

    else if (a === 'add-set') {
      const sess = getSession(wid); const exId = btn.dataset.ex;
      const row = state.days.find(r => r.WorkoutID === wid && r.ExerciseID === exId);
      sess.sets[exId] = sess.sets[exId] || [];
      const n = Math.max(Number(row && row.TargetSets) || 1, sess.sets[exId].length);
      for (let i = sess.sets[exId].length; i < n; i++) sess.sets[exId][i] = { count: repsDefault(row && row.TargetRepsOrTime), done: false };
      sess.sets[exId].push({ count: repsDefault(row && row.TargetRepsOrTime), done: false });
      setSession(wid, sess);
      render();
    }

    else if (a === 'toggle-video') {
      const exId = btn.dataset.ex; const vid = btn.dataset.vid;
      const wrap = $('#vid-' + exId);
      if (!vid) {
        const url = btn.dataset.search || ('https://www.youtube.com/results?search_query=' + encodeURIComponent(btn.dataset.name + ' proper form'));
        window.open(url, '_blank', 'noopener');
        return;
      }
      if (wrap.hidden) {
        wrap.innerHTML = '<iframe src="' + esc(embedUrl(vid)) + '" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>';
        wrap.hidden = false;
      } else { wrap.hidden = true; wrap.innerHTML = ''; }
    }

    else if (a === 'toggle-details') { const el = $('#det-' + btn.dataset.ex); el.hidden = !el.hidden; }
    else if (a === 'dismiss-nudge') { dismissNudge(btn.dataset.key); render(); }
    else if (a === 'motion-set') { startMotionSet(btn.dataset.ex, btn.dataset.wd); }
    else if (a === 'rest') { startRest(Number(btn.dataset.sec) || 60); }
    else if (a === 'walk-timer') { startRest((Number(btn.dataset.min) || 20) * 60, 'walk'); toast('Walk timer running — enjoy it out there.', 'footprints'); }
    else if (a === 'finish') { openFinish(); }
    else if (a === 'save-finish') {
      const effort = ($('#effortRow .sel') || {}).dataset ? $('#effortRow .sel').dataset.effort : 'Good';
      const pain = Number((($('#painScale .sel') || {}).dataset || {}).pain || 0);
      const notes = $('#finishNotes').value || '';
      const rec = {
        EntryID: uid('JRN'), UserName: currentUser(), Date: todayStr(),
        Mood: '', Energy_1_10: '', SleepHours: '', BackPain_0_10: pain, BodyWeight_lb: '',
        CaloriesEstimate: '', ProteinEstimate_g: '',
        Journal: 'Workout ' + (state.workoutId || '') + ' finished. Effort: ' + effort + (notes ? '. ' + notes : ''),
        UpdatedAt: new Date().toISOString(),
      };
      const logs = lsGet('ef_journal', []); logs.push(rec); lsSet('ef_journal', logs);
      post('appendJournal', rec).then(() => updateSyncBadge());
      closeModal();
      if (pain >= 6) toast('Pain ' + pain + '/10 — next session will be lighter. Rest well.', 'octagon-alert', true);
      else if (pain === 5) toast('Pain 5/10 — hold this level next time. Still a win.', 'shield', true);
      else toast('Workout logged. See you next time.', 'flag');
      stopRest();
    }

    else if (a === 'open-exercise') { openExercise(btn.dataset.id); }
    else if (a === 'lib-filter') { state.lib[btn.dataset.key] = btn.dataset.v; state.lib.limit = 120; render(); }
    else if (a === 'lib-more') { state.lib.limit = (state.lib.limit || 120) + 200; render(); }
    else if (a === 'save-run') { saveRun(); }
    else if (a === 'save-day-note') { saveDayNote(); }
    else if (a === 'save-prep') { savePrepChecklist(); }
    else if (a === 'save-journal') { saveDayNote(); }
    else if (a === 'listen-voice') { startVoiceInput(); }
    else if (a === 'save-voice-log') { saveVoiceLog(); }
    else if (a === 'close-modal') { closeModal(); }

    else if (a === 'toggle-backsafe') {
      saveSettings({ backSafe: !CFG.backSafe });
      btn.classList.toggle('active', CFG.backSafe);
      btn.textContent = CFG.backSafe ? 'Hiding red-flag exercises' : 'Showing everything';
    }
    else if (a === 'toggle-setting') {
      const key = btn.dataset.key;
      if (key && Object.prototype.hasOwnProperty.call(CFG, key)) {
        const patch = {}; patch[key] = !CFG[key];
        saveSettings(patch);
        btn.classList.toggle('active', !!CFG[key]);
        toast((CFG[key] ? 'Enabled ' : 'Disabled ') + key.replace(/([A-Z])/g, ' $1').toLowerCase() + '.', 'settings-2');
      }
    }
    else if (a === 'open-add-profile') { openAddProfile(); }
    else if (a === 'save-new-profile') { saveNewProfile(); }
    else if (a === 'save-profile-stats') { saveProfileStats(); }
    else if (a === 'toggle-prep') {
      const prep = getPrep();
      prep.items[btn.dataset.key] = !prep.items[btn.dataset.key];
      prep.dirty = true;
      setPrep(prep);
      render();
    }
    else if (a === 'save-settings') {
      saveSettings({ user: $('#setUser').value.trim() || 'Azhar', sheetId: $('#setSheet').value.trim(), scriptUrl: $('#setScript').value.trim() });
      state.workoutId = null;
      closeModal(); toast('Settings saved — reloading data.', 'save');
      boot();
    }
    else if (a === 'sync-now') { syncQueue(true); }
    else if (a === 'export-data') { exportData(); }
    else if (a === 'import-data') { $('#importFile').click(); }
  });

  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'importFile' && ev.target.files[0]) importData(ev.target.files[0]);
    if (ev.target.id === 'setUser') {
      switchProfile(ev.target.value, { toast: true });
      return;
    }
    if (ev.target.dataset && ev.target.dataset.detail) {
      const sess = getSession(state.workoutId);
      const exId = ev.target.dataset.ex;
      sess.details[exId] = sess.details[exId] || {};
      sess.details[exId][ev.target.dataset.detail] = ev.target.value;
      setSession(state.workoutId, sess);
    }
  });

  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'libSearch') {
      state.lib.q = ev.target.value;
      clearTimeout(state._searchT);
      state._searchT = setTimeout(() => {
        const pos = ev.target.selectionStart;
        render();
        const inp = $('#libSearch'); if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
      }, 220);
    }
    if (ev.target.id === 'routineSearch') {
      state.routine.q = ev.target.value;
      clearTimeout(state._routineSearchT);
      state._routineSearchT = setTimeout(() => {
        const pos = ev.target.selectionStart;
        const picker = $('#exercisePicker');
        if (picker) {
          picker.innerHTML = exercisePickerHtml(state.routine.q);
          lucide.createIcons({ nodes: [picker] });
          const inp = $('#routineSearch');
          if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
        }
      }, 180);
    }
    if (ev.target.id === 'voiceText') {
      clearTimeout(state._voiceT);
      state._voiceT = setTimeout(() => {
        state.voiceDraft = parseVoiceLog(ev.target.value);
        const preview = $('#voicePreview');
        if (preview) preview.innerHTML = voicePreviewHtml(state.voiceDraft);
      }, 120);
    }
    if (ev.target.id === 'runDist' || ev.target.id === 'runMin') {
      const dist = Number($('#runDist').value), mins = Number($('#runMin').value);
      if (dist > 0 && mins > 0) {
        $('#runCalc').hidden = false;
        $('#calcPace').textContent = paceStr(mins / dist);
        $('#calcSpeed').textContent = (dist / (mins / 60)).toFixed(2);
      }
    }
    if (['toolTarget', 'toolBar', 'toolWeight', 'toolReps'].includes(ev.target.id)) updateToolsCalc();
  });

  document.addEventListener('dragstart', (ev) => {
    const item = ev.target.closest('.schedule-edit-item');
    if (!item) return;
    state.scheduleDragId = item.dataset.workoutId || '';
    item.classList.add('dragging');
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', state.scheduleDragId);
    }
  });

  document.addEventListener('dragover', (ev) => {
    const item = ev.target.closest('.schedule-edit-item, .schedule-add-row');
    if (!item || !state.scheduleDragId) return;
    ev.preventDefault();
    $$('.schedule-edit-item.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (item.classList.contains('schedule-edit-item') && item.dataset.workoutId !== state.scheduleDragId) item.classList.add('drop-target');
  });

  document.addEventListener('drop', (ev) => {
    const item = ev.target.closest('.schedule-edit-item, .schedule-add-row');
    if (!item || !state.scheduleDragId) return;
    ev.preventDefault();
    const targetId = item.classList.contains('schedule-edit-item') ? item.dataset.workoutId : '';
    if (moveWorkoutInSchedule(state.scheduleDragId, targetId)) {
      toast('Schedule reordered.', 'grip-vertical');
      render();
    }
    state.scheduleDragId = '';
  });

  document.addEventListener('dragend', () => {
    state.scheduleDragId = '';
    $$('.schedule-edit-item.dragging, .schedule-edit-item.drop-target').forEach(el => el.classList.remove('dragging', 'drop-target'));
  });

  /* modal scrim + effort/pain selection (delegated inside modal) */
  let sheetDrag = null;
  document.addEventListener('touchstart', (ev) => {
    if (!ev.target.closest('.sheet-handle')) return;
    sheetDrag = { y: ev.touches[0].clientY };
  }, { passive: true });

  document.addEventListener('touchmove', (ev) => {
    if (!sheetDrag) return;
    const dy = Math.max(0, ev.touches[0].clientY - sheetDrag.y);
    $('#modalSheet').style.transform = 'translateX(-50%) translateY(' + Math.min(120, dy) + 'px)';
  }, { passive: true });

  document.addEventListener('touchend', (ev) => {
    if (!sheetDrag) return;
    const sheet = $('#modalSheet');
    const matrix = sheet.style.transform || '';
    const match = matrix.match(/translateY\(([\d.]+)px\)/);
    const dy = match ? Number(match[1]) : 0;
    sheetDrag = null;
    if (dy > 72) closeModal();
    else sheet.style.transform = '';
  }, { passive: true });

  document.addEventListener('click', (ev) => {
    if (ev.target.id === 'modalScrim') closeModal();
    const eff = ev.target.closest('#effortRow button');
    if (eff) { $$('#effortRow button').forEach(b => b.classList.remove('sel')); eff.classList.add('sel'); }
    const p = ev.target.closest('#painScale button');
    if (p) {
      $$('#painScale button').forEach(b => b.classList.remove('sel', 'warn'));
      p.classList.add('sel'); if (Number(p.dataset.pain) >= 5) p.classList.add('warn');
    }
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#profileBtn').addEventListener('click', openSettings);
  $('#syncBtn').addEventListener('click', () => fullSync(true));
  $('#restSkip').addEventListener('click', stopRest);
  $('#restAdd').addEventListener('click', () => { state.restEnd += 15000; tickRest(); });
  $('#motionFinish').addEventListener('click', finishMotionSet);
  $('#motionCancel').addEventListener('click', () => stopMotionSet(true));

  window.addEventListener('online', () => fullSync(false));
  window.addEventListener('pagehide', beaconQueue);
  window.addEventListener('hashchange', () => {
    const next = initialTab();
    if (next !== state.tab) { state.tab = next; render(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      beaconQueue();
    } else {
      syncQueue(false);
      if (Date.now() - state.sync.lastReadAt > FOCUS_REFRESH_MS) refreshRemoteLogs(false);
      if (Date.now() - state.sync.lastCoreAt > CORE_REFRESH_MS) refreshCoreData(false);
    }
  });

  function startSyncTimers() {
    if (syncTimersStarted) return;
    syncTimersStarted = true;
    setInterval(() => syncQueue(false), WRITE_RETRY_MS);
    setInterval(() => refreshRemoteLogs(false), READ_REFRESH_MS);
    setInterval(() => refreshCoreData(false), CORE_REFRESH_MS);
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    markRuntimeClasses();
    $('#view').innerHTML = '<div class="empty" style="padding-top:80px"><i data-lucide="dumbbell"></i><div>Opening the club…</div></div>';
    lucide.createIcons({ nodes: [$('#view')] });
    updateProfileBadge();
    await loadCore();
    render();
    refreshRemoteLogs(false);
    syncQueue(false);
    startSyncTimers();
  }

  lucide.createIcons();
  boot();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      setInterval(() => reg.update(), CORE_REFRESH_MS);
    }).catch(() => {});
  }
})();
