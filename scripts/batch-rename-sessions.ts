/**
 * Batch rename OpenCode sessions that still have default titles ("New session - ...").
 *
 * Requires:
 *   - OpenCode server running (`opencode serve --port 4096`)
 *   - sqlite3 available on PATH
 *   - npx tsx (or bun) to execute
 *
 * Environment variables:
 *   OPENCODE_URL        - Server URL (default: http://127.0.0.1:4096)
 *   OPENCODE_PROVIDER   - Provider ID (default: anthropic)
 *   OPENCODE_MODEL      - Model ID for title generation (default: claude-haiku-4-5)
 *   OPENCODE_DB         - Path to OpenCode SQLite DB (default: ~/.local/share/opencode/opencode.db)
 *   MAX_SESSIONS        - Limit the number of sessions to process (0 = all, default: 0)
 *   REQUEST_DELAY       - Delay in ms between requests (default: 1200)
 *
 * Usage:
 *   npx tsx scripts/batch-rename-sessions.ts                    # rename all
 *   MAX_SESSIONS=5 npx tsx scripts/batch-rename-sessions.ts     # dry-run on 5
 */

import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { homedir } from "node:os"

const BASE_URL = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096"
const MODEL = {
  providerID: process.env.OPENCODE_PROVIDER ?? "anthropic",
  modelID: process.env.OPENCODE_MODEL ?? "claude-haiku-4-5",
}
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY ?? 1200)
const MAX_SOURCE_CHARS = 6000
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 0)
const DB_PATH = process.env.OPENCODE_DB ?? resolve(homedir(), ".local/share/opencode/opencode.db")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function targetSessionIDs(): string[] {
  const sql = "SELECT id FROM session WHERE parent_id IS NULL AND title LIKE 'New session%';"
  const output = execFileSync("sqlite3", [DB_PATH, sql], { encoding: "utf8" })
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, init)
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed (${res.status}): ${await res.text()}`)
  }
  const payload = await res.json()
  return (payload?.data ?? payload) as T
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

function sanitizeTitle(raw: string): string | null {
  // Strip <think> blocks (some models emit reasoning)
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

// ---------------------------------------------------------------------------
// Extract first real user message from a session's messages
// ---------------------------------------------------------------------------

function extractSeed(messages: any[]): string | null {
  for (const msg of messages) {
    if (msg?.info?.role !== "user") continue
    const parts: any[] = Array.isArray(msg?.parts) ? msg.parts : []

    // Prefer non-synthetic text parts
    const textParts = parts
      .filter((p) => p?.type === "text" && !p?.synthetic)
      .map((p) => String(p?.text ?? "").trim())
      .filter(Boolean)
    if (textParts.length > 0) return truncate(textParts.join("\n"), MAX_SOURCE_CHARS)

    // Fall back to subtask prompts (from slash commands / agents)
    const subtaskParts = parts
      .filter((p) => p?.type === "subtask")
      .map((p) => String(p?.prompt ?? "").trim())
      .filter(Boolean)
    if (subtaskParts.length > 0) return truncate(subtaskParts.join("\n"), MAX_SOURCE_CHARS)
  }
  return null
}

// ---------------------------------------------------------------------------
// Generate a title by invoking the built-in "title" agent in a scratch session
// ---------------------------------------------------------------------------

async function generateTitle(seed: string): Promise<string> {
  const worker = await api("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "__batch-title-worker__" }),
  })
  const workerID = worker?.id
  if (!workerID) throw new Error("Worker session id missing")

  try {
    const resp = await api(`/session/${workerID}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "title",
        model: MODEL,
        parts: [
          {
            type: "text",
            text: [
              "Generate a concise session title (max 6 words).",
              "Return only the title text, with no explanation or quotes.",
              "",
              "Conversation request:",
              seed,
            ].join("\n"),
          },
        ],
      }),
    })

    const parts: any[] = Array.isArray(resp?.parts) ? resp.parts : []
    const rawText = parts
      .filter((p) => p?.type === "text")
      .map((p) => String(p?.text ?? ""))
      .join("\n")

    const title = sanitizeTitle(rawText)
    if (!title) throw new Error("Model did not return a valid title")
    return title
  } finally {
    await fetch(`${BASE_URL}/session/${workerID}`, { method: "DELETE" }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`OpenCode server: ${BASE_URL}`)
  console.log(`Model: ${MODEL.providerID}/${MODEL.modelID}`)
  console.log(`Database: ${DB_PATH}\n`)

  const allTargets = targetSessionIDs()
  const targets = MAX_SESSIONS > 0 ? allTargets.slice(0, MAX_SESSIONS) : allTargets

  console.log(`Found ${allTargets.length} default-titled parent sessions. Processing ${targets.length}.\n`)

  let renamed = 0
  let failed = 0
  let skipped = 0

  for (let i = 0; i < targets.length; i++) {
    const sessionID = targets[i]
    process.stdout.write(`[${i + 1}/${targets.length}] ${sessionID} `)

    try {
      const messages = await api(`/session/${sessionID}/message`)
      const seed = extractSeed(Array.isArray(messages) ? messages : [])

      if (!seed) {
        console.log("-> skipped (no user content)")
        skipped++
      } else {
        const title = await generateTitle(seed)
        await api(`/session/${sessionID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        })
        console.log(`-> ${title}`)
        renamed++
      }
    } catch (err: any) {
      console.error(`-> FAILED: ${err?.message ?? err}`)
      failed++
    }

    if (i < targets.length - 1) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS))
    }
  }

  console.log(`\n=== Done ===`)
  console.log(`Renamed: ${renamed}  Skipped: ${skipped}  Failed: ${failed}`)

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
