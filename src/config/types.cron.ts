export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  /**
   * How long to retain completed cron run sessions before automatic pruning.
   * Accepts a duration string (e.g. "24h", "7d", "1h30m") or `false` to disable pruning.
   * Default: "24h".
   *
   * @deprecated Use `session.maintenance.pruneRules.cronRun` instead.
   * When both are set, `pruneRules.cronRun` takes precedence.
   */
  sessionRetention?: string | false;
};
