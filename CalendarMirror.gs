/**
 * Calendar Mirror — https://script.google.com
 *
 * ONE-TIME SETUP:
 * 1. Paste this code, set SOURCE_CALENDAR_NAME below, Save
 * 2. Left sidebar → click "+" next to "Services"
 * 3. Find "Google Calendar API" → Add
 * 4. Run listMyCalendars → Allow access
 * 5. Run syncNow (may take several runs if you have lots of meetings)
 * 6. Run createSchedule for automatic syncing every 15 minutes
 */

// ─── EDIT THIS ───────────────────────────────────────────────────────────────
var SOURCE_CALENDAR_NAME = "Work";
var DESTINATION_CALENDAR_NAME = "primary";
// ──────────────────────────────────────────────────────────────────────────────

var MIRROR_PREFIX = "[Work] ";
var SYNC_PAST_DAYS = 7;
var SYNC_FUTURE_DAYS = 365;

// Google rate-limits bulk creates — stay under the limit
var MAX_WRITES_PER_RUN = 8;
var PAUSE_MS = 2500;

var MIRROR_SOURCE_KEY = "mirrorSourceId";
var MIRROR_SOURCE_CAL_KEY = "mirrorSourceCalendarId";

function setup() {
  checkCalendarApi_();
  listMyCalendars();
  Logger.log("Next: run syncNow. If you have many meetings, run it several times (or wait for the schedule).");
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
    Logger.log("  Access: " + cal.accessRole);
  }
  Logger.log("======================");
}

function syncNow() {
  checkCalendarApi_();

  var sourceCalId = findCalendarId_(SOURCE_CALENDAR_NAME, false);
  var destCalId = findCalendarId_(DESTINATION_CALENDAR_NAME, true);

  if (!sourceCalId) {
    throw new Error('Cannot find "' + SOURCE_CALENDAR_NAME + '". Run listMyCalendars for exact names.');
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

  var created = 0, updated = 0, deleted = 0, skipped = 0, writes = 0;
  var seenSourceIds = {};
  var rateLimited = false;

  for (var s = 0; s < sourceEvents.length; s++) {
    if (writes >= MAX_WRITES_PER_RUN) break;

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
          writes++;
          pause_();
        } else {
          skipped++;
        }
      } else {
        createMirror_(destCalId, ev, title, sourceId, sourceCalId);
        created++;
        writes++;
        pause_();
      }
    } catch (e) {
      if (isRateLimit_(e)) {
        rateLimited = true;
        Logger.log("Rate limit hit — stopping early. Wait 10 minutes and run syncNow again.");
        break;
      }
      throw e;
    }
  }

  for (var sourceIdKey in mirrorsBySourceId) {
    if (writes >= MAX_WRITES_PER_RUN) break;
    if (!seenSourceIds[sourceIdKey]) {
      try {
        Calendar.Events.remove(destCalId, mirrorsBySourceId[sourceIdKey].id);
        deleted++;
        writes++;
        pause_();
      } catch (e) {
        if (isRateLimit_(e)) {
          rateLimited = true;
          break;
        }
        throw e;
      }
    }
  }

  var remaining = sourceEvents.length - skipped - created - updated;
  var msg = "Created: " + created + ", Updated: " + updated +
    ", Deleted: " + deleted + ", Skipped: " + skipped;

  if (writes >= MAX_WRITES_PER_RUN || rateLimited) {
    msg += "\n\nNot finished yet — run syncNow again in 10 minutes (or let the schedule handle it).";
  } else {
    msg += "\n\nAll caught up!";
  }

  Logger.log(msg);
  return msg;
}

function createSchedule() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "syncNow") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("syncNow").timeBased().everyMinutes(15).create();
  Logger.log("Auto-sync on — runs every 15 minutes until everything is copied.");
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function checkCalendarApi_() {
  if (typeof Calendar === "undefined" || !Calendar.Events) {
    throw new Error(
      "Google Calendar API not enabled.\n" +
      "Left sidebar → click + next to Services → Google Calendar API → Add → Save → try again."
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
  // Skip expanded instances; mirror the recurring master instead
  if (ev.recurringEventId && !ev.originalStartTime) return false;
  return true;
}

function needsUpdate_(source, mirror, title) {
  var props = (mirror.extendedProperties || {}).private || {};
  if (props.mirrorSourceUpdated === source.updated) return false;
  return mirror.summary !== title;
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
    extendedProperties: {
      private: {}
    }
  };
  body.extendedProperties.private[MIRROR_SOURCE_KEY] = sourceId;
  body.extendedProperties.private[MIRROR_SOURCE_CAL_KEY] = sourceCalId;
  body.extendedProperties.private.mirrorSourceUpdated = source.updated || "";

  if (source.location) body.location = source.location;
  if (source.recurrence) body.recurrence = source.recurrence;

  return body;
}

function createMirror_(destCalId, source, title, sourceId, sourceCalId) {
  var body = buildMirrorBody_(source, title, sourceId, sourceCalId);
  Calendar.Events.insert(body, destCalId, { sendUpdates: "none" });
}

function updateMirror_(destCalId, mirrorId, source, title, sourceId, sourceCalId) {
  var body = buildMirrorBody_(source, title, sourceId, sourceCalId);
  Calendar.Events.update(body, destCalId, mirrorId, { sendUpdates: "none" });
}

function pause_() {
  Utilities.sleep(PAUSE_MS);
}

function isRateLimit_(e) {
  var msg = String(e.message || e);
  return msg.indexOf("too many") !== -1 || msg.indexOf("Rate Limit") !== -1;
}
