import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { taskDir } from '@tade/core'
import { digestOf, type ProjectRow, writeDevices } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { AWAY_CONTROLS, awayPanel } from '../../src/panels/away/state.ts'
import {
  act,
  closeAll,
  DEVICE,
  KEY,
  type Machine,
  machine,
  paired,
  projectionOf,
  revOf,
  rowOf,
  SECRET,
  waitFor,
} from './away-harness.ts'

// The four lifecycle verbs, each all the way through a real listener: an
// agent stopped and opened again, a project closed and opened again.
//
// **What these are about is what each act leaves behind**, read off the thing
// that is the truth rather than off the answer: the registry's lane, the
// home's `config.yaml`, the folder, the task file and the journal. The doors
// are the window's own — `Agents`' stop and reattach, `Projects`' close and
// open — and `away-lifecycle.ts` says the one thing stood in for: what a
// registry and a harness answer.

afterEach(closeAll)

/** A machine listening, with an agent running on its task and a device granted `scopes`. */
async function ready(scopes: readonly string[]): Promise<Machine> {
  const one = await machine()
  one.running(one.task)
  one.lane(one.task, true)
  await paired(one.home, one.port, scopes)
  await one.away.open()
  await one.refresh()
  return one
}

/** The project's own row, as a device that may read it would have it. */
function projectRow(one: Machine, name = 'app', device = DEVICE): ProjectRow {
  const row = projectionOf(one, [], device).projects.find((each) => each.name === name)
  if (row === undefined) throw new Error(`no row for ${name}`)
  return row
}

/** What the home's own config says the projects are. */
function projectsIn(one: Machine): Record<string, { root: string }> {
  const file = parse(readFileSync(join(one.home, 'config.yaml'), 'utf8')) as {
    projects?: Record<string, { root: string }>
  }
  return file.projects ?? {}
}

/**
 * Wait until the journal holds `count` lines about where a project lives, then
 * look again. The window writes them beside an act rather than before its
 * answer, so a look taken the moment the answer arrives can be a beat early.
 */
async function settled(one: Machine, count: number): Promise<void> {
  for (let tries = 0; tries < 50; tries++) {
    const lines = await one.client.events({ types: ['config_changed'] })
    if (lines.length >= count) break
    await new Promise((done) => setTimeout(done, 10))
  }
  await one.refresh()
}

/** Every `web_did` line, as the journal has them. */
async function did(
  one: Machine,
  tools: readonly string[] = [],
): Promise<Record<string, unknown>[]> {
  await waitFor(one.client, 'web_did')
  // **Every line a test is about, not only the first.** Each is written beside
  // its answer rather than before it, so on a loaded machine the second act's
  // line can land after the first is already readable — and reading the moment
  // one appeared is a test about scheduling.
  for (let tries = 0; tries < 50; tries++) {
    const lines = (await one.client.events({ types: ['web_did'] })) as unknown as Record<
      string,
      unknown
    >[]
    const seen = new Set(lines.map((line) => (line.detail as { tool?: string }).tool))
    if (tools.every((tool) => seen.has(tool))) return lines
    await new Promise((done) => setTimeout(done, 10))
  }
  return (await one.client.events({ types: ['web_did'] })) as unknown as Record<string, unknown>[]
}

