# Get started in 5 minutes (no coding)

Do this in your browser. You only need Google Calendar and a Google account.

---

## Step 1 — Open Apps Script

Go to: **https://script.google.com**

Click **New project**.

---

## Step 2 — Paste the code

1. Delete whatever is in the editor
2. Open `CalendarMirror.gs` and paste it all in
3. Confirm these lines near the top match your setup:

   ```
   var SOURCE_CALENDAR_NAME = "Insight";
   var MIRROR_PREFIX = "[Insight] ";
   var ONLY_ACCEPTED = true;
   ```

4. Click **Save**, name the project `Calendar Mirror`

---

## Step 3 — See your calendar names (if unsure)

1. Dropdown → **`listMyCalendars`** → **Run** ▶
2. Allow access when Google asks
3. Confirm **Insight** shows as ← SOURCE

---

## Step 4 — Clean old leftovers, then sync

1. Run **`cleanupStaleMirrors`** (removes old `[Insight]` / `[Work]` copies, including moved times)
2. Refresh Google Calendar — stale ones should disappear
3. If the log still says `Pending > 0` or `Deleted > 0`, run **`cleanupStaleMirrors`** again
4. Run **`syncAll`** once, then **`createSchedule`**

Tentative / not-yet-accepted meetings are **not** mirrored until you accept them.

In Calendly, connect your **main Google Calendar** (the same one you used as destination).  
The `[Work]` blocks will show as busy so Calendly stops double-booking you.

---

## Moved or cancelled meetings

When you move an Insight/work meeting, the old `[Work]` copy should disappear and a new one appear at the new time (within ~5 minutes).

For an immediate fix after a move:
1. Dropdown → **`syncNow`** → Run
2. Or **`cleanupStaleMirrors`** to force-delete leftovers

## Troubleshooting

**"Cannot find source calendar"** — Run `listMyCalendars` and match the name **exactly** (capital letters matter).

**No events created** — Your work calendar might have no events in the next year, or the name is wrong.

**Old time still shows after a move** — Paste the latest `CalendarMirror.gs`, Save, run **`cleanupStaleMirrors`**, then **`createSchedule`**.

**Calendly still books over me** — Make sure Calendly is checking the calendar where `[Work]` events appear.

---

## Python version (optional)

The `sync_calendar.py` Python tool in this repo does the same thing for power users who want to run it on a server. Most people should use Apps Script above.
