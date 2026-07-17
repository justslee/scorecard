# Caddie advice-model decoupling — implementation plan (SAFE, behavior-neutral)

Context: the owner asked "what model is the caddie using?" and observed ChatGPT caddies
better from a screenshot. Full audit + the (a)/(b)/(c) upgrade analysis lives in the
eng-lead report and the backlog items `caddie-advice-sonnet5-flip`, `caddie-smart-strategy-tool`,
`caddie-vision-visual-read`. This doc is the ONE safe change to land this cycle.

## Why (the blast-radius finding)
`ANTHROPIC_MODEL` is a SHARED env with 7 runtime consumers across 3 temperatures
(0.7 tool_loop, 0.3 memory, 0 setup-parse) and 2 default models (sonnet-4-5, opus-4).
Flipping it to `claude-sonnet-5` would HTTP 400 the temperature-carrying paths and hijack
the opus OCR/voice paths. So the caddie advice path needs its OWN env + conditional
temperature — exactly the dedicated-env precedent `GUIDE_WRITER_MODEL` already sets.

Net effect of this change: BYTE-IDENTICAL on current prod (still sonnet-4-5 + temperature
0.7), but the advice mouths become independently flippable to Sonnet 5 via one env, without
a 400 and without touching memory/OCR/voice. The actual flip is a follow-up gated on a live
eval run (needs ANTHROPIC_API_KEY + CI; not available this cycle — honesty rule).

## Step 1 — `_advice_model()` helper in `backend/app/routes/caddie.py`
Replace the three identical `os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")`
reads at lines ~895, ~975, ~1579 with a call to:

```python
def _advice_model() -> str:
    """Model for the text advice mouths only. Dedicated env so the advice
    path moves independently of the other ANTHROPIC_MODEL consumers
    (memory temp 0.3 / setup-parse temp 0 / OCR+voice opus default).
    `or`-chain (not getenv defaults) so an empty env behaves like unset;
    a current prod ANTHROPIC_MODEL override still wins when the new var is unset."""
    return (
        os.getenv("CADDIE_ADVICE_MODEL")
        or os.getenv("ANTHROPIC_MODEL")
        or "claude-sonnet-4-5-20250929"
    )
```

## Step 2 — conditional temperature in `backend/app/caddie/tool_loop.py`
Gate the hard-coded `temperature=0.7` (line ~87). Conservative ALLOWLIST (unknown/future
model ids fail SAFE by OMITTING temperature, never 400):

```python
_TEMPERATURE_OK_PREFIXES = (
    "claude-sonnet-4-",
    "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-2",
    "claude-opus-4-5", "claude-opus-4-6",
    "claude-haiku-4-",
    "claude-3-",
)

def _accepts_temperature(model: str) -> bool:
    return model.startswith(_TEMPERATURE_OK_PREFIXES)
```

In `run_caddie_turn`, build `stream_kwargs` WITHOUT temperature, then:
```python
        if _accepts_temperature(model):
            stream_kwargs["temperature"] = 0.7
```
Note: `"claude-opus-4-2"` deliberately catches the dated `claude-opus-4-20250514`
(.env.example value) while NOT catching `claude-opus-4-7/-8`. Do NOT use a bare
`"claude-opus-4-"` prefix — it would wrongly send temperature to opus-4.7+.

Deny-set today (temperature omitted): `claude-sonnet-5`, `claude-opus-4-7/-4-8`,
`claude-fable-5`, `claude-mythos-5`.

## Step 3 — tests (`backend/tests/test_voice_stream.py`) — EXTEND, do not edit existing
- `test_sse_reply_uses_identical_model_params` (asserts model==sonnet-4-5 AND
  temperature==0.7) STAYS GREEN UNCHANGED — sonnet-4-5 is on the allowlist and the
  fallback chain resolves the env. Verify it still passes; do NOT weaken it.
- ADD two pins for the new contract:
  1. `CADDIE_ADVICE_MODEL` outranks `ANTHROPIC_MODEL` in `kwargs["model"]`.
  2. With `CADDIE_ADVICE_MODEL=claude-sonnet-5`, `"temperature" not in kwargs`.
- Optional: a unit pin on `_accepts_temperature` in `test_caddie_tool_loop.py`.

## Do NOT touch
`.env.example` (guarded `**/.env*`) — document the new env in the `_advice_model()`
docstring + PR/card instead. `memory.py`, `scorecard.py`, `voice.py`, `voice_advanced.py`,
`guide_writer.py` — untouched by design. Eval runners (`run_consistency.py`/`run_tier2.py`)
hard-code candidate temperature 0.7 — flag as a flip-day follow-up, do NOT touch. `hazards.py`
and the orb files — zero overlap with the two concurrent lanes.

## Gates (all offline, no API key)
```
cd backend && ruff check .
cd backend && uv run pytest tests/test_voice_stream.py tests/test_caddie_tool_loop.py \
  tests/test_decision_grounding_prompt.py tests/test_input_grounding_prompt.py \
  tests/test_numbers_coherence_prompt.py tests/test_epistemic_humility_prompt.py \
  tests/test_output_language_prompt.py tests/test_positioning_prompt.py \
  tests/eval/test_tool_parity.py
```
Full CI backend gate (Postgres integration) runs on the PR. Classify: SILENT (enabling
refactor, no user-visible change).
