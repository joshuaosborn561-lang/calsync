from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass
class MirrorConfig:
    source_calendar_ids: list[str]
    destination_calendar_id: str
    event_title_prefix: str = "[Work] "
    sync_past_days: int = 7
    sync_future_days: int = 365
    mark_busy: bool = True
    copy_location: bool = True
    copy_description: bool = True
    skip_all_day: bool = False
    credentials_path: Path = Path("credentials.json")
    token_path: Path = Path("token.json")


def load_config(path: Path | str = "config.yaml") -> MirrorConfig:
    config_path = Path(path)
    if not config_path.exists():
        raise FileNotFoundError(
            f"Config file not found: {config_path}. "
            "Copy config.example.yaml to config.yaml and edit it."
        )

    with config_path.open(encoding="utf-8") as handle:
        raw: dict[str, Any] = yaml.safe_load(handle) or {}

    source_ids: list[str] = []
    if raw.get("source_calendar_ids"):
        source_ids = [
            str(cal_id).strip()
            for cal_id in raw["source_calendar_ids"]
            if str(cal_id).strip()
        ]
    elif raw.get("source_calendar_id"):
        source_ids = [str(raw["source_calendar_id"]).strip()]

    destination = raw.get("destination_calendar_id", "primary").strip()

    if not source_ids:
        raise ValueError(
            "At least one subscribed source calendar is required. "
            "Set source_calendar_id or source_calendar_ids in config.yaml."
        )

    return MirrorConfig(
        source_calendar_ids=source_ids,
        destination_calendar_id=destination or "primary",
        event_title_prefix=raw.get("event_title_prefix", "[Work] "),
        sync_past_days=int(raw.get("sync_past_days", 7)),
        sync_future_days=int(raw.get("sync_future_days", 365)),
        mark_busy=bool(raw.get("mark_busy", True)),
        copy_location=bool(raw.get("copy_location", True)),
        copy_description=bool(raw.get("copy_description", True)),
        skip_all_day=bool(raw.get("skip_all_day", False)),
        credentials_path=Path(raw.get("credentials_path", "credentials.json")),
        token_path=Path(raw.get("token_path", "token.json")),
    )
