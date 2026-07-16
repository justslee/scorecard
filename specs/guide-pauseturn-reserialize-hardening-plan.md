# Plan: guide-pauseturn-reserialize-hardening

Backlog item: `guide-pauseturn-reserialize-hardening` (backend, **SILENT** — invisible in-app,
no UI, consistent with `NORTHSTAR.md`: no product-surface change, protects the caddie
strategy-guide pipeline's reliability).

## Problem (verified)

`backend/app/caddie/guide_writer.py`, `research_hole_guide`, pause_turn continuation loop
(lines 275–279 today):

```python
messages = messages + [
    {"role": "assistant", "content": [c.model_dump(mode="json") for c in result.content]}
]
```

The manual `model_dump(mode="json")` re-serialization of the paused assistant turn is a
latent silent-failure. Verified against the installed SDK (`anthropic==0.77.0`,
`pydantic==2.12.5`, from `backend/uv.lock`):

- The non-beta `ContentBlock` union declares `ServerToolUseBlock.name: Literal["web_search"]`
  and has NO variant for other server-tool blocks (e.g. `bash_code_execution_tool_result` /
  `text_editor_code_execution_tool_result`).
- Empirically: `anthropic._models.construct_type` deserializes an unrecognized block type
  (`{"type": "bash_code_execution_tool_result", ...}`) into a **`TextBlock`** (first union
  variant) carrying extra fields, with `text=None`. `model_dump(mode="json")` on that object
  then emits a **corrupted wire dict** — `{"citations": None, "text": None,
  "type": "bash_code_execution_tool_result", ...}` — i.e. a non-text block polluted with
  null text-block keys, plus (environment-dependent) `PydanticSerializationUnexpectedValue`
  warnings. Re-sending that dict on the continuation is exactly the round-trip failure the
  backlog describes. Non-fatal today (observed smoke hole finished in one turn), but any
  hole that genuinely pauses with such blocks can fail.

## The exact fix (SDK-documented pattern)

Per the Anthropic SDK reference (loaded via the `claude-api` skill,
`shared/tool-use-concepts.md` → "Stop reasons for server-side tools" and
`python/claude-api/tool-use.md` → Manual Agentic Loop), the canonical pause_turn
continuation appends the response's content **objects directly**:

```python
if response.stop_reason == "pause_turn":
    messages = [
        {"role": "user", "content": user_query},
        {"role": "assistant", "content": response.content},   # SDK block objects, NOT dicts
    ]
```

The reference is explicit that extracting/re-serializing content yourself loses state (the
compaction doc says verbatim: "Append full content … Extracting only the text string and
appending that will silently lose the compaction state"), and that the server "detects the
trailing `server_tool_use` block and knows to resume automatically" — do NOT add any extra
user message. `MessageParam.content` accepts SDK block objects (pydantic models); the SDK
performs its own lossless serialization on send. This applies equally to
`client.messages.parse(...)` — it is the same Messages surface/`messages` param as
`messages.create` (structured outputs via `output_format` on `.parse()` is the documented
GA path; `web_search_20260209` needs no beta header). No beta-header or type nuance applies.
The SDK reference is unambiguous here.

### Edit — `backend/app/caddie/guide_writer.py` (only code change)

Replace the continuation append (keep the surrounding comment, updating it):

```python
# Resume the server-tool loop: re-send with the paused assistant turn appended,
# passing result.content (the SDK block objects) DIRECTLY as the assistant
# content — Anthropic's documented pause_turn continuation pattern. A manual
# `model_dump(mode="json")` re-serialization corrupts server-tool blocks that
# aren't in the non-beta ContentBlock union (guide-pauseturn-reserialize-hardening).
messages = messages + [{"role": "assistant", "content": result.content}]
```

Notes for the builder:
- `messages: list[dict]` annotation stays valid (top-level entries are still dicts).
- Do NOT touch the loop structure, `_MAX_CONTINUATIONS`, the usage-accumulation block, the
  cost-guard `log.info`, the `finished` guard, or `parsed_output` handling — all unchanged.
- No other call sites: `pause_turn` appears nowhere else in `backend/` product code.

## Critical files

| File | Change |
|---|---|
| `backend/app/caddie/guide_writer.py` | The one-line continuation fix + comment (above). |
| `backend/tests/test_guide_writer.py` | Extend with the pause_turn continuation tests (below). Existing test file — do NOT create a new file; there is no other guide-writer pause test (`grep MAX_CONTINUATIONS tests/` is empty). |

Shared types: **none**. No `app/caddie/types.py` (`HoleStrategyGuide`) change, no frontend
`types.ts`, no route/schema change. Confirmed by inspection.

## Migration verdict

**NONE.** No DB/schema/Alembic change of any kind. (If the builder believes a migration is
needed, STOP — that is out of scope and requires owner approval.)

## Edge cases / risks the fix must preserve

1. **Mixed block types in one continuation** — thinking + `server_tool_use` (web_search) +
   `web_search_tool_result` + a non-web_search server-tool block. Passing objects through
   untouched handles all of them; the test constructs exactly this mix.
2. **Multiple continuations** — loop runs up to `_MAX_CONTINUATIONS` (5); each iteration
   appends one more assistant turn. Message list must grow monotonically and the
   exceeded-cap `RuntimeError` path must be unchanged.
3. **Common single-turn path** — first response `stop_reason != "pause_turn"` never enters
   the append; behavior byte-identical (existing
   `test_research_success_path_reads_the_sdk_surface` locks this — must stay green).
4. **`result.content` validity for resend after `messages.parse`** — parse returns the same
   Message/content-block pydantic objects as `create`; the SDK serializes them on the next
   request. The test asserts the objects arrive at the 2nd call unmodified (identity).
5. **Cost-guard logging & `_WriterOutput` parsing** — usage still summed across ALL calls
   (including paused ones); final `parsed_output` still consumed; provenance fields still
   stamped by `research_hole_guide`.

## Test plan (offline — no DB, no live API key, no network)

Extend `backend/tests/test_guide_writer.py`, following its existing mocking idiom
(see `test_research_success_path_reads_the_sdk_surface`, ~line 758): a `FakeClient` class
with `self.messages = FakeMessages()`, installed via
`monkeypatch.setattr(guide_writer.anthropic, "AsyncAnthropic", FakeClient)`, plus
`monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")`. `pytest-asyncio` is in
`asyncio_mode = "auto"`, but match the file's existing explicit `@pytest.mark.asyncio` style.

### New test 1 — `test_pause_turn_continuation_resends_sdk_block_objects_directly`

Build a realistic paused first response using REAL SDK types (all verified importable on
`anthropic==0.77.0`):

```python
from anthropic.types import ServerToolUseBlock, ThinkingBlock
from anthropic._models import construct_type
from anthropic.types.content_block import ContentBlock

paused_content = [
    ThinkingBlock(type="thinking", thinking="planning search", signature="sig"),
    ServerToolUseBlock(type="server_tool_use", id="srvtoolu_1", name="web_search",
                       input={"query": "bethpage black hole 4 strategy"}),
    # A server-tool block NOT in the non-beta union — deserialized exactly the way the
    # SDK does it (construct_type against ContentBlock), which yields a TextBlock-typed
    # object with text=None carrying the raw fields. This is the block class the old
    # model_dump round-trip corrupts.
    construct_type(
        value={"type": "bash_code_execution_tool_result", "tool_use_id": "srvtoolu_2",
               "content": {"type": "bash_code_execution_result", "stdout": "", "stderr": "",
                            "return_code": 0, "content": []}},
        type_=cast(type, ContentBlock),
    ),
]
```

`FakeMessages.parse(**kwargs)` records `kwargs["messages"]` into `calls: list` and returns,
in order: (1) `SimpleNamespace(stop_reason="pause_turn", content=paused_content,
parsed_output=None, usage=SimpleNamespace(input_tokens=1000, output_tokens=200,
server_tool_use=SimpleNamespace(web_search_requests=1)))`; (2) a final
`SimpleNamespace(stop_reason="end_turn", content=[],
parsed_output=guide_writer._WriterOutput(play_line="Favor center-left off the tee."),
usage=...)`.

Run `await guide_writer.research_hole_guide(4, 4, 461, None, None, [])` inside
`warnings.catch_warnings(record=True)` with `warnings.simplefilter("always")`.

Assertions:
- **(a) Direct SDK-object resend (the RED/GREEN driver):** two calls made; on call 2,
  `calls[1][-1]["role"] == "assistant"` and `calls[1][-1]["content"] is paused_content`
  (object identity), and every element `is` its original block object /
  `not isinstance(block, dict)`. Under the old code this fails (content is a new list of
  dicts). Also assert `calls[1][0] is` the original user message (history preserved, no
  extra "continue" user turn appended).
- **(b) No pydantic serialization warnings:** no captured warning whose `str(w.message)`
  contains `"PydanticSerializationUnexpectedValue"` or `"Pydantic serializer warnings"`.
  (Honesty note for the builder: whether the OLD code emits this warning is
  pydantic-version-dependent — assertion (a) is the assertion guaranteed to go red pre-fix;
  (b) locks the observed-in-prod symptom against recurrence.)
- **(c) Well-formed result:** returned object is a `HoleStrategyGuide` with
  `play_line == "Favor center-left off the tee."`, `schema_version == 1`, non-empty
  `generated_at`, `model` set.

### New test 2 — `test_pause_turn_multiple_continuations_accumulate_usage_and_messages`

Same fake, scripted `pause_turn` → `pause_turn` → `end_turn` (3 calls, exercising >1
continuation under the `_MAX_CONTINUATIONS` cap). Assert: 3 calls; `len(calls[2]) == 3`
(user + 2 assistant turns, each assistant content being the respective response's
`content` object by identity); and — via `caplog` at INFO on logger
`"looper.guide_writer"` — the cost-guard line reports the SUMMED
`input_tokens`/`output_tokens`/`web_searches` across all 3 responses (locks edge case 5).

### Existing coverage that must stay green
- `test_research_success_path_reads_the_sdk_surface` (single-turn no-pause path, kwargs
  surface: `output_format`, web_search tool, adaptive thinking).
- `test_research_hole_guide_raises_when_api_key_missing_never_fabricates`.

## Gates (all offline, from `backend/`)

```sh
cd backend && uv run pytest tests/test_guide_writer.py   # new + existing tests, no DB/key
cd backend && uv run pytest tests/ -k "guide_writer"     # optional wider sweep
cd backend && uv run ruff check .                        # clean
```

Backend DB integration tests run in CI, not locally — no local Postgres required; nothing
in this change touches the DB. RED→GREEN discipline: run test 1 against the unmodified
`guide_writer.py` first and confirm assertion (a) fails, then apply the one-line fix and
confirm all green.
