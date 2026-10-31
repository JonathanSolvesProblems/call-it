import { describe, expect, it } from "vitest";
import { selectBetMode } from "../src/config.js";

describe("live bet mode selection", () => {
  it.each(["", "affiliate", "partner"] as const)("uses chat mode for broadcaster_type=%s", (broadcasterType) => {
    expect(selectBetMode(broadcasterType)).toBe("chat");
  });
});
