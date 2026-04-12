/**
 * Fires `session_suspend` hook for every active session when the gateway stops.
 * This gives plugins (e.g. ren-plugin) a chance to snapshot per-session state
 * before the process exits.
 */

import { listAgentIds } from "../agents/agent-scope.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildSessionSuspendHookPayload } from "../auto-reply/reply/session-hooks.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import { resolveStorePath } from "../config/sessions/paths.js";

const log = createSubsystemLogger("plugins");

export async function runGlobalSessionSuspendOnShutdown(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("session_suspend")) {
    return;
  }

  const env = params.env ?? process.env;
  const cfg = params.cfg;
  const now = Date.now();

  const seenStorePaths = new Set<string>();
  const suspendCalls: Promise<void>[] = [];

  for (const agentId of listAgentIds(cfg)) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId, env });
    if (seenStorePaths.has(storePath)) {
      continue;
    }
    seenStorePaths.add(storePath);

    let store: Record<string, import("../config/sessions/types.js").SessionEntry>;
    try {
      store = loadSessionStore(storePath, { skipCache: true });
    } catch (err) {
      log.warn(`session_suspend on shutdown: failed to load store ${storePath}: ${String(err)}`);
      continue;
    }

    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry?.sessionId) {
        continue;
      }
      const durationMs =
        typeof entry.updatedAt === "number" && entry.updatedAt > 0
          ? Math.max(0, now - entry.updatedAt)
          : undefined;
      const payload = buildSessionSuspendHookPayload({
        sessionId: entry.sessionId,
        sessionKey,
        cfg,
        messageCount: 0,
        durationMs,
        reason: "gateway_shutdown",
      });
      suspendCalls.push(
        hookRunner
          .runSessionSuspend(payload.event, payload.context)
          .catch((err) => log.warn(`session_suspend hook failed: ${String(err)}`)),
      );
    }
  }

  if (suspendCalls.length > 0) {
    await Promise.allSettled(suspendCalls);
  }
}
