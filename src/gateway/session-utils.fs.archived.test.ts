import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  scanArchivedTranscripts,
  isValidArchivedFileName,
  countMessagesInTranscriptFile,
  readFirstUserMessageFromFile,
} from "./session-utils.fs.js";

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

describe("isValidArchivedFileName", () => {
  it("accepts valid archived filenames", () => {
    expect(isValidArchivedFileName("sess-abc123.jsonl.deleted.2026-02-14T15-00-00.000Z")).toBe(
      true,
    );
    expect(isValidArchivedFileName("sess-xyz.jsonl.reset.2026-01-01T00-00-00.000Z")).toBe(true);
    expect(isValidArchivedFileName("sess-bak.jsonl.bak.2026-03-01T08-15-00.000Z")).toBe(true);
  });

  it("rejects path traversal with ../", () => {
    expect(isValidArchivedFileName("../../../etc/passwd")).toBe(false);
    expect(isValidArchivedFileName("..%2F..%2Fetc%2Fpasswd")).toBe(false);
  });

  it("rejects path traversal with forward slash", () => {
    expect(isValidArchivedFileName("subdir/sess-abc.jsonl.deleted.2026-01-01T00-00-00.000Z")).toBe(
      false,
    );
  });

  it("rejects path traversal with backslash", () => {
    expect(isValidArchivedFileName("..\\..\\etc\\passwd")).toBe(false);
    expect(isValidArchivedFileName("subdir\\file")).toBe(false);
  });

  it("rejects non-matching filenames", () => {
    expect(isValidArchivedFileName("sess-abc.jsonl")).toBe(false);
    expect(isValidArchivedFileName("not-a-session.txt")).toBe(false);
    expect(isValidArchivedFileName("")).toBe(false);
    expect(isValidArchivedFileName("sess-abc.jsonl.unknown.2026-01-01T00-00-00.000Z")).toBe(false);
  });
});

describe("countMessagesInTranscriptFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "count-msg-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("counts user and assistant messages", () => {
    const filePath = path.join(tmpDir, "transcript.jsonl");
    fs.writeFileSync(
      filePath,
      [
        '{"role":"user","content":"hello"}',
        '{"role":"assistant","content":"hi"}',
        '{"role":"user","content":"bye"}',
        '{"role":"system","content":"ignored"}',
      ].join("\n") + "\n",
    );
    expect(countMessagesInTranscriptFile(filePath)).toBe(3);
  });

  it("handles nested message.role format", () => {
    const filePath = path.join(tmpDir, "transcript.jsonl");
    fs.writeFileSync(
      filePath,
      [
        '{"message":{"role":"user","content":"hello"}}',
        '{"message":{"role":"assistant","content":"hi"}}',
      ].join("\n") + "\n",
    );
    expect(countMessagesInTranscriptFile(filePath)).toBe(2);
  });

  it("returns 0 for empty file", () => {
    const filePath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(filePath, "");
    expect(countMessagesInTranscriptFile(filePath)).toBe(0);
  });

  it("returns 0 for non-existent file", () => {
    expect(countMessagesInTranscriptFile(path.join(tmpDir, "nope.jsonl"))).toBe(0);
  });
});

describe("readFirstUserMessageFromFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "first-msg-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads first user message", () => {
    const filePath = path.join(tmpDir, "transcript.jsonl");
    fs.writeFileSync(
      filePath,
      [
        '{"message":{"role":"system","content":"sys prompt"}}',
        '{"message":{"role":"user","content":"hello world"}}',
        '{"message":{"role":"assistant","content":"hi"}}',
      ].join("\n") + "\n",
    );
    expect(readFirstUserMessageFromFile(filePath)).toBe("hello world");
  });

  it("returns null for empty file", () => {
    const filePath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(filePath, "");
    expect(readFirstUserMessageFromFile(filePath)).toBeNull();
  });
});
