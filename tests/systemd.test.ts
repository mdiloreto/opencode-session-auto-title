import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

test("schedules four daily backfills", async () => {
  const timer = await readFile(new URL("../systemd/opencode-session-auto-title.timer", import.meta.url), "utf8")
  const times = [...timer.matchAll(/^OnCalendar=\*-\*-\* (.+)$/gm)].map((match) => match[1])

  assert.deepEqual(times, ["08:00:00", "12:00:00", "16:00:00", "20:00:00"])
  assert.match(timer, /^Persistent=true$/m)
})

test("uses Agy with the Luna fallback", async () => {
  const service = await readFile(new URL("../systemd/opencode-session-auto-title.service", import.meta.url), "utf8")

  assert.match(service, /^Environment=AUTOTITLE_USE_AGY=1$/m)
  assert.match(service, /^Environment=AUTOTITLE_MODEL=openai\/gpt-5\.6-luna$/m)
  assert.match(service, /^Environment=AUTOTITLE_AGY_MODEL=gemini-3\.8-flash-low$/m)
})
