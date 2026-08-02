"""Load environment from the repo-root .env when present.

Keeps `python -m agentfilings_ingest.sync` working locally without exporting vars by
hand. Real environments (Railway, GitHub Actions) inject env vars directly, and those
always win — values already in the environment are never overwritten.
"""

from __future__ import annotations

import os
from pathlib import Path


def find_repo_root(start: Path | None = None) -> Path | None:
    """Walk up from this file looking for a directory containing .env or .git."""
    current = (start or Path(__file__)).resolve()
    for parent in current.parents:
        if (parent / ".env").exists() or (parent / ".git").exists():
            return parent
    return None


def load_dotenv(path: Path | None = None) -> bool:
    """Load KEY=VALUE lines into os.environ without overriding existing values."""
    if path is None:
        root = find_repo_root()
        if root is None:
            return False
        path = root / ".env"
    if not path.exists():
        return False

    # Parse the whole file first so a later line wins over an earlier duplicate
    # (a blank placeholder above a filled-in value is an easy mistake to make).
    parsed: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        # Never let a later blank line erase an earlier real value.
        if value == "" and parsed.get(key):
            continue
        parsed[key] = value

    # Real environment variables always win over the file.
    for key, value in parsed.items():
        if not os.environ.get(key):
            os.environ[key] = value
    return True
