import { describe, expect, it } from "vitest";
import { isChannelSessionKey, isThreadSessionKey } from "./session-key-utils.js";

describe("isThreadSessionKey", () => {
  it("detects :thread: marker", () => {
    expect(isThreadSessionKey("agent:main:slack:channel:c1:thread:t1")).toBe(true);
  });

  it("detects :topic: marker", () => {
    expect(isThreadSessionKey("agent:main:slack:channel:c1:topic:t1")).toBe(true);
  });

  it("case insensitive", () => {
    expect(isThreadSessionKey("agent:main:slack:channel:c1:Thread:t1")).toBe(true);
  });

  it("returns false for channel keys", () => {
    expect(isThreadSessionKey("agent:main:slack:channel:c1")).toBe(false);
  });

  it("returns false for empty/null", () => {
    expect(isThreadSessionKey("")).toBe(false);
    expect(isThreadSessionKey(null)).toBe(false);
    expect(isThreadSessionKey(undefined)).toBe(false);
  });
});

describe("isChannelSessionKey", () => {
  it("returns true for plain channel keys", () => {
    expect(isChannelSessionKey("agent:main:slack:channel:c1")).toBe(true);
  });

  it("returns false for subagent keys", () => {
    expect(isChannelSessionKey("agent:main:subagent:abc")).toBe(false);
  });

  it("returns false for cron run keys", () => {
    expect(isChannelSessionKey("agent:main:cron:job:run:abc")).toBe(false);
  });

  it("returns false for thread keys", () => {
    expect(isChannelSessionKey("agent:main:slack:channel:c1:thread:t1")).toBe(false);
  });

  it("returns false for empty", () => {
    expect(isChannelSessionKey("")).toBe(false);
  });
});
