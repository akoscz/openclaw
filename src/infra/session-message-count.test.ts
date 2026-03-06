import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { countTranscriptMessages } from "./session-message-count.js";

describe("countTranscriptMessages", () => {
  const tmpFiles: string[] = [];

  function writeTmp(content: string): string {
    const p = path.join(
      os.tmpdir(),
      `test-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    fs.writeFileSync(p, content, "utf-8");
    tmpFiles.push(p);
    return p;
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    tmpFiles.length = 0;
  });

  it("returns 0 for undefined path", () => {
    expect(countTranscriptMessages(undefined)).toBe(0);
  });

  it("returns 0 for non-existent file", () => {
    expect(countTranscriptMessages("/tmp/does-not-exist-xyz.jsonl")).toBe(0);
  });

  it("counts user and assistant messages", () => {
    const f = writeTmp(
      [
        '{"role":"system","content":"you are helpful"}',
        '{"role":"user","content":"hello"}',
        '{"role":"assistant","content":"hi"}',
        '{"role":"user","content":"bye"}',
        '{"role":"tool","content":"result"}',
      ].join("\n"),
    );
    expect(countTranscriptMessages(f)).toBe(3);
  });

  it("handles empty file", () => {
    const f = writeTmp("");
    expect(countTranscriptMessages(f)).toBe(0);
  });

  it("skips malformed lines", () => {
    const f = writeTmp(
      [
        '{"role":"user","content":"hi"}',
        "not json at all",
        '{"role":"assistant","content":"hello"}',
      ].join("\n"),
    );
    expect(countTranscriptMessages(f)).toBe(2);
  });
});
