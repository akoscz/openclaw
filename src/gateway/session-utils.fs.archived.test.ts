import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scanArchivedTranscripts } from "./session-utils.fs.js";

describe("scanArchivedTranscripts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archived-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .deleted.* files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "sess-abc123.jsonl.deleted.2026-02-14T15-00-00.000Z"),
      '{"message":{"role":"user","content":"hello"}}\n',
    );
    const results = scanArchivedTranscripts(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("sess-abc123");
    expect(results[0].reason).toBe("deleted");
    expect(results[0].archivedAt).toBe("2026-02-14T15:00:00.000Z");
    expect(results[0].fileSize).toBeGreaterThan(0);
  });

  it("finds .reset.* files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "sess-xyz789.jsonl.reset.2026-01-10T12-30-00.000Z"),
      '{"message":{"role":"user","content":"hi"}}\n',
    );
    const results = scanArchivedTranscripts(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("sess-xyz789");
    expect(results[0].reason).toBe("reset");
    expect(results[0].archivedAt).toBe("2026-01-10T12:30:00.000Z");
  });

  it("finds .bak.* files", () => {
    fs.writeFileSync(path.join(tmpDir, "sess-bak001.jsonl.bak.2026-03-01T08-15-00.000Z"), "");
    const results = scanArchivedTranscripts(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].reason).toBe("bak");
  });

  it("ignores non-matching files", () => {
    fs.writeFileSync(path.join(tmpDir, "sess-abc.jsonl"), "active session");
    fs.writeFileSync(path.join(tmpDir, "something-else.txt"), "not a session");
    fs.writeFileSync(
      path.join(tmpDir, "sess-abc.jsonl.unknown.2026-01-01T00-00-00.000Z"),
      "bad reason",
    );
    const results = scanArchivedTranscripts(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("finds multiple archived files", () => {
    fs.writeFileSync(path.join(tmpDir, "sess-a.jsonl.deleted.2026-02-01T00-00-00.000Z"), "");
    fs.writeFileSync(path.join(tmpDir, "sess-b.jsonl.reset.2026-02-02T00-00-00.000Z"), "");
    fs.writeFileSync(
      path.join(tmpDir, "sess-a.jsonl"), // active, should be ignored
      "",
    );
    const results = scanArchivedTranscripts(tmpDir);
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.sessionId).toSorted();
    expect(ids).toEqual(["sess-a", "sess-b"]);
  });

  it("returns empty array for non-existent directory", () => {
    const results = scanArchivedTranscripts("/tmp/does-not-exist-archived-test");
    expect(results).toHaveLength(0);
  });

  it("parses timestamp with colons restored correctly", () => {
    fs.writeFileSync(path.join(tmpDir, "sess-ts.jsonl.deleted.2026-12-25T23-59-59.999Z"), "");
    const results = scanArchivedTranscripts(tmpDir);
    expect(results[0].archivedAt).toBe("2026-12-25T23:59:59.999Z");
  });
});
