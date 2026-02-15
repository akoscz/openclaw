/**
 * Secret reference substitution for config values.
 *
 * Supports `${gcp:SECRET_NAME}` syntax in string values, resolved at config load time.
 * Secrets are fetched from external providers (e.g. Google Cloud Secret Manager)
 * and cached with a configurable TTL.
 *
 * @example
 * ```json5
 * {
 *   secrets: {
 *     providers: {
 *       gcp: { project: "my-project" }
 *     }
 *   },
 *   channels: {
 *     slack: {
 *       botToken: "${gcp:slack-bot-token}"
 *     }
 *   }
 * }
 * ```
 */

import { isPlainObject } from "../utils.js";

// Matches ${provider:secret-name} where provider is lowercase alpha and
// secret-name allows alphanumeric, hyphens, underscores, slashes, and dots.
const SECRET_REF_PATTERN = /\$\{([a-z]+):([a-zA-Z0-9_\-/.]+)\}/g;

/** Configuration for the secrets section in openclaw.json. */
export type SecretsConfig = {
  providers?: {
    gcp?: {
      /** GCP project ID for Secret Manager. */
      project: string;
      /** Cache TTL in seconds. Default: 300 (5 minutes). */
      cacheTtlSeconds?: number;
    };
  };
};

export class SecretResolutionError extends Error {
  constructor(
    public readonly provider: string,
    public readonly secretName: string,
    public readonly configPath: string,
    cause?: Error,
  ) {
    super(
      `Failed to resolve secret "${provider}:${secretName}" at config path: ${configPath}${cause ? ` — ${cause.message}` : ""}`,
    );
    this.name = "SecretResolutionError";
    this.cause = cause;
  }
}

export class UnknownSecretProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly configPath: string,
  ) {
    super(`Unknown secret provider "${provider}" referenced at config path: ${configPath}`);
    this.name = "UnknownSecretProviderError";
  }
}

type CacheEntry = {
  value: string;
  expiresAt: number;
};

/** In-memory cache for resolved secrets, keyed by `provider:name`. */
const secretCache = new Map<string, CacheEntry>();

/** Clear the secret cache (useful for testing). */
export function clearSecretCache(): void {
  secretCache.clear();
}

/** Interface for a secrets provider backend. */
export interface SecretProvider {
  resolve(secretName: string): Promise<string>;
}

/** GCP Secret Manager provider using dynamic import for optional dependency. */
class GcpSecretProvider implements SecretProvider {
  private readonly project: string;
  private readonly cacheTtlMs: number;
  private client: unknown | null = null;

  constructor(config: NonNullable<SecretsConfig["providers"]>["gcp"]) {
    if (!config) {
      throw new Error("GCP secret provider requires configuration with a project ID");
    }
    this.project = config.project;
    this.cacheTtlMs = (config.cacheTtlSeconds ?? 300) * 1000;
  }

  async resolve(secretName: string): Promise<string> {
    const cacheKey = `gcp:${secretName}`;
    const cached = secretCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const client = await this.getClient();
    const name = `projects/${this.project}/secrets/${secretName}/versions/latest`;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const [version] = await (client as any).accessSecretVersion({ name });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const payload = version?.payload?.data;
    if (!payload) {
      throw new Error(`Secret "${secretName}" has no payload data`);
    }

    const value =
      payload instanceof Uint8Array || Buffer.isBuffer(payload)
        ? Buffer.from(payload).toString("utf-8")
        : String(payload);

    secretCache.set(cacheKey, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }

  private async getClient(): Promise<unknown> {
    if (this.client) {
      return this.client;
    }
    try {
      // Dynamic import — @google-cloud/secret-manager is an optional dependency.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      this.client = new SecretManagerServiceClient();
      return this.client;
    } catch {
      throw new Error(
        'GCP Secret Manager requires the "@google-cloud/secret-manager" package. ' +
          "Install it with: pnpm add @google-cloud/secret-manager",
      );
    }
  }
}

/** Check whether a string contains any secret references (`${provider:name}`). */
export function containsSecretReference(value: string): boolean {
  if (!value.includes("${")) {
    return false;
  }
  SECRET_REF_PATTERN.lastIndex = 0;
  return SECRET_REF_PATTERN.test(value);
}

/** Extract all secret references from a config object (for pre-flight checks). */
export function extractSecretReferences(obj: unknown): Array<{ provider: string; name: string }> {
  const refs: Array<{ provider: string; name: string }> = [];

  function walk(value: unknown): void {
    if (typeof value === "string" && value.includes("${")) {
      SECRET_REF_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SECRET_REF_PATTERN.exec(value)) !== null) {
        refs.push({ provider: match[1], name: match[2] });
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
    } else if (isPlainObject(value)) {
      for (const val of Object.values(value)) {
        walk(val);
      }
    }
  }

