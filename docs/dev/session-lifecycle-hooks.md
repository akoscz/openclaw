# Session Lifecycle Hooks

> **Branch:** `feature/session-hooks` (on fork `akoscz/openclaw`)  
> **Status:** Infrastructure complete, memory plugin not yet built  
> **Last updated:** 2026-02-13

## Overview

OpenClaw sessions follow an Android Activity-inspired lifecycle:

```
session_start → [session_suspend → session_resume]* → session_end
```

Every session gets exactly one `session_start` and one `session_end`. It can be suspended/resumed any number of times in between (e.g., gateway restarts).

## Lifecycle Diagram

```
                    ┌─────────────────────────────────────┐
                    │           ACTIVE SESSION             │
                    │                                       │
  /new or first  ──►│  session_start                        │
  message            │    │                                  │
                    │    ▼                                  │
                    │  messages ◄──► before/after_compaction│
                    │    │                                  │
                    │    │  gateway shutdown                │
                    │    ▼                                  │
                    │  session_suspend ──► persisted state  │
                    │                        │              │
                    │    gateway restart      │              │
                    │    + message arrives    │              │
                    │                        ▼              │
                    │  session_resume ◄── load state        │
                    │    │                                  │
                    │    ▼                                  │
                    │  messages continue...                 │
                    │    │                                  │
                    └────┼──────────────────────────────────┘
                         │
        /new, idle timeout, or prune
                         │
                         ▼
                    session_end (final)
```

## Hook Reference

### `session_start`

Fires when a **brand new** session is created.

| Field         | Type      | Description                          |
| ------------- | --------- | ------------------------------------ |
| `sessionId`   | `string`  | New session ID                       |
| `resumedFrom` | `string?` | Previous session ID if replacing one |

**Context:** `{ sessionId, agentId }`

**When:** `/new`, `/reset`, idle timeout expiry (on next message), first-ever message for a session key.

---

### `session_resume`

Fires when an existing session is **reactivated after a gateway restart**.

| Field            | Type      | Description                     |
| ---------------- | --------- | ------------------------------- |
| `sessionId`      | `string`  | Session ID                      |
| `suspendedForMs` | `number?` | Time between suspend and resume |

**Context:** `{ sessionId, agentId }`

**When:** First message arrives for a session that has `suspendedAt` set (stamped during previous gateway shutdown). Only fires once per restart — `suspendedAt` is cleared after resume.

**Detection mechanism:** `suspendedAt` field on `SessionEntry` is set during `session_suspend` and cleared when the session entry is rebuilt on next message.

---

### `session_suspend`

Fires for **all active sessions** when the gateway is shutting down.

| Field          | Type      | Description                           |
| -------------- | --------- | ------------------------------------- |
| `sessionId`    | `string`  | Session ID                            |
| `messageCount` | `number`  | User/assistant messages in transcript |
| `durationMs`   | `number?` | Time since `createdAt`                |
| `reason`       | `string?` | Why (e.g., "gateway stopping")        |

**Context:** `{ sessionId, agentId }`

**When:** Gateway `close()`, after `gateway_stop` hook fires. Also stamps `suspendedAt` on all session entries for resume detection.

**Important:** This does NOT mean the session is over. It may be resumed after restart.

---

### `session_end`

Fires when a session is **truly over** and won't come back.

| Field          | Type      | Description                           |
| -------------- | --------- | ------------------------------------- |
| `sessionId`    | `string`  | Session ID                            |
| `messageCount` | `number`  | User/assistant messages in transcript |
| `durationMs`   | `number?` | Time since `createdAt`                |

**Context:** `{ sessionId, agentId }`

**When:**

1. A new session **replaces** an old one (via `/new`, `/reset`, or idle timeout on next message)
2. A session is **pruned** by `pruneStaleEntries` during store maintenance (default: 30 days after last `updatedAt`)

