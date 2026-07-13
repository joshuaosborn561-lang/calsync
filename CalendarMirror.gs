/**
 * Calendar Mirror — https://script.google.com
 *
 * SETUP:
 * 1. Paste code, set SOURCE_CALENDAR_NAME below, Save
 * 2. Left sidebar → "+" → Services → Google Calendar API → Add
 * 3. Run listMyCalendars → Allow
 * 4. Run syncAll ONCE → walk away. It finishes automatically.
 */

// ─── EDIT THIS ───────────────────────────────────────────────────────────────
var SOURCE_CALENDAR_NAME = "Work";
var DESTINATION_CALENDAR_NAME = "primary";
// ──────────────────────────────────────────────────────────────────────────────

var MIRROR_PREFIX = "[Work] ";
var SYNC_PAST_DAYS = 7;
var SYNC_FUTURE_DAYS = 365;

var PAUSE_MS = 2000;
var RATE_LIMIT_WAIT_MS = 60000;
var MAX_EXEC_MS = 4 * 60 * 1000;
var CONTINUE_DELAY_MS = 2 * 60 * 1000;
var MAINTENANCE_INTERVAL_MINUTES = 5;

var MIRROR_SOURCE_KEY = "mirrorSourceId";
var MIRROR_SOURCE_CAL_KEY = "mirrorSourceCalendarId";

/**
 * RUN THIS ONCE. Copies everything, then auto-continues in the background.
 * If it times out, that's OK — it schedules itself to keep going.
 */
function syncAll() {
  checkCalendarApi_();
  var startTime = Date.now();
  var deadline = startTime + MAX_EXEC_MS;
  var totals = loadTotals_();
  var finished = false;

  try {
    while (Date.now() < deadline) {
      var pass = runSyncPass_(deadline);

      totals.created += pass.created;
      totals.updated += pass.updated;
      totals.deleted += pass.deleted;
      totals.skipped += pass.skipped;

      saveProgress_(totals, pass.done);

      if (pass.done) {
        finished = true;
        clearContinueTriggers_();
        enableMaintenanceSchedule_();
        var doneMsg = "ALL DONE! Created: " + totals.created + ", Updated: " + totals.updated +
          ", Deleted: " + totals.deleted + ", Skipped: " + totals.skipped +
          "\nAuto-sync ON (every " + MAINTENANCE_INTERVAL_MINUTES + " min).";
        Logger.log(doneMsg);
        return doneMsg;
      }

      if (pass.rateLimited) {
        if (Date.now() + RATE_LIMIT_WAIT_MS < deadline) {
          Logger.log("Rate limit — waiting 60 seconds...");
          Utilities.sleep(RATE_LIMIT_WAIT_MS);
          continue;
        }
        break;
      }

      if (pass.wrote === 0) break;
    }
  } finally {
    if (!finished) {
      scheduleContinue_();
      saveProgress_(totals, false);
      Logger.log(
        "Paused (Google time limit). Created so far: " + totals.created +
        ". Auto-continues in ~2 min — or run finishSetup when ready."
      );
    }
  }
}

/** Auto-triggered — you never need to run this yourself */
function syncAllContinue() {
  syncAll();
}

function checkProgress() {
  var raw = PropertiesService.getScriptProperties().getProperty("syncProgress");
  if (!raw) {
    Logger.log("No sync in progress. Run syncAll to start.");
    return;
  }
  Logger.log(raw);
}

function setup() {
  checkCalendarApi_();
  listMyCalendars();
  Logger.log("Run syncAll once — it handles the rest automatically.");
}

function listMyCalendars() {
  checkCalendarApi_();
  var list = Calendar.CalendarList.list();
  var items = list.items || [];
  Logger.log("=== YOUR CALENDARS ===");
  for (var i = 0; i < items.length; i++) {
    var cal = items[i];
    var hint = "";
    if (cal.summary === SOURCE_CALENDAR_NAME) hint = "  ← SOURCE";
    if (DESTINATION_CALENDAR_NAME === "primary" && cal.primary) hint = "  ← DESTINATION";
    if (cal.summary === DESTINATION_CALENDAR_NAME) hint = "  ← DESTINATION";
    Logger.log(cal.summary + hint);
    Logger.log("  ID: " + cal.id);
  }
  Logger.log("======================");
}

/** One-off quick sync (optional). Use syncAll for the full initial copy. */
function syncNow() {
  var pass = runSyncPass_();
  var msg = "Created: " + pass.created + ", Updated: " + pass.updated +
    ", Deleted: " + pass.deleted + ", Skipped: " + pass.skipped;
  Logger.log(pass.done ? msg + "\nAll caught up!" : msg + "\nRun syncAll for automatic completion.");
  return msg;
}

function createSchedule() {
  enableMaintenanceSchedule_();
  Logger.log("Auto-sync ON — every " + MAINTENANCE_INTERVAL_MINUTES + " minutes.");
}

