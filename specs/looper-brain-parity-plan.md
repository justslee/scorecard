# Looper Brain Parity Plan — `looper-brain-parity`

## Goal (smallest honest slice)
Ground the **off-course** Looper orb prompt in the player's cross-round **memory** + **profile/handicap**, so the single Looper assistant is as personal off-course (home / profile / courses) as the in-round caddie. Backend-only: the grounding rides in on the already-authenticated `user_id`. **Zero frontend change.**

## Explicitly OUT OF SCOPE (do not touch)
- Making the orb round-/course-aware (no hole/course context off-course).
- Threading a live `round_id` into the general `/caddie/voice[/stream]` path.
- Rerouting the orb through the realtime pipeline (`frontend/src/lib/voice/realtime.ts`). These are a large lift and collide with the warm-path mic invariants.
- Any request/response **schema** change (see §4).
- The optional frontend handicap / preferred-persona tweak (see §Follow-ups).

## Consistency with NORTHSTAR / CLAUDE
Quiet, voice-first, calm. This slice changes only the *content* of the spoken reply (makes it personal); no UI, no new chrome, no new endpoints, no new deps. It also does not lengthen the reply structurally — it injects a compact memory/handicap block the model may draw on, same shape the in-round caddie already uses.

---

## §1. Approach — ordered steps

All edits are in **one function**: `_build_voice_prompt` in `backend/app/routes/caddie.py` (~:1034-1107). It is already `async`, so no signature/callsite churn (see §3).

**Decision — grounding applies to BOTH branches (off-course and on-course), unconditionally.**
Rationale: memory + handicap are always relevant, and `user_id` is always present. Critically, the on-course branch of `_build_voice_prompt` is **reachable in-round**: `CaddieSheet`'s tier-2/tier-3 fallback ladder (`frontend/src/lib/caddie/api.ts` ~:503 `/caddie/voice`, ~:780 `/caddie/voice/stream`) calls this stateless path with a **non-null** `hole_number` when the session path fails. Today that fallback silently loses the player's memory. Grounding both branches means personalization survives a session-path failure — a strict improvement, no downside. The happy in-round path still uses `_build_session_voice_prompt` and is untouched. The only callers of `_build_voice_prompt` are `/caddie/voice` (~:1122) and `/caddie/voice/stream` (~:1159); of these, the orb sends `hole_number=null`, the CaddieSheet fallback sends a real hole.

**Step 1 — fetch memory + profile defensively, after the persona load (~:1049), before `context_parts` is assembled.**
Mirror `_build_session_voice_prompt` idioms exactly: module alias `memory_mod`, `memory_mod.get_top_memories(user_id)`, `memory_mod.render_memories_for_prompt(...)`, and `memory_mod.get_player_profile(user_id)`. Both fetchers are `async` and open their own DB session (`get_top_memories` ~:28, `get_player_profile` ~:41 in `backend/app/caddie/memory.py`); `render_memories_for_prompt` (~:46) is sync and already returns `""` for an empty list. Wrap the two DB reads in a single defensive `try/except` that degrades to empty grounding on any failure (see §3 for why this must be defensive here specifically):

```python
    # Personal grounding — mirror _build_session_voice_prompt so the orb's
    # off-course answers (and the stateless in-round fallback) carry the same
    # cross-round memory + handicap the session caddie has. Defensive: a DB
    # hiccup here must never break the voice reply — degrade to no grounding.
    memories_block = ""
    profile = None
    try:
        memories = await memory_mod.get_top_memories(user_id)
        memories_block = memory_mod.render_memories_for_prompt(memories)
        profile = await memory_mod.get_player_profile(user_id)
    except Exception:
        log.exception("voice grounding fetch failed; continuing without it")
        memories_block = ""
        profile = None
```

**Step 2 — render the profile/handicap line into `context_parts`.** Only when present, so no `"Handicap: None"` garbage. Prefer the request-supplied handicap when the caller gave one (in-round fallback may pass it), else fall back to the persisted profile handicap. Replace the existing bare handicap guard (~:1062-1063) with:

```python
    effective_handicap = request.handicap
    if effective_handicap is None and profile is not None and profile.handicap is not None:
        effective_handicap = float(profile.handicap)
    if effective_handicap is not None:
        context_parts.append(f"Player handicap: {effective_handicap}")
```

