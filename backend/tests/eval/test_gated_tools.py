"""Gate-refusal + filename-glob pins for the two on-demand LIVE tools this
item adds (specs/caddie-experience-harness-plan.md §3/§5): `run_consistency.py`
and `run_latency.py`. Mirrors `test_harness_has_teeth.py`'s
`test_run_tier2_filename_does_not_match_pytest_test_glob` pattern — both
modules must be import-safe with no env/network required at import time, and
both must refuse (exit 2) to run without their required key + the
`CADDIE_EVAL_LIVE=1` opt-in.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pathlib  # noqa: E402

import tests.eval.run_consistency as run_consistency_mod  # noqa: E402
import tests.eval.run_latency as run_latency_mod  # noqa: E402


def test_run_consistency_filename_does_not_match_pytest_test_glob():
    filename = pathlib.Path(run_consistency_mod.__file__).name
    assert not filename.startswith("test_"), (
        "run_consistency.py must never match pytest's test_*.py collection glob"
    )
    assert not hasattr(run_consistency_mod, "test_main")


def test_run_latency_filename_does_not_match_pytest_test_glob():
    filename = pathlib.Path(run_latency_mod.__file__).name
    assert not filename.startswith("test_"), (
        "run_latency.py must never match pytest's test_*.py collection glob"
    )
    assert not hasattr(run_latency_mod, "test_main")


def test_run_consistency_refuses_without_any_key_or_live_flag(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("CADDIE_EVAL_LIVE", raising=False)
    assert run_consistency_mod.main([]) == 2


def test_run_consistency_refuses_with_live_flag_but_no_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("CADDIE_EVAL_LIVE", "1")
    assert run_consistency_mod.main([]) == 2


def test_run_consistency_refuses_with_key_but_no_live_flag(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")
    monkeypatch.delenv("CADDIE_EVAL_LIVE", raising=False)
    assert run_consistency_mod.main([]) == 2


def test_run_latency_refuses_without_any_key_or_live_flag(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CADDIE_EVAL_LIVE", raising=False)
    assert run_latency_mod.main([]) == 2


def test_run_latency_refuses_with_live_flag_but_no_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("CADDIE_EVAL_LIVE", "1")
    assert run_latency_mod.main([]) == 2


def test_run_latency_refuses_with_key_but_no_live_flag(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    monkeypatch.delenv("CADDIE_EVAL_LIVE", raising=False)
    assert run_latency_mod.main([]) == 2