/**
 * Run this if syncAll timed out but your calendar looks good.
 * Finishes any remaining copies and turns on auto-sync.
 */
function finishSetup() {
  checkCalendarApi_();
  var deadline = Date.now() + MAX_EXEC_MS;
  var pass = runSyncPass_(deadline);
  if (pass.done) {
    clearContinueTriggers_();
    enableMaintenanceSchedule_();
    saveProgress_(loadTotals_(), true);
    Logger.log("Setup complete! Auto-sync every " + MAINTENANCE_INTERVAL_MINUTES + " min.");
  } else {
    Logger.log(pass.pending + " items still pending. Run syncAll again or wait for auto-continue.");
    scheduleContinue_();
  }
}

// ─── core sync ───────────────────────────────────────────────────────────────

function runSyncPass_(deadlineMs) {
  var deadline = deadlineMs || (Date.now() + 3600000);
  var sourceCalId = findCalendarId_(SOURCE_CALENDAR_NAME, false);
  var destCalId = findCalendarId_(DESTINATION_CALENDAR_NAME, true);

  if (!sourceCalId) {
    throw new Error('Cannot find "' + SOURCE_CALENDAR_NAME + '". Run listMyCalendars.');
  }
  if (!destCalId) {
    throw new Error('Cannot find destination "' + DESTINATION_CALENDAR_NAME + '".');
  }

  var now = new Date();
  var timeMin = new Date(now.getTime() - SYNC_PAST_DAYS * 86400000).toISOString();
  var timeMax = new Date(now.getTime() + SYNC_FUTURE_DAYS * 86400000).toISOString();

  var sourceEvents = listSourceEvents_(sourceCalId, timeMin, timeMax);
  var mirrors = listMirrorEvents_(destCalId, sourceCalId, timeMin, timeMax);

  var mirrorsBySourceId = {};
  for (var m = 0; m < mirrors.length; m++) {
    var props = (mirrors[m].extendedProperties || {}).private || {};
    if (props[MIRROR_SOURCE_KEY]) mirrorsBySourceId[props[MIRROR_SOURCE_KEY]] = mirrors[m];
  }

  var created = 0, updated = 0, deleted = 0, skipped = 0, wrote = 0;
  var rateLimited = false;
  var seenSourceIds = {};

  for (var s = 0; s < sourceEvents.length; s++) {
    if (Date.now() > deadline - 15000) break;

    var ev = sourceEvents[s];
    if (!shouldMirror_(ev)) continue;

    var sourceId = ev.id;
    seenSourceIds[sourceId] = true;
    var title = MIRROR_PREFIX + (ev.summary || "(No title)");
    var existing = mirrorsBySourceId[sourceId];

    try {
      if (existing) {
        if (needsUpdate_(ev, existing, title)) {
          updateMirror_(destCalId, existing.id, ev, title, sourceId, sourceCalId);
          updated++;
          wrote++;
          if (Date.now() + PAUSE_MS < deadline) Utilities.sleep(PAUSE_MS);
        } else {
          skipped++;
        }
      } else {
        createMirror_(destCalId, ev, title, sourceId, sourceCalId);
        created++;
        wrote++;
        if (Date.now() + PAUSE_MS < deadline) Utilities.sleep(PAUSE_MS);
      }
    } catch (e) {
      if (isRateLimit_(e)) {
        rateLimited = true;
        break;
      }
      throw e;
    }
  }

  if (!rateLimited) {
    for (var sourceIdKey in mirrorsBySourceId) {
      if (Date.now() > deadline - 15000) break;
      if (!seenSourceIds[sourceIdKey]) {
        try {
          Calendar.Events.remove(destCalId, mirrorsBySourceId[sourceIdKey].id);
          deleted++;
          wrote++;
          if (Date.now() + PAUSE_MS < deadline) Utilities.sleep(PAUSE_MS);
        } catch (e) {
          if (isRateLimit_(e)) {
            rateLimited = true;
            break;
          }
          throw e;
        }
      }
    }
  }

  var pending = countPending_(sourceEvents, mirrorsBySourceId, seenSourceIds);
  var done = pending === 0 && !rateLimited;

  return {
    created: created,
    updated: updated,
    deleted: deleted,
    skipped: skipped,
    wrote: wrote,
    rateLimited: rateLimited,
    done: done,
    pending: pending
  };
}

function countPending_(sourceEvents, mirrorsBySourceId, seenSourceIds) {
  var pending = 0;
  for (var s = 0; s < sourceEvents.length; s++) {
    var ev = sourceEvents[s];
    if (!shouldMirror_(ev)) continue;
    var sourceId = ev.id;
    var existing = mirrorsBySourceId[sourceId];
    var title = MIRROR_PREFIX + (ev.summary || "(No title)");
    if (!existing || needsUpdate_(ev, existing, title)) pending++;
  }
  for (var key in mirrorsBySourceId) {
    if (!seenSourceIds[key]) pending++;
  }
  return pending;
}

