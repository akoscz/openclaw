/**
 * Test: session lifecycle hook wiring (start, resume, suspend, end)
 *
 * Tests the hook runner methods directly since session init is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("session hook runner methods", () => {
  it("runSessionStart invokes registered session_start hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "session_start", handler }]);
    const runner = createHookRunner(registry);

    await runner.runSessionStart(
      { sessionId: "abc-123", resumedFrom: "old-session" },
      { sessionId: "abc-123", agentId: "main" },
    );

    expect(handler).toHaveBeenCalledWith(
      { sessionId: "abc-123", resumedFrom: "old-session" },
      { sessionId: "abc-123", agentId: "main" },
    );
  });

  it("runSessionEnd invokes registered session_end hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "session_end", handler }]);
    const runner = createHookRunner(registry);

    await runner.runSessionEnd(
      { sessionId: "abc-123", messageCount: 42 },
      { sessionId: "abc-123", agentId: "main" },
    );

    expect(handler).toHaveBeenCalledWith(
      { sessionId: "abc-123", messageCount: 42 },
      { sessionId: "abc-123", agentId: "main" },
    );
  });

  it("runSessionResume invokes registered session_resume hooks", async () => {
    const handler = vi.fn();
    const registry = createMockRegistry([{ hookName: "session_resume", handler }]);
    const runner = createHookRunner(registry);

    await runner.runSessionResume(
      { sessionId: "abc-123", suspendedForMs: 5000 },
      { sessionId: "abc-123", agentId: "main" },
    );

    expect(handler).toHaveBeenCalledWith(
      { sessionId: "abc-123", suspendedForMs: 5000 },
      { sessionId: "abc-123", agentId: "main" },
    );
  });

  it("runSessionSuspend invokes registered session_suspend hooks", async () => {
    const handler = vi.fn();
    const registry = createMockRegistry([{ hookName: "session_suspend", handler }]);
    const runner = createHookRunner(registry);

    await runner.runSessionSuspend(
      { sessionId: "abc-123", messageCount: 10, durationMs: 60000, reason: "gateway stopping" },
      { sessionId: "abc-123", agentId: "main" },
    );

    expect(handler).toHaveBeenCalledWith(
      { sessionId: "abc-123", messageCount: 10, durationMs: 60000, reason: "gateway stopping" },
      { sessionId: "abc-123", agentId: "main" },
    );
  });

  it("hasHooks returns true for registered session hooks", () => {
    const registry = createMockPluginRegistry([{ hookName: "session_start", handler: vi.fn() }]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("session_start")).toBe(true);
    expect(runner.hasHooks("session_end")).toBe(false);
  });
});
