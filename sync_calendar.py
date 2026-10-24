#!/usr/bin/env python3
"""Mirror subscribed Google Calendar events onto a writable calendar."""

from __future__ import annotations

import argparse
import logging
import sys

from calendar_mirror.auth import get_calendar_service
from calendar_mirror.config import load_config
from calendar_mirror.sync import _calendar_kind, list_calendars, sync_calendars


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Mirror events from a subscribed Google Calendar onto your personal "
            "calendar so tools like Calendly can see your busy times."
        )
    )
    parser.add_argument(
        "-c",
        "--config",
        default="config.yaml",
        help="Path to config file (default: config.yaml)",
    )
    parser.add_argument(
        "--list-calendars",
        action="store_true",
        help=(
            "List calendars visible to your Google account and exit. "
            "Subscribed (read-only) calendars are marked — use those as sources."
        ),
    )
    parser.add_argument(
        "--list-subscribed",
        action="store_true",
        help="List only subscribed/read-only calendars (recommended sync sources)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable debug logging",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would happen without making changes (not yet implemented)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if args.dry_run:
        logging.error("--dry-run is not implemented yet; run without it to sync.")
        return 1

    config = load_config(args.config)
    service = get_calendar_service(config.credentials_path, config.token_path)

    if args.list_calendars or args.list_subscribed:
        calendars = list_calendars(service)
        if args.list_subscribed:
            calendars = [cal for cal in calendars if _calendar_kind(cal) == "subscribed"]

        label = "subscribed" if args.list_subscribed else "accessible"
        print(f"\nFound {len(calendars)} {label} calendar(s):\n")
        for cal in calendars:
            cal_id = cal.get("id", "")
            summary = cal.get("summary", "(no name)")
            access = cal.get("accessRole", "unknown")
            kind = _calendar_kind(cal)
            kind_label = {
                "primary": "PRIMARY — writable, good destination",
                "owned": "OWNED — writable, good destination",
                "subscribed": "SUBSCRIBED — read-only, use as source",
                "other": "OTHER",
            }.get(kind, kind.upper())
            print(f"  {summary}")
            print(f"    ID: {cal_id}")
            print(f"    Type: {kind_label} (access: {access})")
            print()
        if args.list_subscribed and not calendars:
            print(
                "No subscribed calendars found. Subscribe to your work calendar in "
                "Google Calendar first, then re-run this command."
            )
        return 0

    result = sync_calendars(service, config)
    stats = result.stats

    print()
    print("Sync complete.")
    print(f"  Source events scanned:  {result.source_events_seen}")
    print(f"  Existing mirrors found: {result.mirror_events_seen}")
    print(f"  Created:  {stats.created}")
    print(f"  Updated:  {stats.updated}")
    print(f"  Deleted:  {stats.deleted}")
    print(f"  Skipped:  {stats.skipped}")
    if stats.errors:
        print(f"  Errors:   {stats.errors}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
