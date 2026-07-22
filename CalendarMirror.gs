/**
 * Calendar Mirror — memory-safe version
 *
 * SETUP:
 * 1. Paste, confirm EDIT THIS section, Save
 * 2. Services → + → Google Calendar API → Add
 * 3. Run listMyCalendars → Allow
 * 4. Run cleanupStaleMirrors (may need a few runs)
 * 5. Run syncAll, then createSchedule
 */

// ─── EDIT THIS ───────────────────────────────────────────────────────────────
var SOURCE_CALENDAR_NAME = "Insight";
var DESTINATION_CALENDAR_NAME = "primary";
var MIRROR_PREFIX = "[Insight] ";
var LEGACY_PREFIXES = ["[Work] ", "[Insight] "];
var ONLY_ACCEPTED = true;
// ──────────────────────────────────────────────────────────────────────────────

// Keep windows small to avoid Apps Script OOM
var SYNC_PAST_DAYS = 14;
var SYNC_FUTURE_DAYS = 120;
var CLEANUP_FUTURE_DAYS = 60;

var PAUSE_MS = 400;
var MAX_EXEC_MS = 4 * 60 * 1000;
var CONTINUE_DELAY_MS = 2 * 60 * 1000;
var MAINTENANCE_INTERVAL_MINUTES = 5;
var MAX_WRITES = 30;
var PAGE_SIZE = 100;

var MIRROR_SOURCE_KEY = "mirrorSourceId";
var MIRROR_SOURCE_CAL_KEY = "mirrorSourceCalendarId";
var MIRROR_HASH_KEY = "mirrorContentHash";

// ─── entry points ────────────────────────────────────────────────────────────

function listMyCalendars() {
  checkApi_();
  var items = Calendar.CalendarList.list({ maxResults: 100 }).items || [];
  Logger.log("=== CALENDARS ===");
  for (var i = 0; i < items.length; i++) {
    var c = items[i];
    var hint = "";
    if (c.summary === SOURCE_CALENDAR_NAME) hint = " ← SOURCE";
    if ((DESTINATION_CALENDAR_NAME === "primary" && c.primary) ||
        c.summary === DESTINATION_CALENDAR_NAME) hint = " ← DESTINATION";
    Logger.log(c.summary + hint);
    Logger.log("  " + c.id);
  }
}

function syncNow() {
  checkApi_();
  Logger.log(format_(runPass_(false)));
}

function cleanupStaleMirrors() {
  checkApi_();
  var result = runPass_(true);
  Logger.log(format_(result));
  Logger.log("Re-run cleanupStaleMirrors until Deleted: 0 and Pending: 0.");
}

function syncAll() {
  checkApi_();
  var deadline = Date.now() + MAX_EXEC_MS;
  var totals = { created: 0, updated: 0, deleted: 0, skipped: 0 };
  var done = false;

  try {
    while (Date.now() < deadline - 20000) {
      var pass = runPass_(false);
      totals.created += pass.created;
      totals.updated += pass.updated;
      totals.deleted += pass.deleted;
      totals.skipped += pass.skipped;
      if (pass.done) {
        done = true;
        clearContinue_();
        enableSchedule_();
        Logger.log("ALL DONE. " + format_(totals) +
          "\nAuto-sync every " + MAINTENANCE_INTERVAL_MINUTES + " min.");
        return;
      }
      if (pass.wrote === 0) break;
    }
  } finally {
    if (!done) {
      scheduleContinue_();
      Logger.log("Paused — continues in ~2 min. " + format_(totals));
    }
  }
}

function syncAllContinue() { syncAll(); }

function createSchedule() {
  enableSchedule_();
  Logger.log("Auto-sync ON every " + MAINTENANCE_INTERVAL_MINUTES + " min.");
}

function finishSetup() {
  cleanupStaleMirrors();
  createSchedule();
}

function setup() {
  listMyCalendars();
  Logger.log("Next: cleanupStaleMirrors → syncAll → createSchedule");
}

// ─── core (streams pages; never holds the full year in memory) ───────────────

