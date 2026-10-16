import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskDir, undecidedProposals } from '@tade/core'
import { readTaskFile, Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { lessonMethods } from '../src/host-lessons.ts'

// The `ToolHost` method behind `tade_propose_check`, against a real workbench
// on a real repository: what the orchestrator is answered, and that what it
// makes is one task, parked as a proposal it decides itself with
// `tade_proposal_decide`, which nothing else starts.

describe('a check the orchestrator proposes', () => {
  let home: string
  let tade: Workbench
  let propose: (p: Record<string, unknown>) => Promise<string>

  beforeEach(async () => {
    const repo = mkrepo()
    home = tmp('tade-host-lessons-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  shop:\n    root: ${repo.root}\n`)
    tade = await Workbench.open({ home, version: '9.9.9' })
    for (const slug of ['refunds', 'payouts']) {
      await tade.createTask({ project: 'shop', slug, intent: `add ${slug}` })
    }
    const method = lessonMethods(tade)['check/propose']
    if (!method) throw new Error('no check/propose method')
    propose = method
  })

  afterEach(async () => {
    await tade.close().catch(() => {})
  })

  it('is made parked as a proposal for the orchestrator, with what was seen in its context file', async () => {
    const said = await propose({
      project: 'shop',
      name: 'floating-promises',
      mistake: 'A promise is started and never awaited.',
      tasks: ['shop/refunds', 'shop/payouts'],
      seen: 'Both times the person asked for the missing await in review.',
    })
    expect(said).toContain('Proposed shop/check-floating-promises, parked and put to you')
    expect(said).toContain('tade_proposal_decide')
    expect(said).not.toContain('picks it up')
    // A proposal like any a watch makes, so deciding it is the same tool and
    // one left undecided is in the next briefing.
    expect(undecidedProposals(await tade.log.read({}))).toMatchObject([
      {
        task: 'shop/check-floating-promises',
        schedule: null,
        key: null,
        title: 'check for floating-promises',
      },
    ])
    const file = await readTaskFile(home, 'shop/check-floating-promises')
    expect(file?.parked).toBe(true)
    expect(file?.by).toBe('orchestrator')
    expect(file?.start?.prompt).toContain('shop/refunds and shop/payouts')
    expect(file?.start?.prompt).toContain('a line in the commit hook, a lint rule or a test')
    const context = readFileSync(
      join(taskDir(home, 'shop/check-floating-promises'), 'context.md'),
      'utf8',
    )
    expect(context).toContain('Both times the person asked for the missing await')
    await expect(
      tade.startQueued({ task: 'shop/check-floating-promises', worktree: home, why: 'ready' }),
    ).rejects.toThrow(/parked/)
  })

  it('refuses a mistake seen once: that is a lesson, not a check', async () => {
    await expect(
      propose({
        project: 'shop',
        name: 'floating-promises',
        mistake: 'A promise is never awaited.',
        tasks: ['shop/refunds', 'shop/refunds'],
      }),
    ).rejects.toThrow(/only shop\/refunds was/)
  })

  it('refuses a task that never was, and a project that is not there', async () => {
    await expect(
      propose({
        project: 'shop',
        name: 'x',
        mistake: 'Something.',
        tasks: ['shop/refunds', 'shop/imagined'],
      }),
    ).rejects.toThrow(/never been a task called shop\/imagined/)
    await expect(
      propose({ project: 'blog', name: 'x', mistake: 'Something.', tasks: [] }),
    ).rejects.toThrow(/no project called blog/)
    await expect(
      propose({ project: 'shop', name: 'Not A Name', mistake: 'Something.', tasks: [] }),
    ).rejects.toThrow(/not a usable name/)
    await expect(propose({ project: 'shop', name: 'x', mistake: ' ', tasks: [] })).rejects.toThrow(
      /say what the mistake is/,
    )
  })
})
