# opencode-session-auto-title

Generate concise titles for OpenCode sessions that still have the exact default
`New session - <timestamp>` title.

The repository contains:

- `plugins/auto-title.ts`: idle-session fallback plugin with Agy-first generation.
- `scripts/batch-rename-sessions.ts`: safe historical backfill command.
- `systemd/`: a user timer that runs the backfill four times daily.

## Models

Agy uses `gemini-3.8-flash-low` by default. If Agy is unavailable or returns
an invalid title, generation falls back to `openai/gpt-5.6-luna` through
OpenCode with low reasoning. Set `AUTOTITLE_USE_AGY=0` to use OpenCode directly.

## Per-Session Plugin

Install both plugin files, then restart OpenCode:

```bash
install -Dm0644 plugins/auto-title.ts ~/.config/opencode/plugins/auto-title.ts
install -Dm0644 lib/auto-title.ts ~/.config/opencode/lib/auto-title.ts
```

The plugin runs after a root session becomes idle and only replaces exact
default titles. Its module intentionally exports only the plugin function;
OpenCode rejects auto-discovered modules that expose non-function test helpers.

## Backfill

The command starts a temporary plugin-free OpenCode server when port 4096 is
not already available and stops only the server it started.

```bash
# Find eligible sessions and verify they contain user content. No model calls or writes.
node scripts/batch-rename-sessions.ts --dry-run --limit 5

# Generate titles without updating sessions.
node scripts/batch-rename-sessions.ts --preview --limit 5

# Rename up to 20 sessions.
node scripts/batch-rename-sessions.ts --limit 20
```

Only unarchived root sessions at least 30 minutes old and matching the exact
default-title format are eligible. The script checks the title again immediately
before updating it.

Options:

| Option | Behavior |
|---|---|
| `--dry-run` | Check candidate messages without model calls or writes |
| `--preview` | Generate titles without writing them |
| `--limit N` | Process at most `N` oldest eligible sessions; `0` means all |
| `--quiet` | Suppress per-session success output |

Configuration:

| Variable | Default |
|---|---|
| `OPENCODE_URL` | `http://127.0.0.1:4096` |
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` |
| `OPENCODE_BIN` | `opencode` |
| `AUTOTITLE_MODEL` | `openai/gpt-5.6-luna` |
| `AUTOTITLE_USE_AGY` | unset; set to `0` to disable Agy |
| `AUTOTITLE_AGY_MODEL` | `gemini-3.8-flash-low` |
| `AGY_BIN` | `agy` |
| `MIN_AGE_MINUTES` | `30` |
| `MAX_SCAN_SESSIONS` | `200`; `0` means all |
| `REQUEST_DELAY` | `1200` milliseconds |
| `AUTOTITLE_TIMEOUT_MS` | `120000` milliseconds |

## Scheduled Run

Install and enable the Linux user timer:

```bash
npm run install:timer
```

The service uses `flock` to prevent overlap, processes at most 20 sessions per
run, enables Agy explicitly, and falls back to OpenCode Luna. The timer runs at
08:00, 12:00, 16:00, and 20:00, is persistent, and adds up to 15 minutes of
randomized delay.

```bash
systemctl --user status opencode-session-auto-title.timer
systemctl --user list-timers opencode-session-auto-title.timer
journalctl --user -u opencode-session-auto-title.service --no-pager
```

## Tests

```bash
npm test
systemd-analyze --user verify systemd/opencode-session-auto-title.service systemd/opencode-session-auto-title.timer
```

## Related OpenCode Issues

- [#14807](https://github.com/anomalyco/opencode/issues/14807): silent title-generation failure.
- [#11988](https://github.com/anomalyco/opencode/issues/11988): regenerate session titles.
- [#9398](https://github.com/anomalyco/opencode/issues/9398): AI-powered rename command.
