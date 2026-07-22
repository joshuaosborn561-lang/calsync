# Get started in 5 minutes (no coding)

Do this in your browser. You only need Google Calendar and a Google account.

---

## Step 1 — Open Apps Script

Go to: **https://script.google.com**

Click **New project**.

---

## Step 2 — Paste the code

1. Delete whatever is in the editor
2. Open the file `CalendarMirror.gs` from this repo (or copy from GitHub)
3. Paste it all in
4. At the top, change this line to your work calendar’s **exact name** (sidebar in Google Calendar):

   ```
   var SOURCE_CALENDAR_NAME = "Work";
   ```

   If your work calendar is called something else, use that name exactly.

5. Leave destination as `primary` unless you made a separate calendar for mirrors
6. Click **Save** (disk icon), name the project `Calendar Mirror`

---

## Step 3 — See your calendar names (if unsure)

1. In the toolbar dropdown (says "Select function"), choose **`listMyCalendars`**
2. Click **Run** ▶
3. Google asks you to **Allow** access — click through and Allow
4. Click **Execution log** at the bottom — you’ll see your calendar names and IDs
5. Copy the exact name of your subscribed work calendar into `SOURCE_CALENDAR_NAME`

---

## Step 4 — Run once and walk away

1. Select **`syncAll`** in the dropdown
2. Click **Run** ▶
3. That's it — close the tab if you want

The script will:
- Copy events in batches with pauses
- Wait and retry if Google rate-limits you
- **Automatically reschedule itself** every 2 minutes until everything is copied
- Turn on ongoing 15-minute sync when finished

To check progress later: run **`checkProgress`** and look at the log.

## Step 5 — Calendly

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
