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

var LOG_SHEETS = {
  appendRunLog: 'Run_Log',
  appendExerciseLog: 'Exercise_Log',
  appendJournal: 'Journal',
};

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

  // Starter profile row
  var users = ss.getSheetByName('Users');
  if (users.getLastRow() < 2) {
    users.appendRow(['Azhar', 'Azhar', 'Fat loss + strength', 'Home', 'Beginner', 'Yes']);
  }

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

function doGet() {
  return json({ ok: true, club: 'FORM', hint: 'POST {action, payload} to log.' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var sheetName = LOG_SHEETS[body.action];
    if (!sheetName) return json({ ok: false, error: 'Unknown action: ' + body.action });

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var ss = SpreadsheetApp.openById(SHEET_ID);
      var sh = ss.getSheetByName(sheetName);
      if (!sh) return json({ ok: false, error: 'Missing tab: ' + sheetName + '. Run setupSheet().' });
      var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
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

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
