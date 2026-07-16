// @vitest-environment jsdom
//
// LooperSheetShell — the shared sheet surface (LooperSheet.tsx). Pins the
// `personaId` prop that selects the SPOKEN voice
// (specs/caddie-orb-persona-consistency-plan.md §1.3C): an optional prop,
// default "classic", so every consumer that omits it stays behavior-
// identical to before the prop existed.

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

// Same cached-Proxy pattern as CaddieOrbSheet.test.tsx — strip animation so
// AnimatePresence mounts/updates synchronously and component identity stays
// stable across re-renders (a fresh component per JSX access would force an
// unmount+remount instead of an update).
vi.mock("framer-motion", () => {
  const passthroughTags = new Set(["div", "button", "span", "svg", "path"]);
  const cache = new Map<string, React.ForwardRefExoticComponent<Record<string, unknown>>>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!passthroughTags.has(tag)) return undefined;
        const cached = cache.get(tag);
        if (cached) return cached;
        const Passthrough = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
          const {
            initial: _initial,
            animate: _animate,
            exit: _exit,
            transition: _transition,
            ...rest
          } = props;
          return React.createElement(tag, { ...rest, ref });
        });
        Passthrough.displayName = `motion.${tag}`;
        cache.set(tag, Passthrough);
        return Passthrough;
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

const { speakMock } = vi.hoisted(() => ({ speakMock: vi.fn() }));
vi.mock("@/hooks/useSheetTTS", () => ({
  useSheetTTS: () => ({
    unlock: vi.fn(),
    speak: speakMock,
    beginStream: vi.fn(),
    enqueue: vi.fn(),
    endStream: vi.fn(),
    stop: vi.fn(),
    isSpeaking: false,
  }),
}));

import { LooperSheetShell, type LooperTurn } from "./LooperSheet";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

const baseProps = {
  open: true,
  onClose: () => {},
  title: "What can I do for you?",
  emptyHint: "Ask me anything.",
  phase: "idle" as const,
  interim: "",
  error: null,
  onMicTap: () => {},
};

describe("LooperSheetShell — personaId prop", () => {
  it("default-prop back-compat: omitted personaId speaks classic", async () => {
    const turns: LooperTurn[] = [];
    const { rerender } = render(<LooperSheetShell {...baseProps} turns={turns} />);

    const withReply: LooperTurn[] = [{ role: "looper", text: "Here's your answer." }];
    await act(async () => {
      rerender(<LooperSheetShell {...baseProps} turns={withReply} />);
    });

    expect(speakMock).toHaveBeenCalledWith("Here's your answer.", "classic");
  });

  it("prop honored: personaId flows through to the spoken voice", async () => {
    const turns: LooperTurn[] = [];
    const { rerender } = render(
      <LooperSheetShell {...baseProps} turns={turns} personaId="hype" />,
    );

    const withReply: LooperTurn[] = [{ role: "looper", text: "Let's go get it." }];
    await act(async () => {
      rerender(<LooperSheetShell {...baseProps} turns={withReply} personaId="hype" />);
    });

    expect(speakMock).toHaveBeenCalledWith("Let's go get it.", "hype");
  });
});
