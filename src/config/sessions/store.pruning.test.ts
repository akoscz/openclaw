import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { capEntryCount, clearSessionStoreCacheForTest, loadSessionStore, pruneStaleEntries, rotateSessionFile, saveSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const fixtureSuite = createFixtureSuite("openclaw-pruning-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Unit tests — each function called with explicit override parameters.
// No config loading needed; overrides bypass resolveMaintenanceConfig().
// ---------------------------------------------------------------------------

describe("pruneStaleEntries", () => {
  it("removes entries older than maxAgeDays", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["fresh", makeEntry(now - 1 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store.fresh).toBeDefined();
  });
});

describe("capEntryCount", () => {
  it("over limit: keeps N most recent by updatedAt, deletes rest", () => {
    const now = Date.now();
    const store = makeStore([
      ["oldest", makeEntry(now - 4 * DAY_MS)],
      ["old", makeEntry(now - 3 * DAY_MS)],
      ["mid", makeEntry(now - 2 * DAY_MS)],
      ["recent", makeEntry(now - 1 * DAY_MS)],
      ["newest", makeEntry(now)],
    ]);

    const evicted = capEntryCount(store, 3);

    expect(evicted).toBe(2);
    expect(Object.keys(store)).toHaveLength(3);
    expect(store.newest).toBeDefined();
    expect(store.recent).toBeDefined();
    expect(store.mid).toBeDefined();
    expect(store.oldest).toBeUndefined();
    expect(store.old).toBeUndefined();
  });
});

describe("rotateSessionFile", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await fixtureSuite.createCaseDir("rotate");
    storePath = path.join(testDir, "sessions.json");
  });

  it("file over maxBytes: renamed to .bak.{timestamp}, returns true", async () => {
    const bigContent = "x".repeat(200);
    await fs.writeFile(storePath, bigContent, "utf-8");

    const rotated = await rotateSessionFile(storePath, 100);

    expect(rotated).toBe(true);
    await expect(fs.stat(storePath)).rejects.toThrow();
    const files = await fs.readdir(testDir);
    const bakFiles = files.filter((f) => f.startsWith("sessions.json.bak."));
    expect(bakFiles).toHaveLength(1);
    const bakContent = await fs.readFile(path.join(testDir, bakFiles[0]), "utf-8");
    expect(bakContent).toBe(bigContent);
  });

  it("multiple rotations: only keeps 3 most recent .bak files", async () => {
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 5));
    try {
      // 4 rotations are enough to verify pruning to <=3 backups.
      for (let i = 0; i < 4; i++) {
        await fs.writeFile(storePath, `data-${i}-${"x".repeat(100)}`, "utf-8");
        await rotateSessionFile(storePath, 50);
      }
    } finally {
      nowSpy.mockRestore();
    }

    const files = await fs.readdir(testDir);
    const bakFiles = files.filter((f) => f.startsWith("sessions.json.bak.")).toSorted();

    expect(bakFiles.length).toBeLessThanOrEqual(3);
  });

  it("non-existent file: no rotation (returns false)", async () => {
    const missingPath = path.join(testDir, "missing.json");

    const rotated = await rotateSessionFile(missingPath, 100);

    expect(rotated).toBe(false);
  });

  it("file exactly at maxBytes: no rotation (returns false)", async () => {
    await fs.writeFile(storePath, "x".repeat(100), "utf-8");

    const rotated = await rotateSessionFile(storePath, 100);

    expect(rotated).toBe(false);
  });

  it("backup file name includes a timestamp", async () => {
    await fs.writeFile(storePath, "x".repeat(100), "utf-8");
    const before = Date.now();

    await rotateSessionFile(storePath, 50);

    const after = Date.now();
    const files = await fs.readdir(testDir);
    const bakFiles = files.filter((f) => f.startsWith("sessions.json.bak."));
    expect(bakFiles).toHaveLength(1);
    const timestamp = Number(bakFiles[0].replace("sessions.json.bak.", ""));
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — exercise saveSessionStore end-to-end.
// The file-level vi.mock("../config.js") stubs loadConfig; per-test
// mockReturnValue controls what resolveMaintenanceConfig() returns.
// ---------------------------------------------------------------------------

describe("Integration: saveSessionStore with pruning", () => {
  let testDir: string;
  let storePath: string;
  let savedCacheTtl: string | undefined;
  let mockLoadConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = await fixtureSuite.createCaseDir("pruning-integ");
    storePath = path.join(testDir, "sessions.json");
    savedCacheTtl = process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "0";
    clearSessionStoreCacheForTest();

    const configModule = await import("../config.js");
    mockLoadConfig = configModule.loadConfig as ReturnType<typeof vi.fn>;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearSessionStoreCacheForTest();
    if (savedCacheTtl === undefined) {
      delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SESSION_CACHE_TTL_MS = savedCacheTtl;
    }
  });

  it("saveSessionStore prunes stale entries on write", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "7d",
          maxEntries: 500,
          rotateBytes: 10_485_760,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      stale: makeEntry(now - 30 * DAY_MS),
      fresh: makeEntry(now),
    };

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded.stale).toBeUndefined();
    expect(loaded.fresh).toBeDefined();
  });

  it("saveSessionStore caps entries over limit", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 5,
          rotateBytes: 10_485_760,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {};
    for (let i = 0; i < 10; i++) {
      store[`key-${i}`] = makeEntry(now - i * 1000);
    }

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(Object.keys(loaded)).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(loaded[`key-${i}`]).toBeDefined();
    }
    for (let i = 5; i < 10; i++) {
      expect(loaded[`key-${i}`]).toBeUndefined();
    }
  });

  it("saveSessionStore rotates file when over size limit and creates .bak", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 500,
          rotateBytes: "100b",
        },
      },
    });

    const now = Date.now();
    const largeStore: Record<string, SessionEntry> = {};
    for (let i = 0; i < 50; i++) {
      largeStore[`agent:main:session-${crypto.randomUUID()}`] = makeEntry(now - i * 1000);
    }
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(largeStore, null, 2), "utf-8");

    const statBefore = await fs.stat(storePath);
    expect(statBefore.size).toBeGreaterThan(100);

    const smallStore: Record<string, SessionEntry> = {
      only: makeEntry(now),
    };
    await saveSessionStore(storePath, smallStore);

    const files = await fs.readdir(testDir);
    const bakFiles = files.filter((f) => f.startsWith("sessions.json.bak."));
    expect(bakFiles.length).toBeGreaterThanOrEqual(1);

    const loaded = loadSessionStore(storePath);
    expect(loaded.only).toBeDefined();
  });

  it("saveSessionStore applies both pruning and capping together", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "10d",
          maxEntries: 3,
          rotateBytes: 10_485_760,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      stale1: makeEntry(now - 15 * DAY_MS),
      stale2: makeEntry(now - 20 * DAY_MS),
      fresh1: makeEntry(now),
      fresh2: makeEntry(now - 1 * DAY_MS),
      fresh3: makeEntry(now - 2 * DAY_MS),
      fresh4: makeEntry(now - 5 * DAY_MS),
    };

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded.stale1).toBeUndefined();
    expect(loaded.stale2).toBeUndefined();
    expect(Object.keys(loaded).length).toBeLessThanOrEqual(3);
    expect(loaded.fresh1).toBeDefined();
    expect(loaded.fresh2).toBeDefined();
    expect(loaded.fresh3).toBeDefined();
    expect(loaded.fresh4).toBeUndefined();
  });

  it("saveSessionStore skips enforcement when maintenance mode is warn", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "warn",
          pruneAfter: "7d",
          maxEntries: 1,
          rotateBytes: 10_485_760,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      stale: makeEntry(now - 30 * DAY_MS),
      fresh: makeEntry(now),
    };

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded.stale).toBeDefined();
    expect(loaded.fresh).toBeDefined();
    expect(Object.keys(loaded)).toHaveLength(2);
  });

  it("resolveMaintenanceConfig reads from loadConfig().session.maintenance", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: { pruneAfter: "7d", maxEntries: 100, rotateBytes: "5mb" },
      },
    });

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config).toEqual({
      mode: "warn",
      pruneAfterMs: 7 * DAY_MS,
      maxEntries: 100,
      rotateBytes: 5 * 1024 * 1024,
    });
  });

  it("resolveMaintenanceConfig uses defaults for missing fields", async () => {
    mockLoadConfig.mockReturnValue({ session: { maintenance: { pruneAfter: "14d" } } });

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config).toEqual({
      mode: "warn",
      pruneAfterMs: 14 * DAY_MS,
      maxEntries: 500,
      rotateBytes: 10_485_760,
    });
  });

  it("resolveMaintenanceConfig falls back to deprecated pruneDays", async () => {
    mockLoadConfig.mockReturnValue({ session: { maintenance: { pruneDays: 2 } } });

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config).toEqual({
      mode: "warn",
      pruneAfterMs: 2 * DAY_MS,
      maxEntries: 500,
      rotateBytes: 10_485_760,
    });
  });

  it("resolveMaintenanceConfig: explicit cronRun=false wins over deprecated sessionRetention", async () => {
    // When new config has cronRun: false AND deprecated sessionRetention is set,
    // the explicit false should NOT be overwritten by sessionRetention.
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          pruneRules: {
            cronRun: false,
          },
        },
      },
      cron: {
        sessionRetention: true,
      },
    });

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config.pruneRules?.cronRun).toBe(false);
  });

  it("resolveMaintenanceConfig: undefined cronRun uses deprecated sessionRetention", async () => {
    // When cronRun is not set (undefined), sessionRetention should be used for backward compat.
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          pruneRules: {},
        },
      },
      cron: {
        sessionRetention: true,
      },
    });

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config.pruneRules?.cronRun).toBe(true);
  });
});
