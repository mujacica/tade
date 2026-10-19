import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'

// A `codex` whose app server answers how much of the plan is used, so asking
// one runs nothing real: a real one would ask the service with the person's
// own sign-in, which no test may do.

/** A snapshot as Codex sends it: windows by their minutes, resets in seconds. */
const SNAPSHOT = {
  limitId: 'codex',
  primary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
  secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_799_990_000 },
  planType: 'plus',
}

/** A `codex` that answers its app server's questions as told, and writes its pid down. */
export function stand(answers: { hello?: string; read?: string }): string {
  const bin = join(tmp('tade-codex-plan-'), 'codex')
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs')",
      "const beside = (what) => process.argv[1] + '.' + what",
      // Moved into place whole, so nobody reads a pid file with no pid in it yet.
      "fs.writeFileSync(beside('pid-'), String(process.pid))",
      "fs.renameSync(beside('pid-'), beside('pid'))",
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

export const HELLO = JSON.stringify({ result: { userAgent: 'codex-stand-in' } })
export const READ = JSON.stringify({ result: { rateLimits: SNAPSHOT } })
