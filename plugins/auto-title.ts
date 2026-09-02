/**
 * Auto-title plugin for OpenCode.
 *
 * Listens for `session.idle` events and generates a concise title for any
 * session that still has the default "New session - ..." name.
 *
 * Place in ~/.config/opencode/plugins/ to auto-load at startup.
 *
 * Configuration (env vars):
 *   AUTOTITLE_PROVIDER  - Provider ID (default: github-copilot)
 *   AUTOTITLE_MODEL     - Model ID    (default: claude-haiku-4.5)
 *   AUTOTITLE_DISABLED  - Set to "1" to disable without removing the file
 */

import type { Plugin } from "@opencode-ai/plugin"

const SERVICE = "auto-title"

// Model used for title generation — intentionally small/cheap
const TITLE_MODEL = {
  providerID: process.env.AUTOTITLE_PROVIDER ?? "github-copilot",
  modelID: process.env.AUTOTITLE_MODEL ?? "claude-haiku-4.5",
}

// Max chars of user content sent to the title agent
const MAX_SEED_CHARS = 4000

// Re-entry guard: session IDs that are currently being titled
const titling = new Set<string>()

// Sessions that have already been titled by us (avoid re-triggering)
const titled = new Set<string>()

export const AutoTitle: Plugin = async ({ client }) => {
  if (process.env.AUTOTITLE_DISABLED === "1") {
    return {}
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      const sessionID = (event as any).properties?.sessionID as
        | string
        | undefined
      if (!sessionID) return

      // Skip if already titled by us or currently in progress
      if (titled.has(sessionID) || titling.has(sessionID)) return

      try {
        // Fetch the session info
        const sessionRes = await client.session.get({ sessionID })
        const session = (sessionRes as any)?.data
        if (!session) return

        // Only act on root sessions (no parentID) with default titles
        if (session.parentID) return
        if (!session.title?.startsWith("New session")) return

        // Mark as in-progress
        titling.add(sessionID)

        await client.app.log({
          service: SERVICE,
          level: "info",
          message: `Generating title for session ${sessionID}`,
        })

        // Get the session messages to extract seed text
        const messagesRes = await client.session.messages({ sessionID })
        const messages: any[] = (messagesRes as any)?.data ?? []

        const seed = extractSeed(messages)
        if (!seed) {
          await client.app.log({
            service: SERVICE,
            level: "debug",
            message: `No user content found in session ${sessionID}, skipping`,
          })
          return
        }

        // Generate the title using a worker session
        const title = await generateTitle(client, seed)
        if (!title) {
          await client.app.log({
            service: SERVICE,
            level: "warn",
            message: `Title generation returned empty for session ${sessionID}`,
          })
          return
        }

        // Update the original session's title
        await client.session.update({ sessionID, title })

        // Remember we titled this one
        titled.add(sessionID)

        await client.app.log({
          service: SERVICE,
          level: "info",
          message: `Session ${sessionID} titled: "${title}"`,
        })
      } catch (err: any) {
        await client.app.log({
          service: SERVICE,
          level: "error",
          message: `Failed to auto-title session ${sessionID}`,
          extra: { error: String(err?.message ?? err) },
        }).catch(() => {})
      } finally {
        titling.delete(sessionID)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first real user message text from session messages.
 */
function extractSeed(messages: any[]): string | null {
  for (const msg of messages) {
    if (msg?.info?.role !== "user") continue
    const parts: any[] = Array.isArray(msg?.parts) ? msg.parts : []

    // Prefer non-synthetic text parts
    const textParts = parts
      .filter((p: any) => p?.type === "text" && !p?.synthetic)
      .map((p: any) => String(p?.text ?? "").trim())
      .filter(Boolean)
    if (textParts.length > 0) {
      return truncate(textParts.join("\n"), MAX_SEED_CHARS)
    }

    // Fall back to subtask prompts
    const subtaskParts = parts
      .filter((p: any) => p?.type === "subtask")
      .map((p: any) => String(p?.prompt ?? "").trim())
      .filter(Boolean)
    if (subtaskParts.length > 0) {
      return truncate(subtaskParts.join("\n"), MAX_SEED_CHARS)
    }
  }
  return null
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

/**
 * Strip <think> blocks and extract a clean title from model output.
 */
function sanitizeTitle(raw: string): string | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "")
  const firstLine = cleaned
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)

  if (!firstLine) return null

  const unwrapped = firstLine.replace(/^["'`]+|["'`]+$/g, "").trim()
  const collapsed = unwrapped.replace(/\s+/g, " ")
  if (!collapsed) return null

  // Cap at 8 words / 100 chars
  const words = collapsed.split(" ")
  const concise = words.length > 8 ? words.slice(0, 8).join(" ") : collapsed
  return concise.length > 100 ? `${concise.slice(0, 97)}...` : concise
}

/**
 * Generate a title by prompting the built-in "title" agent in a worker session.
 * Uses the synchronous client.session.prompt() which waits for the response.
 */
async function generateTitle(
  client: any,
  seed: string,
): Promise<string | null> {
  // Create a disposable worker session
  const createRes = await client.session.create({
    title: "__auto-title-worker__",
  })
  const workerID = (createRes as any)?.data?.id
  if (!workerID) throw new Error("Failed to create worker session")

  try {
    // Use the synchronous prompt() which returns once the agent finishes
    const promptRes = await client.session.prompt({
      sessionID: workerID,
      agent: "title",
      model: TITLE_MODEL,
      parts: [
        {
          type: "text" as const,
          text: [
            "Generate a concise session title (max 6 words).",
            "Return only the title text, with no explanation or quotes.",
            "",
            "Conversation request:",
            seed,
          ].join("\n"),
        },
      ],
    })

    // Extract the assistant response text
    const data = (promptRes as any)?.data
    let rawText = ""

    // prompt() may return the messages directly
    if (Array.isArray(data)) {
      for (const msg of data) {
        if (msg?.info?.role === "assistant") {
          const parts: any[] = Array.isArray(msg?.parts) ? msg.parts : []
          rawText = parts
            .filter((p: any) => p?.type === "text")
            .map((p: any) => String(p?.text ?? ""))
            .join("\n")
          if (rawText.trim()) break
        }
      }
    }

    // If prompt() returned a single message object
    if (!rawText.trim() && data?.info?.role === "assistant") {
      const parts: any[] = Array.isArray(data?.parts) ? data.parts : []
      rawText = parts
        .filter((p: any) => p?.type === "text")
        .map((p: any) => String(p?.text ?? ""))
        .join("\n")
    }

    // Fallback: fetch messages from the worker session
    if (!rawText.trim()) {
      const msgsRes = await client.session.messages({ sessionID: workerID })
      const msgs: any[] = (msgsRes as any)?.data ?? []
      for (const msg of msgs) {
        if (msg?.info?.role === "assistant") {
          const parts: any[] = Array.isArray(msg?.parts) ? msg.parts : []
          rawText = parts
            .filter((p: any) => p?.type === "text")
            .map((p: any) => String(p?.text ?? ""))
            .join("\n")
          if (rawText.trim()) break
        }
      }
    }

    return sanitizeTitle(rawText)
  } finally {
    // Always clean up the worker session
    await client.session.delete({ sessionID: workerID }).catch(() => {})
  }
}
