/**
 * FORM — exercise club · Google Apps Script backend
 *
 * One-time setup:
 *   1. Open your Google Sheet → Extensions → Apps Script, paste this file.
 *   2. Run setupSheet() once (authorise when asked). It builds every tab
 *      and imports the exercise library + workouts from the GitHub repo.
 *   3. Deploy → New deployment → Web app:
 *        Execute as: Me · Who has access: Anyone
 *      Copy the /exec URL into config.js (scriptUrl) or the app's Settings.
 *   4. Share the Sheet: Anyone with the link → Viewer (lets the app read it).
 */

var SHEET_ID = '1-yrjMnyAGWDDZNa4K9NlEACqOn4iTorBwKNSMGEb4-c';
var REPO_RAW = 'https://raw.githubusercontent.com/Azr-Erzr/form-club/main/data/';
var BACKEND_VERSION = 'form-backend-v3.2';

var LOG_SHEETS = {
  appendRunLog: 'Run_Log',
  appendExerciseLog: 'Exercise_Log',
  appendJournal: 'Journal',
  appendUser: 'Users',
  appendWorkout: 'Workouts',
  appendWorkoutDay: 'Workout_Days',
  appendProfileStats: 'Profile_Stats',
};

var MONTHLY_LOG_ACTIONS = {
  appendRunLog: true,
  appendExerciseLog: true,
  appendJournal: true,
};
var LOG_READ_DAYS_DEFAULT = 180;
var LOG_READ_DAYS_MAX = 366;
var MAX_LOG_ROWS_PER_SHEET = 750;
var MAX_LOG_ROWS_RESPONSE = 1500;

var HEADERS = {
  Exercises: null, // imported from CSV
  Workouts: null,
  Workout_Days: null,
  Run_Log: ['LogID', 'UserName', 'Date', 'Distance_km', 'Duration_min', 'Pace_min_per_km',
            'Speed_km_per_h', 'Route/Location', 'RPE_1_10', 'Notes', 'UpdatedAt'],
  Exercise_Log: ['LogID', 'UserName', 'Date', 'ExerciseID', 'ExerciseName', 'SetNumber',
                 'TargetRepsOrTime', 'ActualReps', 'Weight_lb', 'RPE_1_10', 'Pain_0_10',
                 'Completed', 'Notes', 'UpdatedAt'],
  Journal: ['EntryID', 'UserName', 'Date', 'Mood', 'Energy_1_10', 'SleepHours', 'BackPain_0_10',
            'BodyWeight_lb', 'CaloriesEstimate', 'ProteinEstimate_g', 'Journal', 'UpdatedAt'],
  Users: ['UserName', 'DisplayName', 'Goal', 'TrainingLocation', 'ExperienceLevel', 'Active'],
  Profile_Stats: ['StatID', 'UserName', 'Date', 'Height_in', 'BodyWeight_lb', 'RestingHR_bpm', 'Notes', 'UpdatedAt'],
};

function setupSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);

  // Log + profile tabs with fixed headers
  Object.keys(HEADERS).forEach(function (name) {
    if (!HEADERS[name]) return;
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]])
        .setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });

  // Data tabs imported from the repo CSVs
  importCsv(ss, 'Exercises', REPO_RAW + 'exercises.csv');
  importCsv(ss, 'Workouts', REPO_RAW + 'workouts.csv');
  importCsv(ss, 'Workout_Days', REPO_RAW + 'workout_days.csv');
  setupMonthlyLogTabs();

  // Starter profile rows
  var users = ss.getSheetByName('Users');
  var existingUsers = {};
  if (users.getLastRow() > 1) {
    users.getRange(2, 1, users.getLastRow() - 1, 1).getValues()
      .forEach(function (row) { if (row[0]) existingUsers[String(row[0])] = true; });
  }
  [
    ['Azhar', 'Azhar', 'Fat loss + strength', 'Home', 'Beginner', 'Yes'],
    ['Koby', 'Koby', '', '', '', 'Yes'],
    ['Gianluca', 'Gianluca', '', '', '', 'Yes'],
    ['Patrick', 'Patrick', '', '', '', 'Yes'],
    ['Adriano', 'Adriano', '', '', '', 'Yes'],
  ].forEach(function (row) {
    if (!existingUsers[row[0]]) users.appendRow(row);
  });

  // Drop the default empty sheet if present
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
}

