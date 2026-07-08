# Caddie excellence audit — "is a real caddie replaceable?" (2026-07-09)

Owner directive (2026-07-09): *"Based on the maturity scorecard and looking at the code, run a
review/research to determine improvements. This needs to be eventually scalable but also
amazingly good. It should feel like a real caddie is replaceable."*

Method (same shape as `specs/voice-agent-audit.md`): (1) domain research — what the world's best
real caddies actually do; (2) SOTA research — production LLM-agent practice in 2026, verified
against Anthropic + OpenAI docs; (3) a file-and-line code audit of the whole caddie stack graded
against both tracks; (4) a prioritized, one-cycle-sized queue. **Audit only — no features built
this cycle.**

## The stack today (three brains)
- **Realtime orb** — `gpt-realtime` over WebRTC, ephemeral-key mint, **6 client-dispatched tools**
  (`realtime_relay.py`, `frontend/src/lib/voice/realtime.ts`). The primary, agentic voice path.
- **Classic/text caddie** — Anthropic Claude (`ANTHROPIC_MODEL` → `claude-sonnet-4-5-20250929`) via
  `/api/caddie/voice*` + `/session/voice*` (`routes/caddie.py`). **Single-shot, context-injected,
  no tools.** The sheet + fallback path.
- **Deterministic engine** — `aim_point.generate_recommendation` fuses DECADE pin-light logic +
  dispersion + strokes-gained + slope + shot-line terrain. Not an LLM; both brains lean on it for
  actual numbers. This is genuinely strong.

Almost every gap below stems from the **asymmetry between the two conversational brains** and from
**cost/scale hygiene never having been added** (the product has been feature-led, not load-led).

## Scored gap table (code audit)

| Area | Grade | One-line |
|---|---|---|
| A. Providers & models | **B** | Clean OpenAI-Realtime + Anthropic-text split; two brains, **no shared behavior contract** (parallel prompt copies, drift risk flagged in-code at `routes/caddie.py:653-664`) |
| B. Prompt caching | **F** | None anywhere (`cache_control` grep empty); ~700–900 static tokens **+ full 20-turn history re-billed every text turn** (`_build_session_voice_prompt`) |
| C. Tool loop / parity | **D** | Orb has 6 tools (`get_carries` is a **stub** returning `available:false`); Claude text path passes **no `tools=` at all** — materially dumber fallback |
| D. Memory capture | **C** | Auto post-round distillation exists (`memory.summarize_round`) but **only at `/session/end`** (lost on an abandoned round), **no dedup/decay/relevance**, naive top-8 retrieval |
| E. Rate limiting | **F** | **Zero** per-user rate/token/spend limits on paid LLM endpoints; only guards are auth + a 4000-char input cap. An authed client can loop `/voice/stream` with no cost ceiling |
| F. Resilience / scale | **C** | Postgres session state + atomic JSONB writes (good, multi-worker-safe); but **`--workers 1`**, **no timeout/retry on Anthropic calls** (inherits ~10-min SDK default → worker starvation), no load test |
| G. Eval (advice quality) | **D** | **No advice-quality harness** — tests cover geometry/plumbing only; runtime LLM output has no automated quality gate. "Good enough to replace a caddie" is currently unfalsifiable |
| H. Grounding quality | **B** | Deep, honest context (geometry, hazards-from-PostGIS, validated guide, weather, player model, round state). Gaps: **no pin position wired in**, `get_carries` stub, **no lie awareness**, **wind is scalar not shot-relative** in the text prompt |

## What "replaceable" actually demands (domain research)
A top looper does five jobs. We already do the deterministic math well (areas 1–3); the
"irreplaceable" gap lives in the **human side** and the **compounding player model**.
1. **Pre-round prep** — annotated yardage book, pin sheet → per-pin numbers, a game plan built
   from *this player's* tendencies. (We have per-hole guides; we lack a pre-round briefing.)
2. **In-round decisions** — plays-like yardage (head/tailwind ~1%/0.5% per mph, elevation, temp),
   **dispersion-aware targets** (aim fat side, never short-side; scale target to skill), lay-up to
   the player's best wedge number, name the one place you can't miss, putt line+speed.
