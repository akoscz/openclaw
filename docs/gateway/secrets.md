---
summary: "Secrets management: SecretRef contract, runtime snapshot behavior, and safe one-way scrubbing"
read_when:
  - Configuring SecretRefs for providers, auth profiles, skills, or Google Chat
  - Operating secrets reload/audit/configure/apply safely in production
  - Understanding fail-fast and last-known-good behavior
title: "Secrets Management"
---

# Secrets management

OpenClaw supports additive secret references so credentials do not need to be stored as plaintext in config files.

Plaintext still works. Secret refs are optional.

## Goals and runtime model

Secrets are resolved into an in-memory runtime snapshot.

- Resolution is eager during activation, not lazy on request paths.
- Startup fails fast if any referenced credential cannot be resolved.
- Reload uses atomic swap: full success or keep last-known-good.
- Runtime requests read from the active in-memory snapshot.

This keeps secret-provider outages off the hot request path.

## Onboarding reference preflight

When onboarding runs in interactive mode and you choose secret reference storage, OpenClaw performs a fast preflight check before saving:

- Env refs: validates env var name and confirms a non-empty value is visible during onboarding.
- Provider refs (`file` or `exec`): validates the selected provider, resolves the provided `id`, and checks value type.

If validation fails, onboarding shows the error and lets you retry.

## SecretRef contract

Use one object shape everywhere:

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

### `source: "env"`

```json5
{ source: "env", provider: "default", id: "OPENAI_API_KEY" }
```

Validation:

- `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
- `id` must match `^[A-Z][A-Z0-9_]{0,127}$`

### `source: "file"`

```json5
{ source: "file", provider: "filemain", id: "/providers/openai/apiKey" }
```

Validation:

- `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
- `id` must be an absolute JSON pointer (`/...`)
- RFC6901 escaping in segments: `~` => `~0`, `/` => `~1`

### `source: "exec"`

```json5
{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }
```

Validation:

- `provider` must match `^[a-z][a-z0-9_-]{0,63}$`
- `id` must match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`

## Provider config

Define providers under `secrets.providers`:

```json5
{
  secrets: {
    providers: {
      default: { source: "env" },
      filemain: {
        source: "file",
        path: "~/.openclaw/secrets.json",
        mode: "json", // or "singleValue"
      },
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
        args: ["--profile", "prod"],
        passEnv: ["PATH", "VAULT_ADDR"],
        jsonOnly: true,
      },
    },
    defaults: {
      env: "default",
      file: "filemain",
      exec: "vault",
    },
    resolution: {
      maxProviderConcurrency: 4,
      maxRefsPerProvider: 512,
      maxBatchBytes: 262144,
    },
  },
}
```

### Env provider

- Optional allowlist via `allowlist`.
- Missing/empty env values fail resolution.

### File provider

- Reads local file from `path`.
- `mode: "json"` expects JSON object payload and resolves `id` as pointer.
- `mode: "singleValue"` expects ref id `"value"` and returns file contents.
- Path must pass ownership/permission checks.

### Exec provider

- Runs configured absolute binary path, no shell.
- By default, `command` must point to a regular file (not a symlink).
- Set `allowSymlinkCommand: true` to allow symlink command paths (for example Homebrew shims). OpenClaw validates the resolved target path.
- Enable `allowSymlinkCommand` only when required for trusted package-manager paths, and pair it with `trustedDirs` (for example `["/opt/homebrew"]`).
- When `trustedDirs` is set, checks apply to the resolved target path.
- Supports timeout, no-output timeout, output byte limits, env allowlist, and trusted dirs.
- Request payload (stdin):

```json
{ "protocolVersion": 1, "provider": "vault", "ids": ["providers/openai/apiKey"] }
```

- Response payload (stdout):

```json
{ "protocolVersion": 1, "values": { "providers/openai/apiKey": "sk-..." } }
```

Optional per-id errors:

```json
{
  "protocolVersion": 1,
  "values": {},
  "errors": { "providers/openai/apiKey": { "message": "not found" } }
}
```

## Exec integration examples

### 1Password CLI

```json5
{
  secrets: {
    providers: {
      onepassword_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/op",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["read", "op://Personal/OpenClaw QA API Key/password"],
        passEnv: ["HOME"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "onepassword_openai", id: "value" },
      },
    },
  },
}
```

### HashiCorp Vault CLI

```json5
{
  secrets: {
    providers: {
      vault_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/vault",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["kv", "get", "-field=OPENAI_API_KEY", "secret/openclaw"],
        passEnv: ["VAULT_ADDR", "VAULT_TOKEN"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "vault_openai", id: "value" },
      },
    },
  },
}
```

### `sops`

```json5
{
  secrets: {
    providers: {
      sops_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/sops",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["-d", "--extract", '["providers"]["openai"]["apiKey"]', "/path/to/secrets.enc.json"],
        passEnv: ["SOPS_AGE_KEY_FILE"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "sops_openai", id: "value" },
      },
    },
  },
}
```

## In-scope fields (v1)

### `~/.openclaw/openclaw.json`

- `models.providers.<provider>.apiKey`
- `skills.entries.<skillKey>.apiKey`
- `channels.googlechat.serviceAccount`
- `channels.googlechat.serviceAccountRef`
- `channels.googlechat.accounts.<accountId>.serviceAccount`
- `channels.googlechat.accounts.<accountId>.serviceAccountRef`

### `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