function importCsv(ss, name, url) {
  var text = UrlFetchApp.fetch(url).getContentText();
  var rows = Utilities.parseCsv(text);
  if (!rows.length) return;
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'status') return json({ ok: true, version: BACKEND_VERSION, actions: Object.keys(LOG_SHEETS).concat(['deleteWorkoutDay', 'deleteWorkout', 'reorderWorkouts', 'readLogs']) });
  if (action === 'readLogs') return json(readLogs(e.parameter || {}));
  if (action === 'setupMonthlyLogTabs') {
    setupMonthlyLogTabs();
    return json({ ok: true, created: currentMonthlyLogSheetNames() });
  }
  return json({ ok: true, club: 'FORM', hint: 'POST {action, payload} to log, GET ?action=readLogs for bounded recent logs.' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'deleteWorkoutDay') return json(deleteById('Workout_Days', 'WorkoutDayID', body.payload && body.payload.WorkoutDayID));
    if (body.action === 'deleteWorkout') return json(markWorkoutInactive(body.payload && body.payload.WorkoutID));
    if (body.action === 'reorderWorkouts') return json(reorderWorkouts(body.payload || {}));
    var sheetName = LOG_SHEETS[body.action];
    if (!sheetName) return json({ ok: false, error: 'Unknown action: ' + body.action });

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var ss = SpreadsheetApp.openById(SHEET_ID);
      var sh = sheetForWrite(ss, body.action, body.payload || {});
      if (!sh) return json({ ok: false, error: 'Missing tab: ' + sheetName + '. Run setupSheet().' });
      if (body.action === 'appendWorkout') ensureColumn(sh, 'SortOrder');
      var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      var idHeader = body.payload.LogID ? 'LogID'
        : (body.payload.EntryID ? 'EntryID'
        : (body.payload.WorkoutDayID ? 'WorkoutDayID'
        : (body.payload.WorkoutID ? 'WorkoutID'
        : (body.payload.StatID ? 'StatID'
        : (body.payload.UserName ? 'UserName' : '')))));
      var idValue = idHeader ? String(body.payload[idHeader]) : '';
      var idCol = idHeader ? headers.indexOf(idHeader) + 1 : 0;
      if (idValue && idCol > 0) {
        var dedupeSheets = MONTHLY_LOG_ACTIONS[body.action] ? candidateMonthlySheets(ss, sheetName, body.payload.Date || new Date()) : [sheetName];
        if (hasExistingId(ss, dedupeSheets, idHeader, idValue)) return json({ ok: true, deduped: true, sheet: sh.getName() });
      }
      var row = headers.map(function (h) {
        var v = body.payload[h];
        return v === undefined || v === null ? '' : v;
      });
      sh.appendRow(row);
    } finally {
      lock.releaseLock();
    }
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function ensureColumn(sh, header) {
  var lastCol = Math.max(1, sh.getLastColumn());
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = headers.indexOf(header) + 1;
  if (idx > 0) return idx;
  sh.getRange(1, lastCol + 1).setValue(header).setFontWeight('bold');
  return lastCol + 1;
}

function markWorkoutInactive(workoutId) {
  if (!workoutId) return { ok: false, error: 'Missing WorkoutID' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName('Workouts');
    if (!sh) return { ok: false, error: 'Missing tab: Workouts. Run setupSheet().' };
    var idCol = ensureColumn(sh, 'WorkoutID');
    var activeCol = ensureColumn(sh, 'Active');
    var last = sh.getLastRow();
    if (last <= 1) return { ok: true, updated: false };
    var values = sh.getRange(2, idCol, last - 1, 1).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      if (String(values[i][0]) === String(workoutId)) {
        sh.getRange(i + 2, activeCol).setValue('No');
        return { ok: true, updated: true };
      }
    }
    return { ok: true, updated: false };
  } finally {
    lock.releaseLock();
  }
}

function reorderWorkouts(payload) {
  var ids = String(payload.WorkoutIDs || '').split('|').filter(Boolean);
  if (!ids.length) return { ok: false, error: 'Missing WorkoutIDs' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName('Workouts');
    if (!sh) return { ok: false, error: 'Missing tab: Workouts. Run setupSheet().' };
    var idCol = ensureColumn(sh, 'WorkoutID');
    var orderCol = ensureColumn(sh, 'SortOrder');
    var order = {};
    ids.forEach(function (id, i) { order[id] = i + 1; });
    var last = sh.getLastRow();
    if (last <= 1) return { ok: true, updated: 0 };
    var values = sh.getRange(2, idCol, last - 1, 1).getValues();
    var updated = 0;
    values.forEach(function (row, i) {
      var id = String(row[0] || '');
      if (order[id]) {
        sh.getRange(i + 2, orderCol).setValue(order[id]);
        updated++;
      }
    });
    return { ok: true, updated: updated };
  } finally {
    lock.releaseLock();
  }
}

function deleteById(sheetName, idHeader, idValue) {
  if (!idValue) return { ok: false, error: 'Missing ' + idHeader };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(sheetName);
    if (!sh) return { ok: false, error: 'Missing tab: ' + sheetName + '. Run setupSheet().' };
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var idCol = headers.indexOf(idHeader) + 1;
    if (idCol <= 0) return { ok: false, error: 'Missing header: ' + idHeader };
    var last = sh.getLastRow();
    if (last <= 1) return { ok: true, deleted: false };
    var values = sh.getRange(2, idCol, last - 1, 1).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      if (String(values[i][0]) === String(idValue)) {
        sh.deleteRow(i + 2);
        return { ok: true, deleted: true };
      }
    }
    return { ok: true, deleted: false };
  } finally {
    lock.releaseLock();
  }
}