describe('stopping an agent and opening it again', () => {
  it('stops the running agent, keeps its lane, and opens it again where it left off', async () => {
    const one = await ready(['read', 'agents'])
    const row = rowOf(one, one.task)
    expect(row.lane).toBe('running')
    expect(row.can.map((each) => each.verb)).toContain('stop')

    const stopped = await act(one.port, 'stop', {
      task: one.task,
      was: row.rev,
      key: KEY,
      rev: 0,
      confirm: true,
    })
    expect(stopped.status).toBe(200)
    expect(stopped.body.did).toBe(true)
    // **What happens to the lane's spec is said**, because it is the half
    // somebody deciding whether to open it again needs.
    expect(stopped.body.said).toContain('its spec kept')
    // The registry's lane is closed — and kept — and the journal says so.
    expect(one.lane(one.task)).toBe(false)
    expect(await one.client.events({ types: ['lane_closed'], task: one.task })).toHaveLength(1)
    // Never silently: the window says it where somebody at the machine looks.
    // The task, its worktree and its file all stay.
    expect(existsSync(join(taskDir(one.home, one.task), 'task.yaml'))).toBe(true)

    await one.refresh()
    const after = rowOf(one, one.task)
    expect(after.lane).toBe('stopped')
    expect(after.can.map((each) => each.verb)).toContain('reopen')
    expect(after.cannot.find((each) => each.verb === 'stop')?.why).toContain('already stopped')

    const opened = await act(one.port, 'reopen', {
      task: one.task,
      was: after.rev,
      key: 'reopenkey1234567',
      rev: 0,
    })
    expect(opened.status).toBe(200)
    expect(opened.body.said).toContain('nothing said to it')
    expect(one.lane(one.task)).toBe(true)
    expect(await one.client.events({ types: ['run_started'], task: one.task })).toHaveLength(1)
  })

  it('refuses a stop replayed after the agent was opened again, though the lane runs exactly as before', async () => {
    // **The count of starts is what refuses it.** Stop, open again, and the
    // lane is running exactly as the first screen said — so a captured stop
    // sent under a fresh key (its receipt gone) meets a revision that moved,
    // rather than stopping the agent somebody opened since.
    const one = await ready(['read', 'agents'])
    const first = rowOf(one, one.task).rev
    const body = { task: one.task, was: first, key: KEY, rev: 0, confirm: true }
    expect((await act(one.port, 'stop', body)).status).toBe(200)
    await one.refresh()
    const reopen = { task: one.task, was: revOf(one, one.task), key: 'reopenkey1234567', rev: 0 }
    expect((await act(one.port, 'reopen', reopen)).status).toBe(200)
    await one.refresh()
    expect(rowOf(one, one.task).lane).toBe('running')

    // The same key is the same act, answered with the first answer and run once.
    const again = await act(one.port, 'stop', body)
    expect(again.status).toBe(200)
    expect(one.lane(one.task)).toBe(true)
    // A fresh key with the old screen's revision is a different world.
    const replay = await act(one.port, 'stop', { ...body, key: 'replaykey1234567' })
    expect(replay.status).toBe(409)
    expect(replay.body.error).toBe('gone')
    expect(replay.body.rev).toBe(revOf(one, one.task))
    expect(one.lane(one.task)).toBe(true)
  })

  it('reads the lane at the act, so a screen saying running cannot stop an agent that already stopped', async () => {
    const one = await ready(['read', 'agents'])
    const was = rowOf(one, one.task).rev
    // The agent ended on its own after the row was drawn and before the beat
    // that would have said so: the registry is the truth, and it is asked.
    one.lane(one.task, false)
    const no = await act(one.port, 'stop', { task: one.task, was, key: KEY, rev: 0, confirm: true })
    expect(no.status).toBe(409)
    expect(no.body.error).toBe('gone')
    expect(await one.client.events({ types: ['lane_closed'] })).toEqual([])
  })

  it('never starts an agent on a task no agent has run on', async () => {
    const one = await machine()
    await paired(one.home, one.port, ['read', 'agents'])
    await one.away.open()
    await one.refresh()
    const row = rowOf(one, one.task)
    expect(row.lane).toBe('none')
    expect(row.cannot.find((each) => each.verb === 'reopen')?.why).toContain('done at the machine')
    // Crafted anyway, with the row's own revision: nothing here by that name.
    const no = await act(one.port, 'reopen', { task: one.task, was: row.rev, key: KEY, rev: 0 })
    expect(no.status).toBe(404)
    expect(one.lane(one.task)).toBeUndefined()
    expect(await one.client.events({ types: ['run_started'] })).toEqual([])
  })

  it('takes two presses on the page and the literal here: a stop without it is not one', async () => {
    const one = await ready(['read', 'agents'])
    const was = rowOf(one, one.task).rev
    const no = await act(one.port, 'stop', { task: one.task, was, key: KEY, rev: 0 })
    expect(no.status).toBe(400)
    expect(one.lane(one.task)).toBe(true)
  })
})

