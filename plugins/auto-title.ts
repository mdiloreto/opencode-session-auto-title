import type { Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const SERVICE = "auto-title"
const AGY_BIN = process.env.AGY_BIN ?? "agy"
const AGY_MODEL = process.env.AUTOTITLE_AGY_MODEL ?? "gemini-3.8-flash-low"
const TITLE_MODEL = {
  id: process.env.AUTOTITLE_MODEL ?? `${process.env.AUTOTITLE_PROVIDER ?? "openai"}/gpt-5.3-codex-spark`,
}
const TITLE_TIMEOUT_MS = Number(process.env.AUTOTITLE_TIMEOUT_MS ?? 120_000)
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

function sessionParams(sessionID: string) {
  return { id: sessionID, sessionID, path: { id: sessionID, sessionID } } as any
}

function sdkData(result: any, operation: string): any {
  if (result?.error) throw new Error(`${operation} failed`)
  return result?.data ?? result
}

async function appLog(
  client: any,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) {
  try {
    const result = await client.app.log({
      body: { service: SERVICE, level, message, ...(extra ? { extra } : {}) },
    } as any)
    if (result?.error) throw new Error("OpenCode app log request failed")
  } catch (error) {
    console.error(`[${SERVICE}] ${message}`, extra, error)
  }
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

function sanitizeTitle(raw: string): string | null {
  const firstLine = raw
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
  if (!firstLine) return null
  const collapsed = firstLine.replace(/^["'`]+|["'`]+$/g, "").trim().replace(/\s+/g, " ")
  if (!collapsed) return null
  const words = collapsed.split(" ")
  const concise = words.length > 8 ? words.slice(0, 8).join(" ") : collapsed
  return concise.length > 100 ? `${concise.slice(0, 97)}...` : concise
}

async function generateTitle(client: any, seed: string, run = execFileAsync): Promise<string | null> {
  const prompt = [
    "Generate a concise session title (max 6 words).",
    "Return only the title text, with no explanation or quotes.",
    "",
    "Conversation request:",
    seed,
  ].join("\n")

  if (process.env.AUTOTITLE_USE_AGY === "1") {
    try {
      const { stdout } = await run(
        AGY_BIN,
        [
          "--output-format", "text",
          "--disable-slash-commands",
          "--sandbox",
          "--model", AGY_MODEL,
          "--print-timeout", `${Math.ceil(TITLE_TIMEOUT_MS / 1_000)}s`,
          "--print", prompt,
        ],
        { maxBuffer: 1024 * 1024, timeout: TITLE_TIMEOUT_MS },
      )
      const title = sanitizeTitle(stdout)
      if (title) return title
      throw new Error("Agy returned an empty title")
    } catch (error: any) {
      await appLog(client, "warn", "Agy title generation failed; falling back to OpenCode", {
        error: processFailure(error),
      })
    }
  }

  let workerID: string | undefined
  try {
    const { stdout } = await run(
      process.env.OPENCODE_BIN ?? process.execPath,
      [
        "--pure", "run",
        "--agent", "title",
        "--model", TITLE_MODEL.id,
        "--variant", "low",
        "--format", "json",
        prompt,
      ],
      {
        env: {
          ...process.env,
          AUTOTITLE_DISABLED: "1",
          OPENCODE_AUTO_SHARE: "0",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: "disabled" }),
        },
        maxBuffer: 1024 * 1024,
        timeout: TITLE_TIMEOUT_MS,
      },
    )
    const parsed = parseOpenCodeOutput(stdout)
    workerID = parsed.sessionID
    const title = sanitizeTitle(parsed.text)
    if (!title) throw new Error("OpenCode returned an empty title")
    return title
  } catch (error: any) {
    workerID ??= parseOpenCodeOutput(String(error?.stdout ?? "")).sessionID
    throw new Error(`OpenCode title generation failed (${processFailure(error)})`)
  } finally {
    if (workerID) {
      const result = await client.session.delete(sessionParams(workerID))
      if (result?.error) throw new Error(`Failed to delete title worker ${workerID}`)
    }
  }
}

function processFailure(error: any): string {
  const code = error?.code ? `code=${String(error.code)}` : "unknown error"
  const signal = error?.signal ? ` signal=${String(error.signal)}` : ""
  return `${code}${signal}`
}

function parseOpenCodeOutput(stdout: string): { sessionID?: string; text: string } {
  let sessionID: string | undefined
  let text = ""
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      sessionID ??= typeof event?.sessionID === "string" ? event.sessionID : undefined
      if (event?.type === "text" && event?.part?.type === "text") {
        text += String(event.part.text ?? "")
      }
    } catch {
      continue
    }
  }
  return { sessionID, text }
}

export const AutoTitleTest = { generateTitle, parseOpenCodeOutput }