`PlayerProfile.handicap` is `Optional[float]` (Numeric column, `backend/app/db/models.py` ~:74) — cast with `float(...)` exactly as `start_session` does (~:138, ~:159). Do **not** render clubs/tendencies/persona in this slice — memory + handicap is the honest minimum for "brain parity." (Clubs from `profile.club_distances` is a clean future add but not required here.)

**Step 3 — inject the memory block into the system prompt**, mirroring the session builder's `--- PLAYER MEMORY ---` section (`_build_session_voice_prompt` ~:566-567). Build the section conditionally and splice it between the persona prompt and `--- CURRENT SITUATION ---` (replacing the template at ~:1094-1105):

```python
    memory_section = f"\n--- PLAYER MEMORY ---\n{memories_block}\n" if memories_block else ""
    system_prompt = f"""{personality.system_prompt}
{memory_section}
--- CURRENT SITUATION ---
{context}

--- INSTRUCTIONS ---
You are caddying for this golfer right now, on the course. Respond to their question or comment.
Keep your response concise and in-character. If they ask about club selection, aim, or strategy,
use the context above to give specific, actionable advice. If they're just chatting, be personable
but keep it golf-focused. Never break character.

{HAZARD_GROUNDING_RULE}"""
```

When `memories_block` is `""` the section collapses to nothing and the prompt is byte-identical to today's for a memory-less user (aside from the handicap line, which is already guarded). This preserves the existing off-course behavior exactly for new/empty users.

