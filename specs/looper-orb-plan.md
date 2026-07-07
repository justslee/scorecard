# The Looper orb — one standardized voice invocation, everywhere

Owner (2026-07-07): Looper invocation differs across pages (round: floating pill + orb; tee-time: a big HOLD TO TALK bar he dislikes; setup: own mic; most pages: nothing). "The premise of this app is having this constant assistant caddie that can help with any request." Owner-approved design (AskUserQuestion, 2026-07-07):
- **Placement: center orb in the floating tab island** (Instagram-style raised circle). Tabs become Home · Courses · [Looper] · Tee times · Profile; Partners leaves the bar (entry point moves to Home; /players stays routable).
- **Gesture: tap → Looper sheet; long-press (~350ms) → sheet opens already listening.**
- **Rollout bundle 1: tee-times + courses contexts** (+ an honest general-chat context so the orb works on Home/Partners/Profile from day one — the stateless /caddie/voice endpoint already exists). Round page keeps its pill placement, restyled to the same identity in bundle 2.

## Architecture

**`frontend/src/lib/looper-bus.ts` (new, pure-ish):** a tiny window CustomEvent bus.
- `openLooper(detail: { context: "general" | "tee-time" | "courses"; listening: boolean })`
- `onLooperOpen(cb): () => void` (returns unsubscribe)
- `looperContextForPath(pathname): context` — /tee-time → tee-time, /courses → courses, else general. Unit-tested.

**`FloatingTabBar.tsx`:** TABS lose Partners; a center orb slot renders between Courses and Tee times — a raised ink circle (≈54px, breaks the pill's top edge, serif italic "L" in paper, hairline ring; pressed state = accent ring). Pointer handlers: tap → `openLooper({context, listening:false})`; long-press 350ms (pointer down timer, cancel on move/up-before-threshold) → `openLooper({context, listening:true})` + haptic. The orb is a button, not a Link; aria-label "Talk to Looper".

**General context — `frontend/src/components/LooperSheet.tsx` (new):** mounted once next to FloatingTabBar (same layout host), subscribes to the bus for context "general". A lean bottom sheet in the CaddieSheet idiom: LOOPER kicker header, tap-to-talk mic with LIVE dictation (DeepgramLiveTranscriber + VoiceRecorder fallback — the exact pattern/helpers from CaddieSheet/dictation.ts), pinned user line + PulseDot while thinking, answer in serif. Brain: stateless `talkToCaddie({ transcript, personality_id: "classic" })` (existing endpoint; no round context). `listening: true` → starts dictation on open. Conversation history kept for the sheet's lifetime only.

**Tee-time context:** the page subscribes (context "tee-time"). The HOLD TO TALK bar + inline Transcript block are REMOVED from the page body (the Looper greeting line stays as page copy). The orb opens a tee-time-scoped sheet (same visual shell as LooperSheet — extract the shell or accept ~parallel structure) whose final transcript feeds the EXISTING applyParsed pipeline (windows/courses/miles/group/dispatch parsing — unchanged); Looper's confirmation line (the existing say() copy) renders as the reply, and the prefs update live behind the sheet. Hold-to-talk semantics are gone on this page; tap-to-talk + live dictation only.

**Courses context:** the page subscribes (context "courses"). Orb tap → opens the existing full-screen CourseSearch with a new `autoVoice?: boolean` prop: on mount it starts live dictation INTO the query input (deepgram-live, ScoreSheet pattern); interim text updates the query (debounced search fires as usual); stop (tap mic or silence) finalizes the query text. listening:true and tap both auto-start dictation here (search is the context's one job). The CourseSearch mic button becomes functional on this page (not hidden).

**Partners relocation:** Home page gains a quiet "Partners" row/card linking to /players (match Home's existing row idiom). /players route unchanged.

## Edge cases
- Orb on a page whose context sheet is already open → no-op (bus consumer guards).
- Long-press vs tap: movement threshold cancels the press timer (no accidental listen while scrolling past the bar).
- Mic exclusivity: general/tee-time sheets use the same one-mic rule (they're modal; the round orb never coexists — no tab bar on round pages).
- Tab bar hidden pages (round) — orb absent by design; round keeps its own pills.
- 320px width: 4 tabs + orb fit (tabs flex, orb fixed width).
- Voice smoke gate: tee-time parsing pipeline unchanged (only its input surface moved) — the voice-tests must stay green.

## Tests
- looper-bus: dispatch/subscribe/unsubscribe; looperContextForPath mapping.
- FloatingTabBar: orb renders between Courses and Tee times; Partners absent; tap emits open event (jsdom CustomEvent); long-press emits listening:true (fake timers).
- Tee-time: existing voice-prefs tests unchanged (pipeline untouched); sheet-level test that a finalized transcript reaches applyParsed.
- CourseSearch autoVoice: mount with autoVoice starts the live transcriber and interim text lands in the query input (mock deepgram-live as in CaddieSheet.session.test).
- LooperSheet: live dictation happy path → talkToCaddie called with the live transcript; PulseDot while pending.

## Gates
tsc, lint, vitest, voice smoke (hard gate — parsing untouched), build. Designer review of the orb + sheets vs NORTHSTAR when budget allows; owner sees it on TestFlight regardless. No /security-review (no new endpoint/auth/dep; talkToCaddie + live-token exist).

## Out of scope (bundle 2)
Round-page identity restyle; Home/Partners/Profile page-specific powers (navigation/actions from general chat); setup-flow orb.
