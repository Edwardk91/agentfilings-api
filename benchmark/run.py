#!/usr/bin/env python3
"""Run the benchmark and print a report.

    export SEC_CONTACT_EMAIL="you@example.com"
    python run.py                          # SEC ground truth only
    python run.py --compare edgartools     # also record what a library returns
    python run.py --json results.json      # machine-readable output

Every number printed is computed from data fetched during the run. Nothing is
hardcoded, so the report cannot go stale and cannot disagree with the sources it
cites. If a defect gets fixed upstream, re-running shows that.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from adapters import load_adapter
from checks import ALL_CHECKS
from lib.sec import SecClient


def _fmt_money(value: Any) -> str:
    try:
        return f"{float(value):,.0f}"
    except (TypeError, ValueError):
        return str(value)


def print_report(results: list[dict[str, Any]]) -> None:
    for result in results:
        print()
        print("=" * 78)
        print(result["question"])
        print("-" * 78)
        print(f"Ground truth: {result['ground_truth']}")
        print()

        if result["name"] == "restatement_survival":
            for company in result["companies"]:
                if "skipped" in company:
                    print(f"  {company['ticker']:6} skipped ({company['skipped']})")
                    continue
                print(
                    f"  {company['ticker']:6} {company['restated_periods']:>3} restated "
                    f"of {company['distinct_periods']:>3} periods   [{company['concept']}]"
                )
                for ex in company["examples"]:
                    print(
                        f"           {ex['period_start']}..{ex['period_end']}  "
                        f"first-filed {_fmt_money(ex['original_value'])} "
                        f"({ex['original_accession']}, {ex['original_filed']})"
                    )
                    print(
                        f"           {' ' * len(ex['period_start'])}  "
                        f"  current   {_fmt_money(ex['current_value'])} "
                        f"({ex['current_accession']}, {ex['current_filed']})"
                    )
                lib = company.get("library")
                if lib:
                    if lib.get("ok"):
                        print(f"           {lib['library']} {lib['version']} returns: {lib['result']}")
                    else:
                        print(f"           {lib['library']} {lib['version']}: {lib['error']}")
            print()
            print(f"  TOTAL restated periods in sample: {result['summary']['restated_periods_found']}")

        elif result["name"] == "fiscal_label_provenance":
            for company in result["companies"]:
                if "skipped" in company:
                    print(f"  {company['ticker']:6} skipped ({company['skipped']})")
                    continue
                pct = company["share_mislabelled"] * 100
                print(
                    f"  {company['ticker']:6} {company['mislabelled_entries']:>4} of "
                    f"{company['total_entries']:>4} entries carry a later filing's "
                    f"fiscal year  ({pct:.0f}%)"
                )
                for ex in company["examples"][:1]:
                    print(
                        f"           e.g. period ending {ex['period_end']} is labelled "
                        f"FY{ex['entry_fy']} {ex['entry_fp']} by {ex['entry_accession']},"
                    )
                    print(
                        f"                but was originally filed as FY{ex['true_fy']} "
                        f"{ex['true_fp']} in {ex['true_accession']}"
                    )
            s = result["summary"]
            print()
            print(
                f"  TOTAL: {s['entries_carrying_a_later_filings_fiscal_year']} of "
                f"{s['entries_examined']} entries ({s['share'] * 100:.0f}%)"
            )

        elif result["name"] == "entity_identity":
            for row in result["companies"]:
                mark = "ok " if row["agrees"] else "DIFF"
                print(f"  {mark} {row['ticker']:6} map={row['sec_ticker_map_cik']} operating={row['operating_cik']}")
                if not row["agrees"]:
                    print(
                        f"           mapped -> {row.get('mapped_entity_name')} "
                        f"(us-gaap facts: {row.get('mapped_has_us_gaap_facts')})"
                    )
                    print(
                        f"           actual -> {row.get('operating_entity_name')} "
                        f"(us-gaap facts: {row.get('operating_has_us_gaap_facts')})"
                    )
                lib = row.get("library")
                if lib and lib.get("ok"):
                    print(f"           {lib['library']} {lib['version']} resolves to {lib['result']}")
                elif lib:
                    print(f"           {lib['library']} {lib['version']}: {lib['error']}")
            s = result["summary"]
            print()
            print(
                f"  TOTAL: {s['ticker_map_disagreements']} of {s['tickers_checked']} disagree; "
                f"{s['resolving_to_entity_with_no_us_gaap_facts']} resolve to an entity "
                f"with no us-gaap facts"
            )

    print()
    print("=" * 78)
    print("Verify any line above by hand:")
    print("  https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json")
    print("  https://www.sec.gov/files/company_tickers.json")
    print("=" * 78)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compare", help="library to compare against, e.g. edgartools")
    parser.add_argument("--json", help="write full results to this path")
    args = parser.parse_args()

    adapter = None
    if args.compare:
        adapter = load_adapter(args.compare)
        if adapter is None:
            print(
                f"note: {args.compare} is not installed; reporting SEC ground truth only.\n"
                f"      pip install {args.compare}",
                file=sys.stderr,
            )
        else:
            print(f"comparing against {adapter.name} {adapter.version}", file=sys.stderr)

    with SecClient() as client:
        results = [check(client, adapter) for check in ALL_CHECKS]

    print_report(results)

    if args.json:
        payload = {
            "generated_from": "live SEC EDGAR data",
            "comparison_library": (
                {"name": adapter.name, "version": adapter.version} if adapter else None
            ),
            "checks": results,
        }
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        print(f"\nwrote {args.json}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
