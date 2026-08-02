"""Parse an SEC 13F-HR information table (institutional holdings) XML.

The document is `<informationTable>` in the namespace
`http://www.sec.gov/edgar/document/thirteenf/informationtable`, with one `<infoTable>`
per holding. We match tags namespace-agnostically (`{*}`) so a variant namespace URI
still parses.

Notes:
- The info-table filename varies per filer (e.g. `53405.xml`, `informationtable.xml`) —
  locate it from the accession `index.json` (the .xml that is not `primary_doc.xml`),
  not by a hardcoded name.
- `value` is USD. SEC amended Form 13F in 2023 to report whole dollars; older filings
  reported thousands. Normalization by period is left to the consumer.
- A manager may report the same issuer across multiple `<infoTable>` rows (different
  discretion / other managers); rows are returned as-is, not aggregated.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any


def _find_text(el: ET.Element, *tags: str) -> str | None:
    node: ET.Element | None = el
    for tag in tags:
        if node is None:
            return None
        node = node.find(f"{{*}}{tag}")
    if node is None or node.text is None:
        return None
    text = node.text.strip()
    return text or None


def _int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        try:
            return int(float(value))
        except ValueError:
            return None


@dataclass(frozen=True)
class Holding:
    issuer: str | None
    title_of_class: str | None
    cusip: str | None
    value: int | None  # USD (whole dollars for filings since 2023)
    shares: int | None
    shares_type: str | None  # "SH" | "PRN"
    put_call: str | None
    investment_discretion: str | None

    def to_dict(self) -> dict[str, Any]:
        from dataclasses import asdict

        return asdict(self)


def parse_13f_information_table(xml_bytes: bytes) -> list[Holding]:
    root = ET.fromstring(xml_bytes)
    holdings: list[Holding] = []
    for it in root.findall(".//{*}infoTable"):
        holdings.append(
            Holding(
                issuer=_find_text(it, "nameOfIssuer"),
                title_of_class=_find_text(it, "titleOfClass"),
                cusip=_find_text(it, "cusip"),
                value=_int(_find_text(it, "value")),
                shares=_int(_find_text(it, "shrsOrPrnAmt", "sshPrnamt")),
                shares_type=_find_text(it, "shrsOrPrnAmt", "sshPrnamtType"),
                put_call=_find_text(it, "putCall"),
                investment_discretion=_find_text(it, "investmentDiscretion"),
            )
        )
    return holdings
