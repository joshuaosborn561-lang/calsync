/**
 * Calendar Mirror — self-healing edition
 *
 * SETUP (once):
 *   1. Paste this whole file, Save
 *   2. Left sidebar → Services → + → Google Calendar API → Add
 *   3. Run  install()  → Allow access
 *
 * After that it runs itself. It never crashes out:
 *   - Every error is caught and logged, the run continues
 *   - Its own trigger is re-created automatically if it goes missing
 *   - Work is spread across runs, so it can't time out or run out of memory
 *
 * To check on it any time:  run  healthCheck()
 * To stop it completely:    run  uninstall()
 */

// ─── EDIT THIS ───────────────────────────────────────────────────────────────
var SOURCE_CALENDAR_NAME = "Insight";      // subscribed work calendar
var DESTINATION_CALENDAR_NAME = "primary"; // calendar you own (Calendly reads this)
var MIRROR_PREFIX = "[Insight] ";          // title prefix on copies
var LEGACY_PREFIXES = ["[Work] "];         // old prefixes to clean up
var ONLY_ACCEPTED = true;                  // skip tentative / not-yet-accepted
// ──────────────────────────────────────────────────────────────────────────────

var SYNC_INTERVAL_MINUTES = 10;

// Near-term window: re-checked on EVERY run so moves/cancels fix fast
var HOT_PAST_DAYS = 3;
var HOT_FUTURE_DAYS = 21;

// Long-range coverage: walked one slice at a time, run after run
var DEEP_PAST_DAYS = 14;
var DEEP_FUTURE_DAYS = 180;
var SLICE_DAYS = 21;
var MAX_SLICE_ATTEMPTS = 3;

// Safety limits (prevent timeouts, OOM, and rate limits)
var MAX_WRITES_PER_RUN = 35;
var MAX_RUN_MS = 4.5 * 60 * 1000;
var MAX_EVENTS_PER_RANGE = 600;
var PAGE_SIZE = 100;
var PAUSE_MS = 300;
var RETRY_BACKOFF_MS = [2000, 5000, 12000];

var MIRROR_SOURCE_KEY = "mirrorSourceId";
var MIRROR_SOURCE_CAL_KEY = "mirrorSourceCalendarId";
var MIRROR_HASH_KEY = "mirrorContentHash";

var PROP_CURSOR = "sliceCursor";
var PROP_ATTEMPTS = "sliceAttempts";
var PROP_LAST_RUN = "lastRunAt";
var PROP_LAST_OK = "lastSuccessAt";
var PROP_LAST_ERROR = "lastError";
var PROP_ERROR_STREAK = "errorStreak";
var PROP_LAST_SUMMARY = "lastSummary";

// ─── entry points ────────────────────────────────────────────────────────────

/** Run this ONCE. Sets everything up and starts the first sync. */
function install() {
  if (!apiReady_()) {
    Logger.log(
      "STOP: Google Calendar API service is not added.\n" +
      "Left sidebar → Services → + → Google Calendar API → Add, then run install() again."
    );
    return;
  }

  var cals = resolveCalendars_();
  if (!cals) {
    Logger.log(
      'STOP: Could not find calendar "' + SOURCE_CALENDAR_NAME + '" or "' +
      DESTINATION_CALENDAR_NAME + '".\nRun listMyCalendars() and fix the names at the top.'
    );
    return;
  }

  removeTriggers_(["syncNow", "watchdog", "syncAllContinue", "syncAll"]);
  ScriptApp.newTrigger("syncNow").timeBased().everyMinutes(SYNC_INTERVAL_MINUTES).create();
  ScriptApp.newTrigger("watchdog").timeBased().everyHours(6).create();

  var props = props_();
  props.deleteProperty(PROP_LAST_ERROR);
  props.setProperty(PROP_ERROR_STREAK, "0");
  props.setProperty(PROP_CURSOR, "0");
  props.setProperty(PROP_ATTEMPTS, "0");

  Logger.log("Installed. Syncing every " + SYNC_INTERVAL_MINUTES + " minutes. Running first sync now...");
  syncNow();
  Logger.log("\n" + healthText_());
}

/**
 * The worker. Runs on a timer. NEVER throws — a bad event or a Google hiccup
 * can't kill the schedule.
 */