function setupMonthlyLogTabs() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  currentMonthlyLogSheetNames().forEach(function (name) {
    var base = name.replace(/_\d{4}_\d{2}$/, '');
    ensureSheetWithHeaders(ss, name, HEADERS[base]);
  });
}

function currentMonthlyLogSheetNames() {
  return ['Run_Log', 'Exercise_Log', 'Journal'].map(function (base) {
    return monthlySheetName(base, new Date());
  });
}

function sheetForWrite(ss, action, payload) {
  var base = LOG_SHEETS[action];
  if (MONTHLY_LOG_ACTIONS[action]) {
    return ensureSheetWithHeaders(ss, monthlySheetName(base, payload.Date || new Date()), HEADERS[base]);
  }
  return ensureSheetWithHeaders(ss, base, HEADERS[base]);
}

function ensureSheetWithHeaders(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (headers && sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function monthlySheetName(base, value) {
  var d = value instanceof Date ? value : new Date(String(value).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d)) d = new Date();
  return base + '_' + d.getUTCFullYear() + '_' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function candidateMonthlySheets(ss, base, dateValue) {
  var names = [base, monthlySheetName(base, dateValue)];
  var seen = {};
  return names.filter(function (name) {
    if (seen[name]) return false;
    seen[name] = true;
    return !!ss.getSheetByName(name);
  });
}

function hasExistingId(ss, sheetNames, idHeader, idValue) {
  for (var s = 0; s < sheetNames.length; s++) {
    var sh = ss.getSheetByName(sheetNames[s]);
    if (!sh || sh.getLastRow() <= 1) continue;
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var idCol = headers.indexOf(idHeader) + 1;
    if (idCol < 1) continue;
    var firstRow = Math.max(2, sh.getLastRow() - MAX_LOG_ROWS_PER_SHEET + 1);
    var existing = sh.getRange(firstRow, idCol, sh.getLastRow() - firstRow + 1, 1).getValues();
    for (var i = 0; i < existing.length; i++) {
      if (String(existing[i][0]) === idValue) return true;
    }
  }
  return false;
}

function readLogs(params) {
  var days = Math.min(Math.max(Number(params.days || LOG_READ_DAYS_DEFAULT), 7), LOG_READ_DAYS_MAX);
  var since = dateStringDaysAgo(days);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  return {
    ok: true,
    bounded: true,
    since: since,
    days: days,
    runs: readRecentRows(ss, 'Run_Log', since),
    sets: readRecentRows(ss, 'Exercise_Log', since),
    journal: readRecentRows(ss, 'Journal', since),
    profileStats: readRecentRows(ss, 'Profile_Stats', since),
  };
}

function readRecentRows(ss, base, since) {
  var names = recentMonthlyNames(base, since);
  names.unshift(base); // legacy tab, bounded from the bottom.
  var rows = [];
  var seen = {};
  names.forEach(function (name) {
    if (seen[name]) return;
    seen[name] = true;
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() <= 1) return;
    var lastCol = sh.getLastColumn();
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var dateIndex = headers.indexOf('Date');
    var firstRow = Math.max(2, sh.getLastRow() - MAX_LOG_ROWS_PER_SHEET + 1);
    var values = sh.getRange(firstRow, 1, sh.getLastRow() - firstRow + 1, lastCol).getValues();
    values.forEach(function (r) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = r[i] === null ? '' : r[i]; });
      var rowDate = dateIndex >= 0 ? normalizeDateValue(r[dateIndex]) : '';
      if (!rowDate || rowDate >= since) rows.push(obj);
    });
  });
  rows.sort(function (a, b) { return String(b.Date || '').localeCompare(String(a.Date || '')); });
  return rows.slice(0, MAX_LOG_ROWS_RESPONSE);
}

function recentMonthlyNames(base, since) {
  // Compare month indices, not Date objects — comparing Dates dropped the
  // current month whenever the clock time was before the fixed 12:00Z start.
  var out = [];
  var s = new Date(since + 'T12:00:00Z');
  var now = new Date();
  var cur = s.getUTCFullYear() * 12 + s.getUTCMonth();
  var last = now.getUTCFullYear() * 12 + now.getUTCMonth();
  for (; cur <= last; cur++) {
    out.push(base + '_' + Math.floor(cur / 12) + '_' + String((cur % 12) + 1).padStart(2, '0'));
  }
  return out;
}

function dateStringDaysAgo(days) {
  var d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function normalizeDateValue(value) {
  if (value instanceof Date) {
    return value.getUTCFullYear() + '-' + String(value.getUTCMonth() + 1).padStart(2, '0') + '-' + String(value.getUTCDate()).padStart(2, '0');
  }
  return String(value || '').slice(0, 10);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
