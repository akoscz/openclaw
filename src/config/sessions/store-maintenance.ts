import fs from "node:fs";
import path from "node:path";
import { parseByteSize } from "../../cli/parse-bytes.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadConfig } from "../config.js";
import type { SessionMaintenanceConfig, SessionMaintenanceMode, SessionPruneRules } from "../types.base.js";
import {
  isChannelSessionKey,
  isCronRunSessionKey,
  isSubagentSessionKey,
  isThreadSessionKey,
} from "../../sessions/session-key-utils.js";
import type { SessionEntry } from "./types.js";

/**
 * Resolve the TTL (in ms) for a given session key, applying per-type prune rules.
 * Returns `null` when the session type is explicitly exempt from pruning.
 * Falls back to `defaultMs` when no matching rule is configured.
 */
export function resolveSessionTTL(
  sessionKey: string,
  rules: SessionPruneRules | undefined,
  defaultMs: number,
): number | null {
  if (!rules) {
    return defaultMs;
  }
  // Determine session type and look up matching rule.
  let ruleValue: string | number | false | undefined;
  if (isSubagentSessionKey(sessionKey)) {
    ruleValue = rules.subagent;
  } else if (isCronRunSessionKey(sessionKey)) {
    ruleValue = rules.cronRun;
  } else if (isThreadSessionKey(sessionKey)) {
    ruleValue = rules.thread;
  } else if (isChannelSessionKey(sessionKey)) {
    ruleValue = rules.channel;
  }
  if (ruleValue === undefined) {
    return defaultMs;
  }
  if (ruleValue === false) {
    return null; // exempt from pruning
  }
  if (typeof ruleValue === "number") {
    return ruleValue;
  }
  try {
    return parseDurationMs(String(ruleValue).trim(), { defaultUnit: "ms" });
  } catch {
    return defaultMs;
  }
}

const log = createSubsystemLogger("sessions/store");

const DEFAULT_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_MAX_ENTRIES = 500;
const DEFAULT_SESSION_ROTATE_BYTES = 10_485_760; // 10 MB
const DEFAULT_SESSION_MAINTENANCE_MODE: SessionMaintenanceMode = "warn";
const DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO = 0.8;

export type SessionMaintenanceWarning = {
  activeSessionKey: string;
  activeUpdatedAt?: number;
  totalEntries: number;
  pruneAfterMs: number;
  maxEntries: number;
  wouldPrune: boolean;
  wouldCap: boolean;
};

export type ResolvedSessionMaintenanceConfig = {
  mode: SessionMaintenanceMode;
  pruneAfterMs: number;
  maxEntries: number;
  rotateBytes: number;
  resetArchiveRetentionMs: number | null;
  maxDiskBytes: number | null;
  highWaterBytes: number | null;
  pruneRules?: SessionPruneRules;
};

function resolvePruneAfterMs(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.pruneAfter ?? maintenance?.pruneDays;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
  try {
    return parseDurationMs(String(raw).trim(), { defaultUnit: "d" });
  } catch {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
}

function resolveRotateBytes(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.rotateBytes;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SESSION_ROTATE_BYTES;
  }
  try {
    return parseByteSize(String(raw).trim(), { defaultUnit: "b" });
  } catch {
    return DEFAULT_SESSION_ROTATE_BYTES;
  }
}

function resolveResetArchiveRetentionMs(
  maintenance: SessionMaintenanceConfig | undefined,
  pruneAfterMs: number,
): number | null {
  const raw = maintenance?.resetArchiveRetention;
  if (raw === false) {
    return null;
  }
  if (raw === undefined || raw === null || raw === "") {
    return pruneAfterMs;
  }
  try {
    return parseDurationMs(String(raw).trim(), { defaultUnit: "d" });
  } catch {
    return pruneAfterMs;
  }
}

function resolveMaxDiskBytes(maintenance?: SessionMaintenanceConfig): number | null {
  const raw = maintenance?.maxDiskBytes;
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  try {
    return parseByteSize(String(raw).trim(), { defaultUnit: "b" });
  } catch {
    return null;
  }
}

