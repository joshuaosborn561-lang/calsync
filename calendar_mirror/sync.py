from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from googleapiclient.discovery import Resource
from googleapiclient.errors import HttpError

from .config import MirrorConfig

logger = logging.getLogger(__name__)

MIRROR_APP = "calendar-mirror"
MIRROR_SOURCE_KEY = "mirrorSourceEventId"
MIRROR_SOURCE_CAL_KEY = "mirrorSourceCalendarId"
MIRROR_CONTENT_HASH_KEY = "mirrorContentHash"
MIRROR_SOURCE_UPDATED_KEY = "mirrorSourceUpdated"


@dataclass
class SyncStats:
    created: int = 0
    updated: int = 0
    deleted: int = 0
    skipped: int = 0
    errors: int = 0


@dataclass
class SyncResult:
    stats: SyncStats = field(default_factory=SyncStats)
    source_events_seen: int = 0
    mirror_events_seen: int = 0


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _to_rfc3339(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _event_private_props(event: dict[str, Any]) -> dict[str, str]:
    return (event.get("extendedProperties") or {}).get("private") or {}


def _is_all_day(event: dict[str, Any]) -> bool:
    start = event.get("start") or {}
    return "date" in start and "dateTime" not in start


def _content_hash(event: dict[str, Any], config: MirrorConfig) -> str:
    """Stable hash of mirror-relevant fields to detect changes."""
    payload = {
        "summary": event.get("summary", ""),
        "start": event.get("start"),
        "end": event.get("end"),
        "recurrence": event.get("recurrence"),
        "location": event.get("location") if config.copy_location else None,
        "description": event.get("description") if config.copy_description else None,
        "status": event.get("status"),
        "transparency": event.get("transparency"),
    }
    encoded = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _build_mirror_body(
    source: dict[str, Any],
    config: MirrorConfig,
    source_calendar_id: str,
) -> dict[str, Any]:
    summary = source.get("summary") or "(No title)"
    prefix = config.event_title_prefix or ""
    if prefix and not summary.startswith(prefix):
        summary = f"{prefix}{summary}"

    body: dict[str, Any] = {
        "summary": summary,
        "start": source.get("start"),
        "end": source.get("end"),
        "transparency": "opaque" if config.mark_busy else "transparent",
        "guestsCanModify": False,
        "guestsCanInviteOthers": False,
        "guestsCanSeeOtherGuests": False,
        "extendedProperties": {
            "private": {
                MIRROR_SOURCE_KEY: source["id"],
                MIRROR_SOURCE_CAL_KEY: source_calendar_id,
                MIRROR_CONTENT_HASH_KEY: _content_hash(source, config),
                MIRROR_SOURCE_UPDATED_KEY: source.get("updated", ""),
            }
        },
    }

    if config.copy_location and source.get("location"):
        body["location"] = source["location"]

    if config.copy_description:
        note = (
            f"Mirrored from subscribed calendar ({source_calendar_id}).\n"
            f"Source event ID: {source['id']}"
        )
        original = source.get("description") or ""
        body["description"] = f"{note}\n\n{original}".strip() if original else note

    # Never copy recurrence — mirror expanded instances so moves delete cleanly.
    return body


def _list_events(
    service: Resource,
    calendar_id: str,
    time_min: datetime,
    time_max: datetime,
    *,
    single_events: bool = False,
    private_extended_property: str | None = None,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    page_token: str | None = None

    while True:
        kwargs: dict[str, Any] = {
            "calendarId": calendar_id,
            "timeMin": _to_rfc3339(time_min),
            "timeMax": _to_rfc3339(time_max),
            "singleEvents": single_events,
            "showDeleted": False,
            "maxResults": 2500,
            "pageToken": page_token,
        }
        if private_extended_property:
            kwargs["privateExtendedProperty"] = private_extended_property

        response = service.events().list(**kwargs).execute()
        events.extend(response.get("items", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return events


def _list_all_mirror_events(
    service: Resource,
    config: MirrorConfig,
    source_calendar_id: str,
    time_min: datetime,
    time_max: datetime,
) -> list[dict[str, Any]]:
    """Fetch mirrored events tagged by this tool on the destination calendar."""
    prop_filter = f"{MIRROR_SOURCE_CAL_KEY}={source_calendar_id}"
    return _list_events(
        service,
        config.destination_calendar_id,
        time_min,
        time_max,
        single_events=True,
        private_extended_property=prop_filter,
    )


def _should_mirror_source_event(event: dict[str, Any], config: MirrorConfig) -> bool:
    if event.get("status") == "cancelled":
        return False
    if config.skip_all_day and _is_all_day(event):
        return False
    start = event.get("start") or {}
    if "dateTime" not in start and "date" not in start:
        return False
    return True


def _mirror_needs_update(
    source: dict[str, Any],
    mirror: dict[str, Any],
    config: MirrorConfig,
) -> bool:
    props = _event_private_props(mirror)
    source_hash = _content_hash(source, config)
    stored_hash = props.get(MIRROR_CONTENT_HASH_KEY)

    if stored_hash and stored_hash == source_hash:
        return False
    return True


def _create_mirror(
    service: Resource,
    config: MirrorConfig,
    source_calendar_id: str,
    source: dict[str, Any],
) -> None:
    body = _build_mirror_body(source, config, source_calendar_id)
    service.events().insert(
        calendarId=config.destination_calendar_id,
        body=body,
        sendUpdates="none",
    ).execute()


def _update_mirror(
    service: Resource,
    config: MirrorConfig,
    source_calendar_id: str,
    source: dict[str, Any],
    mirror: dict[str, Any],
) -> None:
    body = _build_mirror_body(source, config, source_calendar_id)
    service.events().update(
        calendarId=config.destination_calendar_id,
        eventId=mirror["id"],
        body=body,
        sendUpdates="none",
    ).execute()


def _delete_mirror(
    service: Resource,
    config: MirrorConfig,
    mirror: dict[str, Any],
) -> None:
    service.events().delete(
        calendarId=config.destination_calendar_id,
        eventId=mirror["id"],
        sendUpdates="none",
    ).execute()


WRITABLE_ACCESS_ROLES = {"owner", "writer"}


def _calendar_kind(cal: dict[str, Any]) -> str:
    access = cal.get("accessRole", "unknown")
    if cal.get("primary"):
        return "primary"
    if access in WRITABLE_ACCESS_ROLES:
        return "owned"
    if access in {"reader", "freeBusyReader"}:
        return "subscribed"
    return "other"


def list_calendars(service: Resource) -> list[dict[str, Any]]:
    response = service.calendarList().list().execute()
    return response.get("items", [])


def _get_calendar_access_role(
    service: Resource,
    calendar_id: str,
) -> str | None:
    try:
        entry = service.calendarList().get(calendarId=calendar_id).execute()
    except HttpError:
        return None
    return entry.get("accessRole")


def _validate_destination_writable(service: Resource, config: MirrorConfig) -> None:
    access = _get_calendar_access_role(service, config.destination_calendar_id)
    if access is None:
        raise ValueError(
            f"Destination calendar not found: {config.destination_calendar_id}. "
            "Run --list-calendars to see calendars you can write to."
        )
    if access not in WRITABLE_ACCESS_ROLES:
        raise ValueError(
            f"Destination calendar {config.destination_calendar_id!r} is read-only "
            f"(access: {access}). Subscribed calendars cannot receive native events. "
            "Set destination_calendar_id to a calendar you own, such as 'primary' "
            "or a personal calendar you created for work mirrors."
        )


def _sync_one_source(
    service: Resource,
    config: MirrorConfig,
    source_calendar_id: str,
    time_min: datetime,
    time_max: datetime,
) -> SyncResult:
    result = SyncResult()
    stats = result.stats
    logger.info(
        "Syncing subscribed %s → native %s (%s to %s)",
        source_calendar_id,
        config.destination_calendar_id,
        time_min.date(),
        time_max.date(),
    )

    try:
        source_events = _list_events(
            service,
            source_calendar_id,
            time_min,
            time_max,
            single_events=True,
        )
    except HttpError as exc:
        if exc.resp.status == 404:
            raise ValueError(
                f"Source calendar not found: {source_calendar_id}. "
                "Check the calendar ID in config.yaml. Run with --list-calendars "
                "to see subscribed calendars your account can read."
            ) from exc
        raise

    mirror_events = _list_all_mirror_events(
        service, config, source_calendar_id, time_min, time_max
    )

    result.source_events_seen = len(source_events)
    result.mirror_events_seen = len(mirror_events)

    source_by_id: dict[str, dict[str, Any]] = {}
    for event in source_events:
        if _should_mirror_source_event(event, config):
            source_by_id[event["id"]] = event
        else:
            stats.skipped += 1

    mirror_by_source_id: dict[str, dict[str, Any]] = {}
    for mirror in mirror_events:
        props = _event_private_props(mirror)
        source_id = props.get(MIRROR_SOURCE_KEY)
        if source_id:
            mirror_by_source_id[source_id] = mirror

    # Delete stale mirrors first so moved meetings don't leave old busy blocks.
    for source_id, mirror in list(mirror_by_source_id.items()):
        if source_id not in source_by_id:
            try:
                _delete_mirror(service, config, mirror)
                stats.deleted += 1
                del mirror_by_source_id[source_id]
                logger.info(
                    "Deleted stale mirror for source event %s: %s",
                    source_id,
                    mirror.get("summary"),
                )
            except HttpError as exc:
                stats.errors += 1
                logger.error(
                    "Failed to delete stale mirror %s: %s",
                    mirror.get("id"),
                    exc,
                )

    for source_id, source in source_by_id.items():
        mirror = mirror_by_source_id.get(source_id)
        try:
            if mirror is None:
                _create_mirror(service, config, source_calendar_id, source)
                stats.created += 1
                logger.info("Created mirror for: %s", source.get("summary", source_id))
            elif _mirror_needs_update(source, mirror, config):
                if mirror.get("recurrence"):
                    _delete_mirror(service, config, mirror)
                    _create_mirror(service, config, source_calendar_id, source)
                    stats.deleted += 1
                    stats.created += 1
                    logger.info(
                        "Replaced recurring mirror with instance for: %s",
                        source.get("summary", source_id),
                    )
                else:
                    _update_mirror(service, config, source_calendar_id, source, mirror)
                    stats.updated += 1
                    logger.info(
                        "Updated mirror for: %s", source.get("summary", source_id)
                    )
            else:
                stats.skipped += 1
        except HttpError as exc:
            stats.errors += 1
            logger.error(
                "Failed to sync event %s (%s): %s",
                source_id,
                source.get("summary"),
                exc,
            )

    return result


def sync_calendars(service: Resource, config: MirrorConfig) -> SyncResult:
    _validate_destination_writable(service, config)

    now = _utc_now()
    time_min = now - timedelta(days=config.sync_past_days)
    time_max = now + timedelta(days=config.sync_future_days)

    combined = SyncResult()
    for source_calendar_id in config.source_calendar_ids:
        source_result = _sync_one_source(
            service, config, source_calendar_id, time_min, time_max
        )
        combined.source_events_seen += source_result.source_events_seen
        combined.mirror_events_seen += source_result.mirror_events_seen
        combined.stats.created += source_result.stats.created
        combined.stats.updated += source_result.stats.updated
        combined.stats.deleted += source_result.stats.deleted
        combined.stats.skipped += source_result.stats.skipped
        combined.stats.errors += source_result.stats.errors

    return combined
