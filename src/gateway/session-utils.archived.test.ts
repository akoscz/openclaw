import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { listSessionsFromStore } from "./session-utils.js";

describe("listSessionsFromStore includeArchived", () => {
  let tmpDir: string;
  let storePath: string;

  const baseCfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archived-list-test-"));
    storePath = path.join(tmpDir, "sessions.json");
    // Create an active session transcript
    fs.writeFileSync(
      path.join(tmpDir, "sess-active1.jsonl"),
      '{"message":{"role":"user","content":"active message"}}\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeStore = (): Record<string, SessionEntry> => ({
    "agent:main:test-session": {
      sessionId: "sess-active1",
      updatedAt: Date.now(),
      displayName: "Active Session",
    } as SessionEntry,
  });

  it("excludes archived sessions by default", () => {
    // Create an archived transcript
    fs.writeFileSync(
      path.join(tmpDir, "sess-old1.jsonl.deleted.2026-02-01T10-00-00.000Z"),
      '{"message":{"role":"user","content":"old message"}}\n',
    );

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath,
      store: makeStore(),
      opts: {},
    });
    expect(result.sessions.every((s) => s.status !== "archived")).toBe(true);
    expect(result.sessions).toHaveLength(1);
  });

  it("includes archived sessions when includeArchived is true", () => {
    fs.writeFileSync(
      path.join(tmpDir, "sess-old1.jsonl.deleted.2026-02-01T10-00-00.000Z"),
      '{"message":{"role":"user","content":"old message"}}\n{"message":{"role":"assistant","content":"reply"}}\n',
    );

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath,
      store: makeStore(),
      opts: { includeArchived: true },
    });
    const archived = result.sessions.filter((s) => s.status === "archived");
    expect(archived).toHaveLength(1);
    expect(archived[0].status).toBe("archived");
    expect(archived[0].archivedAt).toBe("2026-02-01T10:00:00.000Z");
    // messageCount is opt-in (not computed during listing to avoid N file reads)
    expect(archived[0].messageCount).toBeUndefined();
    expect(archived[0].key).toContain("archived:");
  });

  it("includes derived title for archived sessions when includeDerivedTitles is true", () => {
    fs.writeFileSync(
      path.join(tmpDir, "sess-titled.jsonl.deleted.2026-02-10T08-00-00.000Z"),
      '{"message":{"role":"user","content":"What is the meaning of life?"}}\n',
    );

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath,
      store: makeStore(),
      opts: { includeArchived: true, includeDerivedTitles: true },
    });
    const archived = result.sessions.filter((s) => s.status === "archived");
    expect(archived).toHaveLength(1);
    expect(archived[0].derivedTitle).toBe("What is the meaning of life?");
  });

  it("finds both .deleted and .reset archived files", () => {
    fs.writeFileSync(path.join(tmpDir, "sess-del.jsonl.deleted.2026-02-01T00-00-00.000Z"), "");
    fs.writeFileSync(path.join(tmpDir, "sess-rst.jsonl.reset.2026-02-02T00-00-00.000Z"), "");

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath,
      store: makeStore(),
      opts: { includeArchived: true },
    });
    const archived = result.sessions.filter((s) => s.status === "archived");
    expect(archived).toHaveLength(2);
  });

  it("applies search filter to archived sessions", () => {
    fs.writeFileSync(path.join(tmpDir, "sess-match.jsonl.deleted.2026-02-01T00-00-00.000Z"), "");
    fs.writeFileSync(path.join(tmpDir, "sess-nomatch.jsonl.deleted.2026-02-02T00-00-00.000Z"), "");

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath,
      store: makeStore(),
      opts: { includeArchived: true, search: "sess-match" },
    });
    const archived = result.sessions.filter((s) => s.status === "archived");
    expect(archived).toHaveLength(1);
    expect(archived[0].sessionId).toBe("sess-match");
  });
});
