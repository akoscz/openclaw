import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "./types.js";
import { pruneStaleEntries, resolveSessionTTL } from "./store.js";

// Mock loadConfig so resolveMaintenanceConfig() never reads a real openclaw.json.
vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

// ---------------------------------------------------------------------------
// resolveSessionTTL
// ---------------------------------------------------------------------------

describe("resolveSessionTTL", () => {
  it("returns defaultMs when no rules provided", () => {
    expect(resolveSessionTTL("agent:main:slack:channel:c1", undefined, DAY_MS)).toBe(DAY_MS);
  });

  it("returns defaultMs when key type has no matching rule", () => {
    expect(resolveSessionTTL("agent:main:slack:channel:c1", { subagent: "1h" }, DAY_MS)).toBe(
      DAY_MS,
    );
  });

  it("applies subagent rule", () => {
    expect(resolveSessionTTL("agent:main:subagent:abc123", { subagent: "2h" }, DAY_MS)).toBe(
      2 * HOUR_MS,
    );
  });

  it("applies cronRun rule", () => {
    expect(
      resolveSessionTTL("agent:main:cron:daily-check:run:abc", { cronRun: "4h" }, DAY_MS),
    ).toBe(4 * HOUR_MS);
  });

  it("applies thread rule", () => {
    expect(
      resolveSessionTTL("agent:main:slack:channel:c1:thread:t1", { thread: "48h" }, DAY_MS),
    ).toBe(48 * HOUR_MS);
  });

  it("applies channel rule (fallback type)", () => {
    expect(resolveSessionTTL("agent:main:slack:channel:c1", { channel: "7d" }, DAY_MS)).toBe(
      7 * DAY_MS,
    );
  });

  it("returns null when type is exempted (false)", () => {
    expect(resolveSessionTTL("agent:main:subagent:abc", { subagent: false }, DAY_MS)).toBeNull();
  });

  it("returns defaultMs on invalid duration string", () => {
    expect(
      resolveSessionTTL("agent:main:subagent:abc", { subagent: "not-a-duration" }, DAY_MS),
    ).toBe(DAY_MS);
  });

  it("accepts numeric ms values", () => {
    expect(resolveSessionTTL("agent:main:subagent:abc", { subagent: 3600000 }, DAY_MS)).toBe(
      3600000,
    );
  });
});

// ---------------------------------------------------------------------------
// pruneStaleEntries with pruneRules
// ---------------------------------------------------------------------------

describe("pruneStaleEntries with pruneRules", () => {
  it("subagent sessions pruned at shorter TTL than default", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:old": makeEntry(now - 2 * HOUR_MS),
      "agent:main:subagent:fresh": makeEntry(now - 30 * 60 * 1000),
      "agent:main:slack:channel:c1": makeEntry(now - 2 * HOUR_MS),
    };

    const pruned = pruneStaleEntries(store, 30 * DAY_MS, {
      pruneRules: { subagent: "1h" },
    });

    expect(pruned).toBe(1);
    expect(store["agent:main:subagent:old"]).toBeUndefined();
    expect(store["agent:main:subagent:fresh"]).toBeDefined();
    expect(store["agent:main:slack:channel:c1"]).toBeDefined();
  });

  it("channel sessions exempted with false", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:slack:channel:c1": makeEntry(now - 60 * DAY_MS),
      "agent:main:subagent:old": makeEntry(now - 60 * DAY_MS),
    };

    const pruned = pruneStaleEntries(store, 30 * DAY_MS, {
      pruneRules: { channel: false },
    });

    expect(pruned).toBe(1);
    expect(store["agent:main:slack:channel:c1"]).toBeDefined(); // exempt
    expect(store["agent:main:subagent:old"]).toBeUndefined(); // pruned by default
  });

  it("thread sessions get their own TTL", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:slack:channel:c1:thread:t1": makeEntry(now - 49 * HOUR_MS),
      "agent:main:slack:channel:c1:thread:t2": makeEntry(now - 47 * HOUR_MS),
    };

    const pruned = pruneStaleEntries(store, 30 * DAY_MS, {
      pruneRules: { thread: "48h" },
    });

    expect(pruned).toBe(1);
    expect(store["agent:main:slack:channel:c1:thread:t1"]).toBeUndefined();
    expect(store["agent:main:slack:channel:c1:thread:t2"]).toBeDefined();
  });

  it("cron run sessions use cronRun rule", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job1:run:abc": makeEntry(now - 3 * HOUR_MS),
      "agent:main:cron:job1:run:def": makeEntry(now - 1 * HOUR_MS),
    };

    const pruned = pruneStaleEntries(store, 30 * DAY_MS, {
      pruneRules: { cronRun: "2h" },
    });

    expect(pruned).toBe(1);
    expect(store["agent:main:cron:job1:run:abc"]).toBeUndefined();
    expect(store["agent:main:cron:job1:run:def"]).toBeDefined();
  });

  it("onPruned callback fires for each pruned entry", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:a": makeEntry(now - 2 * HOUR_MS),
      "agent:main:subagent:b": makeEntry(now - 2 * HOUR_MS),
    };

    const pruned: string[] = [];
    pruneStaleEntries(store, 30 * DAY_MS, {
      pruneRules: { subagent: "1h" },
      onPruned: ({ key }) => pruned.push(key),
    });

    expect(pruned).toHaveLength(2);
    expect(pruned).toContain("agent:main:subagent:a");
    expect(pruned).toContain("agent:main:subagent:b");
  });

  it("mixed types with different TTLs", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:x": makeEntry(now - 2 * HOUR_MS), // subagent 1h → prune
      "agent:main:cron:j:run:r": makeEntry(now - 5 * HOUR_MS), // cronRun 4h → prune
      "agent:main:slack:channel:c:thread:t": makeEntry(now - 25 * HOUR_MS), // thread 48h → keep
      "agent:main:slack:channel:c": makeEntry(now - 60 * DAY_MS), // channel false → keep
    };

    const pruned = pruneStaleEntries(store, 30 * DAY_MS, {
      pruneRules: { subagent: "1h", cronRun: "4h", thread: "48h", channel: false },
    });

    expect(pruned).toBe(2);
    expect(store["agent:main:subagent:x"]).toBeUndefined();
    expect(store["agent:main:cron:j:run:r"]).toBeUndefined();
    expect(store["agent:main:slack:channel:c:thread:t"]).toBeDefined();
    expect(store["agent:main:slack:channel:c"]).toBeDefined();
  });
});