  walk(obj);
  return refs;
}

async function substituteString(
  value: string,
  providers: Map<string, SecretProvider>,
  configPath: string,
): Promise<string> {
  if (!value.includes("${")) {
    return value;
  }

  // Collect all matches first, then resolve in parallel.
  SECRET_REF_PATTERN.lastIndex = 0;
  const matches: Array<{ full: string; provider: string; name: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = SECRET_REF_PATTERN.exec(value)) !== null) {
    matches.push({ full: match[0], provider: match[1], name: match[2] });
  }

  if (matches.length === 0) {
    return value;
  }

  // Resolve all secrets in parallel.
  const resolved = await Promise.all(
    matches.map(async ({ provider: providerName, name, full }) => {
      const provider = providers.get(providerName);
      if (!provider) {
        throw new UnknownSecretProviderError(providerName, configPath);
      }
      try {
        return { full, value: await provider.resolve(name) };
      } catch (err) {
        throw new SecretResolutionError(
          providerName,
          name,
          configPath,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }),
  );

  let result = value;
  for (const { full, value: secretValue } of resolved) {
    result = result.replace(full, secretValue);
  }
  return result;
}

async function substituteAny(
  value: unknown,
  providers: Map<string, SecretProvider>,
  path: string,
): Promise<unknown> {
  if (typeof value === "string") {
    return substituteString(value, providers, path);
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item, index) => substituteAny(item, providers, `${path}[${index}]`)));
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    const resolved = await Promise.all(
      entries.map(async ([key, val]) => {
        const childPath = path ? `${path}.${key}` : key;
        return [key, await substituteAny(val, providers, childPath)] as const;
      }),
    );
    return Object.fromEntries(resolved);
  }

  // Primitives pass through.
  return value;
}

/** Build provider instances from the secrets config section. */
export function buildSecretProviders(
  secretsConfig: SecretsConfig | undefined,
): Map<string, SecretProvider> {
  const providers = new Map<string, SecretProvider>();
  if (!secretsConfig?.providers) {
    return providers;
  }

  if (secretsConfig.providers.gcp) {
    providers.set("gcp", new GcpSecretProvider(secretsConfig.providers.gcp));
  }

  return providers;
}

/**
 * Resolves `${provider:SECRET_NAME}` secret references in config values.
 *
 * This is the async counterpart to `resolveConfigEnvVars` and runs after env
 * var substitution in the config loading pipeline.
 *
 * @param obj - The config object (after env var substitution)
 * @param secretsConfig - The `secrets` section from the config
 * @returns The config object with secrets resolved
 */
export async function resolveConfigSecrets(
  obj: unknown,
  secretsConfig: SecretsConfig | undefined,
): Promise<unknown> {
  // Fast path: if no secrets config, check whether there are any references at all.
  const refs = extractSecretReferences(obj);
  if (refs.length === 0) {
    return obj;
  }

  const providers = buildSecretProviders(secretsConfig);
  if (providers.size === 0 && refs.length > 0) {
    // There are secret references but no providers configured.
    const firstRef = refs[0];
    throw new UnknownSecretProviderError(firstRef.provider, "(config)");
  }

  return substituteAny(obj, providers, "");
}

/**
 * Synchronous check: returns true if the config object contains any secret
 * references that need async resolution. Used to decide whether to enter
 * the async secrets resolution path.
 */
export function configNeedsSecretResolution(obj: unknown): boolean {
  return extractSecretReferences(obj).length > 0;
}

// Re-export for testing.
export { GcpSecretProvider };
