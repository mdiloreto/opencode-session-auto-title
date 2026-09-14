import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { AutoTitleTest } from "../plugins/auto-title.ts"

const { generateTitle } = AutoTitleTest

const originalEnv = {
  AUTOTITLE_USE_AGY: process.env.AUTOTITLE_USE_AGY,
  OPENCODE_BIN: process.env.OPENCODE_BIN,
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function client() {
  const logs: unknown[] = []
  return {
    value: {
      app: { log: async (entry: unknown) => logs.push(entry) },
      session: { delete: async () => true },
    },
    logs,
  }
}

function openCodeOutput(title: string): string {
  return `${JSON.stringify({
    type: "text",
    sessionID: "ses_worker",
    part: { type: "text", text: title },
  })}\n`
}

test("uses OpenCode Spark by default", async () => {
  delete process.env.AUTOTITLE_USE_AGY
  process.env.OPENCODE_BIN = "/test/opencode"
  const calls: Array<{ file: string; args: string[] }> = []

  const title = await generateTitle(
    client().value,
    "Rename old sessions",
    (async (file, args) => {
      calls.push({ file, args })
      return { stdout: openCodeOutput("Rename old sessions"), stderr: "" }
    }) as any,
  )

  assert.equal(title, "Rename old sessions")
  assert.equal(calls[0].file, "/test/opencode")
  assert.ok(calls[0].args.includes("openai/gpt-5.3-codex-spark"))
})

test("uses Agy when enabled and falls back when it fails", async () => {
  process.env.AUTOTITLE_USE_AGY = "1"
  process.env.OPENCODE_BIN = "/test/opencode"
  const calls: string[] = []
  const { value, logs } = client()

  const title = await generateTitle(
    value,
    "Scheduled title backfill",
    (async (file) => {
      calls.push(file)
      if (file === "agy") throw new Error("agy unavailable")
      return { stdout: openCodeOutput("Scheduled title backfill"), stderr: "" }
    }) as any,
  )

  assert.equal(title, "Scheduled title backfill")
  assert.deepEqual(calls, ["agy", "/test/opencode"])
  assert.equal(logs.length, 1)
})
