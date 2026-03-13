# opencode-session-auto-title

Batch rename [OpenCode](https://opencode.ai) sessions that still have default titles (`New session - <timestamp>`) using AI-generated titles via OpenCode's built-in `title` agent.

## The Problem

OpenCode auto-generates session titles on the first user message using a built-in `title` agent and the configured `small_model`. However, this can silently fail if:

- `small_model` is misconfigured (e.g., using `@default` variant suffix that doesn't resolve)
- The model/provider is unavailable at the time of session creation
- Sessions were created before the title feature existed

The result: dozens or hundreds of sessions all named `New session - 2026-01-15T...`, making session history unusable.

This script fixes that retroactively by generating titles for all existing default-titled sessions.

## How It Works

1. Queries the OpenCode SQLite database for parent sessions with default titles
2. For each session, fetches its messages via the OpenCode HTTP API
3. Extracts the first non-synthetic user message as context
4. Creates a temporary worker session and invokes the built-in `title` agent to generate a concise title
5. Updates the session title via `PATCH /session/{id}`
6. Cleans up the worker session

The script uses the same `title` agent and prompt format that OpenCode uses internally for auto-titling, so generated titles are consistent with the native behavior.

## Prerequisites

- [OpenCode](https://opencode.ai) installed
- `sqlite3` available on PATH
- `npx` and `tsx` (or `bun`) to run TypeScript

## Quick Start

```bash
# 1. Start the OpenCode server (if not already running)
opencode serve --port 4096

# 2. Clone this repo
git clone https://github.com/mdiloreto/opencode-session-auto-title.git
cd opencode-session-auto-title

# 3. Dry-run on 5 sessions first
MAX_SESSIONS=5 npx tsx scripts/batch-rename-sessions.ts

# 4. Run on all default-titled sessions
npx tsx scripts/batch-rename-sessions.ts
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_PROVIDER` | `anthropic` | Provider ID for the title model |
| `OPENCODE_MODEL` | `claude-haiku-4-5` | Model ID for title generation |
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | Path to OpenCode SQLite database |
| `MAX_SESSIONS` | `0` (all) | Limit number of sessions to process |
| `REQUEST_DELAY` | `1200` | Delay in ms between API requests |

### Example with custom provider

```bash
# Using OpenAI
OPENCODE_PROVIDER=openai OPENCODE_MODEL=gpt-4o-mini npx tsx scripts/batch-rename-sessions.ts

# Using Google Vertex Anthropic
OPENCODE_PROVIDER=google-vertex-anthropic OPENCODE_MODEL=claude-haiku-4-5@20251001 npx tsx scripts/batch-rename-sessions.ts

# Using a different server port
OPENCODE_URL=http://127.0.0.1:8080 npx tsx scripts/batch-rename-sessions.ts
```

## Output

```
OpenCode server: http://127.0.0.1:4096
Model: anthropic/claude-haiku-4-5
Database: /Users/you/.local/share/opencode/opencode.db

Found 122 default-titled parent sessions. Processing 122.

[1/122] ses_38a1f5f00ffej39j -> Kubectx duplicate context cleanup
[2/122] ses_38dcc434cffeL8F6 -> JPMC file import 503 error fix
[3/122] ses_38c9f7b12ffeQyQu -> Git blame configuration check
...

=== Done ===
Renamed: 120  Skipped: 2  Failed: 0
```

Sessions are **skipped** when they have no non-synthetic user content (e.g., empty sessions or sessions with only system-generated messages).

## How OpenCode Title Generation Works Internally

Understanding the internals helps explain why titles can silently fail:

1. When the first user message is sent, `ensureTitle()` fires in [`packages/opencode/src/session/prompt.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts)
2. It checks if the session still has a default title (`Session.isDefaultTitle()`)
3. Resolves the model via `Provider.getSmallModel(providerID)`, which reads `small_model` from config
4. Uses the built-in `title` agent to generate a title from the conversation context
5. Calls `Session.setTitle()` to persist it

**The silent failure bug ([#14807](https://github.com/anomalyco/opencode/issues/14807))**: `ensureTitle()` is called without `.catch()` at the call site, so if `small_model` is misconfigured, the error becomes an unhandled promise rejection. The session keeps its default name and no error is shown to the user.

### Common `small_model` pitfalls

- `provider/model@default` - the `@default` variant may not exist in the provider's model registry
- The model ID must match a key in `provider.models` exactly (checked via `provider.models[modelID]` lookup)
- Run `opencode models <provider>` to see valid model IDs for your provider

## Example Plugin

The `examples/` directory includes a session hooks plugin that demonstrates:

- Hooking into `session.created` and `session.idle` events
- Playing notification sounds when a task completes
- Running shell scripts on session lifecycle events

> Note: You do NOT need a plugin for auto-titling. That's handled by OpenCode core. The plugin is for additional lifecycle hooks (sounds, scripts, tracking).

## Related Upstream Issues

| Issue | Description |
|-------|-------------|
| [#14807](https://github.com/anomalyco/opencode/issues/14807) | Session auto-naming silently fails when `small_model` is invalid |
| [#11988](https://github.com/anomalyco/opencode/issues/11988) | Add ability to regenerate session title using small model |
| [#9398](https://github.com/anomalyco/opencode/issues/9398) | Improve `/rename` command to be AI powered |
| [#13242](https://github.com/anomalyco/opencode/issues/13242) | Click to rename session in TUI sidebar |

## License

MIT
