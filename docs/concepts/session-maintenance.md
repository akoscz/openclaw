---
title: "Session Maintenance"
summary: "Automatic pruning, capping, and rotation of the session store"
read_when:
  - You want to control how old sessions are cleaned up
  - You need different TTLs for different session types
  - You're migrating from cron.sessionRetention
---

# Session Maintenance

Session maintenance automatically manages the `sessions.json` store by pruning stale entries, capping the total count, and rotating the file when it grows too large.

## Configuration

```json5
{
  session: {
    maintenance: {
      mode: "enforce", // "warn" (default) or "enforce"
      pruneAfter: "30d", // global default TTL
      maxEntries: 500, // cap total session entries
      rotateBytes: "10mb", // rotate sessions.json when over this size
      pruneRules: {
        // per-type TTL overrides
        subagent: "1h",
        cronRun: "2h",
        thread: "48h",
        channel: false, // false = never prune
      },
    },
  },
}
```

## Per-Session-Type TTL (`pruneRules`)

Different session types have different lifecycle expectations. Sub-agent sessions are ephemeral and can be pruned quickly. Channel sessions may represent long-running conversations.

| Key        | Matches                                           | Example TTL |
| ---------- | ------------------------------------------------- | ----------- |
| `subagent` | `agent:*:subagent:*`                              | `"1h"`      |
| `cronRun`  | `agent:*:cron:*:run:*`                            | `"2h"`      |
| `thread`   | Keys containing `:thread:` or `:topic:`           | `"48h"`     |
| `channel`  | Everything else (not subagent, cron, thread, ACP) | `false`     |

Each value can be:

- A **duration string**: `"1h"`, `"2d"`, `"30m"`, etc.
- A **number** (milliseconds)
- **`false`** to exempt that type from pruning entirely

When no rule matches a session key, the global `pruneAfter` TTL applies.

## Transcript Archiving

When a session is pruned, its transcript JSONL file is automatically archived (renamed to `*.deleted.<timestamp>`) so it doesn't remain orphaned on disk. This matches the behavior of manually deleting a session.

## Migration from `cron.sessionRetention`

The `cron.sessionRetention` config is **deprecated**. It is automatically migrated to `pruneRules.cronRun` at runtime. If both are set, `pruneRules.cronRun` takes precedence.

Before:

```json5
{
  cron: { sessionRetention: "6h" },
}
```

After:

```json5
{
  session: {
    maintenance: {
      pruneRules: { cronRun: "6h" },
    },
  },
}
```

## Mode

- **`warn`** (default): logs warnings when sessions would be pruned but doesn't delete them.
- **`enforce`**: actively prunes stale entries on every session store write.

## How It Works

Session maintenance runs as part of `saveSessionStore()`:

1. **Prune stale entries**: removes entries where `updatedAt` is older than the applicable TTL (per-type or global). Fires `session_end` hooks and archives transcripts for each pruned entry.
2. **Cap entry count**: keeps the N most recently updated entries, evicts the rest.
3. **Rotate file**: if `sessions.json` exceeds `rotateBytes`, renames it to a `.bak` file.
