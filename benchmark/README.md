# Three ways SEC XBRL data is easy to read wrong

A reproducible benchmark. It fetches SEC's own `companyfacts` and
`company_tickers.json`, derives what the data actually says, and reports what a
naive read gets wrong.

Every number below was computed by `run.py`. Nothing is hardcoded. Re-run it and
you get today's numbers, not these.

```bash
pip install -r requirements.txt
export SEC_CONTACT_EMAIL="you@example.com"    # SEC requires a contact; requests without one are blocked
python run.py
```

---

## Why this exists

SEC's XBRL API is free, complete, and authoritative. It is also shaped in a way
that quietly punishes the obvious reading, and the failures are silent — no
error, no warning, just a number that is wrong in a way you will not notice
until someone asks where it came from.

One fact explains all three checks:

> A `companyfacts` entry describes a **period**, but its `fy` and `fp` fields
> describe the **filing the entry came from**.

Because every filing re-presents prior periods as comparatives, the same period
appears many times, each copy stamped with a different filing's fiscal calendar
and sometimes a different value. What you do about that determines whether your
numbers are right.

Two consequences, pulling in opposite directions:

- **For a period's value, the newest filing wins.** Restatements happen; the
  most recent figure is the company's current position.
- **For a period's label, the oldest filing wins.** The original filing is the
  one whose fiscal calendar actually describes that period.

Take the first entry, take the last entry, or de-duplicate by period alone, and
you get one of these wrong.

---

## Results

Sample: AAPL, MSFT, XOM, JPM, WMT, KO — chosen before any results were looked
at, and fixed since. Run of **2026-07-26**.

### 1. Restatements — 13 periods where the first-filed number is not the current one

| Company | Restated periods | of total |
|---|---|---|
| JPM | 8 | 53 |
| KO | 5 | 53 |
| AAPL, MSFT, XOM, WMT | 0 | 55–62 each |

Concrete, checkable examples:

| Period | First filed | Current | Change |
|---|---|---|---|
| KO FY2018 | $31,856,000,000 | **$34,300,000,000** | +7.7% |
| JPM FY2020 | $119,543,000,000 | **$119,951,000,000** | +0.3% |
| JPM FY2018 | $109,029,000,000 | **$108,783,000,000** | −0.2% |

KO's FY2018 revenue moved by **$2.4 billion** between its original 10-K
(`0000021344-19-000014`) and the figure carried in its 2021 filing
(`0000021344-21-000008`). A reader that keeps the first entry it sees returns
the superseded number, indefinitely, with no indication anything is stale.

**Note the distribution.** Four of six companies show zero restatements. This is
not a universal problem — it is concentrated, here entirely in the two companies
reporting under the `Revenues` tag. If your universe is large, some of it is
wrong; if it is six mega-caps, possibly none of it is. Both facts matter.

### 2. Fiscal labels — 316 of 635 entries (50%) carry a later filing's fiscal year

| Company | Mislabelled | of entries | Share |
|---|---|---|---|
| MSFT | 69 | 131 | 53% |
| JPM | 62 | 120 | 52% |
| AAPL | 58 | 113 | 51% |
| WMT | 58 | 116 | 50% |
| KO | 50 | 106 | 47% |
| XOM | 19 | 49 | 39% |

Worked example. Apple's quarter ending **2025-03-29**:

- Originally filed as **FY2025 Q2** in `0000320193-25-000057`
- Also appears as **FY2026 Q2** in `0000320193-26-000013`, a later filing that
  showed it as a comparative

Both entries are in the API. Both describe the same 13 weeks. They disagree
about which fiscal year that is, and the second one is simply the later filing
talking about its own calendar.

Anything that filters or groups by `fy` without re-anchoring to the original
filing will mix periods from different fiscal years into the same bucket. At
roughly half of all entries, this is not an edge case.

### 3. Entity identity — 1 of 6 tickers resolves to an entity that files nothing

```
DIFF XOM   map=0002115436  operating=0000034088
         mapped -> EXXON MOBIL CORP          (us-gaap facts: False)
         actual -> Exxon Mobil Corporation   (us-gaap facts: True)
```

SEC's published ticker map sends `XOM` to CIK **2115436**. That entity has a
plausible name and no `us-gaap` facts at all. The operating company that files
financial data is CIK **34088**.

The failure mode is the bad one: you get a valid CIK and a company name that
looks right, then every financial query returns empty. Nothing distinguishes
"this company has no data" from "you are asking the wrong company."

A guard is cheap — if a resolved entity reports no `us-gaap` facts, it is not
the operating entity — but it has to be there.

---

## Comparing a library

```bash
pip install edgartools pandas
python run.py --compare edgartools
```

This records what the library returns for the same questions, alongside the SEC
ground truth. It is deliberately conservative: if the library's API is not what
the adapter expects, it reports `api_mismatch` with the exception rather than
guessing. Publishing a wrong claim about someone else's open-source project
because their API moved would be worse than publishing nothing.

**The measurements above involve no library.** They are properties of SEC's
data. Any tool, including one you wrote yourself, either handles them or does
not — and the way to find out is to run it, not to take this document's word.

### What edgartools 5.43.0 actually did

Run on 2026-07-26, because publishing the three problems without saying how the
most widely used library handles them would mislead by omission.

| Check | Result |
|---|---|
| Entity identity | **Correct.** Resolved `XOM` to CIK 34088, the operating filer — while SEC's own ticker map points at 2115436, which reports no `us-gaap` facts. |
| Restatements | **Returns every value.** For KO's FY2018 revenue it returned both 31,856,000,000 and 34,300,000,000 rather than silently picking one. A caller taking the first row still gets the superseded figure, but the library is not hiding it. |
| Fiscal labels | **Present.** The same Apple quarter ending 2025-03-29 came back twice, once as FY2025 Q2 and once as FY2026 Q2. |

So one of the three shows up in that library's output, and it is already reported
upstream (issues #816, #779, #783). This is not a scoreboard — it is a
demonstration that the three properties are real and worth checking in whatever
you use.

---

## Verify it yourself

Nothing here needs to be taken on trust. Every claim traces to a URL:

```
https://data.sec.gov/api/xbrl/companyfacts/CIK0000021344.json   # KO
https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json   # AAPL
https://www.sec.gov/files/company_tickers.json                  # ticker -> CIK
```

Search a `companyfacts` file for a period end date and you will find the same
period listed several times with different `accn`, `fy`, and sometimes `val`.
That redundancy is the whole subject.

`python run.py --json results.json` writes the complete structured output,
including every example the report truncates.

## Method and limits

- **Sample is six companies.** Large, liquid, heavily analysed, several filing
  styles. Fixed before results were examined. It is not a random sample of all
  filers and does not claim to be — a wider sweep would produce different rates,
  probably higher, since these are the best-resourced filers in the market.
- **Revenue concept only.** Resolved per company in order:
  `RevenueFromContractWithCustomerExcludingAssessedTax`,
  `...IncludingAssessedTax`, `Revenues`, `SalesRevenueNet`. Companies land on
  different tags, which is itself a fourth trap this benchmark does not measure.
- **Duration facts only.** Instant facts (balance-sheet items) are excluded.
- **Numbers move.** New filings arrive continuously. The date on the results
  above is the run date, and re-running is the point.
- **Bugs get fixed.** If a library patches one of these, re-running shows it.
  That is a good outcome and this document should not be read as a standing
  verdict on any tool.

## Licence

MIT. The data is SEC EDGAR, public domain.
