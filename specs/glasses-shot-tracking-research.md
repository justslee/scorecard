# Glasses-based shot tracking + phone-free caddie — feasibility research

*Fable direct-research, 2026-07-09. Owner thesis: camera+mic+speaker glasses (Meta Ray-Ban)
or a tiny clip device could (a) let the golfer talk to the caddie without the phone and
(b) track shots more reliably — "you can see the shot, ball moved, there was a sound,
then GPS moved." Scrutiny requested; scrutiny applied.*

## The hardware/platform reality (verified)

**Meta Wearables Device Access Toolkit (DAT)** — real and current:
- Third-party PHONE apps (ours) can access the glasses' **12MP ultra-wide camera
  (streamed at max 720p/30fps over Bluetooth), 5-mic array, and open-ear speakers**.
  Apps run on the phone; glasses are sensors/outputs. GPS comes from the phone (ours
  already does). Supported: Ray-Ban Meta Gen 1/2, Ray-Ban Display, Oakley Meta HSTN/Vanguard.
- **Status: developer preview.** Building/prototyping is possible NOW (iOS SDK on GitHub,
  v0.6); **public publishing is NOT open yet** — Meta says open publishing lands during 2026.
  Early partners only (Twitch, Microsoft, Logitech Streamlabs).
- **Battery/thermals are the wall for continuous vision**: Gen 2 runs 60–90 min of active
  use; native video recording caps at ~1 min/clip with documented overheating shutoffs;
  Meta's own livestreaming caps at ~30 min. **A 4.5-hour continuous-camera round is
  infeasible on any current glasses.** Anyone claiming otherwise is selling something.

**Clip-on cameras (Insta360 GO 3S class)**: tiny and wearable, but record locally,
GO-series lacks realtime app streaming SDK, and there's **no speaker** — fails the
caddie-interaction half entirely. Glasses beat clips for this product.

**Market signal**: CaddieVision (golf-specific AR glasses, Indiegogo 2025) validates
demand for on-course glasses caddies — and illustrates the niche-hardware risk we avoid
by riding Meta's mainstream device.

## The feasibility verdict

### Caddie interaction phone-free: FEASIBLE — partially TODAY
- The glasses present as a Bluetooth mic+speaker to the phone. Our realtime caddie
  already speaks any BT route — **Ray-Ban Metas may work with the live caddie TODAY as
  a plain BT headset, zero code**. (Same is already true of AirPods — worth saying out
  loud: the phone-free *conversation* never needed glasses.)
- DAT adds the differentiator later: the caddie seeing what you see (camera-grounded
  answers: "what's that bunker?" → it looks).

### Continuous-vision shot tracking: INFEASIBLE (battery/thermal, hard no)

### **Triggered-clip shot tracking: PLAUSIBLE and the real design**
The correct architecture isn't watching everything — it's **short clips at the right
moments**:
- Trigger (phone IMU swing signature and/or impact audio from the glasses' mic array,
  which sits far from wind-muffled pockets) → capture a ~5–10s 720p clip around the swing
  → on-phone vision classification: real swing vs practice, ball departed, rough direction.
- Budget: ~40 full shots × ~8s ≈ **5–7 minutes of total camera time per round** — inside
  the battery envelope with margin.
- **This replaces vocal confirmation with visual confirmation** — the owner's core
  objection to the phone-only spike dissolves: nothing to say, the glasses saw it.
- **Putts**: vision is the FIRST sensor with a real shot at them (the camera literally
  watches the stroke) — but trigger reliability for small putting motions is unproven.
  Honest expectation: full shots high-confidence, short game experimental.
- Fusion remains the point: clip says "swing, ball left"; GPS displacement to the next
  dwell confirms and measures it. That pair is drastically stronger than either alone.

## Risks (unvarnished)
1. **Platform timing**: can't SHIP until Meta opens publishing (promised 2026, date theirs).
   Prototype now, ship when the gate opens.
2. **BT bandwidth on-course**: 720p/30 streaming degrades when BT is congested; clip
   transfer (not live streaming) sidesteps most of it.
3. **Trigger precision**: false clips (practice swings) cost battery; missed triggers cost
   shots. The spike must measure trigger precision/recall first — same discipline as ever.
4. **Adoption**: requires the golfer to own+wear Meta glasses. Fine for the owner-as-user;
   a segment, not the default, for the market. The phone path stays primary.
5. **Vision model**: egocentric swing/ball-flight classification is buildable (short clip,
   constrained scene) but needs a labeled sample — the owner's own rounds bootstrap it.

## Recommended path
1. **NOW / $0 code**: owner acquires Ray-Ban Meta Gen 2; pair as BT audio with the live
   caddie — validate the phone-free conversation experience immediately.
2. **Spike (DAT developer preview)**: prototype triggered-clip capture + a simple
   swing/no-swing classifier on owner rounds; measure trigger precision, clip battery
   cost, classification accuracy. Diagnostic-only, no scorecard effect.
3. **Decide** on the data: if trigger+vision clears ~95% on full shots, build the draft
   shot log (fused with GPS) and the silent scorecard; ship when Meta opens publishing.

## Sources
- https://developers.meta.com/blog/introducing-meta-wearables-device-access-toolkit/
- https://developers.meta.com/wearables/faq/
- https://github.com/facebook/meta-wearables-dat-ios
- https://roadtovr.com/meta-ray-ban-smart-glasses-third-party-app-sdk-device-access-toolkit/
- https://www.uploadvr.com/meta-wearables-device-access-toolkit-public-preview/
- https://medium.com/antaeus-ar/meta-ray-bans-gen-1-vs-gen-2-full-review-and-comparison-7facac116080
- https://www.meta.com/legal/ai-glasses/health-and-safety-warnings/meta-ray-ban-display/
- https://www.tomsguide.com/wellness/fitness/i-wore-caddievisions-golf-ar-glasses-and-the-course-will-never-look-the-same
- https://www.insta360.com/developer/home
