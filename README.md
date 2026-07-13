# Calendar Mirror

Mirror events from **subscribed** Google Calendars (e.g. your work calendar) onto a **native, writable** calendar you own — so scheduling tools like Calendly can see your busy times and stop double-booking you.

## Subscribed vs native calendars

Google Calendar has two ways events can appear on your account:

| Type | What it is | Can Calendly see it? | Can this tool write to it? |
|------|------------|----------------------|----------------------------|
| **Subscribed** | You added someone else's calendar via URL or invite. Events show up read-only. | Usually **no** | **No** — read-only |
| **Native** | Events you own on your primary or a calendar you created. | **Yes** | **Yes** |

**This tool's job:** read subscribed work events → create **native duplicate events** on a calendar you control.

You **cannot** write events back to your employer's actual work calendar without their OAuth/API access. Instead, duplicates live on your personal Google account (e.g. `primary` or a dedicated "Work (mirrored)" calendar). Point Calendly at that native calendar.

```
  Work calendar (employer)          Your Google account
  ───────────────────────          ──────────────────────────────────
  [events you can't OAuth]  ──subscribe──►  Subscribed feed (read-only)
                                                    │
                                              this tool reads
                                                    │
                                                    ▼
                                            Native copies (writable)
                                            ← Calendly checks here
```

## The problem

When you subscribe to a work calendar in Google Calendar, those events show up for you — but they live on a separate read-only feed. Calendly (and similar tools) only check calendars you **own**, not subscribed overlays. The result: Calendly books over your work meetings.

## The solution

This tool runs on a schedule and:

1. **Discovers** subscribed calendars on your Google account (`--list-subscribed`)
2. **Reads** events from the subscribed work calendar(s)
3. **Creates native copies** on your writable destination calendar (marked **busy**)
4. **Updates** copies when work events change
5. **Deletes** copies when work events are removed
6. Handles **recurring events** (including modified instances)

Each mirrored event is tagged with hidden metadata so the tool knows which source event it came from — no duplicates on repeated runs.

## Prerequisites

- Python 3.10+
- A Google account that has the work calendar **subscribed** in Google Calendar
- A Google Cloud project with the Calendar API enabled

## Setup

### 1. Google Cloud OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the **Google Calendar API**
4. Go to **APIs & Services → Credentials**
5. Create an **OAuth 2.0 Client ID** (application type: **Desktop app**)
6. Download the JSON and save it as `credentials.json` in this directory

### 2. Configure which calendars to sync

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml`:

```yaml
source_calendar_id: "abc123@group.calendar.google.com"   # subscribed work calendar
destination_calendar_id: "primary"                      # native calendar you own
event_title_prefix: "[Work] "
```

### 3. Find your subscribed work calendar ID

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python sync_calendar.py --list-subscribed
```

Look for your subscribed work calendar (marked **SUBSCRIBED — read-only, use as source**) and copy its **ID** into `config.yaml`.

To see all calendars including writable destinations:

```bash
python sync_calendar.py --list-calendars
```

### 4. First-time authentication

```bash
python sync_calendar.py
```

A browser window opens for Google OAuth. Sign in with the account that has the work calendar subscribed. A `token.json` file is saved for future runs.

### 5. Run on a schedule

Sync every 15 minutes with cron:

```bash
crontab -e
```

Add:

```
*/15 * * * * cd /path/to/calendar-mirror && .venv/bin/python sync_calendar.py >> sync.log 2>&1
```

Or use GitHub Actions, a VPS, or any machine that can run Python on a timer.

## Calendly setup

In Calendly, connect your **personal Google Calendar** (the destination calendar). The mirrored `[Work]` events will appear as busy blocks, preventing double bookings.

You can hide the mirrored calendar from your own Google Calendar UI by creating a separate destination calendar (instead of `primary`) and only connecting that one to Calendly.

## Configuration reference

| Option | Default | Description |
|--------|---------|-------------|
| `source_calendar_id` | *(required)* | One subscribed calendar to mirror from |
| `source_calendar_ids` | — | Multiple subscribed calendars (list) |
| `destination_calendar_id` | `primary` | **Native** writable calendar to create duplicates on |
| `event_title_prefix` | `[Work] ` | Prefix on mirrored event titles |
| `sync_past_days` | `7` | How far back to sync |
| `sync_future_days` | `365` | How far forward to sync |
| `mark_busy` | `true` | Mark mirrors as busy (opaque) |
| `copy_location` | `true` | Copy event location |
| `copy_description` | `true` | Copy event description |
| `skip_all_day` | `false` | Skip all-day events |

## How deduplication works

Mirrored events store private extended properties:

- `mirrorSourceEventId` — ID of the original work event
- `mirrorSourceCalendarId` — source calendar ID
- `mirrorContentHash` — hash of mirrored fields

On each run, the tool compares source events against existing mirrors. It only creates, updates, or deletes what changed.

## Important notes

- **Subscribed source, native destination**: The tool reads your subscribed work calendar via your personal Google OAuth. It creates real events you own on the destination calendar. It cannot write to your employer's calendar.
- **Read-only source**: You only need read access to the subscribed calendar (which you already have by subscribing). Write access is only needed on the destination calendar.
- **No invite spam**: The tool uses `sendUpdates=none` — it never emails attendees.
- **Attendees are not copied**: Mirrors are personal busy blocks, not meeting invitations.
- **Multiple source calendars**: Run separate configs or duplicate the setup with different `config.yaml` files.

## Troubleshooting

**"Source calendar not found"** — Run `--list-calendars` and verify the ID. Make sure you're authenticated with the Google account that subscribed to the work calendar.

**Calendly still double-books** — Confirm Calendly is connected to the destination calendar. Check that `mark_busy: true`. Allow 15 minutes for the next sync cycle.

**Duplicate events** — Only run one sync instance. If you manually created similar events, delete them; the tool only manages events it created (tagged with mirror metadata).

## License

MIT