function syncNow() {
  var started = Date.now();
  var summary = newSummary_();

  try {
    ensureTriggers_();

    if (!apiReady_()) {
      recordError_("Google Calendar API service not added");
      return;
    }

    var cals = resolveCalendars_();
    if (!cals) {
      recordError_('Calendar not found: "' + SOURCE_CALENDAR_NAME + '" → "' + DESTINATION_CALENDAR_NAME + '"');
      return;
    }

    var budget = newBudget_(MAX_WRITES_PER_RUN, started + MAX_RUN_MS);
    var now = new Date();

    // 1) Near-term window every run — keeps moves/cancels accurate
    syncRange_(cals, addDays_(now, -HOT_PAST_DAYS), addDays_(now, HOT_FUTURE_DAYS), summary, budget);

    // 2) One long-range slice per run — full coverage over time, bounded memory
    var slice = currentSlice_(now);
    if (slice) {
      var complete = syncRange_(cals, slice.start, slice.end, summary, budget);
      advanceSlice_(complete);
    }

    recordSuccess_(summary);
  } catch (e) {
    // Should be unreachable, but a trigger must never die.
    recordError_(errText_(e));
    summary.errors++;
  }

  Logger.log(summaryText_(summary, Date.now() - started));
}

/** Safety net: re-creates the sync trigger if it ever disappears. */
function watchdog() {
  try {
    ensureTriggers_();
    var props = props_();
    var lastOk = Number(props.getProperty(PROP_LAST_OK) || 0);
    var staleMs = Date.now() - lastOk;

    if (lastOk && staleMs > 3 * 60 * 60 * 1000) {
      Logger.log("Watchdog: no successful sync in " + Math.round(staleMs / 3600000) + "h — forcing one.");
      syncNow();
    } else {
      Logger.log("Watchdog: healthy.");
    }
  } catch (e) {
    Logger.log("Watchdog error (ignored): " + errText_(e));
  }
}

/** Status report — safe to run any time. */
function healthCheck() {
  Logger.log(healthText_());
}

/** Deep clean: removes leftover mirrors across the whole range, a chunk per run. */
function cleanupStaleMirrors() {
  var summary = newSummary_();
  try {
    if (!apiReady_()) {
      Logger.log("Add the Google Calendar API service first (Services → +).");
      return;
    }
    var cals = resolveCalendars_();
    if (!cals) {
      Logger.log("Calendar names don't match. Run listMyCalendars().");
      return;
    }

    var budget = newBudget_(MAX_WRITES_PER_RUN * 3, Date.now() + MAX_RUN_MS);
    var now = new Date();
    var start = addDays_(now, -DEEP_PAST_DAYS);
    var end = addDays_(now, DEEP_FUTURE_DAYS);
    var complete = true;

    for (var d = 0; d < 400; d += SLICE_DAYS) {
      var sliceStart = addDays_(start, d);
      if (sliceStart.getTime() >= end.getTime()) break;
      var sliceEnd = minDate_(addDays_(sliceStart, SLICE_DAYS), end);
      if (exhausted_(budget)) { complete = false; break; }
      if (!syncRange_(cals, sliceStart, sliceEnd, summary, budget)) complete = false;
    }

    Logger.log(
      summaryText_(summary, 0) +
      (complete ? "\nFull range clean." : "\nMore to do — run cleanupStaleMirrors() again.")
    );
  } catch (e) {
    Logger.log("Cleanup error: " + errText_(e));
  }
}

function listMyCalendars() {
  if (!apiReady_()) {
    Logger.log("Add the Google Calendar API service first: Services → + → Google Calendar API");
    return;
  }
  var items = [];
  try {
    items = Calendar.CalendarList.list({ maxResults: 250 }).items || [];
  } catch (e) {
    Logger.log("Could not list calendars: " + errText_(e));
    return;
  }
  Logger.log("=== YOUR CALENDARS ===");
  for (var i = 0; i < items.length; i++) {
    var c = items[i];
    var tag = "";
    if (c.summary === SOURCE_CALENDAR_NAME) tag = "   ← SOURCE";
    if ((DESTINATION_CALENDAR_NAME === "primary" && c.primary) || c.summary === DESTINATION_CALENDAR_NAME) {
      tag = "   ← DESTINATION";
    }
    Logger.log(c.summary + tag);
    Logger.log("   id: " + c.id + "   access: " + c.accessRole);
  }
}

/** Turns everything off. */
function uninstall() {
  removeTriggers_(["syncNow", "watchdog", "syncAllContinue", "syncAll"]);
  Logger.log("All triggers removed. Mirrored events were left in place.");
}

// ─── sync engine ─────────────────────────────────────────────────────────────

/**
 * Mirrors one date range. Returns true if the range was fully processed.
 * Errors on individual events are counted, never thrown.
 */
