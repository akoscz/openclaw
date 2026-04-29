import { execFile } from "node:child_process";
import { OPENCLAW_VERSION as VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";

type AgentConfig = {
  id?: string;
  model?: string | { primary?: string };
};

function resolveUserTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
      return trimmed;
    } catch {
      // ignore invalid timezone
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || "UTC";
}
import {
  clearPublishInFlight,
  hasCurrentHomeTab,
  hasCustomHomeTab,
  isPublishInFlight,
  markHomeTabCustom,
  markHomeTabPublished,
  markPublishInFlight,
} from "../../home-tab-state.js";
import { buildDefaultHomeView, type HomeTabParams } from "../../home-tab.js";
import type { SlackMonitorContext } from "../context.js";

/** Returns process uptime in milliseconds, consistent with gateway health state. */
function processUptimeMs(): number {
  return Math.round(process.uptime() * 1000);
}

/**
 * Resolve the primary model string for an agent, falling back to the
 * agents.defaults or top-level model config.
 * @internal Exported for testing only.
 */
export function resolveAgentModelDisplay(
  agent: AgentConfig | undefined,
  cfg: OpenClawConfig,
): string {
  const agentModel = agent?.model;
  if (agentModel) {
    const raw = typeof agentModel === "string" ? agentModel : agentModel.primary;
    if (raw?.trim()) {
      return raw.trim();
    }
  }
  const defaultsModel = cfg.agents?.defaults?.model;
  if (defaultsModel) {
    const raw = typeof defaultsModel === "string" ? defaultsModel : defaultsModel.primary;
    if (raw?.trim()) {
      return raw.trim();
    }
  }
  return "—";
}

export type AppHomeConfig = {
  enabled?: boolean;
  showCommands?: boolean;
  customBlocks?: unknown[];
  customScript?: string;
};

function resolveHomeTabConfig(ctx: SlackMonitorContext): AppHomeConfig {
  const cfg = ctx.cfg;
  const slackCfg = cfg.channels?.slack as Record<string, unknown> | undefined;
  const homeTab = slackCfg?.homeTab as AppHomeConfig | undefined;
  return {
    enabled: homeTab?.enabled ?? true,
    showCommands: homeTab?.showCommands ?? true,
    customBlocks: homeTab?.customBlocks,
    customScript: homeTab?.customScript,
  };
}

function resolveSlashCommandInfo(ctx: SlackMonitorContext): {
  enabled: boolean;
  name: string;
} {
  return {
    enabled: ctx.slashCommand.enabled,
    name: ctx.slashCommand.name?.trim() || "openclaw",
  };
}

function resolveBotName(ctx: SlackMonitorContext): string {
  const cfg = ctx.cfg;
  const slackCfg = cfg.channels?.slack as Record<string, unknown> | undefined;
  return (
    (typeof slackCfg?.name === "string" ? slackCfg.name.trim() : "") ||
    (typeof cfg.ui?.assistant?.name === "string" ? cfg.ui.assistant.name.trim() : "") ||
    "OpenClaw"
  );
}

function resolveChannelIds(ctx: SlackMonitorContext): string[] {
  const cfg = ctx.cfg;
  const slackCfg = cfg.channels?.slack;
  const channelIds: string[] = [];

  if (slackCfg) {
    // Top-level channels (single-account or default account)
    if (slackCfg.channels) {
      channelIds.push(...Object.keys(slackCfg.channels));
    }
    // Multi-account channels
    if (slackCfg.accounts) {
      for (const account of Object.values(slackCfg.accounts)) {
        if (account?.channels) {
          channelIds.push(...Object.keys(account.channels));
        }
      }
    }
  }

  return channelIds.filter((k) => k !== "*");
}

