import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildSessionEndHookPayload,
  buildSessionResumeHookPayload,
  buildSessionStartHookPayload,
  buildSessionSuspendHookPayload,
} from "./session-hooks.js";

const cfg = {} as OpenClawConfig;

describe("session hook payload builders", () => {
  it("session_start includes prompt when provided", () => {
    const { event } = buildSessionStartHookPayload({
      sessionId: "sid-1",
      sessionKey: "key-1",
      cfg,
      prompt: "hello ren",
    });
    expect(event.prompt).toBe("hello ren");
    expect(event.sessionId).toBe("sid-1");
  });

  it("session_start prompt is undefined when omitted", () => {
    const { event } = buildSessionStartHookPayload({
      sessionId: "sid-1",
      sessionKey: "key-1",
      cfg,
    });
    expect(event.prompt).toBeUndefined();
  });

  it("session_suspend carries messageCount, duration, and reason", () => {
    const { event, context } = buildSessionSuspendHookPayload({
      sessionId: "sid-2",
      sessionKey: "key-2",
      cfg,
      messageCount: 17,
      durationMs: 30 * 60 * 1000,
      reason: "idle",
    });
    expect(event.messageCount).toBe(17);
    expect(event.durationMs).toBe(30 * 60 * 1000);
    expect(event.reason).toBe("idle");
    expect(context.sessionKey).toBe("key-2");
  });

  it("session_suspend accepts gateway_shutdown reason", () => {
    const { event } = buildSessionSuspendHookPayload({
      sessionId: "sid-3",
      sessionKey: "key-3",
      cfg,
      messageCount: 0,
      reason: "gateway_shutdown",
    });
    expect(event.reason).toBe("gateway_shutdown");
    expect(event.durationMs).toBeUndefined();
  });

  it("session_resume carries suspendedForMs", () => {
    const { event } = buildSessionResumeHookPayload({
      sessionId: "sid-4",
      sessionKey: "key-4",
      cfg,
      suspendedForMs: 45 * 60 * 1000,
    });
    expect(event.suspendedForMs).toBe(45 * 60 * 1000);
  });

  it("session_end still works (regression check)", () => {
    const { event } = buildSessionEndHookPayload({
      sessionId: "sid-5",
      sessionKey: "key-5",
      cfg,
      messageCount: 5,
      durationMs: 60_000,
      reason: "reset",
    });
    expect(event.messageCount).toBe(5);
    expect(event.reason).toBe("reset");
  });
});
