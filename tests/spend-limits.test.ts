import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCallReporter, positiveLimit, scheduleForceLiveLimit } from "../src/agent/spend-limits.js";

afterEach(() => { vi.useRealTimers(); });

describe("spend limits", () => {
  it("uses a default and validates configured positive limits", () => {
    expect(positiveLimit(undefined, 600, "CALLIT_MAX_MODEL_CALLS")).toBe(600);
    expect(positiveLimit("0.5", 30, "CALLIT_MAX_MINUTES", false)).toBe(0.5);
    expect(() => positiveLimit("0", 600, "CALLIT_MAX_MODEL_CALLS")).toThrow("CALLIT_MAX_MODEL_CALLS must be a positive integer.");
  });

  it("schedules the minute limit only for force-live sessions", () => {
    vi.useFakeTimers();
    const limitedStop = vi.fn();
    const cancelLimited = scheduleForceLiveLimit(true, 0.001, limitedStop);
    const normalStop = vi.fn();
    scheduleForceLiveLimit(false, 0.001, normalStop);
    vi.advanceTimersByTime(60);
    expect(limitedStop).toHaveBeenCalledOnce();
    expect(normalStop).not.toHaveBeenCalled();
    cancelLimited();
  });

  it("reports usage every 50 model calls", () => {
    const log = vi.fn();
    const reporter = new ModelCallReporter(log);
    for (let call = 0; call < 50; call += 1) {
      reporter.callStarted();
      reporter.recordUsage({ inputTokens: 12, outputTokens: 3 });
    }
    expect(reporter.calls).toBe(50);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("Model usage: 50 calls, 600 input tokens, 150 output tokens.");
  });
});
