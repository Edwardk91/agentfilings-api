"""Parse an SEC Form 4 (insider transaction) ownership XML document.

The document is `<ownershipDocument>` with no XML namespace. Structure:
  issuer / reportingOwner (id + relationship) / nonDerivativeTable / derivativeTable.

Gotchas:
- `transactionPricePerShare` may carry a `<footnoteId>` instead of a `<value>` (price
  disclosed in a footnote) → price is None.
- relationship flags are "1"/"0" or "true"/"false".
- The raw XML lives at the accession root; `primaryDocument` may point at the
  `xsl.../` rendered copy — strip the directory prefix to get the raw file.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field


def raw_doc_name(primary_document: str) -> str:
    """Raw ownership-XML filename: the basename of primaryDocument (drops any
    `xslF345X0N/` rendered-copy prefix)."""
    return primary_document.rsplit("/", 1)[-1]


def _text(el: ET.Element | None, path: str) -> str | None:
    if el is None:
        return None
    node = el.find(path)
    if node is None or node.text is None:
        return None
    text = node.text.strip()
    return text or None


_ISO_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def _date(value: str | None) -> str | None:
    """Normalize a Form 4 date to plain YYYY-MM-DD.

    Filer software sometimes appends a timezone offset or time component, e.g.
    '2026-05-12-05:00'. Postgres rejects that as a date, which failed the whole
    company's ingest. Keep the leading date and drop the rest; anything that does not
    start with a valid ISO date becomes None rather than poisoning the row.
    """
    if value is None:
        return None
    m = _ISO_DATE.match(value.strip())
    return m.group(1) if m else None


def _float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _flag(el: ET.Element | None, path: str) -> bool:
    return _text(el, path) in ("1", "true")


@dataclass(frozen=True)
class Form4Transaction:
    transaction_date: str | None
    code: str | None
    security: str | None
    shares: float | None
    price: float | None
    acquired_disposed: str | None  # "A" | "D"
    shares_owned_after: float | None
    derivative: bool


@dataclass(frozen=True)
class Form4:
    issuer_cik: str | None
    issuer_name: str | None
    issuer_ticker: str | None
    owner_cik: str | None
    owner_name: str | None
    relationship: list[str] = field(default_factory=list)
    officer_title: str | None = None
    period_of_report: str | None = None
    transactions: list[Form4Transaction] = field(default_factory=list)


def _relationship(rel: ET.Element | None) -> list[str]:
    out: list[str] = []
    if _flag(rel, "isDirector"):
        out.append("director")
    if _flag(rel, "isOfficer"):
        out.append("officer")
    if _flag(rel, "isTenPercentOwner"):
        out.append("10% owner")
    if _flag(rel, "isOther"):
        out.append("other")
    return out


def _parse_txn(t: ET.Element, *, derivative: bool) -> Form4Transaction:
    return Form4Transaction(
        transaction_date=_date(_text(t, "transactionDate/value")),
        code=_text(t, "transactionCoding/transactionCode"),
        security=_text(t, "securityTitle/value"),
        shares=_float(_text(t, "transactionAmounts/transactionShares/value")),
        price=_float(_text(t, "transactionAmounts/transactionPricePerShare/value")),
        acquired_disposed=_text(t, "transactionAmounts/transactionAcquiredDisposedCode/value"),
        shares_owned_after=_float(
            _text(t, "postTransactionAmounts/sharesOwnedFollowingTransaction/value")
        ),
        derivative=derivative,
    )


def parse_form4(xml_bytes: bytes) -> Form4:
    root = ET.fromstring(xml_bytes)
    issuer = root.find("issuer")
    owner_id = root.find("reportingOwner/reportingOwnerId")
    rel = root.find("reportingOwner/reportingOwnerRelationship")

    transactions = [
        _parse_txn(t, derivative=False)
        for t in root.findall("nonDerivativeTable/nonDerivativeTransaction")
    ]
    transactions += [
        _parse_txn(t, derivative=True)
        for t in root.findall("derivativeTable/derivativeTransaction")
    ]

    return Form4(
        issuer_cik=_text(issuer, "issuerCik"),
        issuer_name=_text(issuer, "issuerName"),
        issuer_ticker=_text(issuer, "issuerTradingSymbol"),
        owner_cik=_text(owner_id, "rptOwnerCik"),
        owner_name=_text(owner_id, "rptOwnerName"),
        relationship=_relationship(rel),
        officer_title=_text(rel, "officerTitle"),
        period_of_report=_date(_text(root, "periodOfReport")),
        transactions=transactions,
    )
