"""Corpus data models. `to_dict()` produces the JSON the API reads (interim store
until Supabase Postgres lands; the JSON shape mirrors packages/shared types)."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class CompanyProfile:
    cik: str  # 10-digit
    ticker: str | None
    name: str
    sic: str | None = None
    sic_description: str | None = None
    exchanges: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Filing:
    accession_no: str
    form: str
    filed_at: str  # YYYY-MM-DD
    period: str | None  # report date, YYYY-MM-DD
    primary_doc: str | None
    primary_doc_url: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class InsiderTransaction:
    filed_at: str  # Form 4 filing date
    accession_no: str
    owner_name: str | None
    owner_cik: str | None
    relationship: list[str]  # director | officer | 10% owner | other
    officer_title: str | None
    transaction_date: str | None
    code: str | None  # SEC transaction code (P, S, A, M, F, ...)
    security: str | None
    shares: float | None
    price: float | None  # None when disclosed only in a footnote
    acquired_disposed: str | None  # "A" | "D"
    shares_owned_after: float | None
    derivative: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class EarningsPeriod:
    period_start: str  # YYYY-MM-DD
    period_end: str  # YYYY-MM-DD
    duration: str  # "annual" | "quarterly" | "interim"
    fiscal_year: int | None
    fiscal_period: str | None  # FY | Q1 | Q2 | Q3
    frame: str | None  # e.g. "CY2026Q1" when SEC assigns one
    revenue: float | None
    net_income: float | None
    eps_basic: float | None
    eps_diluted: float | None
    form: str | None
    filed_at: str | None
    source_accession: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
