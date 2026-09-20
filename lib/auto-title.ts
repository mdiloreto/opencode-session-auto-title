import { execFile } from "node:child_process"
import { promisify } from "node:util"

const SERVICE = "auto-title"
const execFileAsync = promisify(execFile)
const AGY_BIN = process.env.AGY_BIN ?? "agy"
const TITLE_MODEL = process.env.AUTOTITLE_MODEL ??
  `${process.env.AUTOTITLE_PROVIDER ?? "openai"}/gpt-5.6-luna`
const AGY_MODEL = process.env.AUTOTITLE_AGY_MODEL ?? "gemini-3.8-flash-low"
const TITLE_TIMEOUT_MS = Number(process.env.AUTOTITLE_TIMEOUT_MS ?? 120_000)

export function sessionParams(sessionID: string) {
  return {
    id: sessionID,
    sessionID,
    path: { id: sessionID, sessionID },
  } as any
}

export async function appLog(
  client: any,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) {
  try {
    const result = await client.app.log({
      body: {
        service: SERVICE,
        level,
        message,
        ...(extra ? { extra } : {}),
      },
    } as any)
    if (result?.error) throw new Error("OpenCode app log request failed")
  } catch (error) {
    console.error(`[${SERVICE}] ${message}`, extra, error)
  }
}

export async function generateTitle(
  client: any,
  seed: string,
  run = execFileAsync,
): Promise<string | null> {
  const prompt = [
    "Generate a concise session title (max 6 words).",
    "Return only the title text, with no explanation or quotes.",
    "",
    "Conversation request:",
    seed,
  ].join("\n")

  if (process.env.AUTOTITLE_USE_AGY !== "0") {
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
        "--model", TITLE_MODEL,
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