- `profiles.<profileId>.keyRef` for `type: "api_key"`
- `profiles.<profileId>.tokenRef` for `type: "token"`

OAuth credential storage changes are out of scope.

## Required behavior and precedence

- Field without ref: unchanged.
- Field with ref: required at activation time.
- If plaintext and ref both exist, ref wins at runtime and plaintext is ignored.

Warning code:

- `SECRETS_REF_OVERRIDES_PLAINTEXT`

## Activation triggers

Secret activation is attempted on:

- Startup (preflight plus final activation)
- Config reload hot-apply path
- Config reload restart-check path
- Manual reload via `secrets.reload`

Activation contract:

- Success swaps the snapshot atomically.
- Startup failure aborts gateway startup.
- Runtime reload failure keeps last-known-good snapshot.

## Degraded and recovered operator signals

When reload-time activation fails after a healthy state, OpenClaw enters degraded secrets state.

One-shot system event and log codes:

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

Behavior:

- Degraded: runtime keeps last-known-good snapshot.
- Recovered: emitted once after a successful activation.
- Repeated failures while already degraded log warnings but do not spam events.
- Startup fail-fast does not emit degraded events because no runtime snapshot exists yet.

## Audit and configure workflow

Use this default operator flow:

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

Migration completeness:

- Include `skills.entries.<skillKey>.apiKey` targets when those skills use API keys.
- If `audit --check` still reports plaintext findings after a partial migration, migrate the remaining reported paths and rerun audit.

### `secrets audit`

Findings include:

- plaintext values at rest (`openclaw.json`, `auth-profiles.json`, `.env`)
- unresolved refs
- precedence shadowing (`auth-profiles` taking priority over config refs)
- legacy residues (`auth.json`, OAuth out-of-scope reminders)

### `secrets configure`

Interactive helper that:

- configures `secrets.providers` first (`env`/`file`/`exec`, add/edit/remove)
- lets you select secret-bearing fields in `openclaw.json`
- captures SecretRef details (`source`, `provider`, `id`)
- runs preflight resolution
- can apply immediately

Helpful modes:

- `openclaw secrets configure --providers-only`
- `openclaw secrets configure --skip-provider-setup`

`configure` apply defaults to:

- scrub matching static creds from `auth-profiles.json` for targeted providers
- scrub legacy static `api_key` entries from `auth.json`
- scrub matching known secret lines from `<config-dir>/.env`

### `secrets apply`

