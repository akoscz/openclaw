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
## Additional Secrets Providers

summary: "External secrets management: store credentials in GCP Secret Manager instead of plaintext files"
read_when:
  - You want to stop storing API keys in plaintext config files
  - You want per-agent secret isolation in multi-agent setups
  - You want to set up GCP Secret Manager for OpenClaw
  - You want to migrate existing plaintext secrets to a secrets store
title: "Secrets"
---

# External Secrets Management

OpenClaw can resolve secret references in configuration files at runtime, fetching values from an external secrets store instead of storing them in plaintext on disk.

## Why

- **No plaintext secrets on disk** — API keys, tokens, and credentials live in an encrypted, access-controlled store
- **Per-agent isolation** — in multi-agent setups, each agent only accesses secrets it's authorized for (enforced by GCP IAM, not application code)
- **Audit trail** — GCP Secret Manager logs all access
- **Safe version control** — config files contain references (`${gcp:name}`), not actual secrets
- **Rotation without restarts** — update the secret in the store; cached values expire automatically

## Supported Providers

| Provider            | Status       |
| ------------------- | ------------ |
| GCP Secret Manager  | ✅ Supported |
| AWS Secrets Manager | Planned      |
| HashiCorp Vault     | Planned      |
| Azure Key Vault     | Planned      |

## Quick Start

### 1. Prerequisites

- A GCP project with billing enabled
- `gcloud` CLI installed and authenticated (for setup only; not needed at runtime)
- VM or environment with `cloud-platform` OAuth scope (for Compute Engine VMs)

#### Compute Engine VM Setup

If running on a GCP Compute Engine VM:

**OAuth Scopes** — the VM must have `cloud-platform` scope. To update (requires VM restart):

```bash
gcloud compute instances stop <instance> --zone=<zone>
gcloud compute instances set-service-account <instance> --zone=<zone> --scopes=cloud-platform
gcloud compute instances start <instance> --zone=<zone>
```

**IAM Roles** — the compute service account needs these roles:

| Role                                 | Purpose                                     | Required                        |
| ------------------------------------ | ------------------------------------------- | ------------------------------- |
| `roles/secretmanager.secretAccessor` | Read secret values at runtime               | Always                          |
| `roles/secretmanager.admin`          | Create secrets, set per-secret IAM bindings | For setup & per-agent isolation |

Grant via CLI:

```bash
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:<service-account-email>" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:<service-account-email>" \
  --role="roles/secretmanager.admin"
```

Or via the GCP Console:

1. Go to **IAM & Admin → IAM**
2. Find the compute service account
3. Click **Edit** (pencil icon)
4. Add both roles
5. Save

> **Tip:** After setup is complete and per-agent isolation is configured, you can optionally remove `secretmanager.admin` from the compute SA — agents authenticate with their own service accounts at runtime.

### 2. Bootstrap

```bash
openclaw secrets setup --project my-gcp-project --agents main,chai
```

This will:

- Enable the Secret Manager API
- Create per-agent service accounts (`openclaw-main@`, `openclaw-chai@`)
- Generate service account key files
- Set per-secret IAM bindings
- Update `openclaw.json` with the `secrets` config section

Pass `--yes` to skip confirmation prompts.

### 3. Store a Secret

```bash
openclaw secrets set --provider gcp --name openclaw-main-brave-api-key --value "your-key-here"
```

### 4. Reference in Config

Replace plaintext values with secret references:

```json5
{
  // Before
  "apiKey": "sk-real-key-here"

  // After
  "apiKey": "${gcp:openclaw-main-brave-api-key}"
}
```

### 5. Verify

```bash
openclaw secrets test
```

## Secret Reference Syntax

References follow the pattern `${provider:secret-name}`:

```
${gcp:my-secret}          → latest version
${gcp:my-secret#3}        → pinned to version 3
${gcp:path/to/secret}     → slashes allowed in names
```

### Escaping

Use `$${}` to produce a literal `${}` in config:

```json5
{
  literal: "$${gcp:not-a-ref}", // → "${gcp:not-a-ref}"
}
```

### Distinction from Environment Variables

| Syntax              | Resolved by                     | Example                |
| ------------------- | ------------------------------- | ---------------------- |
| `${UPPER_CASE}`     | Env var substitution (existing) | `${BRAVE_API_KEY}`     |
| `${lowercase:name}` | Secret resolution (new)         | `${gcp:brave-api-key}` |

The lowercase provider prefix naturally distinguishes secret refs from env var refs.

## Configuration

