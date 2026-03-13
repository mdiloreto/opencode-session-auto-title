/**
 * Example OpenCode plugin that hooks into session lifecycle events.
 *
 * Place this file in ~/.config/opencode/plugins/ and OpenCode will load it
 * automatically on startup.
 *
 * What this does:
 *   - session.created  -> runs a shell hook script
 *   - session.idle     -> plays a notification sound, runs a shell hook
 *   - tool.execute.after -> tracks file modifications via a shell hook
 *
 * Note: Session title generation is handled by OpenCode core automatically
 * (via the built-in "title" agent). You do NOT need a plugin for auto-titling
 * as long as your `small_model` config is valid.
 *
 * See: https://opencode.ai/docs/plugins
 */

import type { Plugin } from "@opencode-ai/plugin"

export const SessionHooks: Plugin = async ({ project, client, $ }) => {
  return {
    // Generic event hook — filter by event.type
    event: async ({ event }) => {
      if (event.type === "session.created") {
        try {
          await $`bash ~/.config/opencode/hooks/session-start.sh`
        } catch (e) {
          await client.app.log({
            body: {
              service: "session-hooks",
              level: "warn",
              message: "session-start.sh failed",
              extra: { error: String(e) },
            },
          })
        }
      }

      if (event.type === "session.idle") {
        // Play a notification sound (macOS example)
        try {
          await $`afplay /System/Library/Sounds/Glass.aiff`
        } catch {
          // Sound playback is non-critical
        }

        // Run session-end hook
        try {
          await $`bash ~/.config/opencode/hooks/session-end.sh`
        } catch {
          // Non-critical
        }
      }
    },

    // Track file modifications after write/edit tools execute
    "tool.execute.after": async (input, output) => {
      const toolName = input?.tool ?? ""
      if (["write", "edit", "patch", "multiedit"].includes(toolName)) {
        try {
          await $`bash ~/.config/opencode/hooks/post-write-track.sh`
        } catch {
          // Non-critical
        }
      }
    },
  }
}