export function registerSlackAppHomeEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  // If explicitly disabled, don't register the event at all
  const homeTabConfig = resolveHomeTabConfig(ctx);
  if (homeTabConfig.enabled === false) {
    logVerbose("slack: home tab disabled via config");
    return;
  }

  const accountId = ctx.accountId;

  const homeScriptPath =
    homeTabConfig.customScript ??
    `${process.env.HOME}/.openclaw/workspace/scripts/push-home-tab.py`;

  function runCustomScript(userId: string | undefined, reason: string): void {
    execFile("python3", [homeScriptPath], { timeout: 30_000 }, (err, stdout) => {
      if (err) {
        ctx.runtime.error?.(danger(`slack: home tab ${reason} script failed: ${String(err)}`));
      } else {
        logVerbose(`slack: home tab ${reason}${stdout ? ` — ${stdout.trim()}` : ""}`);
      }
    });
  }

  // Handle the "Refresh" button click from the Home tab
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx.app as any).action?.(
    "openclaw:home_tab_refresh",
    async (args: { ack: () => Promise<void>; body: Record<string, unknown> }) => {
      const { ack, body } = args;
      await ack();
      if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
        return;
      }
      const userId = (body.user as Record<string, unknown> | undefined)?.id as string | undefined;
      logVerbose(`slack: home tab refresh requested by ${userId ?? "unknown"}`);
      if (userId) {
        markHomeTabCustom(accountId, userId);
      }
      runCustomScript(userId, "refresh");
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx.app as any).event(
    "app_home_opened",
    async (args: { event: Record<string, unknown>; body: unknown }) => {
      const { event, body } = args;
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }

        // Only handle the "home" tab, not "messages"
        if (event.tab !== "home") {
          return;
        }

        if (!ctx.botUserId) {
          logVerbose("slack: skipping home tab publish — botUserId not available");
          return;
        }

        const userId = event.user as string;

        // If a custom script is configured, run it instead of the default view.
        // Mark the user as having a custom view so subsequent app_home_opened
        // events don't overwrite it with the default layout.
        if (homeTabConfig.customScript) {
          if (!hasCustomHomeTab(accountId, userId)) {
            markHomeTabCustom(accountId, userId);
            runCustomScript(userId, "on-open");
          }
          return;
        }

        // If the user has a custom (agent-pushed) view, don't overwrite it.
        if (hasCustomHomeTab(accountId, userId)) {
          logVerbose(`slack: home tab has custom view for ${userId}, skipping default publish`);
          return;
        }

        // Skip re-publish if this user already has the current version rendered
        if (hasCurrentHomeTab(accountId, userId, VERSION)) {
          logVerbose(`slack: home tab already published for ${userId}, skipping`);
          return;
        }

        // Deduplicate concurrent app_home_opened events for the same user
        if (isPublishInFlight(accountId, userId)) {
          logVerbose(`slack: home tab publish already in-flight for ${userId}, skipping`);
          return;
        }
        markPublishInFlight(accountId, userId);

        try {
          const slashCmd = resolveSlashCommandInfo(ctx);
          const botName = resolveBotName(ctx);
          const model = resolveAgentModelDisplay(
            (ctx.cfg.agents?.list ?? []).find((a) => a.default) ?? ctx.cfg.agents?.list?.[0],
            ctx.cfg,
          );

          const viewParams: HomeTabParams = {
            botName,
            showCommands: homeTabConfig.showCommands,
            slashCommandName: slashCmd.name,
            slashCommandEnabled: slashCmd.enabled,
            customBlocks: homeTabConfig.customBlocks,
            version: VERSION,
            uptimeMs: processUptimeMs(),
            model,
            channelIds: resolveChannelIds(ctx),
            botUserId: ctx.botUserId,
            ownerTimezone: resolveUserTimezone(ctx.cfg.agents?.defaults?.userTimezone),
          };

          const view = buildDefaultHomeView(viewParams);

          await ctx.app.client.views.publish({
            token: ctx.botToken,
            user_id: userId,
            view,
          });

          markHomeTabPublished(accountId, userId, VERSION);
        } finally {
          clearPublishInFlight(accountId, userId);
        }
      } catch (err) {
        ctx.runtime.error?.(danger(`slack app_home_opened handler failed: ${String(err)}`));
      }
    },
  );
}