function syncRange_(cals, startDate, endDate, summary, budget) {
  var timeMin = startDate.toISOString();
  var timeMax = endDate.toISOString();

  var source = loadSourceIndex_(cals.sourceId, timeMin, timeMax, summary);
  if (!source) return false;

  var complete = true;
  var seen = {};
  var pageToken = null;

  do {
    if (exhausted_(budget)) { complete = false; break; }

    var resp = listEvents_(cals.destId, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted: false,
      maxResults: PAGE_SIZE,
      pageToken: pageToken
    }, summary);

    if (!resp) { complete = false; break; }

    var items = resp.items || [];
    for (var i = 0; i < items.length; i++) {
      if (exhausted_(budget)) { complete = false; break; }

      var mirror = items[i];
      if (!isMirrorEvent_(mirror)) continue;

      var sid = mirrorSourceId_(mirror);
      var live = sid ? source.byId[sid] : null;

      var stale =
        (mirror.recurrence && mirror.recurrence.length) ||  // legacy series copy
        !!mirror.recurringEventId ||                        // instance of legacy series
        (sid ? !live : !source.fingerprints[fingerprint_(mirror)]);

      if (stale) {
        if (deleteMirror_(cals.destId, mirror, summary)) {
          summary.deleted++;
          budget.writes++;
          pause_(budget);
        }
        continue;
      }

      if (!live) { summary.skipped++; continue; }

      seen[sid] = true;
      var title = MIRROR_PREFIX + (live.summary || "(No title)");
      var hash = hash_(live, title);

      if (needsUpdate_(live, mirror, title, hash)) {
        if (updateMirror_(cals, mirror.id, live, title, sid, hash, summary)) {
          summary.updated++;
          budget.writes++;
          pause_(budget);
        }
      } else {
        summary.skipped++;
      }
    }

    pageToken = resp.nextPageToken;
  } while (pageToken);

  for (var id in source.byId) {
    if (exhausted_(budget)) { complete = false; break; }
    if (seen[id]) continue;

    var src = source.byId[id];
    var newTitle = MIRROR_PREFIX + (src.summary || "(No title)");
    if (createMirror_(cals, src, newTitle, id, hash_(src, newTitle), summary)) {
      summary.created++;
      budget.writes++;
      pause_(budget);
    }
  }

  return complete;
}

/** Slim index of accepted source events in a range. Returns null on failure. */
function loadSourceIndex_(calendarId, timeMin, timeMax, summary) {
  var byId = {};
  var fingerprints = {};
  var count = 0;
  var pageToken = null;

  do {
    var resp = listEvents_(calendarId, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted: false,
      maxResults: PAGE_SIZE,
      pageToken: pageToken
    }, summary);

    if (!resp) return null;

    var items = resp.items || [];
    for (var i = 0; i < items.length && count < MAX_EVENTS_PER_RANGE; i++) {
      var ev = items[i];
      if (!shouldMirror_(ev)) continue;

      var slim = {
        id: ev.id,
        summary: ev.summary,
        start: ev.start,
        end: ev.end,
        location: ev.location
      };
      byId[ev.id] = slim;
      fingerprints[fingerprint_(slim)] = true;
      count++;
    }

    if (count >= MAX_EVENTS_PER_RANGE) break;
    pageToken = resp.nextPageToken;
  } while (pageToken);

  return { byId: byId, fingerprints: fingerprints };
}

function shouldMirror_(ev) {
  if (!ev || ev.status === "cancelled") return false;
  if (!ev.start || !(ev.start.dateTime || ev.start.date)) return false;
  if (!ONLY_ACCEPTED) return true;
  if (ev.status === "tentative") return false;

  var attendees = ev.attendees || [];
  for (var i = 0; i < attendees.length; i++) {
    if (attendees[i].self) return attendees[i].responseStatus === "accepted";
  }
  return true; // subscribed feeds often have no attendee list
}

// ─── Calendar API wrappers (retry, never throw) ──────────────────────────────

function listEvents_(calendarId, params, summary) {
  for (var attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return Calendar.Events.list(calendarId, params);
    } catch (e) {
      if (attempt < RETRY_BACKOFF_MS.length && transient_(e)) {
        Utilities.sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      noteError_(summary, "list", e);
      return null;
    }
  }
  return null;
}

