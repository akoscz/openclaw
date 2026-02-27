/**
 * Utility to count messages in a session transcript JSONL file.
 *
 * Each line in the transcript is a JSON object. Lines with a "role" field
 * of "user" or "assistant" are counted as messages (excluding system,
 * tool results, and header lines).
 */

import fs from "node:fs";

/**
 * Count user/assistant messages in a transcript JSONL file.
 * Returns 0 if the file doesn't exist or can't be read.
 */
export function countTranscriptMessages(sessionFile?: string): number {
  if (!sessionFile) {
    return 0;
  }
  try {
    if (!fs.existsSync(sessionFile)) {
      return 0;
    }
    const content = fs.readFileSync(sessionFile, "utf-8");
    let count = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { role?: string };
        if (parsed.role === "user" || parsed.role === "assistant") {
          count++;
        }
      } catch {
        // Skip malformed lines
      }
    }
    return count;
  } catch {
    return 0;
  }
}
