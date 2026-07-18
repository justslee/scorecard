// @vitest-environment jsdom
//
// useAuthFlow — proves every transition in the state machine (login-screen-
// visual plan §2): both pivots (silent sign-in/sign-up crossover), the
// error mapping table (§5), the busy re-entrancy guard, and the resend
// cooldown. Mocks @clerk/react (pattern: ClerkTokenBridge.test.tsx) so no
// live Clerk instance is needed — these are the offline, deterministic
// proofs; a live click-through is a separate manual pass (see the plan's §8
// "Spike was CONSTRAINED-GO" note).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { authErrorCopy, useAuthFlow } from "./useAuthFlow";

type ClerkResult = { error: { code: string } | null };
const ok: ClerkResult = { error: null };
const err = (code: string): ClerkResult => ({ error: { code } });

function makeSignIn(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    password: vi.fn(async () => ok),
    finalize: vi.fn(async () => ok),
    emailCode: {
      sendCode: vi.fn(async () => ok),
      verifyCode: vi.fn(async () => ok),
    },
    ...overrides,
  };
}

function makeSignUp(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    password: vi.fn(async () => ok),
    create: vi.fn(async () => ok),
    finalize: vi.fn(async () => ok),
    verifications: {
      sendEmailCode: vi.fn(async () => ok),
      verifyEmailCode: vi.fn(async () => ok),
    },
    ...overrides,
  };
}

const mocks = vi.hoisted(() => ({
  signIn: null as unknown,
  signUp: null as unknown,
}));

vi.mock("@clerk/react", () => ({
  useSignIn: () => ({ signIn: mocks.signIn }),
  useSignUp: () => ({ signUp: mocks.signUp }),
}));

function setClerk(signIn: ReturnType<typeof makeSignIn>, signUp: ReturnType<typeof makeSignUp>) {
  mocks.signIn = signIn;
  mocks.signUp = signUp;
}

describe("authErrorCopy — enumeration hygiene mapping table (§5)", () => {
  it("password path: not-found and wrong-password are byte-identical", () => {
    expect(authErrorCopy("form_identifier_not_found")).toBe(authErrorCopy("form_password_incorrect"));
  });

  it("form_identifier_exists falls back to the same 'don't match' copy", () => {
    expect(authErrorCopy("form_identifier_exists")).toBe(authErrorCopy("form_password_incorrect"));
  });

  it("maps every named code to non-generic, non-raw copy", () => {
    const codes = [
      "form_code_incorrect",
      "verification_expired",
      "verification_failed",
      "too_many_requests",
      "form_password_pwned",
      "form_password_length_too_short",
      "form_password_validation_failed",
      "form_password_size_in_bytes_exceeded",
      "form_param_format_invalid",
    ];
    for (const c of codes) {
      const copy = authErrorCopy(c);
      expect(copy.length).toBeGreaterThan(0);
      expect(copy).not.toContain(c);
    }
  });

  it("verification_expired and verification_failed are byte-identical", () => {
    expect(authErrorCopy("verification_expired")).toBe(authErrorCopy("verification_failed"));
  });

  it("offline maps to the offline copy", () => {
    expect(authErrorCopy("offline")).toMatch(/offline/i);
  });

  it("an unknown code falls back to the generic copy", () => {
    expect(authErrorCopy("totally_made_up_code")).toBe("Something went wrong on our end. Try again.");
  });
});

describe("useAuthFlow — method/email/code step transitions", () => {
  let signIn: ReturnType<typeof makeSignIn>;
  let signUp: ReturnType<typeof makeSignUp>;

  beforeEach(() => {
    signIn = makeSignIn();
    signUp = makeSignUp();
    setClerk(signIn, signUp);
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  });

  it("starts on step 'method' with the seeded intent", () => {
    const { result } = renderHook(() => useAuthFlow("signIn"));
    expect(result.current.state.step).toBe("method");
    expect(result.current.state.intent).toBe("signIn");
    expect(result.current.state.emailMethod).toBe("code");
  });

  it("chooseEmail moves method -> email", () => {
    const { result } = renderHook(() => useAuthFlow("signIn"));
    act(() => result.current.chooseEmail());
    expect(result.current.state.step).toBe("email");
  });

  it("back(): code -> email -> method, clearing error each time", () => {
    const { result } = renderHook(() => useAuthFlow("signIn"));
    act(() => result.current.chooseEmail());
    act(() => {
      // force into a code step + error for the assertion
      result.current.chooseEmail();
    });
    act(() => result.current.back());
    expect(result.current.state.step).toBe("method");
  });

  it("toggleIntent flips signIn <-> signUp and clears error", () => {
    const { result } = renderHook(() => useAuthFlow("signIn"));
    act(() => result.current.toggleIntent());
    expect(result.current.state.intent).toBe("signUp");
    act(() => result.current.toggleIntent());
    expect(result.current.state.intent).toBe("signIn");
  });

  it("toggleEmailMethod flips code <-> password", () => {
    const { result } = renderHook(() => useAuthFlow("signIn"));
    act(() => result.current.toggleEmailMethod());
    expect(result.current.state.emailMethod).toBe("password");
  });
});

