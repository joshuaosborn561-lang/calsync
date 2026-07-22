/**
 * Calendar Mirror — https://script.google.com
 *
 * SETUP:
 * 1. Paste code, set SOURCE_CALENDAR_NAME below, Save
 * 2. Left sidebar → "+" → Services → Google Calendar API → Add
 * 3. Run listMyCalendars → Allow
 * 4. Run syncAll ONCE → walk away. It finishes automatically.
 *
 * HOW MOVES WORK:
 * Each meeting occurrence is mirrored separately. When you move an Insight
 * meeting, the old time disappears from the source → old [Work] copy is deleted,
 * and the new time is created. Run syncNow after a move for an immediate fix.
 */

// ─── EDIT THIS ───────────────────────────────────────────────────────────────
var SOURCE_CALENDAR_NAME = "Work";
var DESTINATION_CALENDAR_NAME = "primary";
// ──────────────────────────────────────────────────────────────────────────────

var MIRROR_PREFIX = "[Work] ";
var SYNC_PAST_DAYS = 7;
var SYNC_FUTURE_DAYS = 365;

var PAUSE_MS = 800;
var RATE_LIMIT_WAIT_MS = 60000;
var MAX_EXEC_MS = 4 * 60 * 1000;
var CONTINUE_DELAY_MS = 2 * 60 * 1000;
var MAINTENANCE_INTERVAL_MINUTES = 5;
var MAX_WRITES_PER_PASS = 40;

var MIRROR_SOURCE_KEY = "mirrorSourceId";
var MIRROR_SOURCE_CAL_KEY = "mirrorSourceCalendarId";
var MIRROR_HASH_KEY = "mirrorContentHash";

/**
 * RUN THIS ONCE. Copies everything, then auto-continues in the background.
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
        var doneMsg = "ALL DONE! Created: " + totals.created +
          ", Updated: " + totals.updated +
          ", Deleted: " + totals.deleted +
          ", Skipped: " + totals.skipped +
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

/** Quick sync — use after you move/cancel a meeting for an immediate update. */
function syncNow() {
  checkCalendarApi_();
  var pass = runSyncPass_(Date.now() + MAX_EXEC_MS);
  var msg = "Created: " + pass.created +
    ", Updated: " + pass.updated +
    ", Deleted: " + pass.deleted +
    ", Skipped: " + pass.skipped;
  if (pass.done) {
    msg += "\nAll caught up — old moved/cancelled times removed.";
  } else {
    msg += "\nStill " + pass.pending + " pending. Run syncNow again in a minute.";
  }
  Logger.log(msg);
  return msg;
}

function createSchedule() {
  enableMaintenanceSchedule_();
  Logger.log("Auto-sync ON — every " + MAINTENANCE_INTERVAL_MINUTES + " minutes.");
}

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

/**
 * One-click cleanup: remove stale [Work] copies that no longer match
 * the subscribed calendar (leftovers from moves/cancels).
 */
