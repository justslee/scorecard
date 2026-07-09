"""Caddie advice-quality eval harness (specs/caddie-advice-eval-plan.md).

`tests/` is a package (has its own `__init__.py`); this mirrors that so
`tests.eval.*` imports resolve the same way whether invoked by pytest or by
`uv run python -m tests.eval.run_tier2`.
"""
