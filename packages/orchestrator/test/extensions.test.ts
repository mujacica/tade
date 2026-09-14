import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@wilco/core'
import { ExtensionHost } from '@wilco/extensions-core'
import { Workbench } from '@wilco/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  BUILTIN_EXTENSIONS,
  decideProposal,
  extensionWorkbench,
  loadExtensions,
  proposedExtensions,
  workbenchExtensions,
} from '../src/extensions.ts'

// What an extension's work becomes in a real repository: an agent in its own
// worktree, told what it was started for and where that came from, launched
// with the extensions' instructions and pieces.

describe('an agent an extension starts', () => {
  let wilco: Workbench | null = null

  afterEach(async () => {
    await wilco?.stopEverything().catch(() => {})
    await wilco?.close().catch(() => {})
    wilco = null
  })

  it('works where agents work, with its context and links, and launches with what extensions give agents', async () => {
    const repo = mkrepo()
    repo.commit('first')
    const home = tmp('wx-home-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  shop:\n    root: ${repo.root}\n`)
    const root = tmp('wx-ext-')
    mkdirSync(join(root, 'skills', 'fixing'), { recursive: true })
    const host = await ExtensionHost.load({
      builtin: [
        {
          name: 'errors',
          title: 'Errors',
          description: 'Errors from production.',
          root,
          tools: [
            {
              name: 'errors_issue',
              description: 'One error.',
              parameters: { type: 'object', properties: {} },
              for: ['agent'],
              run: async () => ({ text: 'an error' }),
            },
          ],
          agents: (_ctx, project) => `${project.name} reports errors to the error tracker.`,
          harness: { pi: { skills: ['skills/fixing'] } },
        },
      ],
      config: { extensions: {}, projects: { shop: { root: repo.root } } },
      home,
    })
    let window: ReturnType<typeof extensionWorkbench> | null = null
    wilco = await Workbench.open({
      home,
      extensions: workbenchExtensions(host, home, () => window),
    })
    const started: string[] = []
    window = extensionWorkbench(wilco, (task) => started.push(task))

    const first = await window.startAgent({
      project: 'shop',
      title: 'fix SHOP-1A',
      prompt: 'Fix SHOP-1A.',
      context: '# SHOP-1A: TypeError in refund',
      links: [{ title: 'SHOP-1A', url: 'https://acme.sentry.io/issues/4411/' }],
      prepare: async (worktree) => writeFileSync(join(worktree, 'prepared.txt'), 'ready\n'),
    })
    expect(first.task).toBe('shop/fix-shop-1a')
    expect(started).toEqual(['shop/fix-shop-1a'])
    // Beside the others in the checkout, which is where agents work unless set otherwise.
    expect(first.worktree).toBe(repo.root)
    const own = join(first.worktree, '.wilco', 'tasks', 'fix-shop-1a')
    expect(readFileSync(join(own, 'context.md'), 'utf8')).toBe(
      '# SHOP-1A: TypeError in refund\n\n## Links\n\n- [SHOP-1A](https://acme.sentry.io/issues/4411/)\n',
    )
    expect(existsSync(join(first.worktree, 'prepared.txt'))).toBe(true)

    // The agent runs with the extensions' words, skills and tools.
    const lane = wilco.lane('shop/fix-shop-1a/agent' as never)
    const args = lane?.spec.args ?? []
    const told = args[args.indexOf('--append-system-prompt') + 1] ?? ''
    // It knows where it is: in Wilco, on this task, in the checkout beside others.
    expect(told).toContain('You are running inside Wilco')
    expect(told).toContain('Your task is shop/fix-shop-1a')
    expect(told).toContain(first.worktree)
    expect(told).toContain('at the same time as other agents')
    expect(told).toContain('.wilco/tasks/fix-shop-1a/context.md')
    expect(told).toContain('shop reports errors to the error tracker.')
    expect(args[args.indexOf('--skill') + 1]).toBe(join(root, 'skills', 'fixing'))
    const tools = JSON.parse(readFileSync(lane?.spec.env?.WILCO_EXTENSION_TOOLS ?? '', 'utf8')) as {
      name: string
    }[]
    expect(tools.map((tool) => tool.name)).toEqual(['errors_issue'])

    // The links are kept with the task, where status reads them back from.
    expect(readFileSync(join(own, 'task.yaml'), 'utf8')).toContain(
      'url: https://acme.sentry.io/issues/4411/',
    )

    // Renamed while it runs: kept in its task, and it keeps the name next time it starts.
    await wilco.renameAgent({ task: first.task, worktree: first.worktree, title: 'Refund retries' })
    expect(readFileSync(join(own, 'task.yaml'), 'utf8')).toContain('title_named: true')

    // The same work started again is a second agent, not an error.
    await wilco.stopAgent('shop/fix-shop-1a')
    const again = await window.startAgent({
      project: 'shop',
      title: 'fix SHOP-1A',
      prompt: 'Again.',
    })
    expect(again.task).toBe('shop/fix-shop-1a-2')
  }, 60_000)

  it('ships dependencies, Sentry and resources, and loads yours beside them', async () => {
    expect(BUILTIN_EXTENSIONS.map((one) => one.name)).toEqual(['deps', 'sentry', 'resources'])
    const home = tmp('wx-load-')
    const host = await loadExtensions({
      config: ConfigSchema.parse({ orchestrator: { extensions: join(home, 'extensions') } }),
      home,
      env: {},
    })
    expect(host.list().map((one) => [one.name, one.state])).toEqual([
      ['deps', 'ready'],
      ['sentry', 'needs setup'],
      ['resources', 'ready'],
    ])
  })

  it('lists what Wilco wrote for itself, and approving or turning one down moves it and is committed', async () => {
    const root = tmp('wx-proposals-')
    mkdirSync(join(root, 'proposed', 'release-notes'), { recursive: true })
    writeFileSync(
      join(root, 'proposed', 'release-notes', 'extension.ts'),
      '// Drafts release notes from merged work.\nexport default {}\n',
    )
    writeFileSync(
      join(root, 'proposed', 'standup.ts'),
      '// Reads out yesterday.\nexport default function () {}\n',
    )
    expect(proposedExtensions(root)).toEqual([
      {
        name: 'release-notes',
        kind: 'extension',
        why: 'Drafts release notes from merged work.',
        path: join(root, 'proposed', 'release-notes'),
      },
      {
        name: 'standup',
        kind: 'tool',
        why: 'Reads out yesterday.',
        path: join(root, 'proposed', 'standup.ts'),
      },
    ])
    expect(await decideProposal(root, 'release-notes', 'approve')).toContain(
      'loads when Wilco next starts',
    )
    expect(existsSync(join(root, 'active', 'release-notes', 'extension.ts'))).toBe(true)
    await decideProposal(root, 'standup', 'reject')
    expect(existsSync(join(root, 'rejected', 'standup.ts'))).toBe(true)
    expect(proposedExtensions(root)).toEqual([])
    await expect(decideProposal(root, 'standup', 'approve')).rejects.toThrow('nothing proposed')
  })
})
