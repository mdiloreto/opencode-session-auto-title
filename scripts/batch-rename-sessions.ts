import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const BASE_URL = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096"
const DB_PATH = process.env.OPENCODE_DB ?? resolve(homedir(), ".local/share/opencode/opencode.db")
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode"
const AGY_BIN = process.env.AGY_BIN ?? "agy"
const AGY_MODEL = process.env.AUTOTITLE_AGY_MODEL ?? "gemini-3.8-flash-low"
const TITLE_MODEL = process.env.AUTOTITLE_MODEL ?? "openai/gpt-5.6-luna"
const TIMEOUT_MS = numberFromEnv("AUTOTITLE_TIMEOUT_MS", 120_000)
const REQUEST_DELAY_MS = numberFromEnv("REQUEST_DELAY", 1_200)
const MIN_AGE_MINUTES = numberFromEnv("MIN_AGE_MINUTES", 30)
const MAX_SCAN_SESSIONS = integerFromEnv("MAX_SCAN_SESSIONS", 200)
const MAX_SOURCE_CHARS = 6_000
const DEFAULT_TITLE = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
let serverPassword = process.env.OPENCODE_SERVER_PASSWORD
const serverUsername = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"

type Options = {
  dryRun: boolean
  preview: boolean
  quiet: boolean
  limit: number
}

export function parseArgs(args: string[]): Options {
  const options: Options = {
    dryRun: false,
    preview: false,
    quiet: false,
    limit: integerFromEnv("MAX_SESSIONS", 0),
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--preview") options.preview = true
    else if (arg === "--quiet") options.quiet = true
    else if (arg === "--limit") {
      const value = args[++index]
      if (value === undefined) throw new Error("--limit requires a value")
      options.limit = parseNonNegativeInteger(value, "--limit")
    } else if (arg === "--help") {
      console.log("Usage: batch-rename-sessions.ts [--dry-run] [--preview] [--limit N] [--quiet]")
      process.exit(0)
    } else throw new Error(`Unknown argument: ${arg}`)
  }

  if (options.dryRun && options.preview) {
    throw new Error("--dry-run and --preview are mutually exclusive")
  }
  return options
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

function integerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  return raw === undefined ? fallback : parseNonNegativeInteger(raw, name)
}