describe("useAuthFlow — submitPassword (sign-in)", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  });

  it("signIn.password -> finalize success reaches 'done'", async () => {
    const signIn = makeSignIn();
    const signUp = makeSignUp();
    setClerk(signIn, signUp);
    const { result } = renderHook(() => useAuthFlow("signIn"));

    await act(async () => {
      await result.current.submitPassword("a@b.com", "hunter22");
    });

    expect(signIn.password).toHaveBeenCalledWith({ emailAddress: "a@b.com", password: "hunter22" });
    expect(signIn.finalize).toHaveBeenCalledTimes(1);
    expect(result.current.state.step).toBe("done");
    expect(result.current.state.error).toBeNull();
  });

  it("wrong password maps to the uniform copy and stays on 'email'", async () => {
    const signIn = makeSignIn({ password: vi.fn(async () => err("form_password_incorrect")) });
    const signUp = makeSignUp();
    setClerk(signIn, signUp);
    const { result } = renderHook(() => useAuthFlow("signIn"));
    act(() => result.current.chooseEmail());

    await act(async () => {
      await result.current.submitPassword("a@b.com", "wrong");
    });

    expect(result.current.state.error).toBe(authErrorCopy("form_password_incorrect"));
    expect(result.current.state.step).toBe("email");
    expect(signIn.finalize).not.toHaveBeenCalled();
  });

  it("not-found and wrong-password produce byte-identical error copy on the password path", async () => {
    const notFound = makeSignIn({ password: vi.fn(async () => err("form_identifier_not_found")) });
    setClerk(notFound, makeSignUp());
    const notFoundHook = renderHook(() => useAuthFlow("signIn"));
    await act(async () => {
      await notFoundHook.result.current.submitPassword("a@b.com", "x");
    });

    const wrongPw = makeSignIn({ password: vi.fn(async () => err("form_password_incorrect")) });
    setClerk(wrongPw, makeSignUp());
    const wrongPwHook = renderHook(() => useAuthFlow("signIn"));
    await act(async () => {
      await wrongPwHook.result.current.submitPassword("a@b.com", "x");
    });

    expect(notFoundHook.result.current.state.error).toBe(wrongPwHook.result.current.state.error);
  });
});

describe("useAuthFlow — submitPassword (sign-up) silent pivot", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  });

  it("signUp.password success sends the verification email and moves to 'code' owned by signUp", async () => {
    const signIn = makeSignIn();
    const signUp = makeSignUp();
    setClerk(signIn, signUp);
    const { result } = renderHook(() => useAuthFlow("signUp"));

    await act(async () => {
      await result.current.submitPassword("new@b.com", "hunter22");
    });

    expect(signUp.password).toHaveBeenCalledWith({ emailAddress: "new@b.com", password: "hunter22" });
    expect(signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(1);
    expect(result.current.state.step).toBe("code");
    expect(result.current.state.flowOwner).toBe("signUp");
  });

  it("form_identifier_exists silently pivots to signIn.password and succeeds", async () => {
    const signIn = makeSignIn();
    const signUp = makeSignUp({ password: vi.fn(async () => err("form_identifier_exists")) });
    setClerk(signIn, signUp);
    const { result } = renderHook(() => useAuthFlow("signUp"));

    await act(async () => {
      await result.current.submitPassword("existing@b.com", "hunter22");
    });

    expect(signIn.password).toHaveBeenCalledWith({ emailAddress: "existing@b.com", password: "hunter22" });
    expect(signIn.finalize).toHaveBeenCalledTimes(1);
    expect(result.current.state.step).toBe("done");
    // Never surfaced the raw pivot trigger code.
    expect(result.current.state.error).toBeNull();
  });

  it("form_identifier_exists pivot that also fails surfaces the uniform 'don't match' copy — no enumeration leak", async () => {
    const signIn = makeSignIn({ password: vi.fn(async () => err("form_password_incorrect")) });
    const signUp = makeSignUp({ password: vi.fn(async () => err("form_identifier_exists")) });
    setClerk(signIn, signUp);
    const { result } = renderHook(() => useAuthFlow("signUp"));
    act(() => result.current.chooseEmail());

    await act(async () => {
      await result.current.submitPassword("existing@b.com", "wrong");
    });

    expect(result.current.state.error).toBe("That email and password don't match.");
    expect(result.current.state.step).toBe("email");
  });
});

