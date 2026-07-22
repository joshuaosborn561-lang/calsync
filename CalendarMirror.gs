/**
 * Calendar Mirror — https://script.google.com
 *
 * SETUP:
 * 1. Paste code, set the EDIT THIS section below, Save
 * 2. Left sidebar → "+" → Services → Google Calendar API → Add
 * 3. Run listMyCalendars → Allow
 * 4. Run cleanupStaleMirrors once (removes old leftovers)
 * 5. Run syncAll once, then createSchedule
 */

// ─── EDIT THIS ───────────────────────────────────────────────────────────────
var SOURCE_CALENDAR_NAME = "Insight";
var DESTINATION_CALENDAR_NAME = "primary";

// Title prefix on mirrored events
var MIRROR_PREFIX = "[Insight] ";

// Also clean up older prefixes from previous runs
var LEGACY_PREFIXES = ["[Work] ", "[Insight] "];

// Only mirror meetings you've accepted (skips tentative / not-responded)
var ONLY_ACCEPTED = true;
// ──────────────────────────────────────────────────────────────────────────────

var SYNC_PAST_DAYS = 30;
var SYNC_FUTURE_DAYS = 365;
var CLEANUP_PAST_DAYS = 90;

var PAUSE_MS = 600;
var RATE_LIMIT_WAIT_MS = 60000;
var MAX_EXEC_MS = 4 * 60 * 1000;
var CONTINUE_DELAY_MS = 2 * 60 * 1000;
var MAINTENANCE_INTERVAL_MINUTES = 5;
var MAX_WRITES_PER_PASS = 50;

var MIRROR_SOURCE_KEY = "mirrorSourceId";
var MIRROR_SOURCE_CAL_KEY = "mirrorSourceCalendarId";
var MIRROR_HASH_KEY = "mirrorContentHash";

function syncAll() {
  checkCalendarApi_();
  var startTime = Date.now();
  var deadline = startTime + MAX_EXEC_MS;
  var totals = loadTotals_();
  var finished = false;

  try {
    while (Date.now() < deadline) {
      var pass = runSyncPass_(deadline, false);

      totals.created += pass.created;
      totals.updated += pass.updated;
      totals.deleted += pass.deleted;
      totals.skipped += pass.skipped;
      saveProgress_(totals, pass.done);

      if (pass.done) {
        finished = true;
        clearContinueTriggers_();
        enableMaintenanceSchedule_();
        Logger.log(
          "ALL DONE! Created: " + totals.created +
          ", Updated: " + totals.updated +
          ", Deleted: " + totals.deleted +
          ", Skipped: " + totals.skipped +
          "\nAuto-sync ON (every " + MAINTENANCE_INTERVAL_MINUTES + " min)."
        );
        return;
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
        "Paused. Created so far: " + totals.created +
        ". Auto-continues in ~2 min."
      );
    }
  }
}

function syncAllContinue() {
  syncAll();
}

function syncNow() {
  checkCalendarApi_();
  var pass = runSyncPass_(Date.now() + MAX_EXEC_MS, false);
  Logger.log(formatPass_(pass));
}

/**
 * Aggressive cleanup for leftover [Insight] / [Work] copies.
 * Run this when you still see stale mirrors.
 */
function cleanupStaleMirrors() {
  checkCalendarApi_();
  var pass = runSyncPass_(Date.now() + MAX_EXEC_MS, true);
  Logger.log(
    "Cleanup pass: " + formatPass_(pass) +
    "\nIf Deleted > 0, check Google Calendar (refresh the page)." +
    "\nRun cleanupStaleMirrors again until Deleted: 0."
  );
}

function createSchedule() {
  enableMaintenanceSchedule_();
  Logger.log("Auto-sync ON — every " + MAINTENANCE_INTERVAL_MINUTES + " minutes.");
}

function finishSetup() {
  checkCalendarApi_();
  var pass = runSyncPass_(Date.now() + MAX_EXEC_MS, true);
  if (pass.done) {
    clearContinueTriggers_();
    enableMaintenanceSchedule_();
    Logger.log("Setup complete! Auto-sync every " + MAINTENANCE_INTERVAL_MINUTES + " min.");
  } else {
    Logger.log(pass.pending + " still pending. Run syncAll or cleanupStaleMirrors again.");
    scheduleContinue_();
  }
}