function createMirror_(cals, source, title, sourceId, hash, summary) {
  try {
    Calendar.Events.insert(body_(source, title, sourceId, cals.sourceId, hash), cals.destId, { sendUpdates: "none" });
    return true;
  } catch (e) {
    if (transient_(e)) {
      Utilities.sleep(RETRY_BACKOFF_MS[0]);
      try {
        Calendar.Events.insert(body_(source, title, sourceId, cals.sourceId, hash), cals.destId, { sendUpdates: "none" });
        return true;
      } catch (e2) {
        noteError_(summary, "create", e2);
        return false;
      }
    }
    noteError_(summary, "create", e);
    return false;
  }
}

function updateMirror_(cals, mirrorId, source, title, sourceId, hash, summary) {
  try {
    Calendar.Events.update(body_(source, title, sourceId, cals.sourceId, hash), cals.destId, mirrorId, { sendUpdates: "none" });
    return true;
  } catch (e) {
    if (gone_(e)) return false; // it'll be recreated next pass
    noteError_(summary, "update", e);
    return false;
  }
}

/** Deletes a mirror. "Already gone" counts as success. */
function deleteMirror_(destId, mirror, summary) {
  var ids = [];
  if (mirror.recurringEventId) ids.push(mirror.recurringEventId);
  ids.push(mirror.id);

  for (var i = 0; i < ids.length; i++) {
    try {
      Calendar.Events.remove(destId, ids[i], { sendUpdates: "none" });
      return true;
    } catch (e) {
      if (gone_(e)) return true;
      if (transient_(e)) {
        Utilities.sleep(RETRY_BACKOFF_MS[0]);
        try {
          Calendar.Events.remove(destId, ids[i], { sendUpdates: "none" });
          return true;
        } catch (e2) {
          if (gone_(e2)) return true;
        }
      }
      if (i === ids.length - 1) {
        noteError_(summary, "delete", e);
        return false;
      }
    }
  }
  return false;
}

// ─── event helpers ───────────────────────────────────────────────────────────

function body_(source, title, sourceId, sourceCalId, hash) {
  var b = {
    summary: title,
    start: source.start,
    end: source.end,
    transparency: "opaque",
    reminders: { useDefault: false, overrides: [] },
    description: "Mirrored from " + SOURCE_CALENDAR_NAME + ".\nSource: " + sourceId,
    extendedProperties: { private: {} }
  };
  b.extendedProperties.private[MIRROR_SOURCE_KEY] = sourceId;
  b.extendedProperties.private[MIRROR_SOURCE_CAL_KEY] = sourceCalId;
  b.extendedProperties.private[MIRROR_HASH_KEY] = hash;
  if (source.location) b.location = source.location;
  return b;
}

function needsUpdate_(source, mirror, title, hash) {
  if (privateProps_(mirror)[MIRROR_HASH_KEY] !== hash) return true;
  if (mirror.summary !== title) return true;
  if (startKey_(mirror) !== startKey_(source)) return true;
  if (endKey_(mirror) !== endKey_(source)) return true;
  return false;
}

function isMirrorEvent_(ev) {
  var summary = ev.summary || "";
  var list = prefixes_();
  for (var i = 0; i < list.length; i++) {
    if (summary.indexOf(list[i]) === 0) return true;
  }
  var p = privateProps_(ev);
  var s = sharedProps_(ev);
  return !!(p[MIRROR_SOURCE_KEY] || p[MIRROR_SOURCE_CAL_KEY] || s[MIRROR_SOURCE_KEY] || s.mirrorSourceId);
}

function mirrorSourceId_(ev) {
  var p = privateProps_(ev);
  if (p[MIRROR_SOURCE_KEY]) return p[MIRROR_SOURCE_KEY];
  var s = sharedProps_(ev);
  return s[MIRROR_SOURCE_KEY] || s.mirrorSourceId || "";
}

function hash_(source, title) {
  return [title, startKey_(source), endKey_(source), source.location || ""].join("|");
}

function fingerprint_(ev) {
  return [stripPrefix_(ev.summary || ""), startKey_(ev), endKey_(ev)].join("|");
}

function stripPrefix_(summary) {
  var list = prefixes_();
  for (var i = 0; i < list.length; i++) {
    if (summary.indexOf(list[i]) === 0) return summary.substring(list[i].length);
  }
  return summary;
}

function prefixes_() {
  var out = [];
  var seen = {};
  var all = [MIRROR_PREFIX].concat(LEGACY_PREFIXES || []);
  for (var i = 0; i < all.length; i++) {
    if (all[i] && !seen[all[i]]) { seen[all[i]] = true; out.push(all[i]); }
  }
  return out;
}