3. **Course management** — DECADE / strokes-gained: aim off the pin scaled to skill, take double
   bogey out of play, "conservative target, aggressive swing."
4. **The human side (the real moat)** — **knowing when to shut up** (go silent during the pre-shot
   routine), reading frustration *before* a tilt decision, present-focus language after a bad hole
   ("next shot is the one that matters"), and — counterintuitively — deliberately taking the mind
   *off* golf under pressure to protect flow.
5. **Post-round** — debrief by facet vs baseline, surface tendencies over time ("you bail right
   under pressure"), prescribe practice, feed it back into next round's plan.

The whole thing rides on **four data pillars**: course geometry, live environment, **the player's
own measured dispersion/tendencies** (the compounding asset), and real-time game-state + emotion
signals. Pillars 1–2 we do well; pillar 3 is modeled-not-measured (needs the shot-tracking epic);
pillar 4 is barely tapped and is where "irreplaceable" hides.

## SOTA levers (production LLM-agent research, verified vs docs)
- **Prompt caching** — Anthropic: explicit `cache_control:{type:"ephemeral"}` on the last stable
  block; render order **tools → system → messages**; read ≈ 0.1× input (up to 90% off), min
  cacheable prefix is model-specific (**~1024–2048 tokens** — verify for the pinned model);
  break-even at 2 requests. OpenAI Realtime caches **automatically** ≥1024 tokens. **Order every
  prompt static→dynamic; never interpolate wind/date/hole into the system string.**
- **Tool loop** — model → `tool_use` → execute → return **all** results in one user message →
  repeat to `end_turn`. Prefer **injected context** when facts are already known (cached course
  geometry); use a **tool loop** only for live lookups. Hard **max-iteration + token-budget +
  no-progress** stops (warning text alone does not stop a loop).
- **Memory** — separate **episodic** (this round) from **semantic** (durable facts); **write-back
  with extraction + consolidation/dedup** at session end; **retrieve by relevance, don't dump**;
  consolidation as a background job.
- **Eval** — git-diffable **golden JSONL** (30–50 scenarios incl. edge cases) → **deterministic
  gates first** (real club? sane yardage? valid JSON? no hallucinated hazard?), then **LLM-as-judge
  with rubrics** for "is the advice good"; **regression-gate in CI**; de-bias the judge (don't
  judge a model with itself; randomize order; control for verbosity).
- **Voice UX** — target **p50 < 250–400ms**; **semantic VAD `eagerness:low`** on the course so it
  doesn't cut a golfer off mid-pause; **complete barge-in** (stop TTS *and* cancel in-flight TTS
  *and* cancel LLM gen); stream TTS; be terse (one club + one reason).
- **Rate limiting / scale** — bucket by `(user, feature, model)`; enforce **RPM and TPM
  together**; per-user spend budgets with 80/90% alerts; token-aware abuse detection (high-input /
  short-output = probing); ≥2 stateless workers behind an LB with a **shared** limit store (Redis);
  load-test on TTFT / tokens-per-sec / p95.

---

## Prioritized queue

Each item is one-cycle-sized. **Cost** = rough build effort. **Dependency** = the honest blocker.

### P1 — do next (unblocked, high ROI). Seeded into `backlog.json` as `ready`.

1. **Prompt caching on the Claude text path** — *what:* restructure `_build_session_voice_prompt`
   so the per-round-stable prefix (persona + `_BASE_BEHAVIOR` + `HAZARD_GROUNDING_RULE` + the hole's
   static geometry/hazards/guide) is one block with an Anthropic `cache_control` breakpoint, and
   only the volatile tail (current lie/wind/question) varies; stop re-sending the full 20-turn
   history uncached. *Why:* area B is an F; SOTA read ≈ 0.1× input → **~70–90% input-cost cut** on
   multi-turn rounds, and lower latency. Grounded in `routes/caddie.py:756-802`. *Cost:* S.
   *Dependency:* none (verify the pinned model's min-cacheable prefix; may need to co-locate more
   static content behind the breakpoint to clear ~1024–2048 tokens).

