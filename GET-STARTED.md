# Get started (5 minutes, then it runs itself)

This copies meetings from your subscribed **Insight** calendar onto your own Google Calendar, so Calendly sees you as busy.

---

## Step 1 — Open Apps Script

Go to **https://script.google.com** and open your project (or click **New project**).

---

## Step 2 — Paste the code

1. Select everything in the editor and delete it
2. Paste all of `CalendarMirror.gs`
3. Check the settings at the top:

```javascript
var SOURCE_CALENDAR_NAME = "Insight";      // your subscribed work calendar
var DESTINATION_CALENDAR_NAME = "primary"; // your own calendar
var MIRROR_PREFIX = "[Insight] ";
var ONLY_ACCEPTED = true;                  // ignore tentative / unaccepted invites
```

4. Click **Save**

---

## Step 3 — Add the Calendar service (once)

Left sidebar → **Services** → **+** → choose **Google Calendar API** → **Add**

---

## Step 4 — Run `install`

1. In the function dropdown, choose **`install`**
2. Click **Run** ▶
3. Approve access when Google asks

That's it. Nothing else to run, ever.

`install` sets up a sync every 10 minutes plus a watchdog that restarts the sync if it ever stops.

---

## Step 5 — Point Calendly at the right calendar

In Calendly, connect the calendar where `[Insight]` events appear (your **primary** calendar unless you changed it).

---

## How it behaves

| Situation | What happens |
|-----------|--------------|
| New meeting accepted | Mirrored within ~10 minutes |
| Meeting moved | Old copy deleted, new copy created |
| Meeting cancelled | Copy deleted |
| Invite still tentative | Not mirrored until you accept |
| You decline a meeting | Copy removed |
| Google rate-limits or errors | Logged and retried on the next run |
| Trigger disappears | Re-created automatically |

The next **3 weeks** are re-checked on every run, so day-to-day changes are fast. Everything further out (up to 6 months) is swept a chunk at a time, so nothing times out or runs out of memory.

**First-time catch-up:** a busy calendar takes about an hour to fully populate the long-range months. Near-term meetings appear on the first run.

---

## Checking on it (optional)

Run **`healthCheck`** and read the log:

```
=== CALENDAR MIRROR STATUS ===
Source:      Insight
Destination: primary
Auto-sync:   ON (every 10 min)
Watchdog:    ON
Last run:    4 min ago
Last result: Created 0 | Updated 1 | Deleted 1 | Unchanged 62
No recent problems.
```

---

## If something looks wrong

| Symptom | Fix |
|---------|-----|
| Nothing syncing | Run **`healthCheck`**. If auto-sync is OFF, run **`install`** |
| Old copies hanging around | Run **`cleanupStaleMirrors`** (safe to run repeatedly) |
| "Calendar not found" | Run **`listMyCalendars`** and match the name exactly |
| Want it to stop | Run **`uninstall`** |

Occasional errors in the execution log are normal — Google throttles bulk calendar writes. The script records them and keeps going; it does not need you to intervene.

---

## Python version (optional)

`sync_calendar.py` does the same job on a server via cron. Most people should use Apps Script above.