describe('closing a project and opening it again', () => {
  it('closes it with an agent working, deletes nothing, and opens it again with everything back', async () => {
    const one = await ready(['read', 'projects'])
    const root = projectsIn(one).app?.root
    expect(root).toBeDefined()
    const row = projectRow(one)
    expect(row).toMatchObject({ open: true, can: [{ verb: 'close', how: 'now' }] })

    const closed = await act(one.port, 'close', {
      project: 'app',
      was: row.rev,
      key: KEY,
      rev: 0,
      confirm: true,
    })
    expect(closed.status).toBe(200)
    expect(closed.body.said).toContain('stopped nothing')
    expect(closed.body.said).toContain('an agent is')
    // No path on the wire, ever: the answer names nothing on disk.
    expect(String(closed.body.said)).not.toContain(String(root))

    // **Preserved**: the project's line left the config, and nothing else
    // moved — the folder, the task file, and the agent still working.
    expect(projectsIn(one).app).toBeUndefined()
    expect(existsSync(join(String(root), '.git'))).toBe(true)
    expect(existsSync(join(taskDir(one.home, one.task), 'task.yaml'))).toBe(true)
    expect(one.lane(one.task)).toBe(true)
    // And who did it, with where it was — what opening it again reads. Beside
    // the answer rather than before it, like every line the window journals.
    const lines = await waitFor(one.client, 'config_changed')
    expect(lines.at(-1)?.detail).toMatchObject({
      path: 'projects.app.root',
      was: root,
      now: '',
      by: `device ${DEVICE}`,
    })

    await one.refresh()
    const shut = projectRow(one)
    expect(shut).toMatchObject({ open: false, can: [{ verb: 'open', how: 'now' }] })
    expect(projectionOf(one).tasks.filter((task) => task.project === 'app')).toEqual([])

    // **Restorable**, from the same phone, naming the project and no folder.
    const opened = await act(one.port, 'open', {
      project: 'app',
      was: shut.rev,
      key: 'openkey123456789',
      rev: 0,
    })
    expect(opened.status).toBe(200)
    expect(projectsIn(one).app?.root).toBe(root)
    await one.refresh()
    expect(projectRow(one).open).toBe(true)
    expect(rowOf(one, one.task)).toMatchObject({ lane: 'running' })
  })

  it('refuses a close replayed after the project was opened again', async () => {
    const one = await ready(['read', 'projects'])
    const first = projectRow(one).rev
    const body = { project: 'app', was: first, key: KEY, rev: 0, confirm: true }
    expect((await act(one.port, 'close', body)).status).toBe(200)
    await settled(one, 1)
    const open = { project: 'app', was: projectRow(one).rev, key: 'openkey123456789', rev: 0 }
    expect((await act(one.port, 'open', open)).status).toBe(200)
    await settled(one, 2)
    expect(projectRow(one).open).toBe(true)
    // Open exactly as the first screen said, and the count of lines about
    // where it lives is what tells the two worlds apart.
    const replay = await act(one.port, 'close', { ...body, key: 'replaykey1234567' })
    expect(replay.status).toBe(409)
    expect(replay.body.error).toBe('gone')
    expect(projectsIn(one).app).toBeDefined()
  })

  it('answers a repeat across a restart from the receipts, and closes once', async () => {
    const one = await ready(['read', 'projects'])
    const body = { project: 'app', was: projectRow(one).rev, key: KEY, rev: 0, confirm: true }
    const first = await act(one.port, 'close', body)
    expect(first.status).toBe(200)
    // The listener goes and comes back — a new lifetime, the same home.
    await one.away.stop()
    await one.away.open()
    const again = await act(one.port, 'close', body)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    const closes = (await one.client.events({ types: ['config_changed'] })).filter(
      (line) => (line.detail as { now?: string }).now === '',
    )
    expect(closes).toHaveLength(1)
  })

  it('does not open a project whose folder has gone, and says nothing about where it was', async () => {
    const one = await ready(['read', 'projects'])
    const root = String(projectsIn(one).app?.root)
    expect(
      (
        await act(one.port, 'close', {
          project: 'app',
          was: projectRow(one).rev,
          key: KEY,
          rev: 0,
          confirm: true,
        })
      ).status,
    ).toBe(200)
    await settled(one, 1)
    rmSync(join(root, '.git'), { recursive: true, force: true })
    const no = await act(one.port, 'open', {
      project: 'app',
      was: projectRow(one).rev,
      key: 'openkey123456789',
      rev: 0,
    })
    expect(no.status).toBe(404)
    expect(JSON.stringify(no.body)).not.toContain(root)
    expect(projectsIn(one).app).toBeUndefined()
  })
})