2. **Per-user rate limiting + spend cap on LLM endpoints** — *what:* per-user **RPM + TPM** limits
   and a hard monthly token/$ budget on `/voice`, `/voice/stream`, `/session/voice*`,
   `/realtime/session` mint, `/course-intel`; token-aware (high-input/short-output) abuse flag;
   80/90% alerts. Start single-box (in-process/Postgres counter); note Redis for multi-instance.
   *Why:* area E is an F — **the single biggest cost/scale risk**; an authed client can loop the
   paid endpoints with zero ceiling. *Cost:* M. *Dependency:* none for single-box; multi-instance
   shared store depends on the ≥2-worker move (P2).

3. **LLM-call timeouts + bounded retries (caddie Claude calls)** — *what:* add explicit
   `timeout` (~20–30s) + bounded `max_retries` to `client.messages.create/stream` at
   `routes/caddie.py:796,863,1359` and `memory.py:129`; degrade to calm honest copy on exhaustion.
   *Why:* area F — today a hung call inherits the ~10-min SDK default and **ties up the sole
   worker for minutes on-course**. Cheap, high-value resilience. *Cost:* S. *Dependency:* none.

4. **Tool-loop parity for the Claude text path (+ real `get_carries`)** — *what:* give the classic
   caddie the same tool schema the orb has (the backing endpoints already exist:
   `/session/recommend`, `/session/shot`, `/session/{id}/conditions`, `/session/{id}/player-profile`)
   with a bounded server-side tool loop (max-iteration + no-progress stop); implement `get_carries`
   for real (currently a stub on both ends). *Why:* area C is a D — the sheet/fallback caddie is
   **materially dumber** than the orb (can't fetch fresh numbers or act). *Cost:* M. *Dependency:*
   none (endpoints exist); pairs with #1 (don't let the tool set change mid-round or it busts cache).

5. **Caddie advice-quality eval harness (golden set + LLM-judge, CI gate)** — *what:* a
   git-diffable golden JSONL of 30–50 scenarios (hole geometry + player + question → expected
   advice properties, incl. edge cases: dogleg, hazard carry, downhill lie, low-confidence parse);
   deterministic assertions (real club? sane yardage? no hallucinated hazard? valid shape) + an
   LLM-judge rubric ("grounded in the actual hole? accounts for lie/wind? appropriately concise?");
   regression-gate in CI; judge with a *different* model than the one under test. *Why:* area G is
   a D — without this, **every other improvement here is unfalsifiable**. *Cost:* M. *Dependency:*
   none (extends the existing voice-tests gate pattern).

### P2 — next (contained, some data/infra-gated)

6. **In-round memory capture + consolidation/dedup + relevance retrieval** — distill durable
   takeaways *during* the round (not only at `/session/end`, which is lost on an abandoned round);
   **merge/dedup/decay** on write-back instead of re-appending; retrieve semantic facts by relevance
   to the current hole/shot, not a naive top-8. *Why:* area D + the compounding player model that
   makes advice personal. *Dep:* none for the pipeline; semantic retrieval (embeddings) optional.
7. **Shot-relative wind + plays-like parity in the text prompt** — resolve raw wind degrees against
   the shot bearing into head/tail/cross (the orb/engine already has `shot_bearing`; the text
   prompt states scalar wind). *Why:* area H. *Dep:* none.
8. **Pin position wired into the turn context** — feed real pin coords into `classify_pin_position`
   (today it degrades to hazard-proximity guessing). *Why:* area H, unlocks short-side/fat-side
   advice. *Dep:* **data-gated** — needs a pin-location source (daily pin sheet or user tap).
9. **Semantic VAD + barge-in completeness on the orb** — `semantic_vad` `eagerness:low`;
   audit that interrupt stops TTS *and* cancels in-flight TTS *and* cancels LLM gen. *Why:* voice
   UX findings; a golfer pausing mid-thought shouldn't get cut off. *Dep:* none (key present).
10. **≥2 workers + move precompute/cleanup to a scheduler** — session state already supports it;
    move `cleanup_loop` + precompute off per-worker in-process loops. *Why:* area F throughput
    cliff (`--workers 1` + SSE holds the loop). *Dep:* **owner/infra-gated** (`deploy/` is guarded).
11. **Streaming TTS on the sheet path (time-to-first-audio)** — stream chunks as synthesized.
    *Why:* voice UX perceived latency. *Dep:* none.
12. **Pre-warm the prompt cache at round start** (`max_tokens:0` write) so the first question
    doesn't pay a cold cache write. *Why:* cost/latency. *Dep:* builds on #1.
13. **One shared behavior contract for both brains** — single source for persona + behavior +
    hazard rule, rendered into both the Realtime mint and the text prompt (kill the parallel
    copies flagged at `routes/caddie.py:653-664`). *Why:* area A drift risk. *Dep:* none.

### P3 — the "amazing" tier (mostly data/owner-gated; see next section)
14. Load-testing harness (TTFT / tokens-per-sec / p95 under concurrency) in CI. *Dep:* none.
15. Lie awareness at shot time (rough/fairway/sand) feeding the engine. *Dep:* **data-gated.**
16. Anthropic Citations on the text path so cited hole data is traceable, not invented. *Dep:* none.
17. Context editing / compaction for very long single rounds. *Dep:* none.

---

## What makes it AMAZING vs merely good — the real-caddie-replaceable bar
The P1/P2 work makes the caddie **fast, cheap, safe, measurable, and at parity**. It does **not**
by itself make a real caddie replaceable. The moat is the **human side + the compounding player
model**, and these are the flagship epics to sequence next (each larger than one cycle, most gated
on the phase-2 **shot-tracking** data spine — the item marked `search-speed`/tracking dependencies):

- **Dispersion-aware targets from MEASURED data** — today dispersion is *modeled* and `personal_sg`
  needs ≥30 logged shots. The elite behavior ("aim fat side sized to *your* spread, never
  short-side") only becomes real once we track shots per club per player. **Ties directly to the
  phase-2 shot-tracking epic** — that epic is the unlock for the whole "personal" claim.
- **Pre-round briefing** — *"here's your game plan for Bethpage today"*: per-hole targets built
  from this player's tendencies + today's wind, spoken before the round. We have the guides and the
  player model; we lack the synthesis + delivery. High-wow, demoable, mostly unblocked.
- **Post-round debrief that writes memories** — strokes-gained by facet vs baseline, tendency
  surfacing ("you bailed right on the par-3s"), a practice prescription, and the write-back that
  makes next round smarter. This closes the compounding loop (pairs with P2 #6). *Dep:* shot data.
- **Knowing when NOT to talk** — a talk/quiet state machine: silent during the pre-shot routine,
  terse in the decision window, conversational only between shots, hard default to *less*. Maps
  straight onto the Northstar "quiet" principle and is a genuine differentiator. Approximable now
  from shot-timing/turn signals; no data gate, needs careful UX design.
- **Reading the player's frustration** — infer tilt from scoring trend + voice tone/cadence and
  pre-empt the hero shot with present-focus language ("next shot is the one that matters"); under
  detected pressure, deliberately take the mind off golf ("walk mode"). Weakest signal, highest
  moat; **data-gated** on tone/sentiment from the voice pipeline. Sequence last, design carefully —
  done badly this violates "quiet"; done well it's the thing a golfer can't get from an app today.

## Non-goals (deliberate)
- Not replacing the deterministic recommendation engine or the tee-time parser with an LLM — they
  are fast, offline-testable, and gate-friendly.
- Not adding a second speech-to-speech provider; `gpt-realtime` stays the orb transport and Claude
  stays the text/tool brain (the SOTA split is correct — keep both).
- Not shipping frustration-detection or "walk mode" before the quiet/talk state machine and the
  eval harness exist — the risk of violating the Northstar "quiet" feel is too high to ship blind.
