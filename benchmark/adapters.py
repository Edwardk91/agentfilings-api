"""Optional comparison against a third-party library.

Everything here is best-effort and deliberately timid. The measurements in
checks.py stand on SEC's own data and need no library at all; this module only
answers the secondary question "and what does library X return for the same
input?"

Two rules govern this file:

  1. Never guess. If the library's API is not what this adapter expects, it
     records `api_mismatch` with the exception text. Publishing a wrong claim
     about somebody else's open-source project because their API moved would be
     worse than publishing no claim.
  2. Always record the version. A finding against an unpinned library is not
     reproducible, and these are the kind of bugs that get fixed -- which is a
     good outcome, not something to hide.
"""

from __future__ import annotations

from typing import Any


def load_adapter(name: str) -> "LibraryAdapter | None":
    if name == "edgartools":
        return EdgarToolsAdapter.try_load()
    raise SystemExit(f"Unknown comparison library: {name}")


class LibraryAdapter:
    name = "unknown"
    version = "unknown"

    def revenue_for_periods(self, ticker: str, periods: list[dict[str, Any]]) -> dict[str, Any]:
        raise NotImplementedError

    def resolve_ticker(self, ticker: str) -> dict[str, Any]:
        raise NotImplementedError


class EdgarToolsAdapter(LibraryAdapter):
    """Adapter for the `edgartools` package.

    edgartools is a capable, widely used library and this benchmark is not a
    verdict on it. It is checked here because it is the most common way people
    read this data, so whatever it returns is what most consumers see.
    """

    name = "edgartools"

    def __init__(self, module: Any, version: str) -> None:
        self._edgar = module
        self.version = version

    @classmethod
    def try_load(cls) -> "EdgarToolsAdapter | None":
        try:
            import edgar  # type: ignore[import-not-found]
        except ImportError:
            return None
        try:
            from importlib.metadata import version as pkg_version

            version = pkg_version("edgartools")
        except Exception:
            version = "unknown"
        return cls(edgar, version)

    def _guard(self, fn: Any) -> dict[str, Any]:
        """Run a probe, converting any API drift into a recorded fact."""
        try:
            return {"ok": True, "result": fn()}
        except Exception as exc:  # noqa: BLE001 - the exception IS the finding
            return {
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "note": (
                    "Could not evaluate via this API surface. This is reported as "
                    "unknown, not as a defect in the library."
                ),
            }

    def _frame(self, ticker: str) -> Any:
        """The facts table. Accessor name has moved between versions, so try each."""
        facts = self._edgar.Company(ticker).get_facts()
        for name in ("to_dataframe", "to_pandas", "to_df"):
            attr = getattr(facts, name, None)
            if attr is not None:
                return attr() if callable(attr) else attr
        raise AttributeError(
            f"no dataframe accessor on {type(facts).__name__}; "
            f"tried to_dataframe/to_pandas/to_df"
        )

    def revenue_for_periods(self, ticker: str, periods: list[dict[str, Any]]) -> dict[str, Any]:
        def probe() -> Any:
            frame = self._frame(ticker)
            wanted = {p["period_end"] for p in periods}
            # Column names differ across versions; find them rather than assume.
            end_col = next((c for c in frame.columns if c.lower() in {"end", "period_end"}), None)
            val_col = next(
                (c for c in frame.columns if c.lower() in {"numeric_value", "val", "value"}), None
            )
            if not end_col or not val_col:
                raise AttributeError(
                    f"expected end/value columns, found {list(frame.columns)[:12]}"
                )
            subset = frame[frame[end_col].astype(str).isin(wanted)]
            # A period can appear several times — once per filing that reported it.
            # Return every distinct value, because collapsing them here would hide
            # exactly the behaviour this check exists to observe.
            out: dict[str, list[Any]] = {}
            for _, row in subset.iterrows():
                out.setdefault(str(row[end_col]), []).append(row[val_col])
            return {k: sorted(set(v)) for k, v in out.items()}

        return {"library": self.name, "version": self.version, **self._guard(probe)}

    def resolve_ticker(self, ticker: str) -> dict[str, Any]:
        def probe() -> Any:
            company = self._edgar.Company(ticker)
            return {"cik": str(getattr(company, "cik", "")).zfill(10), "name": getattr(company, "name", None)}

        return {"library": self.name, "version": self.version, **self._guard(probe)}
