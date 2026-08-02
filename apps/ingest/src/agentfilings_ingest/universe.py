"""The coverage universe: which companies the corpus tracks.

Lists are committed alongside the code (see data/*.txt) rather than fetched at runtime,
so ingestion never depends on a third-party host being up.

Each row is `TICKER,CIK`. **CIK is authoritative.** SEC's ticker->CIK map is ambiguous
after a holding-company reorganization: both the old and new entity claim the ticker,
and the map can return the new shell with no XBRL history (XOM -> CIK 2115436, 0 facts,
while the real Exxon history is CIK 34088). Syncing by CIK avoids that entirely.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"


def normalize_ticker(ticker: str) -> str:
    """SEC's ticker map uses dashes where index lists use dots (BRK.B -> BRK-B)."""
    return ticker.strip().upper().replace(".", "-")


@dataclass(frozen=True)
class UniverseEntry:
    ticker: str
    cik: str  # 10-digit, zero-padded


def load_universe(name: str = "sp500") -> list[UniverseEntry]:
    path = DATA_DIR / f"{name}.txt"
    if not path.exists():
        raise FileNotFoundError(f"Unknown universe '{name}' (expected {path})")

    entries: list[UniverseEntry] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        ticker, _, cik = line.partition(",")
        if not cik:
            continue
        entries.append(
            UniverseEntry(ticker=normalize_ticker(ticker), cik=cik.strip().zfill(10))
        )
    return entries