function privateProps_(ev) { return ((ev.extendedProperties || {}).private) || {}; }
function sharedProps_(ev) { return ((ev.extendedProperties || {}).shared) || {}; }
function startKey_(ev) { var s = ev.start || {}; return s.dateTime || s.date || ""; }
function endKey_(ev) { var e = ev.end || {}; return e.dateTime || e.date || ""; }

// ─── slices, triggers, state ─────────────────────────────────────────────────

function currentSlice_(now) {
  var totalDays = DEEP_PAST_DAYS + DEEP_FUTURE_DAYS;
  var sliceCount = Math.ceil(totalDays / SLICE_DAYS);
  if (sliceCount <= 0) return null;

  var cursor = Number(props_().getProperty(PROP_CURSOR) || 0);
  if (!isFinite(cursor) || cursor < 0 || cursor >= sliceCount) cursor = 0;

  var rangeStart = addDays_(now, -DEEP_PAST_DAYS);
  var start = addDays_(rangeStart, cursor * SLICE_DAYS);
  var end = minDate_(addDays_(start, SLICE_DAYS), addDays_(now, DEEP_FUTURE_DAYS));

  return { index: cursor, count: sliceCount, start: start, end: end };
}

function advanceSlice_(complete) {
  var props = props_();
  var slice = Number(props.getProperty(PROP_CURSOR) || 0);
  var attempts = Number(props.getProperty(PROP_ATTEMPTS) || 0);
  var totalDays = DEEP_PAST_DAYS + DEEP_FUTURE_DAYS;
  var sliceCount = Math.max(1, Math.ceil(totalDays / SLICE_DAYS));

  if (complete || attempts + 1 >= MAX_SLICE_ATTEMPTS) {
    props.setProperty(PROP_CURSOR, String((slice + 1) % sliceCount));
    props.setProperty(PROP_ATTEMPTS, "0");
  } else {
    props.setProperty(PROP_ATTEMPTS, String(attempts + 1));
  }
}

function ensureTriggers_() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var hasSync = false;
    var hasWatchdog = false;

    for (var i = 0; i < triggers.length; i++) {
      var fn = triggers[i].getHandlerFunction();
      if (fn === "syncNow") hasSync = true;
      if (fn === "watchdog") hasWatchdog = true;
    }
    if (!hasSync) {
      ScriptApp.newTrigger("syncNow").timeBased().everyMinutes(SYNC_INTERVAL_MINUTES).create();
      Logger.log("Sync trigger was missing — re-created.");
    }
    if (!hasWatchdog) {
      ScriptApp.newTrigger("watchdog").timeBased().everyHours(6).create();
    }
  } catch (e) {
    Logger.log("Could not verify triggers (ignored): " + errText_(e));
  }
}

function removeTriggers_(names) {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    for (var j = 0; j < names.length; j++) {
      if (fn === names[j]) {
        try { ScriptApp.deleteTrigger(triggers[i]); } catch (e) {}
        break;
      }
    }
  }
}

function resolveCalendars_() {
  var sourceId = findCalendarId_(SOURCE_CALENDAR_NAME);
  var destId = findCalendarId_(DESTINATION_CALENDAR_NAME);
  if (!sourceId || !destId) return null;
  return { sourceId: sourceId, destId: destId };
}

function findCalendarId_(name) {
  try {
    var items = Calendar.CalendarList.list({ maxResults: 250 }).items || [];
    for (var i = 0; i < items.length; i++) {
      if (name === "primary" && items[i].primary) return items[i].id;
      if (items[i].summary === name) return items[i].id;
      if (items[i].id === name) return items[i].id;
    }
  } catch (e) {}
  return null;
}

function props_() { return PropertiesService.getScriptProperties(); }

function recordSuccess_(summary) {
  var props = props_();
  var now = String(Date.now());
  props.setProperty(PROP_LAST_RUN, now);
  props.setProperty(PROP_LAST_SUMMARY, JSON.stringify(summary));

  if (summary.errors === 0) {
    props.setProperty(PROP_LAST_OK, now);
    props.setProperty(PROP_ERROR_STREAK, "0");
    props.deleteProperty(PROP_LAST_ERROR);
  } else {
    props.setProperty(PROP_LAST_OK, now); // it still ran; errors were per-event
    props.setProperty(PROP_LAST_ERROR, summary.lastError || "");
  }
}

