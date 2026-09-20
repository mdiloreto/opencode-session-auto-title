import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import {
  extractSeed,
  generateTitle,
  isDefaultTitle,
  parseArgs,
  parseOpenCodeOutput,
  sanitizeTitle,
} from "../scripts/batch-rename-sessions.ts"

const originalAgySetting = process.env.AUTOTITLE_USE_AGY

afterEach(() => {
  if (originalAgySetting === undefined) delete process.env.AUTOTITLE_USE_AGY
  else process.env.AUTOTITLE_USE_AGY = originalAgySetting
})

function openCodeOutput(title: string): string {
  return `${JSON.stringify({
    type: "text",
    part: { type: "text", text: title },
  })}\n`
}

test("recognizes only exact OpenCode default titles", () => {
  assert.equal(isDefaultTitle("New session - 2026-09-12T12:34:56.789Z"), true)
  assert.equal(isDefaultTitle("New session draft"), false)
  assert.equal(isDefaultTitle("New session - 2026-09-12"), false)
})

test("parses safe operational flags", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--limit", "5", "--quiet"]), {
    dryRun: true,
    preview: false,
    quiet: true,
    limit: 5,
  })
  assert.throws(() => parseArgs(["--limit", "invalid"]), /non-negative integer/)
  assert.throws(() => parseArgs(["--dry-run", "--preview"]), /mutually exclusive/)
})

test("extracts the first non-synthetic user text", () => {
  assert.equal(
    extractSeed([
      { info: { role: "assistant" }, parts: [{ type: "text", text: "ignore" }] },
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "synthetic", synthetic: true },
          { type: "text", text: "Rename old sessions" },
        ],
      },
    ]),
    "Rename old sessions",
  )
})

test("sanitizes generated titles", () => {
  assert.equal(sanitizeTitle('<think>ignore</think> "Concise session title"\nextra'), "Concise session title")
  assert.equal(sanitizeTitle(""), null)
  assert.equal(sanitizeTitle("one two three four five six seven eight nine"), "one two three four five six seven eight")
})

test("parses OpenCode NDJSON text events", () => {
  assert.deepEqual(
    parseOpenCodeOutput(`${JSON.stringify({
      type: "text",
      sessionID: "ses_worker",
      part: { type: "text", text: "Generated title" },
    })}\n`),
    { sessionID: "ses_worker", text: "Generated title" },
  )
})

test("uses Agy first by default", async () => {
  delete process.env.AUTOTITLE_USE_AGY
  const calls: string[] = []

  const title = await generateTitle(
    "Scheduled backfill",
    (async (file) => {
      calls.push(file)
      return { stdout: "Scheduled backfill\n", stderr: "" }
    }) as any,
  )

  assert.equal(title, "Scheduled backfill")
  assert.deepEqual(calls, ["agy"])
})

test("falls back to OpenCode Luna after invalid Agy output", async () => {
  delete process.env.AUTOTITLE_USE_AGY
  const calls: Array<{ file: string; args: string[] }> = []

  const title = await generateTitle(
    "Fallback title",
    (async (file, args) => {
      calls.push({ file, args })
      if (file === "agy") return { stdout: " \n", stderr: "" }
      return { stdout: openCodeOutput("Fallback title"), stderr: "" }
    }) as any,
  )

  assert.equal(title, "Fallback title")
  assert.deepEqual(calls.map(({ file }) => file), ["agy", "opencode"])
  assert.ok(calls[1].args.includes("openai/gpt-5.6-luna"))
})

test("bypasses Agy when disabled", async () => {
  process.env.AUTOTITLE_USE_AGY = "0"
  const calls: string[] = []

  const title = await generateTitle(
    "Direct OpenCode title",
    (async (file) => {
      calls.push(file)
      return { stdout: openCodeOutput("Direct OpenCode title"), stderr: "" }
    }) as any,
  )

  assert.equal(title, "Direct OpenCode title")
  assert.deepEqual(calls, ["opencode"])
})
