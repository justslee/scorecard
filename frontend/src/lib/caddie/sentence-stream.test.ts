// specs/caddie-realtime-conversation-plan.md §6.5.4 (Slice A2) — deterministic
// unit coverage for the incremental sentence segmenter. No timers, no DOM.

import { describe, it, expect } from "vitest";
import { createSentenceStream } from "./sentence-stream";

describe("createSentenceStream", () => {
  it("emits a sentence as soon as its delta completes with trailing whitespace", () => {
    const s = createSentenceStream();
    expect(s.push("Nice drive. ")).toEqual(["Nice drive."]);
  });

  it("does not emit a boundary for the trailing partial (no whitespace yet)", () => {
    const s = createSentenceStream();
    expect(s.push("Now hit the 8.")).toEqual([]); // no trailing whitespace — could still grow
    expect(s.flush()).toEqual(["Now hit the 8."]);
  });

  it("'Nice drive. Now hit the 8.' fed as one delta -> two sentences (push + flush)", () => {
    const s = createSentenceStream();
    expect(s.push("Nice drive. Now hit the 8.")).toEqual(["Nice drive."]);
    expect(s.flush()).toEqual(["Now hit the 8."]);
  });

  it("fed incrementally, token by token, produces the same two sentences", () => {
    const s = createSentenceStream();
    const out: string[] = [];
    for (const tok of ["Nice ", "drive. ", "Now ", "hit ", "the ", "8."]) {
      out.push(...s.push(tok));
    }
    out.push(...s.flush());
    expect(out).toEqual(["Nice drive.", "Now hit the 8."]);
  });

  it('"You\'re 165 yds. out — hit the 7." stays ONE sentence up to the "7." (yds. is not a boundary)', () => {
    const s = createSentenceStream();
    const mid = s.push("You're 165 yds. out — hit the 7.");
    expect(mid).toEqual([]); // "yds." guarded, "7." has no trailing whitespace yet
    expect(s.flush()).toEqual(["You're 165 yds. out — hit the 7."]);
  });

  it("a number-period-lowercase continuation is not a boundary", () => {
    const s = createSentenceStream();
    const mid = s.push("Hit it 250. that's plenty ");
    expect(mid).toEqual([]); // "250." guarded — next word is lowercase
    expect(s.flush()).toEqual(["Hit it 250. that's plenty"]);
  });

  it("a number followed by a capitalized new sentence DOES split", () => {
    const s = createSentenceStream();
    expect(s.push("Carry it 250. Then two putts. ")).toEqual(["Carry it 250.", "Then two putts."]);
  });

  it("a decimal like 3.5 never splits (no whitespace after the internal period)", () => {
    const s = createSentenceStream();
    const mid = s.push("You need 3.5 more yards to clear it. ");
    expect(mid).toEqual(["You need 3.5 more yards to clear it."]);
  });

  it('multi-punctuation "Really?! Go." -> two sentences', () => {
    const s = createSentenceStream();
    expect(s.push("Really?! Go.")).toEqual(["Really?!"]);
    expect(s.flush()).toEqual(["Go."]);
  });

  it("a trailing partial with no punctuation at all stays buffered until flush()", () => {
    const s = createSentenceStream();
    expect(s.push("Aim left of the")).toEqual([]);
    expect(s.flush()).toEqual(["Aim left of the"]);
  });

  it("flush() on an empty/whitespace-only buffer returns nothing", () => {
    const s = createSentenceStream();
    expect(s.flush()).toEqual([]);
    const s2 = createSentenceStream();
    s2.push("   ");
    expect(s2.flush()).toEqual([]);
  });

  it("common abbreviations (Mr., Dr., approx., St.) are not treated as boundaries", () => {
    const s = createSentenceStream();
    const mid = s.push("Ask Dr. Smith or Mr. Jones, approx. 40 yards from the St. Andrews marker. ");
    expect(mid).toEqual([
      "Ask Dr. Smith or Mr. Jones, approx. 40 yards from the St. Andrews marker.",
    ]);
  });

  it("a closing quote/paren between the punctuation and whitespace is still a boundary", () => {
    const s = createSentenceStream();
    expect(s.push('He said "go." Now move. ')).toEqual(['He said "go."', "Now move."]);
  });

  it("consecutive push() calls never re-emit an already-completed sentence", () => {
    const s = createSentenceStream();
    expect(s.push("Nice drive. ")).toEqual(["Nice drive."]);
    expect(s.push("Now hit the 8. ")).toEqual(["Now hit the 8."]);
    expect(s.flush()).toEqual([]); // nothing left buffered
  });
});