// ─── triggers ────────────────────────────────────────────────────────────────

function scheduleContinue_() {
  clearContinueTriggers_();
  ScriptApp.newTrigger("syncAllContinue")
    .timeBased()
    .after(CONTINUE_DELAY_MS)
    .create();
}

function clearContinueTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "syncAllContinue") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function enableMaintenanceSchedule_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "syncNow") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("syncNow").timeBased().everyMinutes(MAINTENANCE_INTERVAL_MINUTES).create();
}

function saveProgress_(totals, done) {
  PropertiesService.getScriptProperties().setProperty(
    "syncProgress",
    JSON.stringify({
      created: totals.created,
      updated: totals.updated,
      deleted: totals.deleted,
      skipped: totals.skipped,
      done: done,
      at: new Date().toISOString()
    })
  );
}

function loadTotals_() {
  var raw = PropertiesService.getScriptProperties().getProperty("syncProgress");
  if (!raw) return { created: 0, updated: 0, deleted: 0, skipped: 0 };
  var p = JSON.parse(raw);
  return {
    created: p.created || 0,
    updated: p.updated || 0,
    deleted: p.deleted || 0,
    skipped: p.skipped || 0
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function checkCalendarApi_() {
  if (typeof Calendar === "undefined" || !Calendar.Events) {
    throw new Error(
      "Enable Google Calendar API: left sidebar → + → Services → Google Calendar API → Add"
    );
  }
}

function findCalendarId_(nameOrPrimary, mustBeWritable) {
  var list = Calendar.CalendarList.list();
  var items = list.items || [];
  for (var i = 0; i < items.length; i++) {
    var cal = items[i];
    if (nameOrPrimary === "primary" && cal.primary) return cal.id;
    if (cal.summary === nameOrPrimary) return cal.id;
  }
  return null;
}

function listSourceEvents_(calendarId, timeMin, timeMax) {
  var events = [];
  var pageToken;
  do {
    var resp = Calendar.Events.list(calendarId, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: false,
      showDeleted: false,
      maxResults: 2500,
      pageToken: pageToken
    });
    if (resp.items) events = events.concat(resp.items);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return events;
}

function listMirrorEvents_(destCalId, sourceCalId, timeMin, timeMax) {
  var events = [];
  var pageToken;
  do {
    var resp = Calendar.Events.list(destCalId, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: false,
      showDeleted: false,
      maxResults: 2500,
      pageToken: pageToken,
      privateExtendedProperty: MIRROR_SOURCE_CAL_KEY + "=" + sourceCalId
    });
    if (resp.items) events = events.concat(resp.items);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return events;
}

function shouldMirror_(ev) {
  if (ev.status === "cancelled") return false;
  if (ev.recurringEventId && !ev.originalStartTime) return false;
  return true;
}

function needsUpdate_(source, mirror, title) {
  var props = (mirror.extendedProperties || {}).private || {};
  if (props.mirrorSourceUpdated !== (source.updated || "")) return true;
  if (mirror.summary !== title) return true;
  if (!dateTimeEqual_(mirror.start, source.start)) return true;
  if (!dateTimeEqual_(mirror.end, source.end)) return true;
  return false;
}

function dateTimeEqual_(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (a.dateTime || a.date) === (b.dateTime || b.date);
}

function buildMirrorBody_(source, title, sourceId, sourceCalId) {
  var body = {
    summary: title,
    start: source.start,
    end: source.end,
    transparency: "opaque",
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    description: "Mirrored from subscribed calendar.\nSource: " + sourceId,
    extendedProperties: { private: {} }
  };
  body.extendedProperties.private[MIRROR_SOURCE_KEY] = sourceId;
  body.extendedProperties.private[MIRROR_SOURCE_CAL_KEY] = sourceCalId;
  body.extendedProperties.private.mirrorSourceUpdated = source.updated || "";
  if (source.location) body.location = source.location;
  if (source.recurrence) body.recurrence = source.recurrence;
  return body;
}

function createMirror_(destCalId, source, title, sourceId, sourceCalId) {
  Calendar.Events.insert(buildMirrorBody_(source, title, sourceId, sourceCalId), destCalId, { sendUpdates: "none" });
}

function updateMirror_(destCalId, mirrorId, source, title, sourceId, sourceCalId) {
  Calendar.Events.update(buildMirrorBody_(source, title, sourceId, sourceCalId), destCalId, mirrorId, { sendUpdates: "none" });
}

function isRateLimit_(e) {
  var msg = String(e.message || e);
  return msg.indexOf("too many") !== -1 || msg.indexOf("Rate Limit") !== -1;
}