describe("useAuthFlow — sendCode (email-code) both pivots produce identical screens", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  });

  it("signIn.emailCode.sendCode success -> step 'code' owned by signIn", async () => {
    const signIn = makeSignIn();
    const signUp = makeSignUp();
    setClerk(signIn, signUp);
    const { result } = renderHook(() => useAuthFlow("signIn"));

    await act(async () => {
      await result.current.sendCode("a@b.com");
    });

    expect(signIn.emailCode.sendCode).toHaveBeenCalledWith({ emailAddress: "a@b.com" });
    expect(result.current.state.step).toBe("code");
    expect(result.current.state.flowOwner).toBe("signIn");
  });

  it("form_identifier_not_found silently pivots to signUp.create + sendEmailCode — same 'code' step", async () => {
    const signIn = makeSignIn({
      emailCode: { sendCode: vi.fn(async () => err("form_identifier_not_found")), verifyCode: vi.fn(async () => ok) },
    });
    const signUp = makeSignUp();
    setClerk(signIn, signUp);
    const { result } = renderHook(() => useAuthFlow("signIn"));

    await act(async () => {
      await result.current.sendCode("brand-new@b.com");
    });

    expect(signUp.create).toHaveBeenCalledWith({ emailAddress: "brand-new@b.com" });
    expect(signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(1);
    expect(result.current.state.step).toBe("code");
    expect(result.current.state.flowOwner).toBe("signUp");
    expect(result.current.state.error).toBeNull();
  });

  it("existing account vs brand-new account produce a byte-identical screen (step + owner-invisible to the user)", async () => {
    // Existing account: signIn.emailCode.sendCode succeeds directly.
    const existingSignIn = makeSignIn();
    setClerk(existingSignIn, makeSignUp());
    const existingHook = renderHook(() => useAuthFlow("signIn"));
    await act(async () => {
      await existingHook.result.current.sendCode("existing@b.com");
    });

    // Brand-new account: not_found -> pivots to signUp.create.
    const newSignIn = makeSignIn({
      emailCode: { sendCode: vi.fn(async () => err("form_identifier_not_found")), verifyCode: vi.fn(async () => ok) },
    });
    setClerk(newSignIn, makeSignUp());
    const newHook = renderHook(() => useAuthFlow("signIn"));
    await act(async () => {
      await newHook.result.current.sendCode("brand-new@b.com");
    });

    expect(existingHook.result.current.state.step).toBe(newHook.result.current.state.step);
    expect(existingHook.result.current.state.error).toBe(newHook.result.current.state.error);
  });

  it("signUp intent + form_identifier_exists pivots to signIn.emailCode.sendCode", async () => {
    const signIn = makeSignIn();
    const signUp = makeSignUp({ create: vi.fn(async () => err("form_identifier_exists")) });
    setClerk(signIn, signUp);
    const { result } = renderHook(() => useAuthFlow("signUp"));

    await act(async () => {
      await result.current.sendCode("existing@b.com");
    });

    expect(signIn.emailCode.sendCode).toHaveBeenCalledWith({ emailAddress: "existing@b.com" });
    expect(result.current.state.step).toBe("code");
    expect(result.current.state.flowOwner).toBe("signIn");
  });
});

