import { describe, expect, it, vi } from "vitest";

// Mock loadConfig to control both session and cron config.
const mockLoadConfig = vi.fn().mockReturnValue({});
vi.mock("../config.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

describe("cron.sessionRetention → pruneRules.cronRun migration", () => {
  it("migrates cron.sessionRetention to pruneRules.cronRun", async () => {
    mockLoadConfig.mockReturnValue({
      cron: { sessionRetention: "6h" },
    });

    // Re-import to pick up mock
    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config.pruneRules).toBeDefined();
    expect(config.pruneRules?.cronRun).toBe("6h");
  });

  it("pruneRules.cronRun takes precedence over cron.sessionRetention", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          pruneRules: { cronRun: "2h" },
        },
      },
      cron: { sessionRetention: "6h" },
    });

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config.pruneRules?.cronRun).toBe("2h");
  });

  it("cron.sessionRetention=false migrates as false", async () => {
    mockLoadConfig.mockReturnValue({
      cron: { sessionRetention: false },
    });

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config.pruneRules?.cronRun).toBe(false);
  });

  it("no cron config means no pruneRules", async () => {
    mockLoadConfig.mockReturnValue({});

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config.pruneRules).toBeUndefined();
  });
});
