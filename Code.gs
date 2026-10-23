/**
 * Calendar Mirror — Insight free/busy -> this account's primary calendar
 * (paste into Code.gs of the CalSync Apps Script project)
 *
 * Writes "[Insight] Busy" / "[Insight] Tentative" blocks onto TARGET_CALENDAR_ID
 * ("primary" = the account running the script) from the subscribed "Insight"
 * free/busy calendar.
 *
 * Existing copies from the older script (they carry mirrorSourceId, may lack
 * the original-start property, and may have old titles) are ADOPTED: matched
 * through the same passes, restamped, retitled and recolored in place, then
 * deduped. Only events the mirror owns are ever touched: events with mirror
 * properties or a title starting with "[Insight]".
 *
 * SETUP (once):
 *   1. Paste this whole file into Code.gs and Save.
 *   2. Services -> + -> Google Calendar API -> Add (identifier "Calendar").
 *   3. Run healthCheck().
 *   4. Run install().
 *
 * Colors: Busy = 3 (Grape), Tentative = 8 (Graphite). Copies with a different
 * color or title are patched on the next sync.
 *
 * Stop with uninstall().
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
var TARGET_CALENDAR_ID = "primary";     // this account's own calendar
var SOURCE_CALENDAR_NAME = "Insight";   // name or ID of the subscribed calendar
var ALERT_EMAIL = "";                   // blank = the account running the script
// ─────────────────────────────────────────────────────────────────────────────

var SYNC_INTERVAL_MINUTES = 10;
var PAST_DAYS = 7;
var FUTURE_DAYS = 60;

var TIME_BUDGET_MS = 4.5 * 60 * 1000;  // stop creates/updates after this, resume next run
var PAGE_SIZE = 250;
var MAX_PAGES = 40;                    // more pages than this = truncated -> unsafe
var RETRY_BACKOFF_MS = [1000, 3000, 8000];

var ALERT_AFTER_FAILURES = 2;
var ALERT_AFTER_MS = 60 * 60 * 1000;
var ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

var TITLE_PREFIX = "[Insight]";
var STYLE = {
  busy:      { summary: "[Insight] Busy",      colorId: "3", transparency: "opaque" },
  tentative: { summary: "[Insight] Tentative", colorId: "8", transparency: "transparent" }
};

var KEY_TAG = "insightMirror";          // private extendedProperty marking our copies
var KEY_SID = "insightSourceId";
var KEY_ORIG = "insightOrigStart";
var KEY_STATUS = "insightStatus";
var LEGACY_SID = "mirrorSourceId";        // set by the older script
var LEGACY_KEYS = ["mirrorSourceId", "mirrorSourceCalendarId"];

var P_LAST_OK = "lastSuccessAt";
var P_LAST_RUN = "lastRunAt";
var P_FAILS = "consecutiveFailures";
var P_FIRST_FAIL = "firstFailureAt";
var P_LAST_ERR = "lastError";
var P_ALERT_AT = "lastAlertAt";
var P_SUMMARY = "lastSummary";

var HANDLER = "syncNow";

// ─── entry points ────────────────────────────────────────────────────────────

/** Creates exactly one 10-minute trigger (removes duplicates). */
function install() {
  if (!apiReady_()) {
    Logger.log("STOP: add the Google Calendar API (Advanced Calendar service) under Services first.");
    return;
  }
  removeTriggers_();
  ScriptApp.newTrigger(HANDLER).timeBased().everyMinutes(SYNC_INTERVAL_MINUTES).create();
  Logger.log("Installed: " + HANDLER + " every " + SYNC_INTERVAL_MINUTES + " minutes, 7 days a week.");
}

/** Removes the trigger. Copies on the target calendar are left in place. */
function uninstall() {
  var n = removeTriggers_();
  Logger.log("Removed " + n + " trigger(s). Copies were left in place.");
}

