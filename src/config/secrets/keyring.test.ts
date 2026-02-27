/**
 * Tests for the keyring secrets provider.
 *
 * Security regression: keychain password must NOT appear in process arguments
 * where it would be visible via `ps aux` / `ps -e` to other users on the system.
 * See: CWE-214 (Invocation of Process Using Visible Sensitive Information)
 */

import EventEmitter from "node:events";
import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared fake child process
// ---------------------------------------------------------------------------

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: null;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = null;
  return child;
}

// ---------------------------------------------------------------------------
// Mocks — hoisted by Vitest before imports
// ---------------------------------------------------------------------------

const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
let fakeChild = makeFakeChild();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args: Array.from(args ?? []), opts: opts ?? {} });
      return fakeChild;
    }),
    // execFile (used via promisify for find-generic-password / lock-keychain)
    // returns a fake ChildProcess; the promisify wrapper will call the last-arg
    // callback when the process emits "close". For these tests we don't need
    // the find-generic-password call to succeed — we only care about unlock.
    execFile: vi.fn((...rawArgs: unknown[]) => {
      // promisify appends a callback; call it with an error so resolve() rejects
      // (we don't care about secret retrieval here)
      const cb = rawArgs[rawArgs.length - 1];
      if (typeof cb === "function") {
        (cb as (e: Error) => void)(new Error("test: no real keychain"));
      }
      return fakeChild;
    }),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => "darwin" as NodeJS.Platform };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createKeyringSecretsProvider — macOS unlock (security regression)", () => {
  it("passes keychain password via env var KEYCHAIN_PASS, not as a process arg (CWE-214)", async () => {
    spawnCalls.length = 0;
    fakeChild = makeFakeChild();

    const { createKeyringSecretsProvider } = await import("./keyring.js");

    const provider = createKeyringSecretsProvider({
      keychainPassword: "hunter2",
      keychainPath: "/tmp/test.keychain-db",
    });

    // Call resolve() — this triggers ensureUnlocked() → spawn()
    const resolvePromise = provider.resolve("some-secret").catch(() => {
      /* expected: no real keychain */
    });

    // Allow microtasks to flush so spawn() fires
    await new Promise((r) => setImmediate(r));

    // Simulate successful keychain unlock so the promise chain can advance
    fakeChild.emit("close", 0);
    await resolvePromise;

    // spawn() must have been called for the unlock step
    expect(spawnCalls.length, "spawn() should be called for unlock").toBeGreaterThan(0);

    const { cmd, args, opts } = spawnCalls[0];

    // Must use a shell wrapper — direct `security -p <password>` would expose it
    expect(cmd).toBe("sh");
    expect(args[0]).toBe("-c");

    const shellScriptArg = args[1] ?? "";

    // The literal password must NOT appear anywhere in the process argument list
    // (this is exactly what is visible in `ps aux`)
    for (const arg of [cmd, ...args]) {
      expect(arg, `process arg "${arg}" must not contain the literal password`).not.toContain(
        "hunter2",
      );
    }

    // The password MUST be delivered via the KEYCHAIN_PASS env var instead
    const env = (opts as { env?: Record<string, string> }).env ?? {};
    expect(env.KEYCHAIN_PASS, "password must flow through KEYCHAIN_PASS env var").toBe("hunter2");

    // The shell script must reference env vars (not inlined values)
    expect(shellScriptArg, "shell script must reference $KEYCHAIN_PASS").toContain(
      "$KEYCHAIN_PASS",
    );
    expect(shellScriptArg, "shell script must reference $KEYCHAIN_PATH").toContain(
      "$KEYCHAIN_PATH",
    );

    // Sanity: the keychain path must also be passed via env (not as a literal arg)
    expect(env.KEYCHAIN_PATH, "keychain path must flow through KEYCHAIN_PATH env var").toBe(
      "/tmp/test.keychain-db",
    );
  });

  it("does not call `security unlock-keychain -p <password>` directly (regression guard)", async () => {
    spawnCalls.length = 0;
    fakeChild = makeFakeChild();

    const { createKeyringSecretsProvider } = await import("./keyring.js");

    const provider = createKeyringSecretsProvider({
      keychainPassword: "topsecret99",
      keychainPath: "/tmp/other.keychain-db",
    });

    const resolvePromise = provider.resolve("key").catch(() => {});
    await new Promise((r) => setImmediate(r));
    fakeChild.emit("close", 0);
    await resolvePromise;

    // If we ever regress to spawn("security", [..., "-p", password, ...]) this fires
    for (const { cmd, args } of spawnCalls) {
      if (cmd === "security") {
        const pIdx = args.indexOf("-p");
        if (pIdx !== -1) {
          expect(
            args[pIdx + 1],
            'literal password must not follow "-p" in security CLI args',
          ).not.toBe("topsecret99");
        }
      }
    }
  });
});
