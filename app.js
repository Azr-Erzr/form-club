/* ============================================================
   FORM — exercise club
   Vanilla JS, no build step. Google Sheet = database,
   Apps Script = write-back, localStorage = offline cache.
   ============================================================ */

(function () {
  'use strict';

  /* ---------------- config + storage ---------------- */

  const DEFAULTS = { sheetId: '', scriptUrl: '', user: 'Azhar', backSafe: true };

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

  function lsGet(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
  }
  function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  /* ---------------- utils ---------------- */

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

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

  /* ---------------- data layer ---------------- */

  const state = {
    tab: 'today',
    exercises: [], workouts: [], days: [],
    remote: { runs: [], sets: [], journal: [], loaded: false },
    source: 'local',
    lib: { q: '', cat: 'All', place: 'All', diff: 'All' },
    workoutId: null,
    restEnd: 0, restTimer: null,
  };

  function sheetCsvUrl(tab) {
    return 'https://docs.google.com/spreadsheets/d/' + CFG.sheetId +
      '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(tab);
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

  async function loadCore() {
    const [ex, w, d] = await Promise.all([
      fetchTable('Exercises', 'data/exercises.csv'),
      fetchTable('Workouts', 'data/workouts.csv'),
      fetchTable('Workout_Days', 'data/workout_days.csv'),
    ]);
    state.exercises = ex; state.workouts = w.filter(x => (x.Active || 'Yes') !== 'No'); state.days = d;
  }

  async function loadRemoteLogs() {
    if (!CFG.sheetId) { state.remote.loaded = true; return; }
    try {
      const [runs, sets, journal] = await Promise.all([
        fetchTable('Run_Log'), fetchTable('Exercise_Log'), fetchTable('Journal'),
      ]);
      state.remote = { runs, sets, journal, loaded: true };
    } catch (e) { state.remote.loaded = true; }
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

  /* ---------------- write-back + queue ---------------- */

  function queue() { return lsGet('ef_queue', []); }
  function setQueue(q) { lsSet('ef_queue', q); updateSyncBadge(); }

  async function post(action, payload) {
    if (!CFG.scriptUrl) { setQueue(queue().concat([{ action, payload }])); return false; }
    try {
      const r = await fetch(CFG.scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || 'write failed');
      return true;
    } catch (e) {
      setQueue(queue().concat([{ action, payload }]));
      return false;
    }
  }

  async function syncQueue(showToast) {
    const q = queue();
    if (!q.length) { if (showToast) toast('Everything is synced.', 'check-circle-2'); return; }
    if (!CFG.scriptUrl) { if (showToast) toast('Add your Apps Script URL in settings first.', 'plug-zap', true); return; }
    let remaining = [];
    for (const item of q) {
      try {
        const r = await fetch(CFG.scriptUrl, {
          method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(item),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error('fail');
      } catch (e) { remaining.push(item); }
    }
    setQueue(remaining);
    if (showToast) {
      if (remaining.length) toast(remaining.length + ' logs still unsynced — will retry.', 'cloud-off', true);
      else toast('All logs synced to the club sheet.', 'check-circle-2');
    }
  }

  function updateSyncBadge() {
    const n = queue().length;
    const b = $('#syncBadge');
    if (b) { b.hidden = n === 0; b.textContent = n; }
    const btn = $('#syncBtn');
    if (btn) btn.classList.toggle('synced', n === 0 && !!CFG.scriptUrl);
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

  /* ---------------- modal ---------------- */

  function openModal(html) {
    $('#modalSheet').innerHTML = '<div class="sheet-handle"></div>' + html;
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';
    lucide.createIcons({ nodes: [$('#modalSheet')] });
  }
  function closeModal() {
    $('#modal').hidden = true;
    $('#modalSheet').innerHTML = '';
    document.body.style.overflow = '';
  }

  /* ---------------- rest timer ---------------- */

  function startRest(seconds, label) {
    state.restEnd = Date.now() + seconds * 1000;
    state.restLabel = label || 'rest';
    $('.restbar-label').textContent = state.restLabel;
    $('#restbar').hidden = false;
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
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      toast(state.restLabel === 'walk' ? 'Walk done — log it in the Run tab.' : 'Rest is over — next set.', 'timer');
    }
  }
  function stopRest() {
    if (state.restTimer) clearInterval(state.restTimer);
    state.restTimer = null;
    $('#restbar').hidden = true;
  }

  /* ---------------- session (Today) ---------------- */

  function sessionKey(wid) { return 'ef_session_' + todayStr() + '_' + wid; }
  function getSession(wid) { return lsGet(sessionKey(wid), { sets: {}, details: {} }); }
  function setSession(wid, sess) { lsSet(sessionKey(wid), sess); }

  function suggestedWorkoutId() {
    const dow = new Date().getDay(); // 0 Sun
    const map = { 1: 'HOME_A', 2: 'MIN_DAY', 3: 'HOME_B', 4: 'BACK_RESET', 5: 'HOME_A', 6: 'HOME_B', 0: 'MIN_DAY' };
    const id = map[dow];
    return state.workouts.some(w => w.WorkoutID === id) ? id : (state.workouts[0] || {}).WorkoutID;
  }

  function repsDefault(target) {
    const m = String(target || '').match(/(\d+)/g);
    if (!m) return 10;
    return m.length > 1 ? Number(m[1]) : Number(m[0]);
  }

  /* progression: completed >= target sets on 2+ separate days with pain <= 4 */
  function progressionReady(exId, targetSets) {
    const sets = lsGet('ef_setlogs', []).filter(s => s.ExerciseID === exId && s.Completed);
    const byDate = {};
    sets.forEach(s => {
      byDate[s.Date] = byDate[s.Date] || { n: 0, pain: 0 };
      byDate[s.Date].n++;
      byDate[s.Date].pain = Math.max(byDate[s.Date].pain, Number(s.Pain_0_10 || 0));
    });
    const good = Object.values(byDate).filter(d => d.n >= (Number(targetSets) || 2) && d.pain <= 4);
    return good.length >= 2;
  }

  /* ---------------- views ---------------- */

  function flagClass(f) {
    const v = String(f || '').toLowerCase();
    return v === 'red' ? 'flag-red' : v === 'amber' || v === 'yellow' ? 'flag-amber' : 'flag-green';
  }

  function renderToday() {
    const wid = state.workoutId || suggestedWorkoutId();
    state.workoutId = wid;
    const workout = state.workouts.find(w => w.WorkoutID === wid);
    const sugg = suggestedWorkoutId();
    const sess = getSession(wid);

    const chips = state.workouts.map(w =>
      '<button class="chip' + (w.WorkoutID === wid ? ' active' : '') + '" data-action="pick-workout" data-id="' + esc(w.WorkoutID) + '">' +
      esc(w.WorkoutName) + (w.WorkoutID === sugg ? '<span class="sug">today</span>' : '') + '</button>'
    ).join('');

    let cards = '';
    if (workout) {
      const rows = state.days.filter(d => d.WorkoutID === wid).sort((a, b) => Number(a.Order) - Number(b.Order));
      cards = rows.map(row => {
        const ex = exById(row.ExerciseID) || { ExerciseName: row.ExerciseID, BackFlag: 'Green' };
        const nSets = Number(row.TargetSets) || 1;
        const done = sess.sets[row.ExerciseID] || [];
        const vid = videoIdOf(ex);
        const ready = progressionReady(row.ExerciseID, nSets) && ex.Progression;
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
        '<div class="card excard" id="ex-' + esc(row.ExerciseID) + '">' +
          '<div class="excard-head">' +
            '<span class="flag ' + flagClass(ex.BackFlag) + '"></span>' +
            '<div style="flex:1">' +
              '<div class="excard-name">' + esc(ex.ExerciseName) + '</div>' +
              (ready ? '<div class="badge badge-gold mt8"><i data-lucide="arrow-up-right"></i> ready to try: ' + esc(ex.Progression) + '</div>' : '') +
            '</div>' +
            '<span class="excard-target">' + esc(row.TargetSets) + ' × ' + esc(row.TargetRepsOrTime) + '</span>' +
          '</div>' +
          (ex.CoachingCues ? '<div class="excard-cues">' + esc(ex.CoachingCues) + '</div>' : '') +
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
            '<button class="toolbtn" data-action="add-set" data-ex="' + esc(row.ExerciseID) + '"><i data-lucide="plus"></i>Add set</button>' +
            '<button class="toolbtn" data-action="rest" data-sec="' + esc(row.RestSeconds || ex.RestSeconds || 60) + '"><i data-lucide="timer"></i>' + esc(row.RestSeconds || ex.RestSeconds || 60) + 's</button>' +
          '</div>' +
        '</div>');
      }).join('');
    }

    /* session progress: done sets vs planned sets */
    let planned = 0, doneSets = 0;
    state.days.filter(d => d.WorkoutID === wid).forEach(row => {
      const arr = sess.sets[row.ExerciseID] || [];
      planned += Math.max(Number(row.TargetSets) || 1, arr.length);
      doneSets += arr.filter(s => s && s.done).length;
    });
    const pct = planned ? Math.round((doneSets / planned) * 100) : 0;

    return (
      '<div class="eyebrow">' + esc(niceDate()) + '</div>' +
      '<div class="titlerow"><h1 class="pagetitle">' + esc(workout ? workout.WorkoutName : 'No workout') + '</h1>' +
        (doneSets ? '<span class="excard-target">' + doneSets + ' / ' + planned + ' sets</span>' : '') + '</div>' +
      (doneSets ? '<div class="hairbar"><span style="width:' + pct + '%"></span></div>' : '') +
      '<p class="pagesub">' + esc(workout ? (workout.Description + ' · about ' + workout.EstimatedMinutes + ' min') : 'Pick a plan below.') + '</p>' +
      '<div class="chiprow">' + chips + '</div>' +
      (workout && workout.BackWarning ? '<div class="badge mt8" style="margin-bottom:14px"><i data-lucide="shield"></i>' + esc(workout.BackWarning) + '</div>' : '') +
      cards +
      '<button class="bigbtn mt16" data-action="finish"><i data-lucide="flag"></i>Finish workout</button>'
    );
  }

  function renderLibrary() {
    const L = state.lib;
    const cats = ['All'].concat([...new Set(state.exercises.map(e => e.Category).filter(Boolean))].sort());
    const places = ['All', 'Home', 'Gym'];
    const diffs = ['All', 'Beginner', 'Intermediate', 'Advanced'];

    let list = state.exercises.filter(e => {
      if (CFG.backSafe && String(e.BackFlag).toLowerCase() === 'red') return false;
      if (L.q && !(e.ExerciseName + ' ' + e.PrimaryMuscles + ' ' + e.Equipment + ' ' + e.MovementPattern).toLowerCase().includes(L.q.toLowerCase())) return false;
      if (L.cat !== 'All' && e.Category !== L.cat) return false;
      if (L.place !== 'All' && !(String(e.BestFor || '').includes(L.place))) return false;
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
      list.map(e =>
        '<button class="libitem" data-action="open-exercise" data-id="' + esc(e.ExerciseID) + '">' +
          '<span class="flag ' + flagClass(e.BackFlag) + '"></span>' +
          '<span class="libitem-body">' +
            '<div class="libitem-name">' + esc(e.ExerciseName) + '</div>' +
            '<div class="libitem-meta">' + esc([e.PrimaryMuscles, e.Equipment, e.Difficulty].filter(Boolean).join(' · ')) + '</div>' +
          '</span><i data-lucide="chevron-right"></i>' +
        '</button>'
      ).join('') +
      (list.length ? '' : '<div class="empty"><i data-lucide="search-x"></i><div>Nothing matches — loosen the filters.</div></div>')
    );
  }

  function paceStr(minPerKm) {
    if (!isFinite(minPerKm) || minPerKm <= 0) return '—';
    const m = Math.floor(minPerKm), s = Math.round((minPerKm - m) * 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function renderRun() {
    const runs = allRuns().sort((a, b) => String(b.Date).localeCompare(String(a.Date))).slice(0, 12);
    const ws = weekStart();
    const byUser = {};
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
      '<p class="pagesub">Distance in, pace out. Saved to the club sheet.</p>' +
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
          '<tr><td>' + esc(u) + '</td><td class="num">' + s.km.toFixed(2) + '</td><td class="num">' + s.runs + '</td>' +
          '<td class="num">' + (s.best < Infinity ? paceStr(s.best) : '—') + '</td></tr>').join('') +
        '</table>' : '') +

      '<div class="section-label">Recent outings</div>' +
      (runs.length ?
        '<table class="datatable"><tr><th>Date</th><th>Who</th><th class="num">km</th><th class="num">pace</th></tr>' +
        runs.map(r =>
          '<tr><td>' + esc(shortDate(r.Date)) + '</td><td>' + esc(r.UserName) + '</td>' +
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
      '<polyline points="' + pts + '" fill="none" stroke="#C6A15B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
    const me = CFG.user;

    const mySets = sets.filter(s => s.UserName === me);
    const myRuns = runs.filter(r => r.UserName === me);
    const setsWeek = mySets.filter(s => String(s.Date) >= ws).length;
    const kmWeek = myRuns.filter(r => String(r.Date) >= ws).reduce((a, r) => a + Number(r.Distance_km || 0), 0);
    const workoutsWeek = new Set(mySets.filter(s => String(s.Date) >= ws).map(s => s.Date)).size;

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
    sets.forEach(s => { if (String(s.Date) >= ws) { users[s.UserName] = users[s.UserName] || { sets: 0, km: 0 }; users[s.UserName].sets++; } });
    runs.forEach(r => { if (String(r.Date) >= ws) { users[r.UserName] = users[r.UserName] || { sets: 0, km: 0 }; users[r.UserName].km += Number(r.Distance_km || 0); } });
    const friends = Object.entries(users).sort((a, b) => (b[1].sets + b[1].km) - (a[1].sets + a[1].km));

    return (
      '<div class="eyebrow">Quiet momentum</div>' +
      '<h1 class="pagetitle">Progress</h1>' +
      '<p class="pagesub">Consistency beats intensity. Here is yours.</p>' +
      '<div class="statgrid">' +
        '<div class="stat"><div class="stat-num">' + workoutsWeek + '</div><div class="stat-label">workouts this week</div></div>' +
        '<div class="stat"><div class="stat-num">' + setsWeek + '</div><div class="stat-label">sets this week</div></div>' +
        '<div class="stat"><div class="stat-num">' + kmWeek.toFixed(1) + '<small> km</small></div><div class="stat-label">distance this week</div></div>' +
        '<div class="stat"><div class="stat-num">' + streak + '<small> day' + (streak === 1 ? '' : 's') + '</small></div><div class="stat-label">streak</div></div>' +
      '</div>' +
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
        friends.map(([u, s]) => '<tr><td>' + esc(u) + '</td><td class="num">' + s.sets + '</td><td class="num">' + s.km.toFixed(1) + '</td></tr>').join('') +
        '</table>' : '') +
      (state.source === 'local' && !CFG.sheetId ?
        '<div class="card mt24"><div class="badge"><i data-lucide="plug"></i>Local mode</div>' +
        '<p class="pagesub mt8" style="margin-bottom:0">Connect the Google Sheet in settings to compare with friends.</p></div>' : '')
    );
  }

  function renderJournal() {
    const entries = allJournal().filter(j => j.UserName === CFG.user)
      .sort((a, b) => String(b.Date).localeCompare(String(a.Date))).slice(0, 10);
    return (
      '<div class="eyebrow">' + esc(niceDate()) + '</div>' +
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
    openModal(
      '<div style="display:flex;gap:10px;align-items:baseline">' +
        '<span class="flag ' + flagClass(e.BackFlag) + '"></span>' +
        '<div class="sheet-title">' + esc(e.ExerciseName) + '</div></div>' +
      '<div class="sheet-sub">' + esc([e.Category, e.MovementPattern, e.Difficulty].filter(Boolean).join(' · ')) + '</div>' +
      (vid ? '<div class="videowrap" style="padding:0 0 14px"><iframe src="https://www.youtube.com/embed/' + esc(vid) + '" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>'
           : (e.YouTubeSearchURL ? '<a class="bigbtn ghost" style="margin-bottom:14px;text-decoration:none" href="' + esc(e.YouTubeSearchURL) + '" target="_blank" rel="noopener"><i data-lucide="youtube"></i>Search form videos</a>' : '')) +
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
    const q = queue().length;
    openModal(
      '<div class="sheet-title">Settings</div>' +
      '<div class="sheet-sub">Data source: ' + (state.source === 'sheet' ? 'club Google Sheet' : 'bundled library (local mode)') + '</div>' +
      '<label><span class="formlabel">Your display name</span><input id="setUser" value="' + esc(CFG.user) + '"></label>' +
      '<label class="mt16" style="display:block;margin-top:14px"><span class="formlabel">Google Sheet ID</span><input id="setSheet" placeholder="1AbC…" value="' + esc(CFG.sheetId) + '"></label>' +
      '<label class="mt16" style="display:block;margin-top:14px"><span class="formlabel">Apps Script web app URL</span><input id="setScript" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(CFG.scriptUrl) + '"></label>' +
      '<div class="kv mt16" style="border-bottom:none;align-items:center;margin-top:10px"><span class="k">Back-safe</span>' +
        '<span class="v"><button class="chip' + (CFG.backSafe ? ' active' : '') + '" data-action="toggle-backsafe">' + (CFG.backSafe ? 'Hiding red-flag exercises' : 'Showing everything') + '</button></span></div>' +
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
    const rec = {
      LogID: uid('SET'), UserName: CFG.user, Date: todayStr(),
      ExerciseID: exId, ExerciseName: ex.ExerciseName || exId,
      SetNumber: i + 1, TargetRepsOrTime: wdRow ? wdRow.TargetRepsOrTime : '',
      ActualReps: st.count, Weight_lb: det.weight || '', RPE_1_10: det.rpe || '',
      Pain_0_10: det.pain || 0, Completed: true, Notes: '', UpdatedAt: new Date().toISOString(),
    };
    const logs = lsGet('ef_setlogs', []); logs.push(rec); lsSet('ef_setlogs', logs);
    post('appendExerciseLog', rec).then(ok => updateSyncBadge());
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
      LogID: uid('RUN'), UserName: CFG.user, Date: todayStr(),
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
      EntryID: uid('JRN'), UserName: CFG.user, Date: todayStr(),
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

  function exportData() {
    const data = {};
    ['ef_settings', 'ef_setlogs', 'ef_runlogs', 'ef_journal', 'ef_queue'].forEach(k => { data[k] = lsGet(k, null); });
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
    const views = { today: renderToday, library: renderLibrary, run: renderRun, progress: renderProgress, journal: renderJournal };
    $('#view').innerHTML = (views[state.tab] || renderToday)();
    lucide.createIcons({ nodes: [$('#view')] });
    updateSyncBadge();
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
  }

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action], .tab');
    if (!btn) return;

    if (btn.classList.contains('tab')) {
      state.tab = btn.dataset.tab;
      window.scrollTo(0, 0);
      render();
      return;
    }

    const a = btn.dataset.action;
    const wid = state.workoutId;

    if (a === 'pick-workout') { state.workoutId = btn.dataset.id; render(); }

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
        if (navigator.vibrate) navigator.vibrate(30);
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
        wrap.innerHTML = '<iframe src="https://www.youtube.com/embed/' + esc(vid) + '" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>';
        wrap.hidden = false;
      } else { wrap.hidden = true; wrap.innerHTML = ''; }
    }

    else if (a === 'toggle-details') { const el = $('#det-' + btn.dataset.ex); el.hidden = !el.hidden; }
    else if (a === 'rest') { startRest(Number(btn.dataset.sec) || 60); }
    else if (a === 'walk-timer') { startRest((Number(btn.dataset.min) || 20) * 60, 'walk'); toast('Walk timer running — enjoy it out there.', 'footprints'); }
    else if (a === 'finish') { openFinish(); }
    else if (a === 'save-finish') {
      const effort = ($('#effortRow .sel') || {}).dataset ? $('#effortRow .sel').dataset.effort : 'Good';
      const pain = Number((($('#painScale .sel') || {}).dataset || {}).pain || 0);
      const notes = $('#finishNotes').value || '';
      const rec = {
        EntryID: uid('JRN'), UserName: CFG.user, Date: todayStr(),
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
    else if (a === 'lib-filter') { state.lib[btn.dataset.key] = btn.dataset.v; render(); }
    else if (a === 'save-run') { saveRun(); }
    else if (a === 'save-journal') { saveJournal(); }
    else if (a === 'close-modal') { closeModal(); }

    else if (a === 'toggle-backsafe') {
      saveSettings({ backSafe: !CFG.backSafe });
      btn.classList.toggle('active', CFG.backSafe);
      btn.textContent = CFG.backSafe ? 'Hiding red-flag exercises' : 'Showing everything';
    }
    else if (a === 'save-settings') {
      saveSettings({ user: $('#setUser').value.trim() || 'Azhar', sheetId: $('#setSheet').value.trim(), scriptUrl: $('#setScript').value.trim() });
      closeModal(); toast('Settings saved — reloading data.', 'save');
      boot();
    }
    else if (a === 'sync-now') { syncQueue(true); }
    else if (a === 'export-data') { exportData(); }
    else if (a === 'import-data') { $('#importFile').click(); }
  });

  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'importFile' && ev.target.files[0]) importData(ev.target.files[0]);
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
    if (ev.target.id === 'runDist' || ev.target.id === 'runMin') {
      const dist = Number($('#runDist').value), mins = Number($('#runMin').value);
      if (dist > 0 && mins > 0) {
        $('#runCalc').hidden = false;
        $('#calcPace').textContent = paceStr(mins / dist);
        $('#calcSpeed').textContent = (dist / (mins / 60)).toFixed(2);
      }
    }
  });

  /* modal scrim + effort/pain selection (delegated inside modal) */
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
  $('#syncBtn').addEventListener('click', () => syncQueue(true));
  $('#restSkip').addEventListener('click', stopRest);
  $('#restAdd').addEventListener('click', () => { state.restEnd += 15000; tickRest(); });

  window.addEventListener('online', () => syncQueue(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncQueue(false); });

  /* ---------------- boot ---------------- */

  async function boot() {
    $('#view').innerHTML = '<div class="empty" style="padding-top:80px"><i data-lucide="dumbbell"></i><div>Opening the club…</div></div>';
    lucide.createIcons({ nodes: [$('#view')] });
    await loadCore();
    render();
    loadRemoteLogs().then(() => { if (state.tab === 'run' || state.tab === 'progress' || state.tab === 'journal') render(); });
    syncQueue(false);
  }

  lucide.createIcons();
  boot();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
