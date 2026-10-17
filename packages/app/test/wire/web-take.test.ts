import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type TadeEvent } from '@tade/core'
import { type Take, TakeSchema } from '@tade/web'
import { Workbench } from '@tade/workbench'
import { readTaskFile, taskContextPath } from '@tade/workbench/tasks'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mkrepo, runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { takingFrom } from '../../src/wire/web-take.ts'

// This machine's half of work another machine of the person's hands it
// (`web-take.ts`): made queued work through the workbench's one write path,
// with a real repository, a real `origin`, and a second checkout of it standing
// in for the other machine — which pushes the branch this one fetches with its
// own credentials and begins a worktree on.

const opened: Workbench[] = []
afterEach(async () => {
  for (const client of opened.splice(0)) await client.close().catch(() => {})
})

/** A machine with one project, `tade`, checked out from a bare origin; and the other machine's clone. */
async function machines() {
  const vps = mkrepo({ remote: true })
  const home = tmp('tade-take-')
  const config = { projects: { tade: { root: vps.root } } }
  writeFileSync(join(home, 'config.yaml'), `projects:\n  tade:\n    root: ${vps.root}\n`)
  const client = await Workbench.open({ home })
  opened.push(client)
  let refreshed = 0
  const wire = {
    now: () => Date.now(),
    live: {
      refresh: async () => {
        refreshed++
      },
    },
    opts: { home, config: ConfigSchema.parse(config), client },
  } as unknown as Wiring
  const mac = join(tmp('tade-mac-'), 'tade')
  runGit(join(mac, '..'), 'clone', '-q', vps.remote ?? '', mac)
  return { vps, home, client, wire, mac, refreshed: () => refreshed }
}

/** The other machine's agent, committing on its branch and pushing it. */
function pushed(mac: string, branch: string): string {
  runGit(mac, 'checkout', '-q', '-b', branch)
  writeFileSync(join(mac, 'fix.txt'), 'half of the fix\n')
  runGit(mac, 'add', 'fix.txt')
  runGit(
    mac,
    '-c',
    'user.name=Mac',
    '-c',
    'user.email=mac@example.invalid',
    'commit',
    '-q',
    '-m',
    'half of the fix',
  )
  runGit(mac, 'push', '-q', 'origin', branch)
  return runGit(mac, 'rev-parse', 'HEAD').trim()
}

const TAKE = {
  from: 'mac',
  was: 'tade/fix-it',
  project: 'tade',
  name: 'fix-it',
  intent: 'fix the flaky test, and say why it was flaky',
  prompt: 'Fix the flaky test.',
  context: '## What we know\n\nIt fails under load.\n',
}

function take(over: Partial<Take> & Record<string, unknown> = {}): Take {
  return TakeSchema.parse({ ...TAKE, ...over })
}

async function lines(client: Workbench, type: string): Promise<TadeEvent[]> {
  return (await client.log.read({})).filter((one) => one.type === type)
}

