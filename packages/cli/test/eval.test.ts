import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

// `tade eval`: a replay made from the command line as queued work, read back
// with no window, refused while a window holds the home, and a judge asked
// again only where one is set up.

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

function tade(
  home: string,
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, TADE_HOME: home, HOME: home },
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      err += chunk
    })
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}

describe('tade eval', () => {
  let home: string
  let window: Workbench | null = null

  beforeEach(async () => {
    const repo = mkrepo()
    home = tmp('tade-eval-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const base = repo.head()
    const sha = repo.commit('Greet\n\nTade-Task: app/greet', { 'src/greet.txt': 'hello\n' })
    // The journal of one task that landed, written and let go of before the
    // command runs: holding the home here would be the refusal under test.
    const tade = await Workbench.open({ home })
    const at = (type: string, detail: Record<string, unknown>) =>
      tade.log.append({ type: type as never, task: 'app/greet', detail })
    await at('task_created', {
      workspace: 'worktree',
      intent_spoken: 'add a greeting that says hello',
      base,
    })
    await at('run_started', { harness: 'pi' })
    await at('commit_seen', { sha, project: 'app', at: new Date().toISOString(), added: 1 })
    await at('task_done', { by: 'rule', rule: 'merged' })
    await tade.close()
  })

  afterEach(async () => {
    await window?.close().catch(() => {})
    window = null
  })

  it('makes a replay as queued work, and reads it back with no window', async () => {
    const run = await tade(home, [
      'eval',
      'run',
      'app',
      '--harness',
      'pi',
      '--ceiling',
      '2',
      '--name',
      'night',
    ])
    expect(run.err).toBe('')
    expect(run.code).toBe(0)
    expect(run.out).toMatch(
      /^night: 1 task to replay, queued with a \$2\.00 ceiling\. A window starts them/,
    )

    const shown = await tade(home, ['eval', 'show', 'night', '--json'])
    expect(shown.code).toBe(0)
    const [replay] = (
      JSON.parse(shown.out) as {
        replays: { name: string; said: string; entrants: { of: string; outcome: string }[] }[]
      }
    ).replays
    expect(replay?.name).toBe('night')
    // What was typed is what the journal keeps as asked.
    expect(replay?.said).toBe('tade eval run app --harness pi --ceiling 2 --name night')
    expect(replay?.entrants).toEqual([
      expect.objectContaining({ of: 'app/greet', outcome: 'waiting' }),
    ])

    const words = await tade(home, ['eval', 'show'])
    expect(words.out).toMatch(/Replay night in app, on pi on its own route: 1 waiting\./)
  })

  it('says what is missing rather than guessing', async () => {
    const nothing = await tade(home, ['eval', 'run', 'app', '--ceiling', '2'])
    expect(nothing.code).toBe(2)
    expect(nothing.err).toMatch(/name what to replay on/)
    const free = await tade(home, ['eval', 'run', 'app', '--model', 'x', '--ceiling', '0'])
    expect(free.code).toBe(2)
    expect(free.err).toMatch(/--ceiling is a number above nought/)
    const none = await tade(home, ['eval', 'show', 'ghost'])
    expect(none.code).toBe(1)
    expect(none.out).toBe('there is no replay called ghost\n')
  })

  it('is refused while a window holds the home, and says where to ask', async () => {
    window = await Workbench.open({ home })
    const run = await tade(home, ['eval', 'run', 'app', '--harness', 'pi', '--ceiling', '2'])
    expect(run.code).toBe(1)
    expect(run.err).toMatch(
      /Ask the orchestrator there to run the eval \(tade_replay\), or close it first/,
    )
    // A question is still answered with the window open.
    const shown = await tade(home, ['eval', 'show'])
    expect(shown.code).toBe(0)
  })

  it('asks no judge that is not set up', async () => {
    const judged = await tade(home, ['eval', 'judge', '--ceiling', '1'])
    expect(judged.code).toBe(1)
    expect(judged.err).toMatch(/TYPESAFE_API_KEY|needs setup/)
  })
})
