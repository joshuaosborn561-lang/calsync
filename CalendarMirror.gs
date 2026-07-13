/**
 * Calendar Mirror — paste this entire file at https://script.google.com
 *
 * WHAT IT DOES:
 * Copies events from your subscribed work calendar onto a calendar you own,
 * so Calendly can see you're busy.
 *
 * SETUP (5 minutes):
 * 1. Paste this code into a new Apps Script project
 * 2. Edit SOURCE_CALENDAR_NAME below (the name you see in Google Calendar)
 * 3. Run "setup" from the dropdown → click Allow when Google asks
 * 4. Run "listMyCalendars" if you're not sure of the calendar name
 * 5. Run "syncNow" once to test
 * 6. Run "createSchedule" to auto-sync every 15 minutes
 */

// ─── EDIT THIS ───────────────────────────────────────────────────────────────
// The exact name of your subscribed WORK calendar (as shown in Google Calendar sidebar)
var SOURCE_CALENDAR_NAME = "Work";

// Where to put copies. Use "primary" for your main calendar, or a name like "Work (mirrored)"
var DESTINATION_CALENDAR_NAME = "primary";
// ──────────────────────────────────────────────────────────────────────────────

var MIRROR_PREFIX = "[Work] ";
var SYNC_PAST_DAYS = 7;
var SYNC_FUTURE_DAYS = 365;

function setup() {
  listMyCalendars();
  Logger.log("If you see your work calendar above, make sure SOURCE_CALENDAR_NAME matches exactly.");
  Logger.log("Then run syncNow to test, then createSchedule for automatic syncing.");
}

function listMyCalendars() {
  var calendars = CalendarApp.getAllCalendars();
  Logger.log("=== YOUR CALENDARS ===");
  for (var i = 0; i < calendars.length; i++) {
    var cal = calendars[i];
    var id = cal.getId();
    var name = cal.getName();
    var hint = "";
    if (name === SOURCE_CALENDAR_NAME) hint = "  ← SOURCE (configured)";
    if (name === DESTINATION_CALENDAR_NAME || (DESTINATION_CALENDAR_NAME === "primary" && cal.isMyPrimaryCalendar())) {
      hint = "  ← DESTINATION (configured)";
    }
    Logger.log(name + hint);
    Logger.log("  ID: " + id);
  }
  Logger.log("======================");
}

function syncNow() {
  var source = findCalendar_(SOURCE_CALENDAR_NAME, false);
  var dest = findCalendar_(DESTINATION_CALENDAR_NAME, true);

  if (!source) {
    throw new Error(
      'Cannot find source calendar named "' + SOURCE_CALENDAR_NAME + '". ' +
      "Run listMyCalendars and copy the exact name."
    );
  }
  if (!dest) {
    throw new Error(
      'Cannot find destination calendar "' + DESTINATION_CALENDAR_NAME + '". ' +
      'Use "primary" or the exact name of a calendar you own.'
    );
  }

  var now = new Date();
  var start = new Date(now.getTime() - SYNC_PAST_DAYS * 24 * 60 * 60 * 1000);
  var end = new Date(now.getTime() + SYNC_FUTURE_DAYS * 24 * 60 * 60 * 1000);

  var sourceEvents = source.getEvents(start, end);
  var destEvents = dest.getEvents(start, end);

  var mirrorsBySourceId = {};
  for (var d = 0; d < destEvents.length; d++) {
    var mirror = destEvents[d];
    var tag = mirror.getTag("mirrorSourceId");
    if (tag) mirrorsBySourceId[tag] = mirror;
  }

  var created = 0, updated = 0, deleted = 0, skipped = 0;
  var seenSourceIds = {};

  for (var s = 0; s < sourceEvents.length; s++) {
    var ev = sourceEvents[s];
    var sourceId = ev.getId();
    seenSourceIds[sourceId] = true;

    var title = MIRROR_PREFIX + ev.getTitle();
    var existing = mirrorsBySourceId[sourceId];

    if (existing) {
      if (eventMatches_(ev, existing, title)) {
        skipped++;
      } else {
        updateMirror_(existing, ev, title);
        updated++;
      }
    } else {
      createMirror_(dest, ev, title, sourceId, source.getId());
      created++;
    }
  }

  for (var sourceIdKey in mirrorsBySourceId) {
    if (!seenSourceIds[sourceIdKey]) {
      mirrorsBySourceId[sourceIdKey].deleteEvent();
      deleted++;
    }
  }

  var msg = "Sync done! Created: " + created + ", Updated: " + updated +
    ", Deleted: " + deleted + ", Skipped: " + skipped;
  Logger.log(msg);
  return msg;
}

function createSchedule() {
  // Remove old triggers first
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "syncNow") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("syncNow").timeBased().everyMinutes(15).create();
  Logger.log("Automatic sync enabled — runs every 15 minutes.");
}

function findCalendar_(nameOrPrimary, mustBeWritable) {
  var calendars = CalendarApp.getAllCalendars();
  for (var i = 0; i < calendars.length; i++) {
    var cal = calendars[i];
    if (nameOrPrimary === "primary" && cal.isMyPrimaryCalendar()) {
      return cal;
    }
    if (cal.getName() === nameOrPrimary) {
      return cal;
    }
  }
  return null;
}

function createMirror_(destCal, sourceEv, title, sourceId, sourceCalId) {
  var options = {
    description: "Mirrored from subscribed calendar.\nSource: " + sourceId,
    location: sourceEv.getLocation() || "",
  };
  var newEv = destCal.createEvent(title, sourceEv.getStartTime(), sourceEv.getEndTime(), options);
  newEv.setTag("mirrorSourceId", sourceId);
  newEv.setTag("mirrorSourceCalendarId", sourceCalId);
  newEv.setTransparency(CalendarApp.EventTransparency.OPAQUE);
}

function updateMirror_(mirror, sourceEv, title) {
  mirror.setTitle(title);
  mirror.setTime(sourceEv.getStartTime(), sourceEv.getEndTime());
  mirror.setLocation(sourceEv.getLocation() || "");
  mirror.setDescription("Mirrored from subscribed calendar.\nSource: " + sourceEv.getId());
  mirror.setTransparency(CalendarApp.EventTransparency.OPAQUE);
}

function eventMatches_(sourceEv, mirror, title) {
  return mirror.getTitle() === title &&
    mirror.getStartTime().getTime() === sourceEv.getStartTime().getTime() &&
    mirror.getEndTime().getTime() === sourceEv.getEndTime().getTime();
}