function cleanupStaleMirrors() {
  checkCalendarApi_();
  var pass = runSyncPass_(Date.now() + MAX_EXEC_MS);
  Logger.log(
    "Cleanup finished. Deleted: " + pass.deleted +
    ", Updated: " + pass.updated +
    ", Created: " + pass.created
  );
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

  // Expand recurring events into concrete instances so a moved meeting
  // becomes: old instance gone + new instance present.
  var sourceEvents = listExpandedEvents_(sourceCalId, timeMin, timeMax);
  var mirrors = listAllMirrors_(destCalId, sourceCalId, timeMin, timeMax);

  var mirrorsBySourceId = {};
  for (var m = 0; m < mirrors.length; m++) {
    var props = privateProps_(mirrors[m]);
    var sid = props[MIRROR_SOURCE_KEY];
    if (sid) mirrorsBySourceId[sid] = mirrors[m];
  }

  var sourceById = {};
  for (var s = 0; s < sourceEvents.length; s++) {
    var ev = sourceEvents[s];
    if (!shouldMirror_(ev)) continue;
    sourceById[ev.id] = ev;
  }

  var created = 0, updated = 0, deleted = 0, skipped = 0, wrote = 0;
  var rateLimited = false;

  // Prefer deletes first so moved meetings don't leave the old busy block.
  var staleIds = [];
  for (var mirrorSourceId in mirrorsBySourceId) {
    if (!sourceById[mirrorSourceId]) staleIds.push(mirrorSourceId);
  }

  for (var d = 0; d < staleIds.length; d++) {
    if (wrote >= MAX_WRITES_PER_PASS || Date.now() > deadline - 15000) break;
    var staleMirror = mirrorsBySourceId[staleIds[d]];
    try {
      Calendar.Events.remove(destCalId, staleMirror.id, { sendUpdates: "none" });
      deleted++;
      wrote++;
      delete mirrorsBySourceId[staleIds[d]];
      softPause_(deadline);
    } catch (e) {
      if (isRateLimit_(e)) {
        rateLimited = true;
        break;
      }
      // Already gone — fine
      if (String(e).indexOf("Not Found") !== -1 || String(e).indexOf("404") !== -1) {
        deleted++;
        delete mirrorsBySourceId[staleIds[d]];
        continue;
      }
      throw e;
    }
  }

  if (!rateLimited) {
    for (var sourceId in sourceById) {
      if (wrote >= MAX_WRITES_PER_PASS || Date.now() > deadline - 15000) break;

      var source = sourceById[sourceId];
      var title = MIRROR_PREFIX + (source.summary || "(No title)");
      var existing = mirrorsBySourceId[sourceId];
      var hash = contentHash_(source, title);

      try {
        if (!existing) {
          createMirror_(destCalId, source, title, sourceId, sourceCalId, hash);
          created++;
          wrote++;
          softPause_(deadline);
        } else if (needsUpdate_(source, existing, title, hash)) {
          // If the mirror was an old recurring-series copy, replace it with
          // a single instance so future moves delete cleanly.
          if (existing.recurrence && existing.recurrence.length) {
            Calendar.Events.remove(destCalId, existing.id, { sendUpdates: "none" });
            createMirror_(destCalId, source, title, sourceId, sourceCalId, hash);
            deleted++;
            created++;
            wrote += 2;
          } else {
            updateMirror_(destCalId, existing.id, source, title, sourceId, sourceCalId, hash);
            updated++;
            wrote++;
          }
          softPause_(deadline);
        } else {
          skipped++;
        }
      } catch (e) {
        if (isRateLimit_(e)) {
          rateLimited = true;
          break;
        }
        throw e;
      }
    }
  }

  var pending = countPending_(sourceById, mirrorsBySourceId);
  var done = pending === 0 && !rateLimited && wrote < MAX_WRITES_PER_PASS;

  // Recheck: if we hit write/time limits, not done yet.
  if (wrote >= MAX_WRITES_PER_PASS || Date.now() > deadline - 15000) {
    done = false;
  }

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

function countPending_(sourceById, mirrorsBySourceId) {
  var pending = 0;
  for (var sourceId in sourceById) {
    var source = sourceById[sourceId];
    var title = MIRROR_PREFIX + (source.summary || "(No title)");
    var hash = contentHash_(source, title);
    var existing = mirrorsBySourceId[sourceId];
    if (!existing || needsUpdate_(source, existing, title, hash)) pending++;
  }
  for (var mirrorSourceId in mirrorsBySourceId) {
    if (!sourceById[mirrorSourceId]) pending++;
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

function listExpandedEvents_(calendarId, timeMin, timeMax) {
  var events = [];
  var pageToken;
  do {
    var resp = Calendar.Events.list(calendarId, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted: false,
      maxResults: 2500,
      pageToken: pageToken
    });
    if (resp.items) events = events.concat(resp.items);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return events;
}

function listAllMirrors_(destCalId, sourceCalId, timeMin, timeMax) {
  var byId = {};
  var pageToken;

  // Tagged mirrors for this source calendar
  do {
    var resp = Calendar.Events.list(destCalId, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted: false,
      maxResults: 2500,
      pageToken: pageToken,
      privateExtendedProperty: MIRROR_SOURCE_CAL_KEY + "=" + sourceCalId
    });
    if (resp.items) {
      for (var i = 0; i < resp.items.length; i++) {
        byId[resp.items[i].id] = resp.items[i];
      }
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);

  // Also pick up leftover [Work] events from older sync versions (tags / series)
  pageToken = null;
  do {
    var resp2 = Calendar.Events.list(destCalId, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted: false,
      maxResults: 2500,
      pageToken: pageToken,
      q: MIRROR_PREFIX.trim()
    });
    if (resp2.items) {
      for (var j = 0; j < resp2.items.length; j++) {
        var ev = resp2.items[j];
        if ((ev.summary || "").indexOf(MIRROR_PREFIX) === 0) {
          // Ensure it has a source id tag so cleanup can treat it as a mirror.
          var props = privateProps_(ev);
          if (!props[MIRROR_SOURCE_KEY]) {
            // Synthesize a key from start+title so stale copies can be deleted
            // if they don't match any live source event.
            ev.extendedProperties = ev.extendedProperties || { private: {} };
            ev.extendedProperties.private = ev.extendedProperties.private || {};
            ev.extendedProperties.private[MIRROR_SOURCE_KEY] =
              "orphan:" + (ev.id || "") + ":" + eventStartKey_(ev);
            ev.extendedProperties.private[MIRROR_SOURCE_CAL_KEY] = sourceCalId;
          }
          byId[ev.id] = ev;
        }
      }
    }
    pageToken = resp2.nextPageToken;
  } while (pageToken);

  var out = [];
  for (var id in byId) out.push(byId[id]);
  return out;
}

function shouldMirror_(ev) {
  if (!ev || ev.status === "cancelled") return false;
  if (!ev.start || !(ev.start.dateTime || ev.start.date)) return false;
  return true;
}

function needsUpdate_(source, mirror, title, hash) {
  var props = privateProps_(mirror);
  if (props[MIRROR_HASH_KEY] !== hash) return true;
  if (mirror.summary !== title) return true;
  if (!dateTimeEqual_(mirror.start, source.start)) return true;
  if (!dateTimeEqual_(mirror.end, source.end)) return true;
  if (mirror.recurrence && mirror.recurrence.length) return true;
  return false;
}

function contentHash_(source, title) {
  return [
    title,
    eventStartKey_(source),
    eventEndKey_(source),
    source.status || "",
    source.location || ""
  ].join("|");
}

function eventStartKey_(ev) {
  var s = ev.start || {};
  return s.dateTime || s.date || "";
}

function eventEndKey_(ev) {
  var e = ev.end || {};
  return e.dateTime || e.date || "";
}

function dateTimeEqual_(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (a.dateTime || a.date || "") === (b.dateTime || b.date || "");
}

function privateProps_(ev) {
  return ((ev.extendedProperties || {}).private) || {};
}

function buildMirrorBody_(source, title, sourceId, sourceCalId, hash) {
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
  body.extendedProperties.private[MIRROR_HASH_KEY] = hash;
  body.extendedProperties.private.mirrorSourceUpdated = source.updated || "";
  if (source.location) body.location = source.location;
  // Never copy recurrence — we mirror expanded instances instead.
  return body;
}

function createMirror_(destCalId, source, title, sourceId, sourceCalId, hash) {
  Calendar.Events.insert(
    buildMirrorBody_(source, title, sourceId, sourceCalId, hash),
    destCalId,
    { sendUpdates: "none" }
  );
}

function updateMirror_(destCalId, mirrorId, source, title, sourceId, sourceCalId, hash) {
  Calendar.Events.update(
    buildMirrorBody_(source, title, sourceId, sourceCalId, hash),
    destCalId,
    mirrorId,
    { sendUpdates: "none" }
  );
}

function softPause_(deadline) {
  if (Date.now() + PAUSE_MS < deadline) Utilities.sleep(PAUSE_MS);
}

function isRateLimit_(e) {
  var msg = String(e.message || e);
  return msg.indexOf("too many") !== -1 || msg.indexOf("Rate Limit") !== -1;
}