Add a `secrets` section to `openclaw.json`:

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
    providers: {
      gcp: {
        // GCP project ID (required)
        project: "my-gcp-project",

        // Cache TTL in seconds (default: 300)
        cacheTtlSeconds: 300,

        // Path to service account key file (required for per-agent isolation)
        // If omitted, uses Application Default Credentials (ADC)
        credentialsFile: "/path/to/openclaw-main-sa.json",
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
## Auth Profiles

Secret references also work in `auth-profiles.json`:

```json
{
  "profiles": {
    "openai:default": {
      "type": "token",
      "provider": "openai",
      "token": "${gcp:openclaw-main-openai-token}"
    }
  }
}
```

## Per-Agent Isolation

Per-agent isolation ensures each agent can **only** read its own secrets, enforced at the GCP IAM level. This is not application-level filtering — GCP itself blocks unauthorized access.

### How It Works

Each agent gets:

1. **Its own GCP service account** (e.g., `openclaw-main@project.iam.gserviceaccount.com`)
2. **A service account key file** stored locally (e.g., `~/.config/gcp/openclaw-main-sa.json`)
3. **Per-secret IAM bindings** granting only that SA access to its secrets

### Naming Convention

Secrets are namespaced by agent name:

```
openclaw-main-*     → only the main agent can read
openclaw-chai-*     → only the chai agent can read
openclaw-shared-*   → multiple agents can read (both SAs get access)
```

### Setup Steps

**1. Create per-agent service accounts:**

```bash
gcloud iam service-accounts create openclaw-main \
  --display-name="OpenClaw Main Agent"
gcloud iam service-accounts create openclaw-chai \
  --display-name="OpenClaw Chai Agent"
```

**2. Generate key files:**

```bash
gcloud iam service-accounts keys create ~/.config/gcp/openclaw-main-sa.json \
  --iam-account=openclaw-main@<project>.iam.gserviceaccount.com
gcloud iam service-accounts keys create ~/.config/gcp/openclaw-chai-sa.json \
  --iam-account=openclaw-chai@<project>.iam.gserviceaccount.com
chmod 600 ~/.config/gcp/*.json
```

**3. Set per-secret IAM bindings:**

```bash
# Main agent's secrets → only main SA
gcloud secrets add-iam-policy-binding openclaw-main-openai-key \
  --member="serviceAccount:openclaw-main@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Chai agent's secrets → only chai SA
gcloud secrets add-iam-policy-binding openclaw-chai-alpaca-key \
  --member="serviceAccount:openclaw-chai@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Shared secrets → both SAs
gcloud secrets add-iam-policy-binding openclaw-shared-brave-key \
  --member="serviceAccount:openclaw-main@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding openclaw-shared-brave-key \
  --member="serviceAccount:openclaw-chai@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

**4. Configure each agent to use its own SA:**

Main agent's `openclaw.json`:

```json5
{
  secrets: {
    provider: "keyring",
    keyring: {
      keychainPath: "~/Library/Keychains/openclaw.keychain-db",
      keychainPassword: "",
      account: "openclaw",
    providers: {
      gcp: {
        project: "my-project",
        credentialsFile: "/home/user/.config/gcp/openclaw-main-sa.json",
      },
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
Chai agent's `openclaw.json`:

```json5
{
  secrets: {
    provider: "keyring",
    providers: {
      gcp: {
        project: "my-project",
        credentialsFile: "/home/user/.config/gcp/openclaw-chai-sa.json",
      },
    },
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
### Verification

After setup, verify isolation is enforced:

```
✅ main reads openclaw-main-openai-key     → access granted
🔒 main reads openclaw-chai-alpaca-key     → PERMISSION_DENIED
✅ chai reads openclaw-chai-alpaca-key     → access granted
🔒 chai reads openclaw-main-openai-key     → PERMISSION_DENIED
```

If an agent tries to read another agent's secret, GCP returns `PERMISSION_DENIED` — the request never reaches OpenClaw.

## Worked Example: Multi-Agent Migration

This example walks through migrating a two-agent setup (main + chai) from plaintext to GCP Secret Manager with full isolation.

### Before (plaintext)

```
~/.config/openai/credentials.env     → OPENAI_API_KEY=sk-proj-abc123...
~/.config/alpaca/sandbox.env         → ALPACA_KEY_ID=CKN... / ALPACA_SECRET_KEY=7TV...
~/.config/himalaya/.nine30-pass      → cbmc pxsf mlzr puea
openclaw.json                        → "apiKey": "BSAIGr...", "token": "83a1aa..."
```

All secrets in plaintext. Any agent or process on the machine can read everything.

### Step 1: Enable Secret Manager API

```bash
gcloud services enable secretmanager.googleapis.com --project=my-project
```

### Step 2: Store secrets with agent-namespaced names

```bash
# Main agent secrets
openclaw secrets set --provider gcp --name openclaw-main-openai-api-key --value "sk-proj-abc123..."
openclaw secrets set --provider gcp --name openclaw-main-brave-api-key --value "BSAIGr..."
openclaw secrets set --provider gcp --name openclaw-main-gateway-token --value "83a1aa..."
openclaw secrets set --provider gcp --name openclaw-main-email-password --value "cbmc pxsf mlzr puea"

# Chai agent secrets
openclaw secrets set --provider gcp --name openclaw-chai-alpaca-key-id --value "CKN..."
openclaw secrets set --provider gcp --name openclaw-chai-alpaca-secret-key --value "7TV..."
```

### Step 3: Create service accounts and keys

```bash
gcloud iam service-accounts create openclaw-main --display-name="OpenClaw Main Agent"
gcloud iam service-accounts create openclaw-chai --display-name="OpenClaw Chai Agent"

gcloud iam service-accounts keys create ~/.config/gcp/openclaw-main-sa.json \
  --iam-account=openclaw-main@my-project.iam.gserviceaccount.com
gcloud iam service-accounts keys create ~/.config/gcp/openclaw-chai-sa.json \
  --iam-account=openclaw-chai@my-project.iam.gserviceaccount.com

chmod 600 ~/.config/gcp/*.json
```

### Step 4: Set per-secret IAM bindings

```bash
# Main-only secrets
for SECRET in openclaw-main-openai-api-key openclaw-main-brave-api-key \
              openclaw-main-gateway-token openclaw-main-email-password; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:openclaw-main@my-project.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done

# Chai-only secrets
for SECRET in openclaw-chai-alpaca-key-id openclaw-chai-alpaca-secret-key; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:openclaw-chai@my-project.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

### Step 5: Update config files with references

Main agent's `openclaw.json`:

```json5
{
  secrets: {
    providers: {
      gcp: {
        project: "my-project",
        credentialsFile: "/home/user/.config/gcp/openclaw-main-sa.json",
      },
    },
  },
  tools: {
    web: {
      search: {
        apiKey: "${gcp:openclaw-main-brave-api-key}",
      },
    },
  },
  gateway: {
    auth: {
      token: "${gcp:openclaw-main-gateway-token}",
    },
  },
}
```

### Step 6: Purge plaintext files

Only after verifying all references resolve (`openclaw secrets test`):

```bash
# Replace file contents with migration notes
echo "# Migrated to GCP Secret Manager" > ~/.config/openai/credentials.env
echo "# Migrated to GCP Secret Manager" > ~/.config/alpaca/sandbox.env
echo "# Migrated to GCP Secret Manager" > ~/.config/himalaya/.nine30-pass
```

### After

```
GCP Secret Manager (encrypted, access-controlled):
  openclaw-main-openai-api-key      → only main SA can read
  openclaw-main-brave-api-key       → only main SA can read
  openclaw-main-gateway-token       → only main SA can read
  openclaw-main-email-password      → only main SA can read
  openclaw-chai-alpaca-key-id       → only chai SA can read
  openclaw-chai-alpaca-secret-key   → only chai SA can read

Local disk:
  ~/.config/gcp/openclaw-main-sa.json  (SA key — the only secret on disk)
  ~/.config/gcp/openclaw-chai-sa.json  (SA key — the only secret on disk)
  openclaw.json                        (contains ${gcp:...} refs, safe to commit)
```

> **Note:** The SA key files are the one remaining secret on disk. Protect them with `chmod 600` and restrict filesystem access. On GKE or Cloud Run, use Workload Identity to eliminate even these files.

### External scripts

Scripts that need secrets (e.g., monitoring scripts, cron jobs) can also use per-agent SA keys:

```python
from google.cloud import secretmanager

# Use Chai's SA key — can only access openclaw-chai-* secrets
client = secretmanager.SecretManagerServiceClient.from_service_account_json(
    "/home/user/.config/gcp/openclaw-chai-sa.json"
)
response = client.access_secret_version(
    request={"name": "projects/my-project/secrets/openclaw-chai-alpaca-key-id/versions/latest"}
)
api_key = response.payload.data.decode("utf-8")
```

## Migration

To migrate existing plaintext secrets:

```bash
openclaw secrets migrate
```

This will:

1. Scan config files for sensitive values (API keys, tokens)
2. Upload each to GCP Secret Manager
3. Replace plaintext values with `${gcp:name}` references
4. Verify all references resolve
5. Prompt before purging plaintext originals

Pass `--yes` to skip confirmation prompts. Plaintext is **never** purged unless the upload and verification succeed.

## Caching

- Secrets are cached **in memory only** (never written to disk)
- Default TTL: 300 seconds (configurable per-provider)
- Cache is cleared on `SIGUSR1` restart
- **Stale-while-revalidate**: if the provider is unreachable and cached values exist (even expired), stale values are used and a warning is logged

## CLI Commands

| Command                    | Description                                                          |
| -------------------------- | -------------------------------------------------------------------- |
| `openclaw secrets setup`   | Bootstrap GCP Secret Manager (enable API, create SAs, configure IAM) |
| `openclaw secrets test`    | Verify all secret references resolve successfully                    |
| `openclaw secrets list`    | List configured providers and their status                           |
| `openclaw secrets set`     | Store a secret manually                                              |
| `openclaw secrets migrate` | Migrate plaintext secrets to the store                               |

## Error Handling

| Error                                        | Behavior                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| Provider not configured                      | Feature using the secret fails; system continues                        |
| Secret not found                             | Clear error: "Secret 'name' not found in project 'project'"             |
| Permission denied                            | Clear error: "Permission denied for secret 'name'. Check IAM bindings." |
| Network timeout                              | Retry once; fall back to stale cache if available                       |
| `@google-cloud/secret-manager` not installed | Clear error with install instructions                                   |

## Backward Compatibility

- **Entirely opt-in**: no `secrets` config = no behavior change
- `@google-cloud/secret-manager` is an optional dependency
- Existing env var substitution (`${UPPER_CASE}`) is unaffected
- Config files without secret refs pass through unchanged