/** Logs access to both calendars, last success, failure count and copy count. */
function healthCheck() {
  var props = props_();
  var out = ["=== CALENDAR MIRROR HEALTH ==="];
  out.push("Advanced Calendar service: " + (apiReady_() ? "enabled" : "NOT ENABLED"));

  var sourceId = null;
  try {
    sourceId = resolveSourceId_();
    out.push("Source: " + (sourceId ? "OK (" + SOURCE_CALENDAR_NAME + ")" : "NOT FOUND (" + SOURCE_CALENDAR_NAME + ")"));
  } catch (e) { out.push("Source: ERROR " + errText_(e)); }

  try {
    var cal = Calendar.Calendars.get(TARGET_CALENDAR_ID);
    out.push("Target: OK (" + cal.id + ")");
    var w = window_();
    var t = listAll_(TARGET_CALENDAR_ID, w.min, w.max);
    if (t.ok) {
      out.push("Copies in window: " + t.items.filter(isCopy_).length + (t.truncated ? " (truncated)" : ""));
    } else {
      out.push("Copies in window: could not list (" + t.error + ")");
    }
  } catch (e) { out.push("Target: ERROR " + errText_(e) + " — is it shared with 'Make changes to events'?"); }

  if (sourceId) {
    var w2 = window_();
    var s = listAll_(sourceId, w2.min, w2.max);
    out.push("Source events in window: " + (s.ok ? s.items.length + (s.truncated ? " (truncated)" : "") : "error " + s.error));
  }

  var trig = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === HANDLER; }).length;
  out.push("Triggers: " + trig + (trig === 1 ? "" : trig === 0 ? " — run install()" : " — run install() to dedupe"));
  var lastOk = Number(props.getProperty(P_LAST_OK) || 0);
  out.push("Last success: " + (lastOk ? new Date(lastOk).toString() : "never"));
  out.push("Consecutive failures: " + (props.getProperty(P_FAILS) || "0"));
  var err = props.getProperty(P_LAST_ERR);
  if (err) out.push("Last error: " + err);
  var sum = props.getProperty(P_SUMMARY);
  if (sum) out.push("Last summary: " + sum);
  Logger.log(out.join("\n"));
}

/** The trigger handler. Never throws. */
function syncNow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log("Another run is active; skipping."); return; }
  var started = Date.now();
  var sum = { created: 0, updated: 0, deleted: 0, unchanged: 0, deferred: 0, errors: 0 };
  try {
    if (!apiReady_()) throw new Error("Advanced Calendar service not enabled");
    var sourceId = resolveSourceId_();
    if (!sourceId) throw new Error("Source calendar not found: " + SOURCE_CALENDAR_NAME);

    var w = window_();
    var src = listAll_(sourceId, w.min, w.max);
    if (!src.ok) throw new Error("Source list failed: " + src.error);
    if (src.truncated) throw new Error("Source list truncated; no changes made");
    var tgt = listAll_(TARGET_CALENDAR_ID, w.min, w.max);
    if (!tgt.ok) throw new Error("Target list failed: " + tgt.error);
    if (tgt.truncated) throw new Error("Target list truncated; no changes made");

    var sources = src.items.filter(function (e) { return e.status !== "cancelled"; });
    var copies = tgt.items.filter(isCopy_);

    if (sources.length === 0) {
      // Empty source is never trusted for deletes.
      if (copies.length) throw new Error("Source returned 0 events but " + copies.length + " copies exist; skipped deletes");
      recordSuccess_(sum, started);
      return;
    }

    var plan = match_(sources, copies);

    // 1) Deletes first, no cap: unmatched copies and duplicates.
    plan.toDelete.forEach(function (c) {
      if (call_(function () { Calendar.Events.remove(TARGET_CALENDAR_ID, c.id, { sendUpdates: "none" }); }, true)) sum.deleted++;
      else sum.errors++;
    });

    // 2) Updates, then creates, throttled by elapsed time.
    var deadline = started + TIME_BUDGET_MS;
    plan.pairs.forEach(function (p) {
      if (!needsUpdate_(p.src, p.copy, p.pass)) { sum.unchanged++; return; }
      if (Date.now() > deadline) { sum.deferred++; return; }
      var body = body_(p.src);
      if (call_(function () { Calendar.Events.patch(body, TARGET_CALENDAR_ID, p.copy.id, { sendUpdates: "none" }); })) sum.updated++;
      else sum.errors++;
    });
    plan.unmatched.forEach(function (s) {
      if (Date.now() > deadline) { sum.deferred++; return; }
      var body = body_(s);
      if (call_(function () { Calendar.Events.insert(body, TARGET_CALENDAR_ID, { sendUpdates: "none" }); })) sum.created++;
      else sum.errors++;
    });

    if (sum.errors) throw new Error(sum.errors + " write(s) failed");
    recordSuccess_(sum, started);
  } catch (e) {
    recordFailure_(errText_(e), sum);
  } finally {
    lock.releaseLock();
  }
}

// ─── matching ────────────────────────────────────────────────────────────────

/**
 * Pass 1: source ID + original start. Pass 2: start + end + status.
 * Pass 3: start + end. Each source keeps exactly one copy; the rest are deleted.
 */