**Not fired:** On gateway shutdown (that's `session_suspend`), or for sessions that just idle without replacement.

---

### `before_compaction` / `after_compaction`

Fires during auto-compaction (context window management) within an active agent run.

| Field            | Type     | Description                               |
| ---------------- | -------- | ----------------------------------------- |
| `messageCount`   | `number` | Messages in session at time of compaction |
| `compactedCount` | `number` | (after only) Number of compactions so far |

**Context:** `{ agentId, sessionKey, workspaceDir }`

**When:** Agent hits context window limit and compresses older messages. `after_compaction` only fires on successful compaction (not on retry).

---

### `message_received`

Fires for every inbound message before routing.

| Field       | Type      | Description               |
| ----------- | --------- | ------------------------- |
| `from`      | `string`  | Sender identifier         |
| `content`   | `string`  | Message text              |
| `timestamp` | `number?` | Message timestamp         |
| `metadata`  | `object`  | Rich metadata (see below) |

**Metadata fields:** `to`, `provider`, `surface`, `threadId`, `originatingChannel`, `originatingTo`, `messageId`, `senderId`, `senderName`, `senderUsername`, `senderE164`

**Context:** `{ channelId, accountId, conversationId }`

**When:** Every inbound message, before command processing or agent invocation. Fire-and-forget (cannot modify or cancel the message).

## SessionEntry Fields (added)

| Field         | Type      | Description                               |
| ------------- | --------- | ----------------------------------------- |
| `createdAt`   | `number?` | Timestamp when session was created        |
| `suspendedAt` | `number?` | Timestamp when session was last suspended |

These are optional for backwards compatibility — existing sessions won't have them until their next new session creation.

## File Locations

| File                                                     | What it does                                        |
| -------------------------------------------------------- | --------------------------------------------------- |
| `src/plugins/types.ts`                                   | Hook name enum, event types, handler map            |
| `src/plugins/hooks.ts`                                   | Hook runner methods (runSessionStart, etc.)         |
| `src/auto-reply/reply/session.ts`                        | Fires session_start, session_resume, session_end    |
| `src/gateway/server.impl.ts`                             | Fires session_suspend on shutdown                   |
| `src/config/sessions/types.ts`                           | SessionEntry with createdAt, suspendedAt            |
| `src/config/sessions/store.ts`                           | onSessionPruned callback, pruneStaleEntries         |
| `src/infra/session-message-count.ts`                     | countTranscriptMessages utility                     |
| `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts` | Compaction hooks with agent context                 |
| `src/agents/pi-embedded-subscribe.types.ts`              | agentId/sessionKey/workspaceDir on subscribe params |
| `src/agents/pi-embedded-runner/run/attempt.ts`           | Passes agent context to subscription                |

## Plugin Registration Example

```typescript
// In a plugin's register/activate function:
api.on("session_start", async (event, ctx) => {
  console.log(`New session: ${event.sessionId}, agent: ${ctx.agentId}`);
  // Load relevant memories, warm caches, etc.
});

api.on("session_resume", async (event, ctx) => {
  console.log(`Resumed after ${event.suspendedForMs}ms`);
  // Reload context, inject "you were away" summary
});

api.on("session_suspend", async (event, ctx) => {
  console.log(`Suspending: ${event.messageCount} messages, ${event.durationMs}ms`);
  // Flush working memory, save conversation summary
});

api.on("session_end", async (event, ctx) => {
  console.log(`Session over: ${event.messageCount} messages`);
  // Final memory consolidation, archive
});

api.on("after_compaction", async (event, ctx) => {
  console.log(`Compacted in session ${ctx.sessionKey}`);
  // Extract important details before they're compressed away
});
```

## Known Gaps / Future Work

1. **Sessions that idle but don't get pruned** — between idle timeout and prune threshold (default 30 days), `session_end` won't fire until either a new message triggers replacement or the prune sweep runs during any `updateSessionStore` call.

2. **No `session_end` on crash** — if the gateway crashes without clean shutdown, `session_suspend` never fires. Sessions will either resume or eventually be pruned.

3. **`before_agent_start` for memory injection** — use `prependContext` in the return value to inject memories into the system prompt. This is the primary mechanism for a memory plugin to surface relevant context.

4. **Internal hooks vs plugin hooks** — the older internal hook system (`command:new`, `command:stop`, `gateway:startup`) is separate from the plugin hooks described here. Workspace JS hook handlers loaded from `hooks/` directories use the internal system and cannot listen for plugin hook events.
