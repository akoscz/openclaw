import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readPreviewItemsFromFile } from "./session-utils.fs.js";

describe("readPreviewItemsFromFile (archived transcripts)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-archived-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads preview items from an archived transcript file", () => {
    const filePath = path.join(tmpDir, "sess-abc.jsonl.deleted.2026-02-14T15-00-00.000Z");
    fs.writeFileSync(
      filePath,
      [
        '{"message":{"role":"user","content":"Hello world"}}',
        '{"message":{"role":"assistant","content":"Hi there!"}}',
        '{"message":{"role":"user","content":"How are you?"}}',
      ].join("\n") + "\n",
    );

    const items = readPreviewItemsFromFile(filePath, 10, 240);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ role: "user", text: "Hello world" });
    expect(items[1]).toEqual({ role: "assistant", text: "Hi there!" });
    expect(items[2]).toEqual({ role: "user", text: "How are you?" });
  });

  it("returns empty for non-existent file", () => {
    const items = readPreviewItemsFromFile("/tmp/does-not-exist.jsonl", 10, 240);
    expect(items).toHaveLength(0);
  });

  it("returns empty for empty file", () => {
    const filePath = path.join(tmpDir, "empty.jsonl.deleted.2026-01-01T00-00-00.000Z");
    fs.writeFileSync(filePath, "");
    const items = readPreviewItemsFromFile(filePath, 10, 240);
    expect(items).toHaveLength(0);
  });

  it("respects maxItems limit", () => {
    const filePath = path.join(tmpDir, "many.jsonl.deleted.2026-01-01T00-00-00.000Z");
    const lines = Array.from(
      { length: 20 },
      (_, i) => `{"message":{"role":"user","content":"message ${i}"}}`,
    );
    fs.writeFileSync(filePath, lines.join("\n") + "\n");

    const items = readPreviewItemsFromFile(filePath, 5, 240);
    expect(items).toHaveLength(5);
  });
});