function match_(sources, copies) {
  var free = copies.slice();
  var pairs = [];
  var unmatchedSrc = [];
  var remaining = sources.slice();

  var passes = [
    { n: 1, s: function (e) { return e.id + "|" + origKey_(e); },
            c: function (c) { var id = copySid_(c); var o = priv_(c)[KEY_ORIG]; return id && o ? id + "|" + o : null; } },
    { n: 1, s: function (e) { return e.id; },          // adopted copies with no original-start stamp
            c: function (c) { var id = copySid_(c); return id && !priv_(c)[KEY_ORIG] ? id : null; } },
    { n: 2, s: function (e) { return timeKey_(e) + "|" + kind_(e); },
            c: function (c) { return timeKey_(c) + "|" + copyKind_(c); } },
    { n: 3, s: function (e) { return timeKey_(e); },
            c: function (c) { return timeKey_(c); } }
  ];

  passes.forEach(function (pass) {
    var idx = {};
    free.forEach(function (c) {
      var k = pass.c(c);
      if (k) (idx[k] = idx[k] || []).push(c);
    });
    var used = {};
    var next = [];
    remaining.forEach(function (s) {
      var list = idx[pass.s(s)];
      var c = null;
      while (list && list.length) { var x = list.shift(); if (!used[x.id]) { c = x; break; } }
      if (c) { used[c.id] = true; pairs.push({ src: s, copy: c, pass: pass.n }); }
      else next.push(s);
    });
    free = free.filter(function (c) { return !used[c.id]; });
    remaining = next;
  });
  unmatchedSrc = remaining;

  return { pairs: pairs, unmatched: unmatchedSrc, toDelete: free };
}

function needsUpdate_(s, c, pass) {
  if (pass !== 1) return true; // refresh stored source ID
  var want = STYLE[kind_(s)];
  var p = priv_(c);
  return p[KEY_SID] !== s.id ||
    p[KEY_ORIG] !== origKey_(s) ||
    (p[LEGACY_SID] && p[LEGACY_SID] !== s.id) ||
    !!c.description || !!c.location ||
    c.summary !== want.summary ||
    c.colorId !== want.colorId ||
    (c.transparency || "opaque") !== want.transparency ||
    timeKey_(c) !== timeKey_(s) ||
    p[KEY_STATUS] !== kind_(s) ||
    p[KEY_TAG] !== "1" ||
    !(c.reminders && c.reminders.useDefault === false && !(c.reminders.overrides || []).length);
}

function body_(s) {
  var k = kind_(s);
  var st = STYLE[k];
  var priv = {};
  priv[KEY_TAG] = "1";
  priv[KEY_SID] = s.id;
  priv[KEY_ORIG] = origKey_(s);
  priv[KEY_STATUS] = k;
  priv[LEGACY_SID] = s.id;   // keep legacy key consistent on adopted copies
  return {
    summary: st.summary,
    colorId: st.colorId,
    transparency: st.transparency,
    start: s.start,
    end: s.end,
    description: "",
    location: "",
    reminders: { useDefault: false, overrides: [] },
    attendees: [],
    guestsCanSeeOtherGuests: false,
    guestsCanInviteOthers: false,
    visibility: "default",
    extendedProperties: { private: priv }
  };
}

/** Owned by the mirror: mirror properties or an "[Insight]" title. Nothing else. */
function isCopy_(ev) {
  var p = priv_(ev), sh = shared_(ev);
  if (p[KEY_TAG] === "1" || p[KEY_SID]) return true;
  for (var i = 0; i < LEGACY_KEYS.length; i++) {
    if (p[LEGACY_KEYS[i]] || sh[LEGACY_KEYS[i]]) return true;
  }
  return (ev.summary || "").indexOf(TITLE_PREFIX) === 0;
}

function copySid_(c) {
  var p = priv_(c), sh = shared_(c);
  return p[KEY_SID] || p[LEGACY_SID] || sh[LEGACY_SID] || "";
}

function kind_(s) { return s.status === "tentative" ? "tentative" : "busy"; }
function copyKind_(c) {
  var k = priv_(c)[KEY_STATUS];
  if (k) return k;
  return (c.summary || "").indexOf("Tentative") !== -1 ? "tentative" : "busy";
}
function shared_(ev) { return ((ev.extendedProperties || {}).shared) || {}; }
function priv_(ev) { return ((ev.extendedProperties || {}).private) || {}; }
function tKey_(t) {
  t = t || {};
  if (t.date) return "d:" + t.date;
  if (t.dateTime) return "t:" + new Date(t.dateTime).getTime();
  return "";
}
function timeKey_(ev) { return tKey_(ev.start) + "~" + tKey_(ev.end); }
function origKey_(ev) { return tKey_(ev.originalStartTime || ev.start); }

// ─── calendar I/O ────────────────────────────────────────────────────────────