function recordError_(message) {
  var props = props_();
  var streak = Number(props.getProperty(PROP_ERROR_STREAK) || 0) + 1;
  props.setProperty(PROP_LAST_RUN, String(Date.now()));
  props.setProperty(PROP_LAST_ERROR, message);
  props.setProperty(PROP_ERROR_STREAK, String(streak));
  Logger.log("Sync problem (will retry automatically): " + message);
}

function newSummary_() {
  return { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0, lastError: "" };
}

function noteError_(summary, what, e) {
  summary.errors++;
  summary.lastError = what + ": " + errText_(e);
}

function summaryText_(s, elapsedMs) {
  var line = "Created " + s.created +
    " | Updated " + s.updated +
    " | Deleted " + s.deleted +
    " | Unchanged " + s.skipped;
  if (s.errors) line += " | Skipped due to errors " + s.errors;
  if (elapsedMs) line += " | " + Math.round(elapsedMs / 1000) + "s";
  if (s.lastError) line += "\nLast issue: " + s.lastError;
  return line;
}

function healthText_() {
  var props = props_();
  var lines = [];
  var syncTrigger = false;
  var watchdogTrigger = false;

  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      var fn = triggers[i].getHandlerFunction();
      if (fn === "syncNow") syncTrigger = true;
      if (fn === "watchdog") watchdogTrigger = true;
    }
  } catch (e) {}

  lines.push("=== CALENDAR MIRROR STATUS ===");
  lines.push("Source:      " + SOURCE_CALENDAR_NAME);
  lines.push("Destination: " + DESTINATION_CALENDAR_NAME);
  lines.push("Auto-sync:   " + (syncTrigger ? "ON (every " + SYNC_INTERVAL_MINUTES + " min)" : "OFF — run install()"));
  lines.push("Watchdog:    " + (watchdogTrigger ? "ON" : "OFF"));
  lines.push("Only accepted meetings: " + (ONLY_ACCEPTED ? "yes" : "no"));

  var lastRun = Number(props.getProperty(PROP_LAST_RUN) || 0);
  lines.push("Last run:    " + (lastRun ? ago_(lastRun) : "never"));

  var lastSummary = props.getProperty(PROP_LAST_SUMMARY);
  if (lastSummary) {
    try { lines.push("Last result: " + summaryText_(JSON.parse(lastSummary), 0)); } catch (e) {}
  }

  var slice = currentSlice_(new Date());
  if (slice) lines.push("Deep scan:   slice " + (slice.index + 1) + " of " + slice.count);

  var lastError = props.getProperty(PROP_LAST_ERROR);
  var streak = Number(props.getProperty(PROP_ERROR_STREAK) || 0);
  if (lastError) {
    lines.push("Last issue:  " + lastError + (streak > 1 ? " (x" + streak + ")" : ""));
    lines.push("This retries on its own — no action needed unless it repeats for hours.");
  } else {
    lines.push("No recent problems.");
  }

  return lines.join("\n");
}

function ago_(ms) {
  var mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  var hours = Math.round(mins / 60);
  if (hours < 48) return hours + "h ago";
  return Math.round(hours / 24) + " days ago";
}

// ─── small utilities ─────────────────────────────────────────────────────────

function apiReady_() {
  try { return typeof Calendar !== "undefined" && !!Calendar.Events; } catch (e) { return false; }
}

function newBudget_(maxWrites, deadline) {
  return { writes: 0, maxWrites: maxWrites, deadline: deadline };
}

function exhausted_(budget) {
  return budget.writes >= budget.maxWrites || Date.now() > budget.deadline - 20000;
}

function pause_(budget) {
  if (Date.now() + PAUSE_MS < budget.deadline) Utilities.sleep(PAUSE_MS);
}

function transient_(e) {
  var m = errText_(e).toLowerCase();
  return m.indexOf("too many") !== -1 ||
    m.indexOf("rate limit") !== -1 ||
    m.indexOf("quota") !== -1 ||
    m.indexOf("backend error") !== -1 ||
    m.indexOf("internal error") !== -1 ||
    m.indexOf("timed out") !== -1 ||
    m.indexOf("try again") !== -1;
}

function gone_(e) {
  var m = errText_(e).toLowerCase();
  return m.indexOf("not found") !== -1 ||
    m.indexOf("404") !== -1 ||
    m.indexOf("has been deleted") !== -1 ||
    m.indexOf("deleted") !== -1 ||
    m.indexOf("410") !== -1;
}

function errText_(e) { return String((e && e.message) || e); }
function addDays_(d, n) { return new Date(d.getTime() + n * 86400000); }
function minDate_(a, b) { return a.getTime() <= b.getTime() ? a : b; }
