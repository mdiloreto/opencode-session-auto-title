import assert from "node:assert/strict"
import { test } from "node:test"

import {
  extractSeed,
  isDefaultTitle,
  parseArgs,
  parseOpenCodeOutput,
  sanitizeTitle,
} from "../scripts/batch-rename-sessions.ts"

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