describe('a journal line nobody at this machine wrote', () => {
  it('cannot make a device open a folder the close never named', async () => {
    // The journal is a file anything running as you can append to. A line
    // claiming a project closed from a relative path is not one the close
    // wrote — it writes the config's own root — so opening it is refused, and
    // nothing is resolved against wherever the window happens to be.
    const one = await ready(['read', 'projects'])
    await one.client.log.append({
      type: 'config_changed',
      // `.` is this process's own folder — a git checkout, here — which is
      // exactly what a check that resolved it would find and accept.
      detail: { path: 'projects.ghost.root', was: '.', now: '', by: 'window' },
    })
    await one.refresh()
    const ghost = projectRow(one, 'ghost')
    expect(ghost.open).toBe(false)
    const no = await act(one.port, 'open', { project: 'ghost', was: ghost.rev, key: KEY, rev: 0 })
    expect(no.status).toBe(404)
    expect(projectsIn(one).ghost).toBeUndefined()
  })
})

describe('who may', () => {
  it('refuses a device granted both acting tiers and neither lifecycle scope', async () => {
    const one = await ready(['read', 'answer', 'steer'])
    const stop = await act(one.port, 'stop', {
      task: one.task,
      was: rowOf(one, one.task).rev,
      key: KEY,
      rev: 0,
      confirm: true,
    })
    expect(stop.status).toBe(403)
    const close = await act(one.port, 'close', {
      project: 'app',
      was: projectRow(one).rev,
      key: 'closekey12345678',
      rev: 0,
      confirm: true,
    })
    expect(close.status).toBe(403)
    expect(one.lane(one.task)).toBe(true)
    expect(projectsIn(one).app).toBeDefined()
  })

  it('keeps the two scopes apart: agents is not projects, and projects is not agents', async () => {
    const agents = await ready(['read', 'agents'])
    const close = await act(agents.port, 'close', {
      project: 'app',
      was: projectRow(agents).rev,
      key: KEY,
      rev: 0,
      confirm: true,
    })
    expect(close.status).toBe(403)
    expect(projectsIn(agents).app).toBeDefined()

    const projects = await ready(['read', 'projects'])
    const stop = await act(projects.port, 'stop', {
      task: projects.task,
      was: rowOf(projects, projects.task).rev,
      key: KEY,
      rev: 0,
      confirm: true,
    })
    expect(stop.status).toBe(403)
    expect(projects.lane(projects.task)).toBe(true)
  })

  it('holds a device to the projects it reads, which is the per-project boundary', async () => {
    const one = await machine()
    one.running(one.task)
    one.lane(one.task, true)
    // Granted both lifecycle scopes, and the reading of one other project.
    await writeDevices(one.home, [
      {
        kind: 'paired',
        device: DEVICE,
        at: new Date().toISOString(),
        label: 'iPhone',
        digest: digestOf(SECRET),
        host: `127.0.0.1:${one.port}`,
        csrf: 'x'.repeat(43),
        until: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: ['read', 'agents', 'projects'],
        projects: ['shop'],
        granted: [],
        from: '127.0.0.1',
      },
    ])
    await one.away.open()
    await one.refresh()
    const close = await act(one.port, 'close', {
      project: 'app',
      was: projectRow(one).rev,
      key: KEY,
      rev: 0,
      confirm: true,
    })
    expect(close.status).toBe(403)
    const stop = await act(one.port, 'stop', {
      task: one.task,
      was: rowOf(one, one.task).rev,
      key: 'stopkey123456789',
      rev: 0,
      confirm: true,
    })
    expect(stop.status).toBe(403)
    expect(projectsIn(one).app).toBeDefined()
    expect(one.lane(one.task)).toBe(true)
  })
})