function listMyCalendars() {
  checkCalendarApi_();
  var items = (Calendar.CalendarList.list().items) || [];
  Logger.log("=== YOUR CALENDARS ===");
  for (var i = 0; i < items.length; i++) {
    var cal = items[i];
    var hint = "";
    if (cal.summary === SOURCE_CALENDAR_NAME) hint = "  ← SOURCE";
    if (DESTINATION_CALENDAR_NAME === "primary" && cal.primary) hint = "  ← DESTINATION";
    if (cal.summary === DESTINATION_CALENDAR_NAME) hint = "  ← DESTINATION";
    Logger.log(cal.summary + hint);
    Logger.log("  ID: " + cal.id + "  access: " + cal.accessRole);
  }
}

function checkProgress() {
  var raw = PropertiesService.getScriptProperties().getProperty("syncProgress");
  Logger.log(raw || "No progress saved yet.");
}

function setup() {
  listMyCalendars();
  Logger.log("1) Run cleanupStaleMirrors  2) Run syncAll  3) Run createSchedule");
}

// ─── core ────────────────────────────────────────────────────────────────────

function runSyncPass_(deadlineMs, aggressiveCleanup) {
  var deadline = deadlineMs || (Date.now() + 3600000);
  var sourceCalId = findCalendarId_(SOURCE_CALENDAR_NAME);
  var destCalId = findCalendarId_(DESTINATION_CALENDAR_NAME);

  if (!sourceCalId) {
    throw new Error('Cannot find source calendar "' + SOURCE_CALENDAR_NAME + '". Run listMyCalendars.');
  }
  if (!destCalId) {
    throw new Error('Cannot find destination "' + DESTINATION_CALENDAR_NAME + '".');
  }

  var now = new Date();
  var pastDays = aggressiveCleanup ? CLEANUP_PAST_DAYS : SYNC_PAST_DAYS;
  var timeMin = new Date(now.getTime() - pastDays * 86400000).toISOString();
  var timeMax = new Date(now.getTime() + SYNC_FUTURE_DAYS * 86400000).toISOString();

  var sourceEvents = listExpandedEvents_(sourceCalId, timeMin, timeMax);
  var sourceById = {};
  var sourceFingerprints = {};

  for (var s = 0; s < sourceEvents.length; s++) {
    var ev = sourceEvents[s];
    if (!shouldMirror_(ev)) continue;
    sourceById[ev.id] = ev;
    sourceFingerprints[fingerprint_(ev)] = true;
  }

  var mirrors = listMirrorCandidates_(destCalId, sourceCalId, timeMin, timeMax, aggressiveCleanup);
  var mirrorsBySourceId = {};
  var untagged = [];

  for (var m = 0; m < mirrors.length; m++) {
    var mirror = mirrors[m];
    var props = privateProps_(mirror);
    var sid = props[MIRROR_SOURCE_KEY];
    if (sid) {
      // Prefer master events over expanded instances when both appear
      if (!mirrorsBySourceId[sid] || !mirror.recurringEventId) {
        mirrorsBySourceId[sid] = mirror;
      }
    } else {
      untagged.push(mirror);
    }
  }

  var created = 0, updated = 0, deleted = 0, skipped = 0, wrote = 0;
  var rateLimited = false;

  // 1) Delete untagged leftovers ([Insight]/ies without metadata)
  for (var u = 0; u < untagged.length; u++) {
    if (hitLimit_(wrote, deadline)) break;
    var orphan = untagged[u];
    // Keep only if fingerprint still matches a live accepted source event
    if (sourceFingerprints[fingerprint_(orphan)]) {
      skipped++;
      continue;
    }
    if (!deleteMirrorSafe_(destCalId, orphan)) continue;
    deleted++;
    wrote++;
    softPause_(deadline);
  }

  // 2) Delete stale tagged mirrors first (moved / cancelled / unaccepted)
  var staleIds = [];
  for (var mid in mirrorsBySourceId) {
    if (!sourceById[mid]) staleIds.push(mid);
  }

  for (var d = 0; d < staleIds.length; d++) {
    if (hitLimit_(wrote, deadline) || rateLimited) break;
    try {
      if (!deleteMirrorSafe_(destCalId, mirrorsBySourceId[staleIds[d]])) continue;
      deleted++;
      wrote++;
      delete mirrorsBySourceId[staleIds[d]];
      softPause_(deadline);
    } catch (e) {
      if (isRateLimit_(e)) {
        rateLimited = true;
        break;
      }
      throw e;
    }
  }

  // 3) Create / update current accepted source events
  if (!rateLimited && !aggressiveCleanup) {
    for (var sourceId in sourceById) {
      if (hitLimit_(wrote, deadline)) break;
      var source = sourceById[sourceId];
      var title = MIRROR_PREFIX + (source.summary || "(No title)");
      var hash = contentHash_(source, title);
      var existing = mirrorsBySourceId[sourceId];

      try {
        if (!existing) {
          createMirror_(destCalId, source, title, sourceId, sourceCalId, hash);
          created++;
          wrote++;
          softPause_(deadline);
        } else if (needsUpdate_(source, existing, title, hash)) {
          if (existing.recurrence && existing.recurrence.length) {
            deleteMirrorSafe_(destCalId, existing);
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
  } else if (aggressiveCleanup) {
    // Still create missing ones during cleanup so calendar stays complete
    for (var sourceId2 in sourceById) {
      if (hitLimit_(wrote, deadline) || rateLimited) break;
      if (mirrorsBySourceId[sourceId2]) {
        skipped++;
        continue;
      }
      var source2 = sourceById[sourceId2];
      var title2 = MIRROR_PREFIX + (source2.summary || "(No title)");
      var hash2 = contentHash_(source2, title2);
      try {
        createMirror_(destCalId, source2, title2, sourceId2, sourceCalId, hash2);
        created++;
        wrote++;
        softPause_(deadline);
      } catch (e2) {
        if (isRateLimit_(e2)) {
          rateLimited = true;
          break;
        }
        throw e2;
      }
    }
  }

  var pending = 0;
  for (var sid2 in sourceById) {
    var ex = mirrorsBySourceId[sid2];
    var t = MIRROR_PREFIX + (sourceById[sid2].summary || "(No title)");
    var h = contentHash_(sourceById[sid2], t);
    if (!ex || needsUpdate_(sourceById[sid2], ex, t, h)) pending++;
  }
  for (var sid3 in mirrorsBySourceId) {
    if (!sourceById[sid3]) pending++;
  }
  pending += untagged.length; // approximate; many may already be deleted

  var done = pending === 0 && !rateLimited && !hitLimit_(wrote, deadline);

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

function shouldMirror_(ev) {
  if (!ev || ev.status === "cancelled") return false;
  if (!ev.start || !(ev.start.dateTime || ev.start.date)) return false;

  if (ONLY_ACCEPTED) {
    if (ev.status === "tentative") return false;

    var selfAttendee = findSelfAttendee_(ev);
    if (selfAttendee) {
      var resp = selfAttendee.responseStatus || "";
      // Only mirror once you've accepted
      if (resp !== "accepted") return false;
    } else if (ev.organizer && ev.organizer.self) {
      // You organized it — keep it
    } else {
      // Subscribed feed with no self attendee: still mirror confirmed blocks
      // (common for Insight subscribed calendars)
    }
  }
  return true;
}

function findSelfAttendee_(ev) {
  var attendees = ev.attendees || [];
  for (var i = 0; i < attendees.length; i++) {
    if (attendees[i].self) return attendees[i];
  }
  return null;
}

// ─── listing / cleanup discovery ─────────────────────────────────────────────

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

/**
 * Find every mirrored event — tagged, legacy [Work]/ [Insight], and
 * recurring masters (not just expanded instances).
 */
function listMirrorCandidates_(destCalId, sourceCalId, timeMin, timeMax, aggressive) {
  var byId = {};

  // A) Tagged by current source calendar id
  addListed_(byId, destCalId, {
    timeMin: timeMin,
    timeMax: timeMax,
    singleEvents: false,
    showDeleted: false,
    maxResults: 2500,
    privateExtendedProperty: MIRROR_SOURCE_CAL_KEY + "=" + sourceCalId
  });

  // B) Any event whose title starts with a known mirror prefix
  //    (catches old runs, wrong tags, CalendarApp leftovers)
  var all = listExpandedEvents_(destCalId, timeMin, timeMax);
  for (var i = 0; i < all.length; i++) {
    var ev = all[i];
    if (hasMirrorPrefix_(ev.summary || "")) {
      byId[ev.id] = ev;
    }
  }

  // C) Also pull non-expanded masters with those titles
  addListed_(byId, destCalId, {
    timeMin: timeMin,
    timeMax: timeMax,
    singleEvents: false,
    showDeleted: false,
    maxResults: 2500
  }, true);

  if (aggressive) {
    // Wider sweep already uses CLEANUP_PAST_DAYS via caller
  }

  var out = [];
  for (var id in byId) out.push(byId[id]);
  return out;
}

function addListed_(byId, calendarId, params, prefixFilterOnly) {
  var pageToken;
  do {
    var opts = {};
    for (var k in params) opts[k] = params[k];
    opts.pageToken = pageToken;
    var resp = Calendar.Events.list(calendarId, opts);
    var items = resp.items || [];
    for (var i = 0; i < items.length; i++) {
      var ev = items[i];
      if (prefixFilterOnly && !hasMirrorPrefix_(ev.summary || "")) continue;
      byId[ev.id] = ev;
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
}

function hasMirrorPrefix_(summary) {
  var prefixes = uniquePrefixes_();
  for (var i = 0; i < prefixes.length; i++) {
    if (summary.indexOf(prefixes[i]) === 0) return true;
  }
  return false;
}

function uniquePrefixes_() {
  var out = [];
  var seen = {};
  var all = [MIRROR_PREFIX].concat(LEGACY_PREFIXES || []);
  for (var i = 0; i < all.length; i++) {
    var p = all[i];
    if (p && !seen[p]) {
      seen[p] = true;
      out.push(p);
    }
  }
  return out;
}

/**
 * Delete a mirror. If it's an expanded instance of a recurring series,
 * delete the whole series master so every leftover slot disappears.
 */
function deleteMirrorSafe_(destCalId, mirror) {
  if (!mirror || !mirror.id) return false;
  try {
    var idToDelete = mirror.id;
    if (mirror.recurringEventId) {
      idToDelete = mirror.recurringEventId;
    }
    Calendar.Events.remove(destCalId, idToDelete, { sendUpdates: "none" });
    return true;
  } catch (e) {
    var msg = String(e.message || e);
    if (msg.indexOf("Not Found") !== -1 || msg.indexOf("404") !== -1) return true;
    if (isRateLimit_(e)) throw e;
    // Fallback: try the instance id itself
    try {
      Calendar.Events.remove(destCalId, mirror.id, { sendUpdates: "none" });
      return true;
    } catch (e2) {
      if (String(e2).indexOf("Not Found") !== -1 || String(e2).indexOf("404") !== -1) return true;
      throw e2;
    }
  }
}

// ─── create / update ─────────────────────────────────────────────────────────

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

function fingerprint_(ev) {
  return [
    stripPrefix_(ev.summary || ""),
    eventStartKey_(ev),
    eventEndKey_(ev)
  ].join("|");
}

function stripPrefix_(summary) {
  var prefixes = uniquePrefixes_();
  for (var i = 0; i < prefixes.length; i++) {
    if (summary.indexOf(prefixes[i]) === 0) {
      return summary.substring(prefixes[i].length);
    }
  }
  return summary;
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
    description: "Mirrored from Insight.\nSource: " + sourceId,
    extendedProperties: { private: {} }
  };
  body.extendedProperties.private[MIRROR_SOURCE_KEY] = sourceId;
  body.extendedProperties.private[MIRROR_SOURCE_CAL_KEY] = sourceCalId;
  body.extendedProperties.private[MIRROR_HASH_KEY] = hash;
  body.extendedProperties.private.mirrorSourceUpdated = source.updated || "";
  if (source.location) body.location = source.location;
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

// ─── misc ────────────────────────────────────────────────────────────────────

function findCalendarId_(nameOrPrimary) {
  var items = (Calendar.CalendarList.list().items) || [];
  for (var i = 0; i < items.length; i++) {
    var cal = items[i];
    if (nameOrPrimary === "primary" && cal.primary) return cal.id;
    if (cal.summary === nameOrPrimary) return cal.id;
  }
  return null;
}

function checkCalendarApi_() {
  if (typeof Calendar === "undefined" || !Calendar.Events) {
    throw new Error(
      "Enable Google Calendar API: left sidebar → + → Services → Google Calendar API → Add"
    );
  }
}

function hitLimit_(wrote, deadline) {
  return wrote >= MAX_WRITES_PER_PASS || Date.now() > deadline - 15000;
}

function softPause_(deadline) {
  if (Date.now() + PAUSE_MS < deadline) Utilities.sleep(PAUSE_MS);
}

function isRateLimit_(e) {
  var msg = String(e.message || e);
  return msg.indexOf("too many") !== -1 || msg.indexOf("Rate Limit") !== -1;
}

function formatPass_(pass) {
  return "Created: " + pass.created +
    ", Updated: " + pass.updated +
    ", Deleted: " + pass.deleted +
    ", Skipped: " + pass.skipped +
    (pass.done ? "\nAll caught up." : "\nPending: " + pass.pending + " — run again.");
}

function scheduleContinue_() {
  clearContinueTriggers_();
  ScriptApp.newTrigger("syncAllContinue").timeBased().after(CONTINUE_DELAY_MS).create();
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
