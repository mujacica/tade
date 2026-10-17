import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CodexAdapter } from '../src/adapter.ts'
import { askPlan, limitsOf } from '../src/plan.ts'

// Asking Codex how much of its plan is used, without running anything: its app
// server, asked `account/rateLimits/read`, against a stand-in that speaks the
// same JSON-RPC a real one does. A real one would ask the service with the
// person's own sign-in, which no test may do.
//
// The stand-in ends when its input does, as the real server does — before it
// has answered — so a client that wrote its questions and closed would hear
// nothing, and the first case would fail.

const HOUR = 3_600_000

/** A snapshot as Codex sends it: windows by their minutes, resets in seconds. */
const SNAPSHOT = {
  limitId: 'codex',
  primary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
  secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_799_990_000 },
  planType: 'plus',
}

/** A `codex` that answers its app server's questions as told, and writes its pid down. */
function stand(answers: { hello?: string; read?: string }): string {
  const bin = join(tmp('tade-codex-plan-'), 'codex')
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs')",
      "const beside = (what) => process.argv[1] + '.' + what",
      "fs.writeFileSync(beside('pid'), String(process.pid))",
      "if (process.argv[2] !== 'app-server') process.exit(2)",
      "const lines = require('node:readline').createInterface({ input: process.stdin })",
      'const say = (id, body) => body && console.log(JSON.stringify({ id, ...JSON.parse(body) }))',
      "lines.on('line', (line) => {",
      '  const message = JSON.parse(line)',
      `  if (message.method === 'initialize') say(message.id, ${JSON.stringify(answers.hello ?? '')})`,
      // Told to go quiet by a file beside it, so one account can be asked twice.
      "  if (message.method === 'account/rateLimits/read' && !fs.existsSync(beside('quiet')))",
      `    setTimeout(() => say(message.id, ${JSON.stringify(answers.read ?? '')}), 50)`,
      '})',
      "lines.on('close', () => process.exit(0))",
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

const HELLO = JSON.stringify({ result: { userAgent: 'codex-stand-in' } })
const READ = JSON.stringify({ result: { rateLimits: SNAPSHOT } })

/**
 * Whether the stand-in that wrote `bin.pid` is still running. One that never
 * wrote it was ended before it got that far, which is not running either.
 */
function alive(bin: string): boolean {
  if (!existsSync(`${bin}.pid`)) return false
  const pid = Number(readFileSync(`${bin}.pid`, 'utf8'))
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(bin: string): Promise<boolean> {
  for (let tries = 0; tries < 50 && alive(bin); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return !alive(bin)
}

describe("asking Codex's app server for the plan", () => {
  /** What an ask said about why it came to nothing. */
  let said: string[] = []
  const ask = (bin: string, timeoutMs = 5_000) =>
    askPlan(bin, process.env, timeoutMs, (why) => void said.push(why))
  beforeEach(() => {
    said = []
  })

  it('hears both windows, shorter as the short one, and ends the server once it has', async () => {
    const bin = stand({ hello: HELLO, read: READ })
    const heard = await ask(bin)
    expect(heard).toMatchObject({
      fiveHour: { used: 40, resetsAt: 1_799_990_000_000 },
      sevenDay: { used: 12, resetsAt: 1_800_000_000_000 },
    })
    expect(Number.isFinite(heard?.at)).toBe(true)
    expect(said).toEqual([])
    expect(await gone(bin)).toBe(true)
  })

  it('hears nothing, in time, when the server never answers, says so, and leaves nothing running', async () => {
    const bin = stand({ hello: HELLO })
    const began = Date.now()
    expect(await ask(bin, 400)).toBeNull()
    expect(Date.now() - began).toBeLessThan(3_000)
    // However far the stand-in got before it was ended: started, or not yet.
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/did not answer within|ended before it answered/)
    expect(await gone(bin)).toBe(true)
  })

  it('hears nothing when the server answers with an error, or not in a shape Codex has, and says which', async () => {
    const refused = JSON.stringify({ error: { code: -32600, message: 'not signed in' } })
    expect(await ask(stand({ hello: HELLO, read: refused }))).toBeNull()
    expect(said.at(-1)).toBe('it answered not signed in')
    expect(await ask(stand({ hello: refused }))).toBeNull()
    expect(said.at(-1)).toBe('it refused to start talking: not signed in')
    const odd = JSON.stringify({ result: { rateLimits: { primary: { usedPercent: 'lots' } } } })
    expect(await ask(stand({ hello: HELLO, read: odd }))).toBeNull()
    expect(said.at(-1)).toBe('it answered in a shape Codex does not have')
  })

  it('says nothing at all when there is no codex to ask', async () => {
    expect(await ask('/nonexistent/codex')).toBeNull()
    expect(said).toEqual([])
  })

  it('reads one window as the short one, and a window that never resets as one', () => {
    const one = limitsOf({ primary: { usedPercent: 4, windowDurationMins: 43_200 } }, 1_000)
    expect(one).toEqual({ at: 1_000, fiveHour: { used: 4, resetsAt: 0 }, sevenDay: null })
    expect(limitsOf(null, 1_000)).toBeNull()
  })
})

describe('a Codex account asked for its plan', () => {
  const adapter = (bin: string, account?: { kind: 'subscription' | 'api-key' }) =>
    new CodexAdapter({
      runDir: tmp('tcx-'),
      codexHome: tmp('tade-codex-account-'),
      home: tmp('tade-codex-home-'),
      bin,
      ...(account ? { account: { name: 'work', dir: tmp('tade-codex-work-'), ...account } } : {}),
    })

  it('keeps what it heard, as if an agent had said it', async () => {
    const one = adapter(stand({ hello: HELLO, read: READ }))
    expect(one.limits()).toBeNull()
    const heard = await one.askLimits(5_000)
    expect(heard?.fiveHour?.used).toBe(40)
    expect(one.limits()).toEqual(heard)
  })

  it('keeps what it had when asking came to nothing', async () => {
    const bin = stand({ hello: HELLO, read: READ })
    const one = adapter(bin)
    const heard = await one.askLimits(5_000)
    // The same account, its server silent since: nothing heard, nothing lost.
    writeFileSync(`${bin}.quiet`, '')
    expect(await one.askLimits(400)).toBeNull()
    expect(one.limits()).toEqual(heard)
    expect(Date.now() - (heard?.at ?? 0)).toBeLessThan(HOUR)
  })

  it('asks nothing for an account paid by key, which has no plan', async () => {
    const bin = stand({ hello: HELLO, read: READ })
    expect(await adapter(bin, { kind: 'api-key' }).askLimits(5_000)).toBeNull()
    expect(existsSync(`${bin}.pid`)).toBe(false)
  })
})