describe("useAuthFlow — verifyCode", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  });

  async function toCodeStep(intent: "signIn" | "signUp", signIn: ReturnType<typeof makeSignIn>, signUp: ReturnType<typeof makeSignUp>) {
    setClerk(signIn, signUp);
    const hook = renderHook(() => useAuthFlow(intent));
    await act(async () => {
      await hook.result.current.sendCode("a@b.com");
    });
    return hook;
  }

  it("flowOwner signIn: verifyCode + finalize -> done", async () => {
    const signIn = makeSignIn();
    const hook = await toCodeStep("signIn", signIn, makeSignUp());

    await act(async () => {
      await hook.result.current.verifyCode("424242");
    });

    expect(signIn.emailCode.verifyCode).toHaveBeenCalledWith({ code: "424242" });
    expect(signIn.finalize).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.step).toBe("done");
  });

  it("flowOwner signUp: verifyEmailCode + finalize -> done", async () => {
    // Drive flowOwner to "signUp" deterministically via the sign-in
    // not-found -> sign-up pivot (sendCode's own pivot, proven above).
    const signIn = makeSignIn({
      emailCode: { sendCode: vi.fn(async () => err("form_identifier_not_found")), verifyCode: vi.fn(async () => ok) },
    });
    const signUp = makeSignUp();
    const hook = await toCodeStep("signIn", signIn, signUp);
    expect(hook.result.current.state.flowOwner).toBe("signUp");

    await act(async () => {
      await hook.result.current.verifyCode("424242");
    });

    expect(signUp.verifications.verifyEmailCode).toHaveBeenCalledWith({ code: "424242" });
    expect(signUp.finalize).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.step).toBe("done");
  });

  it("wrong code maps to the uniform copy and stays on 'code'", async () => {
    const signIn = makeSignIn({
      emailCode: { sendCode: vi.fn(async () => ok), verifyCode: vi.fn(async () => err("form_code_incorrect")) },
    });
    const hook = await toCodeStep("signIn", signIn, makeSignUp());

    await act(async () => {
      await hook.result.current.verifyCode("000000");
    });

    expect(hook.result.current.state.error).toBe(authErrorCopy("form_code_incorrect"));
    expect(hook.result.current.state.step).toBe("code");
    expect(signIn.finalize).not.toHaveBeenCalled();
  });
});

describe("useAuthFlow — resendCode cooldown", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  });

  it("no-ops before the 30s cooldown elapses", async () => {
    const signIn = makeSignIn();
    setClerk(signIn, makeSignUp());
    const { result } = renderHook(() => useAuthFlow("signIn"));
    await act(async () => {
      await result.current.sendCode("a@b.com");
    });
    expect(signIn.emailCode.sendCode).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.resendCode();
    });
    // Still 1 — cooldown blocks the resend.
    expect(signIn.emailCode.sendCode).toHaveBeenCalledTimes(1);
  });

  it("resends once the cooldown has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const signIn = makeSignIn();
      setClerk(signIn, makeSignUp());
      const { result } = renderHook(() => useAuthFlow("signIn"));
      await act(async () => {
        await result.current.sendCode("a@b.com");
      });
      expect(signIn.emailCode.sendCode).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(30_001);
      });

      await act(async () => {
        await result.current.resendCode();
      });
      expect(signIn.emailCode.sendCode).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useAuthFlow — busy re-entrancy guard", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  });

  it("a second submitPassword call while the first is in flight is a no-op", async () => {
    let resolvePassword!: (v: ClerkResult) => void;
    const passwordPromise = new Promise<ClerkResult>((resolve) => {
      resolvePassword = resolve;
    });
    const signIn = makeSignIn({ password: vi.fn(() => passwordPromise) });
    setClerk(signIn, makeSignUp());
    const { result } = renderHook(() => useAuthFlow("signIn"));

    let firstCall: Promise<void>;
    act(() => {
      firstCall = result.current.submitPassword("a@b.com", "hunter22");
    });
    expect(result.current.state.busy).toBe(true);

    // Second call while busy — must no-op (password() still called once).
    await act(async () => {
      await result.current.submitPassword("a@b.com", "hunter22");
    });
    expect(signIn.password).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePassword(ok);
      await firstCall;
    });
    expect(result.current.state.busy).toBe(false);
  });
});

describe("useAuthFlow — offline handling", () => {
  it("pre-checks navigator.onLine and never calls Clerk when offline", async () => {
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    const signIn = makeSignIn();
    setClerk(signIn, makeSignUp());
    const { result } = renderHook(() => useAuthFlow("signIn"));

    await act(async () => {
      await result.current.submitPassword("a@b.com", "hunter22");
    });

    expect(signIn.password).not.toHaveBeenCalled();
    expect(result.current.state.error).toBe(authErrorCopy("offline"));
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  });

  it("a thrown transport error is caught and mapped to the offline copy", async () => {
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    const signIn = makeSignIn({ password: vi.fn(async () => { throw new Error("network down"); }) });
    setClerk(signIn, makeSignUp());
    const { result } = renderHook(() => useAuthFlow("signIn"));

    await act(async () => {
      await result.current.submitPassword("a@b.com", "hunter22");
    });

    expect(result.current.state.error).toBe(authErrorCopy("offline"));
    expect(result.current.state.busy).toBe(false);
  });
});