describe('the audit', () => {
  it('writes a line under the device for every act, and for every refusal', async () => {
    const one = await ready(['read', 'agents'])
    const was = rowOf(one, one.task).rev
    await act(one.port, 'stop', { task: one.task, was, key: KEY, rev: 0, confirm: true })
    // Refused at the door: no `projects` scope. The body is never read there,
    // so the line names the device and the verb and nothing it did not read.
    await act(one.port, 'close', {
      project: 'app',
      was: projectRow(one).rev,
      key: 'closekey12345678',
      rev: 0,
      confirm: true,
    })
    const lines = await did(one, ['stop', 'close'])
    const stop = lines.find((line) => (line.detail as { tool?: string }).tool === 'stop')
    expect(stop).toMatchObject({
      task: one.task,
      detail: { device: DEVICE, tool: 'stop', state: 'stopped its agent', why: 'done' },
    })
    const door = lines.find((line) => (line.detail as { tool?: string }).tool === 'close')
    expect(door).toMatchObject({
      task: null,
      detail: { device: DEVICE, tool: 'close', state: 'refused', why: 'out_of_scope' },
    })
  })

  it('names the project, never as a task, on a project act the window refused', async () => {
    const one = await ready(['read', 'projects'])
    const stale = await act(one.port, 'close', {
      project: 'app',
      was: 'o1.c9',
      key: KEY,
      rev: 0,
      confirm: true,
    })
    expect(stale.status).toBe(409)
    const line = (await did(one)).find(
      (each) => (each.detail as { tool?: string }).tool === 'close',
    )
    // A project is not a task: it is in the detail, and the event has none.
    expect(line).toMatchObject({
      task: null,
      detail: { device: DEVICE, tool: 'close', project: 'app', state: 'refused', why: 'gone' },
    })
    expect(projectsIn(one).app).toBeDefined()
  })
})

describe('granting it, at the machine', () => {
  /** Press one of the panel's own controls, the way a click reaches the subject. */
  async function press(one: Machine, control: string): Promise<void> {
    const submit = one.away.submits().away
    if (submit === undefined) throw new Error('the away panel has no submit')
    await submit(awayPanel(), control)
  }

  it('is off for a paired device until a person presses its chip, one scope per chip', async () => {
    const one = await machine()
    one.running(one.task)
    one.lane(one.task, true)
    await paired(one.home, one.port, ['answer', 'steer'])
    await one.away.open()
    await one.away.reread()
    one.show()
    const before = one.away.panel()?.away?.devices[0]
    expect(before).toMatchObject({ mayAct: true, mayStop: false, mayClose: false })

    await press(one, `${AWAY_CONTROLS.agents}${DEVICE}`)
    expect(one.news.join(' ')).toContain('can stop an agent or open it again')
    expect(one.away.panel()?.away?.devices[0]).toMatchObject({
      mayAct: true,
      mayStop: true,
      mayClose: false,
    })
    // The grant composes: both acting tiers are still there, and reading.
    const lines = readFileSync(join(one.home, 'web-devices.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      kind: 'allowed',
      scopes: expect.arrayContaining(['read', 'answer', 'steer', 'agents']),
    })
    expect(JSON.parse(lines.at(-1) ?? '{}').scopes).not.toContain('projects')
    // And it is in the journal as a grant at the machine.
    const granted = await waitFor(one.client, 'web_paired')
    expect(granted.at(-1)).toMatchObject({ detail: { device: DEVICE, granted: 'at the machine' } })

    // The device can now stop the agent, and still cannot close the project.
    await one.refresh()
    const stop = await act(one.port, 'stop', {
      task: one.task,
      was: rowOf(one, one.task).rev,
      key: KEY,
      rev: 0,
      confirm: true,
    })
    expect(stop.status).toBe(200)
    const close = await act(one.port, 'close', {
      project: 'app',
      was: projectRow(one).rev,
      key: 'closekey12345678',
      rev: 0,
      confirm: true,
    })
    expect(close.status).toBe(403)

    // Pressed again, it is taken back — and nothing else with it.
    await press(one, `${AWAY_CONTROLS.agents}${DEVICE}`)
    expect(one.news.join(' ')).toContain('can no longer stop an agent')
    expect(one.away.panel()?.away?.devices[0]).toMatchObject({ mayAct: true, mayStop: false })
  })

  it('draws both chips only where acting is on, and refuses a grant while it is off', async () => {
    const on = await machine()
    await paired(on.home, on.port, [])
    await on.away.open()
    await on.away.reread()
    on.show()
    expect(on.away.panel()?.away?.acting).toBe(true)

    const off = await machine({ acting: false })
    await paired(off.home, off.port, [])
    await off.away.open()
    await off.away.reread()
    off.show()
    await press(off, `${AWAY_CONTROLS.projects}${DEVICE}`)
    expect(off.away.panel()?.away?.problem).toContain('Let a paired device act')
    expect(off.away.panel()?.away?.devices[0]?.mayClose).toBe(false)
  })
})