function resolveHighWaterBytes(
  maintenance: SessionMaintenanceConfig | undefined,
  maxDiskBytes: number | null,
): number | null {
  const computeDefault = () => {
    if (maxDiskBytes == null) {
      return null;
    }
    if (maxDiskBytes <= 0) {
      return 0;
    }
    return Math.max(
      1,
      Math.min(
        maxDiskBytes,
        Math.floor(maxDiskBytes * DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO),
      ),
    );
  };
  if (maxDiskBytes == null) {
    return null;
  }
  const raw = maintenance?.highWaterBytes;
  if (raw === undefined || raw === null || raw === "") {
    return computeDefault();
  }
  try {
    const parsed = parseByteSize(String(raw).trim(), { defaultUnit: "b" });
    return Math.min(parsed, maxDiskBytes);
  } catch {
    return computeDefault();
  }
}

/**
 * Resolve maintenance settings from openclaw.json (`session.maintenance`).
 * Falls back to built-in defaults when config is missing or unset.
 */
export function resolveMaintenanceConfig(): ResolvedSessionMaintenanceConfig {
  let maintenance: SessionMaintenanceConfig | undefined;
  try {
    maintenance = loadConfig().session?.maintenance;
  } catch {
    // Config may not be available (e.g. in tests). Use defaults.
  }
  const pruneAfterMs = resolvePruneAfterMs(maintenance);
  const maxDiskBytes = resolveMaxDiskBytes(maintenance);
  return {
    mode: maintenance?.mode ?? DEFAULT_SESSION_MAINTENANCE_MODE,
    pruneAfterMs,
    maxEntries: maintenance?.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES,
    rotateBytes: resolveRotateBytes(maintenance),
    resetArchiveRetentionMs: resolveResetArchiveRetentionMs(maintenance, pruneAfterMs),
    maxDiskBytes,
    highWaterBytes: resolveHighWaterBytes(maintenance, maxDiskBytes),
    pruneRules: maintenance?.pruneRules,
  };
}

/**
 * Remove entries whose `updatedAt` is older than the configured threshold.
 * Entries without `updatedAt` are kept (cannot determine staleness).
 * Mutates `store` in-place.
 */
export function pruneStaleEntries(
  store: Record<string, SessionEntry>,
  overrideMaxAgeMs?: number,
  opts: {
    log?: boolean;
    onPruned?: (params: { key: string; entry: SessionEntry }) => void;
    pruneRules?: SessionPruneRules;
  } = {},
): number {
  const defaultMaxAgeMs = overrideMaxAgeMs ?? resolveMaintenanceConfig().pruneAfterMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    const ttlMs = resolveSessionTTL(key, opts.pruneRules, defaultMaxAgeMs);
    if (ttlMs === null) {
      continue; // This session type is exempt from pruning
    }
    const cutoffMs = Date.now() - ttlMs;
    if (entry?.updatedAt != null && entry.updatedAt < cutoffMs) {
      opts.onPruned?.({ key, entry });
      delete store[key];
      pruned++;
    }
  }
  if (pruned > 0 && opts.log !== false) {
    log.info("pruned stale session entries", { pruned, maxAgeMs: defaultMaxAgeMs });
  }
  return pruned;
}

function getEntryUpdatedAt(entry?: SessionEntry): number {
  return entry?.updatedAt ?? Number.NEGATIVE_INFINITY;
}