Apply a saved plan:

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
```

For strict target/path contract details and exact rejection rules, see:

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

## One-way safety policy

OpenClaw intentionally does **not** write rollback backups that contain pre-migration plaintext secret values.

Safety model:

- preflight must succeed before write mode
- runtime activation is validated before commit
- apply updates files using atomic file replacement and best-effort in-memory restore on failure

## `auth.json` compatibility notes

For static credentials, OpenClaw runtime no longer depends on plaintext `auth.json`.

- Runtime credential source is the resolved in-memory snapshot.
- Legacy `auth.json` static `api_key` entries are scrubbed when discovered.
- OAuth-related legacy compatibility behavior remains separate.

## Related docs

- CLI commands: [secrets](/cli/secrets)
- Plan contract details: [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)
- Auth setup: [Authentication](/gateway/authentication)
- Security posture: [Security](/gateway/security)
- Environment precedence: [Environment Variables](/help/environment)

---

## Dollar-Secret Pattern Resolution (\{NAME})

Set the variable before starting OpenClaw:

```bash
export OPENROUTER_API_KEY="sk-or-..."
openclaw gateway start
```

### 2) Switch to GCP Secret Manager for production

```json5
{
  secrets: {
    provider: "gcp",
    gcp: { project: "my-prod-project" },
  },
  gateway: {
    auth: {
      token: "$secret{OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

## Configuration

Full `secrets` config block:

```json5
{
  secrets: {
    // Supported: gcp, env, keyring
    // Planned (not yet implemented): aws, 1password, doppler, bitwarden, vault
    provider: "gcp" | "env" | "keyring" | "aws" | "1password" | "doppler" | "bitwarden" | "vault",
    gcp: { project: "..." },          // required when provider is "gcp"
    aws: { region: "..." },
    doppler: { project: "...", config: "..." },
    vault: { address: "...", namespace: "...", mountPath: "..." },
    keyring: { keychainPath: "...", keychainPassword: "...", account: "..." },
  },
}
```

Only configure the provider block you use.

## Syntax

- `$secret{NAME}`: resolves to the secret value
- `$$secret{NAME}`: escapes to literal `$secret{NAME}`
- **Valid secret names:** alphanumeric characters, hyphens, underscores, and dots (`[a-zA-Z0-9_.-]+`). Examples: `my-api-key`, `slack.bot.token`, `DB_PASSWORD_v2`
- Works in any string value in config
- Resolution happens **after** `${ENV_VAR}` substitution
  - This means you can use env vars inside `secrets` provider settings
- The `secrets` block itself is **not** secret-resolved (prevents circular dependencies)

## Provider Guides

### Environment Variables (`env`)

Best for local testing, CI/CD, and Docker-based deployments.

```json5
{
  secrets: { provider: "env" },
  channels: {
    telegram: {
      botToken: "$secret{TELEGRAM_BOT_TOKEN}",
    },
  },
}
```

Set environment variables:

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC..."
export OPENROUTER_API_KEY="sk-or-..."
```

In CI/Docker, set them using your platform’s secret/env settings.

### GCP Secret Manager (`gcp`)

Prerequisites:

- Install dependency: `pnpm add @google-cloud/secret-manager`
- Configure ADC (Application Default Credentials)
- Set `project` in config (required — Secret Manager doesn't support automatic project discovery)

Create a secret:

```bash
gcloud secrets create NAME --data-file=-
```

Then paste/pipe the secret value when prompted.

Example config:

```json5
{
  secrets: {
    provider: "gcp",
    gcp: { project: "my-project-id" },
  },
  models: {
    providers: {
      openai: {
        apiKey: "$secret{OPENAI_API_KEY}",
      },
    },
  },
}
```

How ADC works:

- Local development: typically uses your user credentials from `gcloud auth application-default login`
- Containers/servers: typically uses attached service account credentials

### OS Keyring (`keyring`)

#### macOS

Uses the `security` CLI with a dedicated OpenClaw keychain.

Create keychain:

```bash
security create-keychain -p '' ~/Library/Keychains/openclaw.keychain-db
```

Add secret:

```bash
security add-generic-password -a openclaw -s NAME -w "VALUE" ~/Library/Keychains/openclaw.keychain-db
```

Example config:

```json5
{
  secrets: {
    provider: "keyring",
    keyring: {
      keychainPath: "~/Library/Keychains/openclaw.keychain-db",
      keychainPassword: "",
      account: "openclaw",
    },
  },
}
```

#### Linux

Uses `secret-tool` (libsecret / D-Bus Secret Service).

Install libsecret tools:

```bash
# Arch
sudo pacman -S libsecret

# Debian/Ubuntu
sudo apt install libsecret-tools

# Fedora
sudo dnf install libsecret
```

Add secret:

```bash
echo -n "VALUE" | secret-tool store --label="openclaw: NAME" service openclaw key NAME
```

Example config:

```json5
{
  secrets: {
    provider: "keyring",
  },
}
```

#### Windows

Not yet supported.

### Coming Soon

The following providers are recognized in config but **not yet implemented**:

- AWS Secrets Manager (`aws`)
- 1Password (`1password`)
- Doppler (`doppler`)
- Bitwarden (`bitwarden`)
- HashiCorp Vault (`vault`)

**Behavior when configured:**

- If your config has `$secret{...}` references → startup **fails immediately** with a clear
  error telling you the provider isn't available yet and listing supported alternatives.
- If your config has **no** `$secret{...}` references → startup **succeeds with a warning**
  in the logs, so you're aware the provider won't work when you add secret references later.

This means you can safely prepare your config for a future provider switch without breaking
your current setup — just don't add `$secret{...}` references until the provider is implemented.

Contributions are welcome — see the stub files in `src/config/secrets/`.

## Sync vs Async

`$secret{...}` resolution requires async config loading.

The Gateway handles this automatically during normal startup. If secret references are detected in a sync-only load path, OpenClaw throws a clear error instead of silently continuing.

## Error Diagnostics

When `$secret{...}` references remain unresolved (e.g. sync load path), error messages include
the full config path where each reference was found:

```
Unresolved secret references: $secret{OPENAI_KEY} at models.providers.openai.apiKey
```

This helps you quickly locate which config field needs attention, especially in large configs
with multiple secret references.

## Troubleshooting

- `GCP secrets provider requires 'gcp.project' to be set`
  - Add `gcp: { project: "your-project-id" }` to your `secrets` config block
- `Failed to load @google-cloud/secret-manager`
  - Install the dependency in your OpenClaw environment:
    - `pnpm add @google-cloud/secret-manager`
- `secret-tool not found`
  - Install libsecret tools (`libsecret-tools` on Debian/Ubuntu)
- `Secret not found in keychain`
  - Add it with the keychain CLI commands above and verify `NAME` matches exactly
- `Config contains $secret{...} references but secrets can only be resolved in async mode`
  - Start the gateway normally (`openclaw gateway start`) so async config loading is used
