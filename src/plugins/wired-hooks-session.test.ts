/**
 * Test: session lifecycle hook wiring (start, resume, suspend, end)
 *
 * Tests the hook runner methods directly since session init is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";
import type {
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
} from "./types.js";

async function expectSessionHookCall(params: {
  hookName: "session_start" | "session_end";
  event: PluginHookSessionStartEvent | PluginHookSessionEndEvent;
  sessionCtx: PluginHookSessionContext & { sessionKey: string; agentId: string };
}) {
  const handler = vi.fn();
  const { runner } = createHookRunnerWithRegistry([{ hookName: params.hookName, handler }]);

  if (params.hookName === "session_start") {
    await runner.runSessionStart(params.event as PluginHookSessionStartEvent, params.sessionCtx);
  } else {
    await runner.runSessionEnd(params.event as PluginHookSessionEndEvent, params.sessionCtx);
  }

  expect(handler).toHaveBeenCalledWith(params.event, params.sessionCtx);
}

describe("session hook runner methods", () => {
  const sessionCtx = { sessionId: "abc-123", sessionKey: "agent:main:abc", agentId: "main" };

  it.each([
    {
      name: "runSessionStart invokes registered session_start hooks",
      hookName: "session_start" as const,
      event: { sessionId: "abc-123", sessionKey: "agent:main:abc", resumedFrom: "old-session" },
    },
    {
      name: "runSessionEnd invokes registered session_end hooks",
      hookName: "session_end" as const,
      event: { sessionId: "abc-123", sessionKey: "agent:main:abc", messageCount: 42 },
    },
  ] as const)("$name", async ({ hookName, event }) => {
    await expectSessionHookCall({ hookName, event, sessionCtx });
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
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "session_start", handler: vi.fn() },
    ]);

    expect(runner.hasHooks("session_start")).toBe(true);
    expect(runner.hasHooks("session_end")).toBe(false);
  });
});
