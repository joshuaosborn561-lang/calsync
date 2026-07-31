/**
 * Local test harness for CalendarMirror.gs — simulates the Apps Script
 * Calendar API so we can verify sync behaviour without a Google account.
 */

const fs = require("fs");
const vm = require("vm");

function buildEnv(options = {}) {
  const state = {
    calendars: [
      { id: "src@group.calendar.google.com", summary: "Insight", accessRole: "reader" },
      { id: "me@example.com", summary: "Personal", primary: true, accessRole: "owner" },
    ],
    events: {
      "src@group.calendar.google.com": [],
      "me@example.com": [],
    },
    triggers: [],
    props: {},
    logs: [],
    apiCalls: { list: 0, insert: 0, update: 0, remove: 0 },
    failures: options.failures || {},
  };

  let nextId = 1;

  const inWindow = (ev, timeMin, timeMax) => {
    const start = new Date(ev.start.dateTime || ev.start.date).getTime();
    return start >= new Date(timeMin).getTime() && start < new Date(timeMax).getTime();
  };

  const Calendar = {
    CalendarList: {
      list: () => ({ items: state.calendars }),
    },
    Events: {
      list(calendarId, params) {
        state.apiCalls.list++;
        if (state.failures.list && state.failures.list-- > 0) {
          throw new Error("Rate Limit Exceeded");
        }
        const all = state.events[calendarId] || [];
        const items = all
          .filter((ev) => ev.status !== "cancelled")
          .filter((ev) => inWindow(ev, params.timeMin, params.timeMax));
        return { items };
      },
      insert(body, calendarId) {
        state.apiCalls.insert++;
        if (state.failures.insert && state.failures.insert-- > 0) {
          throw new Error("Backend Error");
        }
        const ev = JSON.parse(JSON.stringify(body));
        ev.id = "mirror-" + nextId++;
        state.events[calendarId].push(ev);
        return ev;
      },
      update(body, calendarId, eventId) {
        state.apiCalls.update++;
        const list = state.events[calendarId];
        const idx = list.findIndex((e) => e.id === eventId);
        if (idx === -1) throw new Error("Not Found");
        const ev = JSON.parse(JSON.stringify(body));
        ev.id = eventId;
        list[idx] = ev;
        return ev;
      },
      remove(calendarId, eventId) {
        state.apiCalls.remove++;
        const list = state.events[calendarId];
        const idx = list.findIndex(
          (e) => e.id === eventId || e.recurringEventId === eventId
        );

        // Real Google behaviour: the event is gone, and the API reports it as
        // "Resource has been deleted" when the caller had a stale listing.
        if (state.failures.remove && state.failures.remove-- > 0) {
          if (idx !== -1) list.splice(idx, 1);
          throw new Error(
            "API call to calendar.events.delete failed with error: Resource has been deleted"
          );
        }

        if (idx === -1) throw new Error("Not Found");
        list.splice(idx, 1);
        return {};
      },
    },
  };

  const ScriptApp = {
    getProjectTriggers: () => state.triggers.slice(),
    deleteTrigger: (t) => {
      state.triggers = state.triggers.filter((x) => x !== t);
    },
    newTrigger(fn) {
      const trigger = { fn, getHandlerFunction: () => fn };
      const builder = {
        timeBased: () => ({
          everyMinutes: () => ({ create: () => state.triggers.push(trigger) }),
          everyHours: () => ({ create: () => state.triggers.push(trigger) }),
          after: () => ({ create: () => state.triggers.push(trigger) }),
        }),
      };
      return builder;
    },
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in state.props ? state.props[k] : null),
      setProperty: (k, v) => {
        state.props[k] = String(v);
      },
      deleteProperty: (k) => {
        delete state.props[k];
      },
    }),
  };

  const sandbox = {
    Calendar,
    ScriptApp,
    PropertiesService,
    Utilities: { sleep: () => {} },
    Logger: { log: (m) => state.logs.push(String(m)) },
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    isFinite,
    __state: state,
  };

  const code = fs.readFileSync(__dirname + "/../CalendarMirror.gs", "utf8");
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);
  return { sandbox, state, context };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const SRC = "src@group.calendar.google.com";