/** Lists every page. Reports truncation instead of silently stopping. */
function listAll_(calId, min, max, maxPages) {
  var items = [], token = null, pages = 0;
  maxPages = maxPages || MAX_PAGES;
  try {
    do {
      var opts = { timeMin: min, timeMax: max, singleEvents: true, showDeleted: false, maxResults: PAGE_SIZE };
      if (token) opts.pageToken = token;
      var resp = withRetry_(function () { return Calendar.Events.list(calId, opts); });
      if (!resp) return { ok: false, error: "empty response" };
      items = items.concat(resp.items || []);
      token = resp.nextPageToken;
      pages++;
    } while (token && pages < maxPages);
  } catch (e) {
    return { ok: false, error: errText_(e) };
  }
  return { ok: true, items: items, truncated: !!token };
}

function call_(fn, okIfGone) {
  try { withRetry_(fn); return true; }
  catch (e) {
    if (okIfGone && /not found|404|410|deleted/i.test(errText_(e))) return true;
    Logger.log("Write failed: " + errText_(e));
    return false;
  }
}

function withRetry_(fn) {
  for (var i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      if (i >= RETRY_BACKOFF_MS.length || !/rate|quota|too many|backend|internal|timed out|try again|503|500/i.test(errText_(e))) throw e;
      Utilities.sleep(RETRY_BACKOFF_MS[i]);
    }
  }
}

function resolveSourceId_() {
  var token = null;
  do {
    var opts = { maxResults: 250 };
    if (token) opts.pageToken = token;
    var resp = Calendar.CalendarList.list(opts);
    var items = resp.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].summary === SOURCE_CALENDAR_NAME || items[i].id === SOURCE_CALENDAR_NAME) return items[i].id;
    }
    token = resp.nextPageToken;
  } while (token);
  return null;
}

// ─── state, alerts, triggers ─────────────────────────────────────────────────

function recordSuccess_(sum, started) {
  var p = props_();
  var now = String(Date.now());
  p.setProperty(P_LAST_OK, now);
  p.setProperty(P_LAST_RUN, now);
  p.setProperty(P_FAILS, "0");
  p.deleteProperty(P_FIRST_FAIL);
  p.deleteProperty(P_LAST_ERR);
  p.deleteProperty(P_ALERT_AT);
  p.setProperty(P_SUMMARY, JSON.stringify(sum));
  Logger.log("OK " + JSON.stringify(sum) + " in " + Math.round((Date.now() - started) / 1000) + "s");
}

function recordFailure_(msg, sum) {
  var p = props_();
  var now = Date.now();
  var fails = Number(p.getProperty(P_FAILS) || 0) + 1;
  p.setProperty(P_FAILS, String(fails));
  p.setProperty(P_LAST_RUN, String(now));
  p.setProperty(P_LAST_ERR, msg);
  p.setProperty(P_SUMMARY, JSON.stringify(sum));
  if (!p.getProperty(P_FIRST_FAIL)) p.setProperty(P_FIRST_FAIL, String(now));
  Logger.log("FAILED (" + fails + " in a row): " + msg);

  var lastOk = Number(p.getProperty(P_LAST_OK) || p.getProperty(P_FIRST_FAIL));
  var lastAlert = Number(p.getProperty(P_ALERT_AT) || 0);
  var due = fails >= ALERT_AFTER_FAILURES || now - lastOk >= ALERT_AFTER_MS;
  if (due && now - lastAlert >= ALERT_REPEAT_MS) {
    try {
      var to = ALERT_EMAIL || Session.getEffectiveUser().getEmail();
      MailApp.sendEmail(to, "Calendar mirror failing (" + fails + " runs)",
        "The Insight calendar mirror has failed " + fails + " consecutive run(s).\n" +
        "Last success: " + (p.getProperty(P_LAST_OK) ? new Date(Number(p.getProperty(P_LAST_OK))).toString() : "never") + "\n" +
        "Last error: " + msg + "\n\nRun healthCheck() in the Apps Script project for details.");
      p.setProperty(P_ALERT_AT, String(now));
    } catch (e) { Logger.log("Alert email failed: " + errText_(e)); }
  }
}

function removeTriggers_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === HANDLER) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function window_() {
  var now = Date.now();
  return {
    min: new Date(now - PAST_DAYS * 86400000).toISOString(),
    max: new Date(now + FUTURE_DAYS * 86400000).toISOString()
  };
}

function props_() { return PropertiesService.getScriptProperties(); }
function apiReady_() { try { return typeof Calendar !== "undefined" && !!Calendar.Events; } catch (e) { return false; } }
function errText_(e) { return String((e && e.message) || e); }
