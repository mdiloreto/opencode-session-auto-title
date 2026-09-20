import type { Plugin } from "@opencode-ai/plugin"
import { appLog, generateTitle, sessionParams } from "../lib/auto-title.ts"

const MAX_SEED_CHARS = 4_000
const DEFAULT_TITLE = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const titling = new Set<string>()
const titled = new Set<string>()

export const AutoTitle: Plugin = async ({ client }) => {
  if (process.env.AUTOTITLE_DISABLED === "1") return {}

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = (event as any).properties?.sessionID as string | undefined
      if (!sessionID || titled.has(sessionID) || titling.has(sessionID)) return

      try {
        const session = sdkData(await client.session.get(sessionParams(sessionID)), "Fetch session")
        if (!session || session.parentID || !DEFAULT_TITLE.test(session.title ?? "")) return
        titling.add(sessionID)

        const messages = sdkData(await client.session.messages(sessionParams(sessionID)), "Fetch messages")
        const seed = extractSeed(messages)
        if (!seed) return

        const title = await generateTitle(client, seed)
        if (!title) return
        const current = sdkData(await client.session.get(sessionParams(sessionID)), "Recheck session")
        if (!current || !DEFAULT_TITLE.test(current.title ?? "")) return
        const updated = sdkData(await client.session.update({
          ...sessionParams(sessionID),
          title,
          body: { title },
        }), "Update title")
        if (updated?.title !== title) throw new Error("OpenCode did not persist the generated title")
        titled.add(sessionID)
      } catch (error: any) {
        await appLog(client, "error", `Failed to auto-title session ${sessionID}`, {
          error: String(error?.message ?? error),
        })
      } finally {
        titling.delete(sessionID)
      }
    },
  }
}

function sdkData(result: any, operation: string): any {
  if (result?.error) throw new Error(`${operation} failed`)
  return result?.data ?? result
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

function extractSeed(messages: any[]): string | null {
  for (const message of messages) {
    if (message?.info?.role !== "user") continue
    const parts = Array.isArray(message?.parts) ? message.parts : []
    const text = parts
      .filter((part: any) => part?.type === "text" && !part?.synthetic)
      .map((part: any) => String(part?.text ?? "").trim())
      .filter(Boolean)
    if (text.length > 0) return truncate(text.join("\n"), MAX_SEED_CHARS)

    const subtasks = parts
      .filter((part: any) => part?.type === "subtask")
      .map((part: any) => String(part?.prompt ?? "").trim())
      .filter(Boolean)
    if (subtasks.length > 0) return truncate(subtasks.join("\n"), MAX_SEED_CHARS)
  }
  return null
}