const DEST = "me@example.com";

function daysFromNow(n, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function sourceEvent(state, opts) {
  const start = opts.start;
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const ev = {
    id: opts.id,
    summary: opts.summary,
    status: opts.status || "confirmed",
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };
  if (opts.attendees) ev.attendees = opts.attendees;
  state.events[SRC].push(ev);
  return ev;
}

function mirrors(state) {
  return state.events[DEST];
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: !!condition, detail });
  const mark = condition ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${condition ? "" : "  → " + detail}`);
}

// ─── tests ───────────────────────────────────────────────────────────────────

console.log("\n--- Test 1: accepted meetings get mirrored, tentative do not ---");
{
  const { sandbox, state } = buildEnv();
  sourceEvent(state, { id: "a1", summary: "Accepted call", start: daysFromNow(2) });
  sourceEvent(state, {
    id: "a2",
    summary: "Needs response",
    start: daysFromNow(3),
    attendees: [{ self: true, responseStatus: "needsAction" }],
  });
  sourceEvent(state, {
    id: "a3",
    summary: "Tentative hold",
    start: daysFromNow(4),
    status: "tentative",
  });
  sourceEvent(state, {
    id: "a4",
    summary: "I accepted",
    start: daysFromNow(5),
    attendees: [{ self: true, responseStatus: "accepted" }],
  });

  sandbox.syncNow();
  const titles = mirrors(state).map((m) => m.summary).sort();

  check("accepted + untracked events mirrored", titles.length === 2, titles.join(", "));
  check("tentative skipped", !titles.some((t) => t.includes("Tentative")), titles.join(", "));
  check("needsAction skipped", !titles.some((t) => t.includes("Needs response")), titles.join(", "));
  check("prefix applied", titles.every((t) => t.startsWith("[Insight] ")), titles.join(", "));
  check("mirrors marked busy", mirrors(state).every((m) => m.transparency === "opaque"));
}

console.log("\n--- Test 2: moving a meeting removes the old copy ---");
{
  const { sandbox, state } = buildEnv();
  const ev = sourceEvent(state, { id: "m1", summary: "Standup", start: daysFromNow(2, 9) });
  sandbox.syncNow();
  const before = mirrors(state).map((m) => m.start.dateTime);
  check("mirror created at original time", before.length === 1, JSON.stringify(before));

  // Move it: same event id, new time (typical reschedule of a single event)
  const newStart = daysFromNow(2, 15);
  ev.start = { dateTime: newStart.toISOString() };
  ev.end = { dateTime: new Date(newStart.getTime() + 3600000).toISOString() };

  sandbox.syncNow();
  const after = mirrors(state);
  check("still exactly one mirror after move", after.length === 1, JSON.stringify(after.map((m) => m.start)));
  check(
    "mirror moved to the new time",
    after[0] && after[0].start.dateTime === newStart.toISOString(),
    after[0] ? after[0].start.dateTime : "none"
  );
}

console.log("\n--- Test 3: recurring instance moved to a new slot ---");
{
  const { sandbox, state } = buildEnv();
  // Expanded recurring instances, as singleEvents:true returns them
  sourceEvent(state, { id: "r1_20260801", summary: "Weekly sync", start: daysFromNow(2, 11) });
  sourceEvent(state, { id: "r1_20260808", summary: "Weekly sync", start: daysFromNow(9, 11) });
  sandbox.syncNow();
  check("two instances mirrored", mirrors(state).length === 2, String(mirrors(state).length));

  // The second occurrence is moved: old instance id disappears, new one appears
  state.events[SRC] = state.events[SRC].filter((e) => e.id !== "r1_20260808");
  sourceEvent(state, { id: "r1_20260808_moved", summary: "Weekly sync", start: daysFromNow(10, 14) });

  sandbox.syncNow();
  const times = mirrors(state).map((m) => m.start.dateTime).sort();
  check("still two mirrors after the move", mirrors(state).length === 2, String(mirrors(state).length));
  check(
    "old occurrence slot removed",
    !times.includes(daysFromNow(9, 11).toISOString()),
    times.join(", ")
  );
  check(
    "new occurrence slot present",
    times.includes(daysFromNow(10, 14).toISOString()),
    times.join(", ")
  );
}

console.log("\n--- Test 4: cancelled meeting removes its mirror ---");
{
  const { sandbox, state } = buildEnv();
  const ev = sourceEvent(state, { id: "c1", summary: "Doomed meeting", start: daysFromNow(3) });
  sandbox.syncNow();
  check("mirror exists first", mirrors(state).length === 1);

  ev.status = "cancelled";
  sandbox.syncNow();
  check("mirror deleted after cancellation", mirrors(state).length === 0, String(mirrors(state).length));
}

console.log("\n--- Test 5: un-accepting a meeting removes its mirror ---");
{
  const { sandbox, state } = buildEnv();
  const ev = sourceEvent(state, {
    id: "u1",
    summary: "Maybe meeting",
    start: daysFromNow(4),
    attendees: [{ self: true, responseStatus: "accepted" }],
  });
  sandbox.syncNow();
  check("accepted meeting mirrored", mirrors(state).length === 1);

  ev.attendees = [{ self: true, responseStatus: "declined" }];
  sandbox.syncNow();
  check("declined meeting un-mirrored", mirrors(state).length === 0, String(mirrors(state).length));
}

console.log("\n--- Test 6: legacy [Work] copies get cleaned up ---");
{
  const { sandbox, state } = buildEnv();
  state.events[DEST].push({
    id: "legacy-1",
    summary: "[Work] Old ghost meeting",
    start: { dateTime: daysFromNow(5, 8).toISOString() },
    end: { dateTime: daysFromNow(5, 9).toISOString() },
  });
  sandbox.syncNow();
  check(
    "legacy [Work] leftover deleted",
    !mirrors(state).some((m) => m.summary.startsWith("[Work]")),
    JSON.stringify(mirrors(state).map((m) => m.summary))
  );
}

console.log("\n--- Test 7: API errors never crash the run ---");
{
  const { sandbox, state } = buildEnv({ failures: { insert: 2, remove: 3 } });
  sourceEvent(state, { id: "e1", summary: "Flaky one", start: daysFromNow(2) });
  sourceEvent(state, { id: "e2", summary: "Another", start: daysFromNow(3) });
  state.events[DEST].push({
    id: "ghost-1",
    summary: "[Insight] Ghost",
    start: { dateTime: daysFromNow(6, 8).toISOString() },
    end: { dateTime: daysFromNow(6, 9).toISOString() },
  });

  let threw = false;
  try {
    sandbox.syncNow();
  } catch (e) {
    threw = true;
  }
  check("syncNow never throws", !threw);
  check("run recorded a result", state.props.lastRunAt !== undefined);

  // Recovers on the next run
  sandbox.syncNow();
  check(
    "events eventually mirrored after transient failures",
    mirrors(state).filter((m) => m.summary.startsWith("[Insight]")).length >= 2,
    JSON.stringify(mirrors(state).map((m) => m.summary))
  );
  check(
    "'already deleted' treated as success",
    !mirrors(state).some((m) => m.summary === "[Insight] Ghost"),
    JSON.stringify(mirrors(state).map((m) => m.summary))
  );
}

console.log("\n--- Test 8: self-healing trigger ---");
{
  const { sandbox, state } = buildEnv();
  sandbox.install();
  const afterInstall = state.triggers.map((t) => t.fn).sort();
  check("install creates sync + watchdog triggers",
    afterInstall.includes("syncNow") && afterInstall.includes("watchdog"),
    afterInstall.join(", "));

  // Simulate Google removing / user deleting the trigger
  state.triggers = [];
  sandbox.syncNow();
  check(
    "missing trigger is re-created automatically",
    state.triggers.some((t) => t.fn === "syncNow"),
    state.triggers.map((t) => t.fn).join(", ")
  );

  sandbox.uninstall();
  check("uninstall removes triggers", state.triggers.length === 0);
}

console.log("\n--- Test 9: repeated runs stay stable (no duplicates) ---");
{
  const { sandbox, state } = buildEnv();
  sourceEvent(state, { id: "s1", summary: "Stable meeting", start: daysFromNow(2) });
  sourceEvent(state, { id: "s2", summary: "Another stable", start: daysFromNow(6) });

  sandbox.syncNow();
  const firstCount = mirrors(state).length;
  sandbox.syncNow();
  sandbox.syncNow();
  const finalCount = mirrors(state).length;

  check("no duplicate mirrors across runs", firstCount === 2 && finalCount === 2,
    `first=${firstCount} final=${finalCount}`);
  check("idle runs do no writes", state.apiCalls.update === 0, String(state.apiCalls.update));
}

console.log("\n--- Test 10: health report ---");
{
  const { sandbox, state } = buildEnv();
  sandbox.install();
  state.logs.length = 0;
  sandbox.healthCheck();
  const text = state.logs.join("\n");
  check("health shows auto-sync ON", /Auto-sync:\s+ON/.test(text), text);
  check("health shows source and destination", /Source:\s+Insight/.test(text), text);
}

console.log("\n--- Test 11: big calendar catches up on its own ---");
{
  const { sandbox, state } = buildEnv();

  // ~180 meetings spread over the next 5 months
  let expected = 0;
  for (let day = 1; day < 150; day++) {
    for (const hour of [9, 14]) {
      if ((day + hour) % 3 !== 0) continue;
      sourceEvent(state, {
        id: `big-${day}-${hour}`,
        summary: `Meeting ${day}-${hour}`,
        start: daysFromNow(day, hour),
      });
      expected++;
    }
  }

  let runs = 0;
  let mirrored = 0;
  const maxRuns = 60;
  while (runs < maxRuns) {
    sandbox.syncNow();
    runs++;
    mirrored = mirrors(state).filter((m) => m.summary.startsWith("[Insight] ")).length;
    if (mirrored >= expected) break;
  }

  check(
    "large backlog fully mirrored without manual steps",
    mirrored === expected,
    `mirrored=${mirrored} expected=${expected} runs=${runs}`
  );
  check("caught up within a reasonable number of runs", runs < maxRuns, `runs=${runs}`);

  const before = state.apiCalls.insert;
  sandbox.syncNow();
  check(
    "steady state does no extra writes",
    state.apiCalls.insert === before,
    `${before} → ${state.apiCalls.insert}`
  );

  // A meeting far out gets moved; the deep scan should fix it without help
  const target = state.events[SRC].find((e) => e.id === "big-120-9");
  const movedStart = daysFromNow(121, 16);
  target.start = { dateTime: movedStart.toISOString() };
  target.end = { dateTime: new Date(movedStart.getTime() + 3600000).toISOString() };

  let fixed = false;
  for (let i = 0; i < 40 && !fixed; i++) {
    sandbox.syncNow();
    const times = mirrors(state).map((m) => m.start.dateTime);
    fixed =
      times.includes(movedStart.toISOString()) &&
      !times.includes(daysFromNow(120, 9).toISOString());
  }
  check("far-future move is fixed automatically by the deep scan", fixed);
  check(
    "no duplicates after all that churn",
    mirrors(state).filter((m) => m.summary.startsWith("[Insight] ")).length === expected,
    String(mirrors(state).filter((m) => m.summary.startsWith("[Insight] ")).length)
  );
}

// ─── summary ─────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nFailures:");
  failed.forEach((f) => console.log(" - " + f.name + " → " + f.detail));
  process.exit(1);
}