export function getActiveSessionMaintenanceWarning(params: {
  store: Record<string, SessionEntry>;
  activeSessionKey: string;
  pruneAfterMs: number;
  maxEntries: number;
  nowMs?: number;
}): SessionMaintenanceWarning | null {
  const activeSessionKey = params.activeSessionKey.trim();
  if (!activeSessionKey) {
    return null;
  }
  const activeEntry = params.store[activeSessionKey];
  if (!activeEntry) {
    return null;
  }
  const now = params.nowMs ?? Date.now();
  const cutoffMs = now - params.pruneAfterMs;
  const wouldPrune = activeEntry.updatedAt != null ? activeEntry.updatedAt < cutoffMs : false;
  const keys = Object.keys(params.store);
  const wouldCap =
    keys.length > params.maxEntries &&
    keys
      .toSorted((a, b) => getEntryUpdatedAt(params.store[b]) - getEntryUpdatedAt(params.store[a]))
      .slice(params.maxEntries)
      .includes(activeSessionKey);

  if (!wouldPrune && !wouldCap) {
    return null;
  }

  return {
    activeSessionKey,
    activeUpdatedAt: activeEntry.updatedAt,
    totalEntries: keys.length,
    pruneAfterMs: params.pruneAfterMs,
    maxEntries: params.maxEntries,
    wouldPrune,
    wouldCap,
  };
}

/**
 * Cap the store to the N most recently updated entries.
 * Entries without `updatedAt` are sorted last (removed first when over limit).
 * Mutates `store` in-place.
 */
export function capEntryCount(
  store: Record<string, SessionEntry>,
  overrideMax?: number,
  opts: {
    log?: boolean;
    onCapped?: (params: { key: string; entry: SessionEntry }) => void;
  } = {},
): number {
  const maxEntries = overrideMax ?? resolveMaintenanceConfig().maxEntries;
  const keys = Object.keys(store);
  if (keys.length <= maxEntries) {
    return 0;
  }

  // Sort by updatedAt descending; entries without updatedAt go to the end (removed first).
  const sorted = keys.toSorted((a, b) => {
    const aTime = getEntryUpdatedAt(store[a]);
    const bTime = getEntryUpdatedAt(store[b]);
    return bTime - aTime;
  });

  const toRemove = sorted.slice(maxEntries);
  for (const key of toRemove) {
    const entry = store[key];
    if (entry) {
      opts.onCapped?.({ key, entry });
    }
    delete store[key];
  }
  if (opts.log !== false) {
    log.info("capped session entry count", { removed: toRemove.length, maxEntries });
  }
  return toRemove.length;
}

async function getSessionFileSize(storePath: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(storePath);
    return stat.size;
  } catch {
    return null;
  }
}

/**
 * Rotate the sessions file if it exceeds the configured size threshold.
 * Renames the current file to `sessions.json.bak.{timestamp}` and cleans up
 * old rotation backups, keeping only the 3 most recent `.bak.*` files.
 */
export async function rotateSessionFile(
  storePath: string,
  overrideBytes?: number,
): Promise<boolean> {
  const maxBytes = overrideBytes ?? resolveMaintenanceConfig().rotateBytes;

  // Check current file size (file may not exist yet).
  const fileSize = await getSessionFileSize(storePath);
  if (fileSize == null) {
    return false;
  }

  if (fileSize <= maxBytes) {
    return false;
  }

  // Rotate: rename current file to .bak.{timestamp}
  const backupPath = `${storePath}.bak.${Date.now()}`;
  try {
    await fs.promises.rename(storePath, backupPath);
    log.info("rotated session store file", {
      backupPath: path.basename(backupPath),
      sizeBytes: fileSize,
    });
  } catch {
    // If rename fails (e.g. file disappeared), skip rotation.
    return false;
  }

  // Clean up old backups — keep only the 3 most recent .bak.* files.
  try {
    const dir = path.dirname(storePath);
    const baseName = path.basename(storePath);
    const files = await fs.promises.readdir(dir);
    const backups = files
      .filter((f) => f.startsWith(`${baseName}.bak.`))
      .toSorted()
      .toReversed();

    const maxBackups = 3;
    if (backups.length > maxBackups) {
      const toDelete = backups.slice(maxBackups);
      for (const old of toDelete) {
        await fs.promises.unlink(path.join(dir, old)).catch(() => undefined);
      }
      log.info("cleaned up old session store backups", { deleted: toDelete.length });
    }
  } catch {
    // Best-effort cleanup; don't fail the write.
  }

  return true;
}
