# Caddie Orb Tap-to-Talk Inversion — Implementation Plan

**Spec status:** CONTRACT. The builder implements this to the letter; the designer's state table (reproduced in section 0/1) is settled — do not re-litigate it.
**Northstar check:** all feedback is the existing ink-medallion scale pulse / static printed-ring treatments — no glow, no chime, no new design language. Voice-first: tap now goes straight to talking.

Owner directive (verbatim, v1.1.10 field test): "On hold we open the chat, on tap we don't open and can just start talking immediately." INVERT the caddie orb: TAP -> start talking immediately (live mic, NO sheet, pulsing-medallion feedback); HOLD (long-press) -> open the chat sheet. Previous convention was tap->sheet / hold->listen.

## 0. Summary of the inversion

| Surface | State | TAP | HOLD |
|---|---|---|---|
| Round pill | idle | mic live NOW (voice.stop(); detachedCaddieLive.start()), no sheet — light haptic | 350ms -> openCaddieSheet() (sheet + live) — medium haptic, no confirm flash |
| Round pill | live/connecting/suspended | UNCHANGED (reopen sheet) | UNCHANGED (480ms -> "Release to end" -> end) |
| General orb | idle | open host in presentation:"docked" + listening — orb pulses, caption chip, no sheet chrome — light haptic | 350ms -> open presentation:"full", not listening (today's tap payload) — medium haptic |
| General orb | docked listening | send now (handleMicTap's listening branch) | 350ms -> dictation.cancel() + collapse to idle — light haptic, no confirm flash |

Hard constraints: no second Realtime/dictation session path (the general orb stays on the single useLooperDictation in CaddieOrbSheet); docked->full promotion routes through the same open/sessionRef/presentation state, never a parallel boolean; a live mic always has a same-frame visual indicator; every listening state has a light exit; frontend/src/hooks/useDetachedCaddieLive.test.tsx and frontend/src/components/CaddieSheet.session.test.tsx must pass unmodified.

Implementation order: Step 1 (shared plumbing) -> Step 2 (Surface B host) -> Step 3 (Surface B orb) -> Step 4 (Surface A pill) -> Step 5 (discoverability chips) -> Step 6 (tests/gates). Steps 2-3 land together; Step 4 is independent.

NOTE: The full authoritative plan text is carried in the eng-lead dispatch to the builder and in tasks/progress.md. This file is the durable spec pointer; sections 1-9 below capture the complete contract.

## 1. Step 1 — Shared plumbing (types + channels)

### 1a. frontend/src/lib/looper-bus.ts
Add to LooperOpenDetail: `presentation?: "docked" | "full"` (optional; omitted = "full", back-compat). Add a new docked-gesture window CustomEvent mirroring looper:open verbatim (SSR-safe no-ops):
- `export type LooperDockedGesture = "send" | "cancel";`
- event name "looper:docked-gesture"
- `sendLooperDockedGesture(gesture)` / `onLooperDockedGesture(cb): () => void`
Only CaddieOrb.tsx dispatches openLooper (verified); courses list page + CaddieOrbSheet are listeners. courses page ignores presentation (reads context only) — no change.

### 1b. frontend/src/lib/caddie-context.ts
- CaddieOrbState union: `"idle" | "connecting" | "listening" | "thinking" | "confirming"` (activate reserved "listening", add "connecting"; "thinking" stays reserved). Update comment.
- New one-way caption channel (host -> orb), same module pub-sub shape as orb-state:
  `type CaddieOrbCaption = string | null;` + `setCaddieOrbCaption` (dedup-guard like setCaddieOrbState) / `getCaddieOrbCaption` / `onCaddieOrbCaption`. Pure module state, SSR-inert.

## 2. Step 2 — Surface B host: frontend/src/components/CaddieOrbSheet.tsx

### 2a. New state + refs (next to open/boundId)
```
const [presentation, setPresentation] = useState<"docked"|"full">("full");
const presentationRef = useRef<"docked"|"full">("full"); // mirrored via effect like openRef
const dockedExpectedStopRef = useRef(false);
const noSpeechTimerRef = useRef<ReturnType<typeof setTimeout>|null>(null);
```

### 2b. Summon routing (lane 3)
```
setBoundId(ctx?.kind === "task" ? ctx.id : null);
setPresentation(detail.presentation ?? "full");
setOpen((wasOpen) => { if (!wasOpen) resetSession(); return true; });
if (detail.listening) setTimeout(() => void dictationRef.current.start(), 60);
```
Lanes 1 (surface) and 2 (legacy courses floor) unchanged. Surface-registered pages now receive the inverted listening flag from the orb (tap -> summon(true), hold -> summon(false)) — owner directive applied uniformly; their UIs already handle both.

### 2c. close() — add docked hygiene
Append inside close(): clear noSpeechTimerRef; setPresentation("full"); dockedExpectedStopRef.current=false; setCaddieOrbState("idle"); setCaddieOrbCaption(null). (setCaddieOrbState dedups -> inert for full-sheet closes.)

### 2d. Promotion helper (near close)
```
const promoteToFull = useCallback(() => {
  if (noSpeechTimerRef.current) { clearTimeout(noSpeechTimerRef.current); noSpeechTimerRef.current = null; }
  setPresentation("full"); setCaddieOrbState("idle"); setCaddieOrbCaption(null);
}, []);
```
Promotion is ONLY a presentation flip — same open, same sessionRef gen, same turns, same dictation instance. Satisfies dedup/zombie-guard invariant by construction.

### 2e. Promotion triggers
(a) User turn appended: in handleMicTap right after appendTurn({role:"user",text:heard}) -> `if (presentationRef.current === "docked") promoteToFull();` (caption user saw ~= heard = top turn, no jump-cut; precedes parse/converse so all downstream renders in the tested full sheet).
(b) Real mic/connect error — new effect: `if (open && presentation === "docked" && dictation.micError) promoteToFull();` deps [open,presentation,dictation.micError,promoteToFull].
(c) Unexpected listening drop — new effect w/ prevListeningRef: if listening -> dockedExpectedStopRef=false, return; if !was return; if !openRef or presentationRef!=="docked" return; if dockedExpectedStopRef -> reset+return; else promoteToFull(). Set dockedExpectedStopRef.current=true in exactly two places: (i) in handleMicTap immediately before `await dictation.stopAndResolve()` (covers docked tap-to-send AND onUtteranceEnd auto-send, same handler); (ii) in the docked-cancel gesture handler (2g). close() sets open false after sessionRef++ so the effect's openRef guard makes close inert.

### 2f. Bare no-speech self-heal (docked only) — in handleMicTap !heard branch
If presentationRef.current === "docked": setCaddieOrbCaption("Didn't catch that"); capture gen2=sessionRef.current; noSpeechTimerRef = setTimeout(2500) that guards (sessionRef===gen2 && openRef && presentationRef==="docked") then close() (collapse to idle — no full-sheet promotion for silence). Else existing setError copy. dockedExpectedStopRef was set before stopAndResolve so (c) doesn't also fire.

### 2g. Docked gesture subscription — new effect
onLooperDockedGesture((g)): if !openRef or presentationRef!=="docked" return. "send" -> if !dictationRef.current.listening return (connecting: inert) else micTapRef.current(). "cancel" -> dockedExpectedStopRef.current=true; close() (close calls dictation.cancel() + resets presentation/orb/caption).

### 2h. Docked -> orb state/caption publisher — new effect
if !open or presentation!=="docked" return. if dictation.listening -> setCaddieOrbState("listening"); setCaddieOrbCaption(interim ? quoted interim : "Hearing..."). else setCaddieOrbState("connecting"); if !noSpeechTimerRef.current setCaddieOrbCaption("Connecting...") (don't clobber no-speech caption while its timer runs). deps [open,presentation,dictation.listening,dictation.interim].

### 2i. Route-change hygiene (docked is page-scoped)
Add usePathname() (host mounted once in app/layout.tsx, inside app router). prevPathRef; on pathname change if openRef && presentationRef==="docked" -> dockedExpectedStopRef=true; close(). Full-sheet behavior across nav untouched.

### 2j. Shell rendering — LooperSheetShell stays byte-identical
Gate the existing open prop: `<LooperSheetShell open={open && presentation === "full"} ...unchanged/>`. Docked -> shell renders nothing (no chrome/scroll lock), as if closed; on promotion shell sees closed->open and re-baselines speak-newest watermark to turns.length-1 (the just-appended user turn) so first caddie reply is spoken, user turn is not. NO presentation prop added to shell (keeps LooperSheet.test.tsx + tee-time consumer untouched).

## 3. Step 3 — Surface B orb: frontend/src/components/CaddieOrb.tsx

### 3a. Subscriptions
`const [orbState,setOrbState]=useState(getCaddieOrbState()); useEffect(()=>onCaddieOrbState(setOrbState),[]);` confirming = orbState==="confirming". Add caption subscription (getCaddieOrbCaption/onCaddieOrbCaption). Import useReducedMotion from framer-motion.

### 3b. Pointer handlers — migrate mechanics verbatim, swap actions
Keep ORB_HOLD_MS=350, ORB_DRIFT_PX=12, holdTimer/heldFired/downAt, drift-cancel, onPointerCancel, onContextMenu prevent, touchAction:"none". Capture pressState ref in onPointerDown so a mid-press connecting->listening flip can't change semantics.
- onPointerDown hold body: pressState docked (listening/connecting) -> haptic('light'); sendLooperDockedGesture('cancel'). else idle/confirming -> haptic('medium'); openLooper({context:looperContextForPath(pathname), listening:false, presentation:"full"}).
- onPointerUp tap (after existing heldFired/wasPending guards): docked -> haptic('light'); sendLooperDockedGesture('send'). else -> haptic('light'); openLooper({context, listening:true, presentation:"docked"}).
Mic-privacy: pulse driven by orbState==="listening", published from the same dictation.listening render that means mic is hot -> indicator + mic hot same frame; "Connecting..." static beat covers pre-hot. No chime.

### 3c. Motion
animate: confirming -> {scale:[1,1.12,1]}; else listening && !reduceMotion -> {scale:[1,1.06,1]}; else {scale:1}. transition: confirming -> {0.5 easeOut}; else listening && !reduceMotion -> {2.6s repeat Infinity easeInOut}; else T.springSoft. "connecting" never pulses. Static shadow stack untouched.
Reduced-motion static listening indicator: when listening && reduceMotion, prepend to boxShadow array `0 0 0 2.5px ${T.paper}, 0 0 0 4px ${T.ink}` (printed double ring, zero animation). Idle/connecting get no ring.

### 3d. Docked caption chip — rendered BY THE ORB
Factor existing intro-chip JSX into local OrbChip({children}) preserving role="status", aria-live="polite", paper pill, pointerEvents:"none", spring. Render inside AnimatePresence with mutual exclusion:
showIntro -> "Your caddie moved here"; showInvertIntro && !showIntro -> "Tap to talk - hold to open chat"; dockedCaption!=null && !showIntro && !showInvertIntro -> {dockedCaption}. Interim crosses via caption channel — no provider.

### 3e. Orb hidden while docked-live (overlay/route guard)
Before `if (!visible) return null`: useEffect that if !visible && (listening||connecting) -> sendLooperDockedGesture("cancel"). deps [visible,orbState]. Covers fullscreen overlay (CourseSearch) + nav onto shouldShowCaddieOrb-false route; host pathname effect (2i) is the belt.

### 3f. Stateful aria-label
idle/confirming: "Talk to your caddie — tap to talk, hold to open chat". listening: "Caddie listening — tap to send, hold to cancel". connecting: "Caddie connecting — hold to cancel".

## 4. Step 4 — Surface A pill: frontend/src/app/round/[id]/RoundPageClient.tsx

### 4a. New constant + ref
`const PILL_OPEN_HOLD_MS = 350;` (comment: intentionally differs from PILL_END_HOLD_MS=480, end is higher-stakes). `const pillOpenHoldFiredRef = useRef(false);`

### 4b. onPointerDown — arm per state; live branch byte-identical
`if (pillIsLive) { EXISTING live-end hold body UNCHANGED; return; }` (pillIsLive = liveOn && !fellBack, true while suspended too -> suspended keeps arming end hold, byte-identical). Else IDLE: pillOpenHoldFiredRef=false; pillHoldTimerRef = setTimeout(PILL_OPEN_HOLD_MS) -> pillOpenHoldFiredRef=true; haptic("medium"); openCaddieSheet(). Both holds share pillHoldTimerRef (mutually exclusive at arm time; clearPillHold on up/leave/cancel clears whichever pending). Timer-coexistence edge: live->idle flip mid-hold makes pending end-timer call end() on an already-ended session — end() is idempotent. Add a one-line comment.

### 4c. onClick — invert idle branch only
```
if (pillEndHoldFiredRef.current) { pillEndHoldFiredRef.current=false; return; }   // unchanged
if (pillOpenHoldFiredRef.current) { pillOpenHoldFiredRef.current=false; return; } // NEW: hold opened sheet
if (pillIsLive) { setCaddieOpen(true); return; }                                  // unchanged tap-to-view
// IDLE TAP: talk immediately. Eligibility gate mirrors useDetachedCaddieLive start() (KEEP IN SYNC):
if (!(caddieSessionActive && !isLocalRound) || !getCaddieLiveMode() || (typeof navigator!=="undefined" && !navigator.onLine)) { openCaddieSheet(); return; }
haptic("light"); voice.stop(); detachedCaddieLive.start(); // fires grounded spoken opener; DO NOT touch
```
Import getCaddieLiveMode from @/lib/voice/live-mode-pref. Do NOT setCaddieOpen(true) on the live idle-tap path. start()->liveOn->pillConnecting("Connecting...",no pulse)->pillPulsing medallion + liveStatusLabel gives feedback for free.

### 4d. aria-label — stateful
pillEndConfirming -> "Ask caddie — release to end"; pillIsSuspended -> "... paused, tap to resume, hold to end"; pillConnecting -> "... connecting, tap to view, hold to end"; pillIsLive -> "... live, tap to view, hold to end"; else -> "Ask caddie — tap to talk, hold to open chat".

### 4e. Reduced-motion static listening indicator (medallion)
Today pillPulsing && reduceMotion = static medallion identical to idle (a live mic w/ no indicator). Fix: `const pillStaticLive = pillPulsing && reduceMotion;` prepend `0 0 0 2px ${accent}` to the medallion boxShadow string when true. Border tint (${accent}55) + label unchanged.

Do not touch: live-hold-to-end body, PILL_END_HOLD_MS/PILL_END_CONFIRM_MS, pulse cadences, openCaddieSheet itself, useDetachedCaddieLive, opening-turn.ts, CaddieSheet props.

## 5. Step 5 — One-time re-teach chips

### 5a. General orb (CaddieOrb.tsx)
New key `looper.tapHoldInvertedSeen`. Effect modeled byte-for-byte on intro effect (SSR-guarded typeof window, try/catch, burn-once, deferred setState). Sequencing: introFiredRef tracks whether moved-here fired this mount; invert chip show timer = introFiredRef.current ? 3400 : 0 ms, hide at show+3200. Copy "Tap to talk - hold to open chat". Renders via OrbChip w/ mutual-exclusion.

### 5b. Round pill (RoundPageClient.tsx)
Own key looper.roundPillTapHoldInvertedSeen, same SSR-guarded burn-once effect; state showPillIntro. AnimatePresence chip absolutely positioned above the action row (position:absolute, bottom:100%, centered), exact orb-chip treatment (role="status", paper pill, serif italic 14, pointerEvents:none, 3.2s). Same copy. Only when idle (!pillIsLive).

## 6. Edge cases & risks (resolved)
1. Docked mic hot across nav — host cancels on pathname change (2i); orb cancels on visibility loss (3e).
2. Docked + second orb tap — orb reads orbState; listening=send, connecting=inert (host guard). No double start().
3. Promotion racing stale session — (a) synchronous after existing sessionRef!==gen guards; (b)/(c) effects check live openRef/presentationRef. promoteToFull never touches sessionRef/turns/dictation.
4. Reduced-motion — pill accent ring (4e); orb printed double ring (3c); connecting never pulses; docked chip motion-light + role=status.
5. SSR — new localStorage keys read/written only in useEffect w/ typeof window + try/catch; new channels SSR-inert.
6. Pill idle-hold vs live-hold — one timer ref, two fired-refs, state checked at pointer-down; both cleared by clearPillHold.
7. VoiceOver on auto-promote — do NOT steal focus; docked caption role=status aria-live=polite; promoted sheet mounts like today's manual summon (no focus move). Focus pass out of scope.
8. onUtteranceEnd auto-send while docked — routes through handleMicTap->stopAndResolve->append->promotion(a); dockedExpectedStopRef keeps (c) quiet; bare silence -> no-speech self-heal.
9. Task-bound docked session whose page unregisters — existing context-unmount hygiene calls close() which now resets orb/caption. Covered.
10. Ineligible round pill tap — explicit fallback to openCaddieSheet() (4c).

## 7. Shared-type sync
types.ts <-> models.py untouched (no shared API shapes; zero backend edits). looper-bus.ts: presentation? + LooperDockedGesture + send/on. caddie-context.ts: CaddieOrbState gains "connecting", "listening" becomes live, new CaddieOrbCaption channel. LooperSheet.tsx: no prop changes.

## 8. Test plan & gates
Gates (from frontend/): npm run lint; npx tsc --noEmit; npm run build; npx tsx voice-tests/runner.ts --smoke; npx vitest run.
Must pass UNMODIFIED (do not edit): useDetachedCaddieLive.test.tsx, CaddieSheet.session.test.tsx, LooperSheet.test.tsx, caddie-experience-suite manifest membership.
EXPECTED rewrites (contract changed, not regressions): CaddieOrb.test.tsx — tap now asserts {context:"tee-time",listening:true,presentation:"docked"}; hold asserts {context:"tee-time",listening:false,presentation:"full"}; aria-label queries -> new idle label; framer-motion mock adds useReducedMotion:()=>false (overridable). looper-bus.test.ts — presentation field + gesture event round-trip.
NEW tests — CaddieOrb.test.tsx: listening-state pulse; orb hold-to-cancel; docked caption chip; hidden-while-docked cancel; invert intro chip sequencing. CaddieOrbSheet.test.tsx: docked open (no chrome, connecting->listening trace); promotion (a) send->append->chrome; promotion (b) micError; promotion (c) listening flips false; no-speech self-heal (fake timers, 2500ms close); docked cancel gesture; route-change cancel (add usePathname to next/navigation mock); back-compat (listening:false no presentation behaves as existing tests).
Pill: no unit harness — manual run + gates; call out in PR as manually verified with evidence.

## 9. Out of scope (do NOT touch)
Realtime machinery (useCaddieLiveSession, useDetachedCaddieLive.ts, realtime.ts, reconnect/suspend/warm, opening-turn.ts/opening-shot.ts). Live-hold-to-end + live tap-to-reopen (aria-label only). CaddieSheet.tsx, VoiceSheet, useVoiceCaddie, LooperSheetShell internals, tee-time's shell instance. No second session path; no spoken opener/chime on general orb. Backend: zero. shouldShowCaddieOrb routing, orb placement/clearance, resting-orb shadow.
