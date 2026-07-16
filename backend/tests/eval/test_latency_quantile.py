"""Teeth for `run_latency._p95` (P5, caddie-latency-p95-smalln) — pins that a
REPORTED p95 must never EXCEED a REAL measurement.

`statistics.quantiles(latencies_ms, n=20)` defaults to the EXCLUSIVE method,
which at small n interpolates a rank BEYOND the observed data — i.e. it
EXTRAPOLATES. On the 2026-07-15 n=10 latency run this produced p95=1138ms
while the observed max was 869ms: a number nobody actually measured, printed
as if it were one. `_p95` must clamp to the observed max no matter which
quantile method computes the raw value.

Runs in CI (matches pytest's `test_*.py` glob) — unlike `run_latency.py`
itself, which is gated OFF by default and never runs in CI (see its module
docstring). Importing `run_latency` here must need NO env / NO network, same
import-safety contract the module promises.
"""

import pytest

from tests.eval.run_latency import _p95


# Reproduces the 2026-07-15 shape: nine values clustered ~610-700ms plus one
# outlier at 869ms — the exact shape that made the exclusive-method quantile
# extrapolate above the observed max.
_FIXTURE_N10 = [610.0, 620.0, 630.0, 640.0, 650.0, 660.0, 670.0, 680.0, 700.0, 869.0]


def test_p95_never_exceeds_observed_max_on_the_2026_07_15_shape():
    """RED-proof against today's exclusive-extrapolation code: the old
    `statistics.quantiles(latencies_ms, n=20)[18]` computes ~945ms on this
    fixture — ABOVE the observed max of 869ms. A reported p95 must never
    exceed a real measurement."""
    result = _p95(_FIXTURE_N10)
    assert result <= max(_FIXTURE_N10), (
        f"_p95 returned {result}, which exceeds the observed max {max(_FIXTURE_N10)} — "
        "a reported p95 must never extrapolate past a real measurement"
    )


def test_p95_single_sample_is_that_sample():
    assert _p95([742.0]) == 742.0


def test_p95_empty_raises_value_error():
    with pytest.raises(ValueError):
        _p95([])


def test_p95_is_monotonically_at_or_above_the_median():
    """Sanity: p95 should never read BELOW p50 on a normal distribution of
    latencies — a quantile implementation that inverted this would be a
    different, more alarming bug than the extrapolation one."""
    import statistics

    p50 = statistics.median(_FIXTURE_N10)
    p95 = _p95(_FIXTURE_N10)
    assert p95 >= p50


def test_run_latency_is_import_safe_with_no_env():
    """Same import-safety contract `run_latency.py`'s module docstring
    promises: importing it (which this whole test file already did at
    collection time) must need no env var and no network — the OPENAI/DB
    import stays deferred inside `_run_async`, called only after main()'s
    gate passes."""
    import tests.eval.run_latency as run_latency_mod

    assert hasattr(run_latency_mod, "_p95")
    assert hasattr(run_latency_mod, "main")