function runPass_(cleanupOnly) {
  var sourceId = findCal_(SOURCE_CALENDAR_NAME);
  var destId = findCal_(DESTINATION_CALENDAR_NAME);
  if (!sourceId) throw new Error('Source "' + SOURCE_CALENDAR_NAME + '" not found. Run listMyCalendars.');
  if (!destId) throw new Error('Destination "' + DESTINATION_CALENDAR_NAME + '" not found.');

  var now = new Date();
  var futureDays = cleanupOnly ? CLEANUP_FUTURE_DAYS : SYNC_FUTURE_DAYS;
  var timeMin = iso_(addDays_(now, -SYNC_PAST_DAYS));
  var timeMax = iso_(addDays_(now, futureDays));

  // Build a compact set of accepted source instance IDs + fingerprints
  var source = loadSourceIndex_(sourceId, timeMin, timeMax);

  var created = 0, updated = 0, deleted = 0, skipped = 0, wrote = 0;
  var pendingCreate = 0;
  var deadline = Date.now() + MAX_EXEC_MS;
  var seenSourceIds = {};

  // Pass 1: walk destination mirrors page-by-page and delete stale ones
  var pageToken = null;
  do {
    if (wrote >= MAX_WRITES || Date.now() > deadline - 15000) break;

    var resp = Calendar.Events.list(destId, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted: false,
      maxResults: PAGE_SIZE,
      pageToken: pageToken
    });

    var items = resp.items || [];
    for (var i = 0; i < items.length; i++) {
      if (wrote >= MAX_WRITES || Date.now() > deadline - 15000) break;

      var mirror = items[i];
      if (!isMirrorEvent_(mirror)) continue;

      var props = priv_(mirror);
      var sid = props[MIRROR_SOURCE_KEY] || "";

      // Stale if: tagged source id gone, OR untagged and fingerprint gone,
      // OR tagged but event is no longer accepted (tentative etc.)
      var stale = false;
      if (sid) {
        if (!source.byId[sid]) stale = true;
        else seenSourceIds[sid] = true;
      } else {
        if (!source.fingerprints[fp_(mirror)]) stale = true;
      }

      // Also replace wrong prefix / recurring masters left behind
      if (!stale && mirror.recurringEventId && source.byId[sid]) {
        // expanded instance of an old series — delete whole series once
        stale = true;
      }
      if (!stale && mirror.recurrence && mirror.recurrence.length) {
        stale = true; // old series master style — remove; instances will be recreated
      }

      if (!stale) {
        // live tagged mirror — maybe needs update
        if (sid && source.byId[sid] && !cleanupOnly) {
          var src = source.byId[sid];
          var title = MIRROR_PREFIX + (src.summary || "(No title)");
          var hash = hash_(src, title);
          if (needsUpdate_(src, mirror, title, hash)) {
            try {
              Calendar.Events.update(
                body_(src, title, sid, sourceId, hash),
                destId,
                mirror.id,
                { sendUpdates: "none" }
              );
              updated++;
              wrote++;
              sleep_();
            } catch (e) {
              if (isRate_(e)) return done_(created, updated, deleted, skipped, wrote, true, 1);
              throw e;
            }
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
        continue;
      }

      try {
        deleteSafe_(destId, mirror);
        deleted++;
        wrote++;
        sleep_();
      } catch (e2) {
        if (isRate_(e2)) return done_(created, updated, deleted, skipped, wrote, true, 1);
        throw e2;
      }
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);

  // Pass 2: create missing mirrors
  if (wrote < MAX_WRITES && Date.now() < deadline - 15000) {
    for (var sid2 in source.byId) {
      if (wrote >= MAX_WRITES || Date.now() > deadline - 15000) break;
      if (seenSourceIds[sid2]) continue;

      var src2 = source.byId[sid2];
      var title2 = MIRROR_PREFIX + (src2.summary || "(No title)");
      var hash2 = hash_(src2, title2);
      try {
        Calendar.Events.insert(body_(src2, title2, sid2, sourceId, hash2), destId, { sendUpdates: "none" });
        created++;
        wrote++;
        seenSourceIds[sid2] = true;
        sleep_();
      } catch (e3) {
        if (isRate_(e3)) return done_(created, updated, deleted, skipped, wrote, true, 1);
        throw e3;
      }
    }
  }

  var pendingCreate = 0;
  for (var sid4 in source.byId) {
    if (!seenSourceIds[sid4]) pendingCreate++;
  }

  var finished = pendingCreate === 0 && wrote < MAX_WRITES;
  return done_(created, updated, deleted, skipped, wrote, false, pendingCreate, finished);
}

function loadSourceIndex_(calendarId, timeMin, timeMax) {
  var byId = {};
  var fingerprints = {};
  var pageToken = null;
  var count = 0;
  var MAX_SOURCE = 800; // hard cap to protect memory

  do {
    var resp = Calendar.Events.list(calendarId, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted: false,
      maxResults: PAGE_SIZE,
      pageToken: pageToken
    });
    var items = resp.items || [];
    for (var i = 0; i < items.length; i++) {
      if (count >= MAX_SOURCE) break;
      var ev = items[i];
      if (!shouldMirror_(ev)) continue;
      // Store a slim copy only — drop heavy fields
      var slim = {
        id: ev.id,
        summary: ev.summary,
        start: ev.start,
        end: ev.end,
        status: ev.status,
        location: ev.location,
        updated: ev.updated
      };
      byId[ev.id] = slim;
      fingerprints[fp_(slim)] = true;
      count++;
    }
    if (count >= MAX_SOURCE) break;
    pageToken = resp.nextPageToken;
  } while (pageToken);

  return { byId: byId, fingerprints: fingerprints, count: count };
}

function shouldMirror_(ev) {
  if (!ev || ev.status === "cancelled") return false;
  if (!ev.start || !(ev.start.dateTime || ev.start.date)) return false;
  if (!ONLY_ACCEPTED) return true;
  if (ev.status === "tentative") return false;

  var attendees = ev.attendees || [];
  for (var i = 0; i < attendees.length; i++) {
    if (attendees[i].self) {
      return attendees[i].responseStatus === "accepted";
    }
  }
  // No self attendee (common on subscribed calendars) — keep confirmed events
  return true;
}

function isMirrorEvent_(ev) {
  var summary = ev.summary || "";
  var prefixes = prefixes_();
  for (var i = 0; i < prefixes.length; i++) {
    if (summary.indexOf(prefixes[i]) === 0) return true;
  }
  var props = priv_(ev);
  return !!(props[MIRROR_SOURCE_KEY] || props[MIRROR_SOURCE_CAL_KEY]);
}

function needsUpdate_(source, mirror, title, hash) {
  var props = priv_(mirror);
  if (props[MIRROR_HASH_KEY] !== hash) return true;
  if (mirror.summary !== title) return true;
  if (startKey_(mirror) !== startKey_(source)) return true;
  if (endKey_(mirror) !== endKey_(source)) return true;
  return false;
}

function deleteSafe_(destId, mirror) {
  var id = mirror.recurringEventId || mirror.id;
  try {
    Calendar.Events.remove(destId, id, { sendUpdates: "none" });
  } catch (e) {
    if (alreadyGone_(e)) return;
    if (id !== mirror.id) {
      try {
        Calendar.Events.remove(destId, mirror.id, { sendUpdates: "none" });
        return;
      } catch (e2) {
        if (alreadyGone_(e2)) return;
        throw e2;
      }
    }
    throw e;
  }
}

function alreadyGone_(e) {
  var msg = String(e.message || e);
  return msg.indexOf("Not Found") !== -1 ||
    msg.indexOf("404") !== -1 ||
    msg.indexOf("has been deleted") !== -1 ||
    msg.indexOf("Resource has been deleted") !== -1;
}

function body_(source, title, sourceId, sourceCalId, hash) {
  var b = {
    summary: title,
    start: source.start,
    end: source.end,
    transparency: "opaque",
    description: "Mirrored from Insight.\nSource: " + sourceId,
    extendedProperties: { private: {} }
  };
  b.extendedProperties.private[MIRROR_SOURCE_KEY] = sourceId;
  b.extendedProperties.private[MIRROR_SOURCE_CAL_KEY] = sourceCalId;
  b.extendedProperties.private[MIRROR_HASH_KEY] = hash;
  if (source.location) b.location = source.location;
  return b;
}

function hash_(source, title) {
  return [title, startKey_(source), endKey_(source), source.location || ""].join("|");
}

function fp_(ev) {
  return [strip_(ev.summary || ""), startKey_(ev), endKey_(ev)].join("|");
}

function strip_(summary) {
  var p = prefixes_();
  for (var i = 0; i < p.length; i++) {
    if (summary.indexOf(p[i]) === 0) return summary.substring(p[i].length);
  }
  return summary;
}

function prefixes_() {
  var out = [], seen = {};
  var all = [MIRROR_PREFIX].concat(LEGACY_PREFIXES || []);
  for (var i = 0; i < all.length; i++) {
    if (all[i] && !seen[all[i]]) { seen[all[i]] = true; out.push(all[i]); }
  }
  return out;
}

function priv_(ev) { return ((ev.extendedProperties || {}).private) || {}; }
function startKey_(ev) { var s = ev.start || {}; return s.dateTime || s.date || ""; }
function endKey_(ev) { var e = ev.end || {}; return e.dateTime || e.date || ""; }

function findCal_(name) {
  var items = Calendar.CalendarList.list({ maxResults: 100 }).items || [];
  for (var i = 0; i < items.length; i++) {
    if (name === "primary" && items[i].primary) return items[i].id;
    if (items[i].summary === name) return items[i].id;
  }
  return null;
}

function checkApi_() {
  if (typeof Calendar === "undefined" || !Calendar.Events) {
    throw new Error("Add Google Calendar API: left sidebar → Services → + → Google Calendar API");
  }
}

function addDays_(d, n) { return new Date(d.getTime() + n * 86400000); }
function iso_(d) { return d.toISOString(); }
function sleep_() { Utilities.sleep(PAUSE_MS); }
function isRate_(e) {
  var m = String(e.message || e);
  return m.indexOf("too many") !== -1 || m.indexOf("Rate Limit") !== -1 || m.indexOf("overhead") !== -1;
}

function done_(created, updated, deleted, skipped, wrote, rateLimited, pending, finished) {
  return {
    created: created,
    updated: updated,
    deleted: deleted,
    skipped: skipped,
    wrote: wrote,
    rateLimited: !!rateLimited,
    pending: pending || 0,
    done: !!finished && !rateLimited && (pending || 0) === 0
  };
}

function format_(p) {
  return "Created: " + (p.created || 0) +
    ", Updated: " + (p.updated || 0) +
    ", Deleted: " + (p.deleted || 0) +
    ", Skipped: " + (p.skipped || 0) +
    ", Pending: " + (p.pending || 0);
}

function scheduleContinue_() {
  clearContinue_();
  ScriptApp.newTrigger("syncAllContinue").timeBased().after(CONTINUE_DELAY_MS).create();
}

function clearContinue_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "syncAllContinue") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function enableSchedule_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "syncNow") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("syncNow").timeBased().everyMinutes(MAINTENANCE_INTERVAL_MINUTES).create();
}