function parseNonNegativeInteger(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

export function isDefaultTitle(title: unknown): title is string {
  return typeof title === "string" && DEFAULT_TITLE.test(title)
}

function targetSessionIDs(): string[] {
  const oldestAllowed = Date.now() - MIN_AGE_MINUTES * 60_000
  const sql = [
    "SELECT id FROM session",
    "WHERE parent_id IS NULL",
    "AND time_archived IS NULL",
    "AND title GLOB 'New session - ????-??-??T??:??:??.???Z'",
    `AND time_created <= ${oldestAllowed}`,
    "ORDER BY time_created ASC",
    `LIMIT ${MAX_SCAN_SESSIONS || -1};`,
  ].join(" ")
  const output = execFileSync("sqlite3", [DB_PATH, sql], { encoding: "utf8" })
  return output.split("\n").map((line) => line.trim()).filter(Boolean)
}

async function fetchWithTimeout(path: string, init?: RequestInit, timeout = TIMEOUT_MS): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (serverPassword) {
    headers.set("Authorization", `Basic ${Buffer.from(`${serverUsername}:${serverPassword}`).toString("base64")}`)
  }
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeout),
  })
}

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithTimeout(path, init)
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status}): ${await response.text()}`)
  }
  const payload = await response.json()
  return (payload?.data ?? payload) as T
}

async function serverHealthy(): Promise<boolean> {
  try {
    const response = await fetchWithTimeout("/global/health", undefined, 2_000)
    return response.ok
  } catch {
    return false
  }
}

async function ensureServer(): Promise<ChildProcess | null> {
  if (await serverHealthy()) return null

  const url = new URL(BASE_URL)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error(`OpenCode server unavailable at ${BASE_URL}`)
  }

  serverPassword ??= randomBytes(24).toString("base64url")

  const server = spawn(
    OPENCODE_BIN,
    ["--pure", "serve", "--hostname", url.hostname, "--port", url.port || "4096"],
    {
      cwd: homedir(),
      env: {
        ...process.env,
        AUTOTITLE_DISABLED: "1",
        OPENCODE_SERVER_USERNAME: serverUsername,
        OPENCODE_SERVER_PASSWORD: serverPassword,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  )
  let stderr = ""
  let spawnError: Error | null = null
  server.once("error", (error) => {
    spawnError = error
  })
  server.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await serverHealthy()) return server
    if (spawnError) break
    if (server.exitCode !== null) break
    await delay(250)
  }

  await stopServer(server)
  const detail = spawnError?.message ?? stderr.trim()
  throw new Error(`OpenCode server failed to start${detail ? `: ${detail}` : ""}`)
}

async function stopServer(server: ChildProcess | null): Promise<void> {
  if (!server || server.exitCode !== null) return
  await new Promise<void>((resolve, reject) => {
    let force: NodeJS.Timeout | undefined
    let giveUp: NodeJS.Timeout | undefined
    const finish = (error?: Error) => {
      if (force) clearTimeout(force)
      if (giveUp) clearTimeout(giveUp)
      if (error) reject(error)
      else resolve()
    }
    force = setTimeout(() => {
      if (server.exitCode !== null) return
      if (!server.kill("SIGKILL")) finish(new Error("Failed to kill temporary OpenCode server"))
      giveUp = setTimeout(() => finish(new Error("Temporary OpenCode server did not exit")), 2_000)
    }, 5_000)
    server.once("exit", () => finish())
    server.once("error", (error) => finish(error))
    if (!server.kill("SIGTERM")) finish(new Error("Failed to stop temporary OpenCode server"))
  })
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

export function sanitizeTitle(raw: string): string | null {
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

export function extractSeed(messages: any[]): string | null {
  for (const message of messages) {
    if (message?.info?.role !== "user") continue
    const parts = Array.isArray(message?.parts) ? message.parts : []
    const text = parts
      .filter((part: any) => part?.type === "text" && !part?.synthetic)
      .map((part: any) => String(part?.text ?? "").trim())
      .filter(Boolean)
    if (text.length > 0) return truncate(text.join("\n"), MAX_SOURCE_CHARS)

    const subtasks = parts
      .filter((part: any) => part?.type === "subtask")
      .map((part: any) => String(part?.prompt ?? "").trim())
      .filter(Boolean)
    if (subtasks.length > 0) return truncate(subtasks.join("\n"), MAX_SOURCE_CHARS)
  }
  return null
}

function titlePrompt(seed: string): string {
  return [
    "Generate a concise session title (max 6 words).",
    "Return only the title text, with no explanation or quotes.",
    "",
    "Conversation request:",
    seed,
  ].join("\n")
}

async function generateWithAgy(prompt: string, run = execFileAsync): Promise<string> {
  const { stdout } = await run(
    AGY_BIN,
    [
      "--output-format", "text",
      "--disable-slash-commands",
      "--sandbox",
      "--model", AGY_MODEL,
      "--print-timeout", `${Math.ceil(TIMEOUT_MS / 1_000)}s`,
      "--print", prompt,
    ],
    { maxBuffer: 1024 * 1024, timeout: TIMEOUT_MS },
  )
  const title = sanitizeTitle(stdout)
  if (!title) throw new Error("Agy returned an empty title")
  return title
}

async function generateWithOpenCode(prompt: string, run = execFileAsync): Promise<string> {
  const [provider, ...modelParts] = TITLE_MODEL.split("/")
  if (!provider || modelParts.length === 0) throw new Error("AUTOTITLE_MODEL must use provider/model format")
  let workerID: string | undefined
  try {
    const { stdout } = await run(
      OPENCODE_BIN,
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
        timeout: TIMEOUT_MS,
      },
    )
    const parsed = parseOpenCodeOutput(stdout)
    workerID = parsed.sessionID
    const title = sanitizeTitle(parsed.text)
    if (!title) throw new Error("OpenCode returned an empty title")
    return title
  } catch (error: any) {
    workerID ??= parseOpenCodeOutput(String(error?.stdout ?? "")).sessionID
    throw error
  } finally {
    if (workerID) {
      await api(`/session/${workerID}`, { method: "DELETE" })
    }
  }
}

export function parseOpenCodeOutput(stdout: string): { sessionID?: string; text: string } {
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

export async function generateTitle(seed: string, run = execFileAsync): Promise<string> {
  const prompt = titlePrompt(seed)
  if (process.env.AUTOTITLE_USE_AGY !== "0") {
    try {
      return await generateWithAgy(prompt, run)
    } catch (error: any) {
      console.warn(`Agy failed; using OpenCode (${processFailure(error)})`)
    }
  }
  return generateWithOpenCode(prompt, run)
}

function processFailure(error: any): string {
  const code = error?.code ? `code=${String(error.code)}` : "unknown error"
  const signal = error?.signal ? ` signal=${String(error.signal)}` : ""
  return `${code}${signal}`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const allTargets = targetSessionIDs()
  if (!options.quiet) console.log(`Found ${allTargets.length} candidate sessions.`)

  let server: ChildProcess | null = null
  let renamed = 0
  let skipped = 0
  let failed = 0
  let processed = 0

  try {
    if (allTargets.length > 0) server = await ensureServer()
    for (let index = 0; index < allTargets.length; index++) {
      const sessionID = allTargets[index]
      let generated = false
      try {
        const messages = await api<any[]>(`/session/${sessionID}/message`)
        if (!Array.isArray(messages)) throw new Error("OpenCode returned an invalid messages response")
        const seed = extractSeed(messages)
        if (!seed) {
          skipped++
        } else {
          if (options.limit > 0 && processed >= options.limit) break
          processed++
          if (options.dryRun) {
            if (!options.quiet) console.log(`[${processed}] eligible`)
            continue
          }
          generated = true
          const title = await generateTitle(seed)
          if (options.preview) {
            if (!options.quiet) console.log(`[${processed}] ${title}`)
          } else {
            const current = await api<any>(`/session/${sessionID}`)
            if (!isDefaultTitle(current?.title)) {
              skipped++
            } else {
              await api(`/session/${sessionID}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title }),
              })
              renamed++
              if (!options.quiet) console.log(`[${processed}] ${title}`)
            }
          }
        }
      } catch (error: any) {
        failed++
        console.error(`Session ${index + 1}/${allTargets.length} failed: ${error?.message ?? error}`)
      }
      if (generated && index < allTargets.length - 1) await delay(REQUEST_DELAY_MS)
    }
  } finally {
    await stopServer(server)
  }

  console.log(`Auto-title complete: renamed=${renamed} skipped=${skipped} failed=${failed}`)
  if (failed > 0) process.exitCode = 1
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : ""
if (entrypoint === import.meta.filename) {
  main().catch((error) => {
    console.error(`Auto-title failed: ${error?.message ?? error}`)
    process.exitCode = 1
  })
}
