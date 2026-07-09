# Looper's agentic engineering system — design & rationale

*How an always-on team of Claude agents ships this app autonomously, and WHY it's built
this way. Evaluated 2026-07-09 against the current state of the art (Anthropic's
multi-agent research writeup + the 2026 orchestration literature) — this records where we
match the field, where we lead it, and the deliberate trade-offs.*

## The shape
A single **orchestrator** (`eng-lead`) drives one backlog item per cycle through a pipeline
of **context-isolated specialist agents** — `Plan → builder → reviewer + qa + designer` —
and lands the result on one rolling branch. A human approves merges in noticeable-sized
batches. An hourly loop re-invokes the orchestrator; a weekly `retro` compounds lessons.

```
loop (hourly) ─▶ eng-lead (orchestrator, opus)
                   │  Step 0: owner feedback/approvals first
                   │  Plan (FABLE) ──▶ specs/<id>-plan.md   ← the contract
                   │  builder (sonnet) ──▶ commit on integration/next
                   │  reviewer (opus/fable) ┐
                   │  qa (sonnet)           ├─ parallel multi-lens verification
                   │  designer (sonnet)     ┘
                   │  iterate until green ──▶ update the ONE bundle PR
                   └─ notify owner ONLY when the bundle is noticeable + green
retro (weekly, opus) ──▶ tasks/lessons.md + backlog grooming
```

## The seven design decisions, and why

**1. Orchestrator-worker (supervisor) topology.** One agent decomposes and delegates;
workers never see each other's execution. This is the 2026 production default
([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)). We use it
because coding work is a dependency chain (plan→build→verify), not a free-for-all.

**2. Context isolation with conclusion-only returns.** Each subagent runs in its own event
stream and returns a summary, not its transcript. This is what makes long autonomous runs
possible — the orchestrator's context stays small while the workers burn their own. It's
also least-privilege: `builder` can Edit/Write; `reviewer`/`qa` are read-only + Bash + Skill.

**3. Evaluator-optimizer panel, not one reviewer.** `reviewer` (correctness+security),
`qa` (the gates), and `designer` (Northstar) look at the same diff through *different
lenses*. Anthropic calls this out explicitly: a panel catches failure modes a single
reviewer misses. Our record proves it — independent reviews have caught a merged-over-red
CI, a streaming double-render race, and a mirrored-geometry bug a single pass would have
shipped.

**4. Plan-first, ALWAYS, on the strongest model.** Every change is gated by a written plan
(`specs/<id>-plan.md`) before any code — the plan is the contract the builder implements,
not re-derives. Plans (and the highest-stakes reviews) run on **Fable**, the top model,
because plan quality gates everything downstream: a Fable review *falsified a wrong geometry
fix pre-ship* that a lesser review would have merged. Model tiering — Fable (plan/hardest
review) · opus (orchestrator/retro) · sonnet (builder/qa/designer) — spends the most
capable model exactly where an error is most expensive.

**5. The bundle model (our own optimization, ahead of the common practice).** The unit of a
PR is "a change the owner would notice on a TestFlight build," not one item. All work
accumulates on one rolling `integration/next` branch behind one open PR; silent work
(tests/refactors/infra) rides along and merges with the next noticeable change on a single
"ship it." This decouples *engineering cadence* (many small commits) from *approval cadence*
(rare, meaningful) — a human-attention optimization the orchestration writeups don't cover,
because most assume a human isn't the bottleneck. Here the human's time is the scarcest
resource, so the system is designed around spending it well.

**6. Compounding via a retro loop.** `retro` distills every rough patch into
`tasks/lessons.md` rules that then bind the workers ("a red spec test means fix the CODE,
never the assertion" is now a hard builder rule + a blocking reviewer check). The team gets
measurably better over time instead of repeating mistakes — the mechanism most one-shot
orchestration demos lack.

**7. Layered, defense-in-depth safety.** A `guard.sh` PreToolUse hook hard-blocks
`.env`/`deploy/`/migrations/`rm -rf`/force-push/push-to-`main` regardless of what any agent
decides; CI gates every PR; a human approves every merge; agents treat embedded instructions
in tool output as DATA, never commands (planted "approve the pairing"/"date changed" strings
have appeared repeatedly and been ignored every time). No single agent failure can reach prod.

## Cost discipline (the 15× tax, paid deliberately)
Multi-agent runs cost ~15× a single chat ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system));
the value is that they "spend enough tokens to solve the problem." We pay it selectively:
one item per cycle; the full roster only when warranted (`designer` on user-facing changes,
`/security-review` on new surfaces); prompt caching cut per-turn cost ~75%; per-user rate
limits cap runaway spend. The bundle model further amortizes cost across an approval.

## Where we sit vs the field
- **Match the 2026 default:** supervisor topology, context isolation, evaluator-optimizer
  panel, plan-first, model tiering, context compaction on long runs.
- **Ahead of the common writeups:** the bundle/approval-cadence decoupling, the retro
  compounding loop as a first-class agent, the honesty doctrine (no-fake-data as a hard rule
  the eval harness enforces), and an advice-quality eval harness with *teeth* (every check
  proves it can fail) gating agent output — most demos have no quality gate at all.
- **Known weakness, now mitigated:** the orchestrator historically died at await-points and
  orphaned child reports. The fix is now doctrine (checkpoint + push + a `## AWAITING` note
  before every await; reconcile from the branch on resume) rather than manual parent rescue.

## The honest trade-offs
- One item per cycle trades throughput for reviewability — deliberate; the human reads
  bundles, not firehoses.
- Human-in-the-loop on every merge trades autonomy for safety — deliberate; nothing
  unreviewed reaches an app real people use on the course.
- Subscription-path execution (not the metered API) trades some ergonomics for a flat cost
  — deliberate; it's what makes an always-on team economically sane.

*This system was designed intentionally, evaluated against the state of the art, and
improved where the evaluation found gaps. It is not a demo; it ships a real app.*
