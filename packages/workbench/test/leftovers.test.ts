import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_TEXT_IS_MATERIAL, taskDir, undecidedProposals } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { answerAgentTool } from '../src/agent-tools.ts'
import { LEFTOVERS } from '../src/leftovers.ts'
import { readTaskFile } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// An agent reporting what it found and did not fix, through the door every
// harness sends `tade_leftovers` and `tade_done`'s `leftovers` to — against a
// real workbench on a real repository: each item made a parked task the
// orchestrator decides, the report written down once on the reporting task,
// and nothing starting until somebody decides.

const LAN = {
  title: 'bind: lan refuses the phone’s own LAN address',
  where: 'packages/web/src/listeners.ts:88',
  why: 'outside this task',
  sure: 'certain',
}
const DEBIAN = {
  title: 'on Debian the speech step says brew install whisper-cpp',
  where: 'tade setup on Debian',
  why: 'the speech step is not what this task changes',
  sure: 'likely',
}

describe('what an agent left, reported to Tade', () => {
  let home: string
  let tade: Workbench

  beforeEach(async () => {
    const repo = mkrepo()
    home = tmp('tade-leftovers-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  tade:\n    root: ${repo.root}\n`)
    tade = await Workbench.open({ home, version: '9.9.9' })
    await tade.createTask({ project: 'tade', slug: 'remote-headless-linux', intent: 'a server' })
  })

  afterEach(async () => {
    await tade.close().catch(() => {})
  })

  const report = (input: Record<string, unknown>, task = 'tade/remote-headless-linux') =>
    answerAgentTool(
      { home, log: tade.log, tasks: () => tade },
      { run: 'r1', task, cwd: home, tool: LEFTOVERS, input, callId: 'c1' },
    )

  it('makes each of two items parked work for the orchestrator, written down once', async () => {
    const said = await report({ items: [LAN, DEBIAN], finishing: true })
    const made = [
      'tade/bind-lan-refuses-the-phone-s-own-lan',
      'tade/on-debian-the-speech-step-says-brew',
    ]
    expect(said).toBe(
      `What you left is put to the orchestrator as ${made[0]} and ${made[1]}, parked until it decides whether each gets fixed, so do not fix them yourself now.`,
    )
    const lines = await tade.log.read({ types: ['leftovers_reported'] })
    expect(lines).toEqual([
      expect.objectContaining({
        task: 'tade/remote-headless-linux',
        run: 'r1',
        urgency: 'notable',
        detail: {
          items: [
            { task: made[0], ...LAN },
            { task: made[1], ...DEBIAN },
          ],
          finishing: true,
        },
      }),
    ])
    // Proposals like a watch's, so the same tool decides them and the
    // briefing says the undecided ones again.
    expect(undecidedProposals(await tade.log.read({})).map((one) => one.task)).toEqual(made)
    for (const task of made) {
      const file = await readTaskFile(home, task)
      expect(file?.parked).toBe(true)
      expect(file?.by).toBe('agent:tade/remote-headless-linux')
      expect(file?.start?.prompt).toContain('The agent on tade/remote-headless-linux found')
      await expect(tade.startQueued({ task, worktree: home, why: 'ready' })).rejects.toThrow(
        /parked/,
      )
    }
    const context = readFileSync(join(taskDir(home, made[1]!), 'context.md'), 'utf8')
    expect(context).toContain(AGENT_TEXT_IS_MATERIAL)
    expect(context).toContain('- Where: tade setup on Debian')
  })

  it('makes none of a report twice, however it is sent again', async () => {
    await report({ items: [LAN] })
    // `tade_leftovers` before finishing, then `tade_done` with the same list.
    const again = await report({ items: [{ ...LAN, title: LAN.title.toUpperCase() }, DEBIAN] })
    expect(again).toContain('put to the orchestrator as tade/on-debian-the-speech-step-says-brew')
    expect(again).toContain(
      'Already reported: "BIND: LAN REFUSES THE PHONE’S OWN LAN ADDRESS" (tade/bind-lan-refuses-the-phone-s-own-lan).',
    )
    expect(await report({ items: [DEBIAN] })).toBe(
      'Already reported: "on Debian the speech step says brew install whisper-cpp" (tade/on-debian-the-speech-step-says-brew).',
    )
    expect(await tade.log.read({ types: ['leftovers_reported'] })).toHaveLength(2)
  })

  it('refuses a report missing what makes an item findable, and writes nothing', async () => {
    await expect(report({ items: [LAN, { ...DEBIAN, where: '' }] })).rejects.toThrow(
      'item 2 has no where',
    )
    await expect(report({ items: [LAN] }, 'chats/3')).rejects.toThrow(
      'only an agent working on a task',
    )
    expect(await tade.log.read({ types: ['leftovers_reported'] })).toEqual([])
    expect(await readTaskFile(home, 'tade/bind-lan-refuses-the-phone-s-own-lan')).toBeNull()
  })

  it('says what could not be made, after writing down what was', async () => {
    // A workbench that cannot make work: what it says is what the agent reads.
    const failing = {
      createTask: async () => {
        throw new Error('the checkout is gone')
      },
      parkTask: tade.parkTask.bind(tade),
      log: tade.log,
    }
    await expect(
      answerAgentTool(
        { home, log: tade.log, tasks: () => failing as unknown as Workbench },
        {
          run: 'r1',
          task: 'tade/remote-headless-linux',
          cwd: home,
          tool: LEFTOVERS,
          input: { items: [LAN] },
          callId: 'c2',
        },
      ),
    ).rejects.toThrow(`Could not make "${LAN.title}" (the checkout is gone): send those again.`)
    expect(await tade.log.read({ types: ['leftovers_reported'] })).toEqual([])
  })
})
