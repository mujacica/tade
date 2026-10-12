import { describe, expect, it } from 'vitest'
import { ExtensionHost } from '../src/host.ts'
import type { ExecResult, TadeExtension } from '../src/port.ts'
import { object } from '../src/schema.ts'

// What an extension runs through `ctx.exec`: the resources extension's `ps`,
// the review's `gh`, the checks' and Jev's `git`. These were the programs that
// retitled the terminal Tade runs in, every few seconds, because the host
// started them with `execFile` and its `detached` was never passed on. So this
// asks the machine which group the program ran in, through the host, rather
// than trusting the runner beneath it to have been used.

/** An extension with one tool that runs a program and hands back what came of it. */
function running(command: string, args: string[]): TadeExtension {
  return {
    name: 'probe',
    title: 'Probe',
    description: 'Runs one program and says what came of it.',
    tools: [
      {
        name: 'probe_run',
        description: 'Run the program.',
        parameters: object({}),
        for: ['orchestrator'],
        run: async (_input, ctx) => ({ text: JSON.stringify(await ctx.exec(command, args)) }),
      },
    ],
  }
}

async function ran(command: string, args: string[]): Promise<ExecResult> {
  const loaded = await ExtensionHost.load({
    builtin: [running(command, args)],
    config: { extensions: {}, projects: {} },
    home: '/home',
  })
  const answer = await loaded.call('probe_run', {}, { caller: { kind: 'you' }, id: 'c1' })
  return JSON.parse(answer.text) as ExecResult
}

describe('a program an extension runs', () => {
  it('runs in a process group of its own, so the terminal is never named after it', async () => {
    const said = await ran('sh', ['-c', 'echo $$ $(ps -o pgid= -p $$)'])
    const [pid, group] = said.stdout.trim().split(/\s+/)
    // A machine with no `ps` cannot be asked, and a test that cannot ask is
    // not a test that fails.
    if (!group) return
    expect(group).toBe(pid)
  })

  it('hands back its code and what it said, and a program that is not there is one too', async () => {
    expect(await ran('sh', ['-c', 'echo out; echo err >&2; exit 3'])).toEqual({
      code: 3,
      stdout: 'out\n',
      stderr: 'err\n',
    })
    expect(await ran('tade-no-such-program', [])).toEqual({
      code: 127,
      stdout: '',
      stderr: 'there is no tade-no-such-program on this machine',
    })
  })
})