Leave the `--- INSTRUCTIONS ---` wording as-is (do not copy the session builder's "you have memory of the entire round" line — that would be a lie off-course). The persona prompt + the PLAYER MEMORY block are enough for the model to personalize; keep it quiet and calm.

---

## §2. Critical files to touch
- `backend/app/routes/caddie.py` — the only production edit (`_build_voice_prompt`, ~:1034-1107).
- `backend/tests/test_voice_stream.py` — **extend** with the new grounding tests (see §5). It already imports `caddie_routes`, `VoiceCaddieRequest`, `CaddiePersonality`, uses `monkeypatch` to stub `personality_visible` / `load_personality` with no DB, and already exercises `_build_voice_prompt` directly (~:311-333) — the ideal home; no new file needed.

No other production files change.

---

## §3. Edge cases + risks

- **User with no memories** → `get_top_memories` returns `[]` → `render_memories_for_prompt([])` returns `""` → `memory_section` empty → prompt identical to today. No crash.
- **User with no profile** → `get_player_profile` returns `None` → handicap line skipped unless the request supplied one. No `"Handicap: None"`.
- **Profile with `handicap = None`** → guarded by the `is not None` check → line skipped.
- **Fetcher raises / DB hiccup — the real risk, and why we go defensive.** `_build_voice_prompt` is called **outside** the route-level `try/except`: in `/voice` the call is at ~:1122 while the `try` starts at ~:1124, and in `/voice/stream` (~:1159) there is no surrounding try at all (the body is streamed lazily). So an exception raised inside `_build_voice_prompt` today would surface as an uncaught raw 500 and break the spoken reply. The in-round `_build_session_voice_prompt` is itself **not** defensive around its memory read (~:504-506) — it relies on `session_voice`'s outer try. Since our callers don't give us that outer net, this plan **improves on** the session path: wrap the two DB reads in `try/except Exception` (Step 1) and degrade to no grounding, logging via the existing module `log` (`log.exception`, matching `voice_caddie`'s pattern ~:1141). A grounding failure therefore costs personalization, never the reply.
- **Sync/async & signatures:** `_build_voice_prompt` is **already `async`** and both fetchers are already `await`-ed inside it — **no signature change, no callsite change.** The two callers (`/voice` ~:1122, `/voice/stream` ~:1159) already `await _build_voice_prompt(...)`. Nothing else to update.
- **Latency:** adds two lightweight indexed reads (`CaddieMemory` by `user_id` + weight/created_at; `PlayerProfile` PK `get`) to the off-course path — same two reads `/session/start` already does per round. Negligible; both happen before the model call. Keep them sequential (mirrors the session builder); do not over-engineer with gather.
- **On-course fallback double-inject risk:** none — the happy in-round path uses `_build_session_voice_prompt` (its own memory inject). `_build_voice_prompt` is a distinct function; a request only ever flows through one of them.

---

## §4. Shared types — NO change (assert explicitly)
This is server-side grounding only. `VoiceCaddieRequest` / `VoiceCaddieResponse` (`backend/app/caddie/types.py` ~:222-242) are untouched; `frontend/src/lib/types.ts` and `backend/app/models.py` are untouched. No request field is added (grounding rides on the auth `user_id` dependency) and no response field is added. **If any schema change appears during implementation, STOP and flag it — it means the slice has drifted out of scope.**

---

## §5. Exact gates to verify

1. **Lint:** `cd backend && ruff check .` — must pass.
2. **New backend pytest (unit, no live DB)** added to `backend/tests/test_voice_stream.py`. Follow the existing `test_build_voice_prompt_downgrades_invisible_persona_to_classic` pattern (~:311): call `caddie_routes._build_voice_prompt(request, "user-1")` directly, `monkeypatch` `personality_visible` (→ async True) and `load_personality` (→ async `CaddiePersonality` with a known `system_prompt`). Because the memory/profile reads go through the module aliases, also `monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", ...)` and `..., "get_player_profile", ...` with async stubs — **no Postgres needed** (note: DB-backed tests otherwise run only in CI Postgres, so mocking is required for local runnability, and the code structure supports it cleanly since all DB access is behind `memory_mod`). `render_memories_for_prompt` is a pure sync function — let it run for real to assert the exact rendered text.

   Three cases:
   - **(a) has memory + profile, off-course (`hole_number=None`):** stub `get_top_memories` → one `CaddieMemory(kind="tendency", summary="misses approaches short")`, `get_player_profile` → a `PlayerProfile` with `handicap=12`. Assert the returned `system_prompt` **contains** `"--- PLAYER MEMORY ---"`, the rendered bullet text `render_memories_for_prompt` emits for that memory, and `"Player handicap: 12"`.
   - **(b) no memory, no profile, off-course:** stub `get_top_memories` → `[]`, `get_player_profile` → `None`. Assert the prompt is **valid** (persona prompt present, ends with `HAZARD_GROUNDING_RULE`), contains **no** `"--- PLAYER MEMORY ---"`, and contains **no** `"handicap: None"` / `"None"` garbage (assert `"handicap" not in system_prompt.lower()` when no handicap supplied).
   - **(c) fetcher raises (defensive degrade):** stub `get_top_memories` to `raise RuntimeError`. Assert `_build_voice_prompt` still returns a valid prompt (no exception propagates) with no memory section — proving a DB hiccup can't break the reply.

   Run: `cd backend && python -m pytest tests/test_voice_stream.py -q` (or `uv run pytest ...` per repo convention).
3. **Frontend gates unaffected** — there is no frontend change, so `npm run lint`, `npx tsc --noEmit`, `voice-tests/runner.ts --smoke`, and `next build` are not impacted by this slice. State this in the PR; do not claim to have run them for this change.

---

## §6. Classification
**noticeable-subtle.** The orb's off-course spoken answers become personalized (references the player's known tendencies/preferences + handicap) — the owner would feel it on his own account — but there is **no UI delta**. Rides the rolling `integration/next` bundle; no standalone approval ping required beyond the normal bundle approval. Not a blocker, not a major backend/data-layer change the owner must test on staging (behavior is additive and self-degrading).

---

## Follow-ups (NOT this slice)
- Optional frontend tweak: have `LooperSheet.handleMicTap` (~:510-576) send the player's `handicap` and `preferred_personality_id` so the orb also honors the preferred persona off-course. Pure enhancement; requires a frontend change and its gates. Call out only.
- Optional: also render `profile.club_distances` into the off-course context (mirrors session builder ~:533-540) for fuller parity.

---

### Critical Files for Implementation
- backend/app/routes/caddie.py
- backend/app/caddie/memory.py
- backend/tests/test_voice_stream.py
- backend/app/db/models.py
- backend/app/caddie/types.py