describe('work handed to this machine, as its window makes it', () => {
  it('makes queued work in the project, the person’s, with its words and context kept', async () => {
    const one = await machines()
    const answer = await takingFrom(one.wire)(take(), 'ab12cd34ab12cd34')
    expect(answer).toMatchObject({ took: true, task: 'tade/fix-it', pushes: null })
    const file = await readTaskFile(one.home, 'tade/fix-it')
    expect(file?.intent_spoken).toBe(TAKE.intent)
    expect(file?.by).toBe('you')
    expect(file?.start).toMatchObject({ after: [], prompt: TAKE.prompt })
    expect(file?.start?.from).toBeUndefined()
    expect(readFileSync(taskContextPath(one.home, 'tade/fix-it'), 'utf8')).toBe(TAKE.context)
    const taken = await lines(one.client, 'task_taken')
    expect(taken.map((line) => [line.task, line.detail])).toEqual([
      ['tade/fix-it', { from: 'mac', was: 'tade/fix-it', device: 'ab12cd34ab12cd34' }],
    ])
    // Started by the queue's own rule on the next look, which this asked for.
    expect(one.refreshed()).toBe(1)
  })

  it('fetches a pushed branch with its own credentials and begins a worktree on it', async () => {
    const one = await machines()
    const head = pushed(one.mac, 'tade/fix-it')
    const answer = await takingFrom(one.wire)(
      take({ begins: { branch: 'tade/fix-it', head } }),
      'ab12cd34ab12cd34',
    )
    expect(answer).toMatchObject({ took: true, task: 'tade/fix-it', pushes: true })
    if (!answer.took) return
    expect(answer.said).toContain(head.slice(0, 12))
    const file = await readTaskFile(one.home, 'tade/fix-it')
    expect(file?.start?.from).toBe(head)
    // A worktree of its own, whatever the project says: in a shared checkout
    // `start.from` would mean nothing.
    const [created] = await lines(one.client, 'task_created')
    expect(created?.detail).toMatchObject({ workspace: 'worktree', branch: 'tade/fix-it' })
    // Fetched into git's own place for it, and nothing in the checkout moved.
    expect(one.vps.git('rev-parse', 'refs/remotes/origin/tade/fix-it').trim()).toBe(head)
    expect(one.vps.git('status', '--porcelain').trim()).toBe('')
    expect(existsSync(join(one.vps.root, 'fix.txt'))).toBe(false)
    const [taken] = await lines(one.client, 'task_taken')
    expect(taken?.detail).toMatchObject({ branch: 'tade/fix-it', head })
  })

  it('takes nothing that begins on a commit origin does not have', async () => {
    const one = await machines()
    pushed(one.mac, 'tade/fix-it')
    const answer = await takingFrom(one.wire)(
      take({ begins: { branch: 'tade/fix-it', head: 'c'.repeat(40) } }),
      'ab12cd34ab12cd34',
    )
    expect(answer).toMatchObject({ took: false })
    if (answer.took) return
    expect(answer.said).toContain('never reached origin')
    expect(await readTaskFile(one.home, 'tade/fix-it')).toBeNull()
    expect(await lines(one.client, 'task_taken')).toEqual([])
  })

  it('says what its own credentials could not fetch, and makes nothing', async () => {
    const one = await machines()
    one.vps.git('remote', 'set-url', 'origin', join(one.home, 'nowhere.git'))
    const answer = await takingFrom(one.wire)(
      take({ begins: { branch: 'tade/fix-it', head: 'c'.repeat(40) } }),
      'ab12cd34ab12cd34',
    )
    expect(answer).toMatchObject({ took: false })
    if (answer.took) return
    expect(answer.said).toContain('with its own credentials')
    expect(await readTaskFile(one.home, 'tade/fix-it')).toBeNull()
  })

  it('refuses a name used here before, and a project it does not have', async () => {
    const one = await machines()
    await one.client.createTask({ project: 'tade', slug: 'fix-it', intent: 'an older one' })
    const used = await takingFrom(one.wire)(take(), 'ab12cd34ab12cd34')
    expect(used).toMatchObject({ took: false })
    if (!used.took) expect(used.said).toContain('never used twice')
    const none = await takingFrom(one.wire)(take({ project: 'shop' }), 'ab12cd34ab12cd34')
    expect(none).toEqual({ took: false, said: 'There is no project called shop here.' })
    expect(await lines(one.client, 'task_taken')).toEqual([])
  })

  it('answers a check without making, fetching or writing anything', async () => {
    const one = await machines()
    const before = (await one.client.log.read({})).length
    const answer = await takingFrom(one.wire)(
      take({ check: true, begins: { branch: 'tade/fix-it', head: 'c'.repeat(40) } }),
      'ab12cd34ab12cd34',
    )
    expect(answer).toEqual({
      took: true,
      task: 'tade/fix-it',
      said: 'tade/fix-it can be taken here.',
      pushes: null,
    })
    expect(await readTaskFile(one.home, 'tade/fix-it')).toBeNull()
    expect((await one.client.log.read({})).length).toBe(before)
    expect(() => one.vps.git('rev-parse', '--verify', 'refs/remotes/origin/tade/fix-it')).toThrow()
    expect(one.refreshed()).toBe(0)
  })

  it('keeps the task file a task file another Tade reads', async () => {
    const one = await machines()
    await takingFrom(one.wire)(take({ done: 'idle', at: '2026-10-18T06:00:00.000Z' }), 'd')
    const raw = parse(
      readFileSync(join(one.home, 'projects', 'tade', 'tasks', 'fix-it', 'task.yaml'), 'utf8'),
    )
    expect(raw.done).toBe('idle')
    expect(raw.start.at).toBe('2026-10-18T06:00:00.000Z')
  })
})
