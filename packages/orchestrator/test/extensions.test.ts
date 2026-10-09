import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, loadConfig, settingsOf, taskDir } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  BUILTIN_EXTENSIONS,
  enabledTools,
  extensionWorkbench,
  loadExtensions,
  oneExtensionsFolder,
  workbenchExtensions,
  writtenTools,
} from '../src/extensions.ts'

// What an extension's work becomes in a real repository: an agent in its own
// worktree, told what it was started for and where that came from, launched
// with the extensions' instructions and pieces.

describe('an agent an extension starts', () => {
  let tade: Workbench | null = null

  afterEach(async () => {
    await tade?.stopEverything().catch(() => {})
    await tade?.close().catch(() => {})
    tade = null
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
    tade = await Workbench.open({
      home,
      extensions: workbenchExtensions(host, home, () => window),
    })
    const started: string[] = []
    window = extensionWorkbench(tade, (task) => started.push(task))

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
    // Its context is in Tade's home, under its project: nothing of it is in
    // the checkout the agent is about to work in.
    const own = taskDir(home, 'shop/fix-shop-1a')
    expect(existsSync(join(first.worktree, '.tade'))).toBe(false)
    expect(readFileSync(join(own, 'context.md'), 'utf8')).toBe(
      '# SHOP-1A: TypeError in refund\n\n## Links\n\n- [SHOP-1A](https://acme.sentry.io/issues/4411/)\n',
    )
    expect(existsSync(join(first.worktree, 'prepared.txt'))).toBe(true)

    // The agent runs with the extensions' words, skills and tools.
    const lane = tade.lane('shop/fix-shop-1a/agent' as never)
    const args = lane?.spec.args ?? []
    const told = args[args.indexOf('--append-system-prompt') + 1] ?? ''
    // It knows where it is: in Tade, on this task, in the checkout beside others.
    expect(told).toContain('You are running inside Tade')
    expect(told).toContain('Your task is shop/fix-shop-1a')
    expect(told).toContain(first.worktree)
    expect(told).toContain('at the same time as other agents')
    expect(told).toContain(join(own, 'context.md'))
    expect(told).toContain('shop reports errors to the error tracker.')
    expect(args[args.indexOf('--skill') + 1]).toBe(join(root, 'skills', 'fixing'))
    const tools = JSON.parse(readFileSync(lane?.spec.env?.TADE_EXTENSION_TOOLS ?? '', 'utf8')) as {
      name: string
    }[]
    expect(tools.map((tool) => tool.name)).toEqual(['errors_issue'])

    // The links are kept with the task, where status reads them back from.
    expect(readFileSync(join(own, 'task.yaml'), 'utf8')).toContain(
      'url: https://acme.sentry.io/issues/4411/',
    )

    // Renamed while it runs: kept in its task, and it keeps the name next time it starts.
    await tade.renameAgent({ task: first.task, worktree: first.worktree, title: 'Refund retries' })
    expect(readFileSync(join(own, 'task.yaml'), 'utf8')).toContain('title_named: true')

    // The same work started again is a second agent, not an error.
    await tade.stopAgent('shop/fix-shop-1a')
    const again = await window.startAgent({
      project: 'shop',
      title: 'fix SHOP-1A',
      prompt: 'Again.',
    })
    expect(again.task).toBe('shop/fix-shop-1a-2')
  }, 60_000)

  it('ships the checks, dependencies, intake, Jev, reviews, Sentry and resources, and loads yours beside them', async () => {
    expect(BUILTIN_EXTENSIONS.map((one) => one.name)).toEqual([
      'checks',
      'deps',
      'intake',
      'jev',
      'review',
      'sentry',
      'resources',
    ])
    const home = tmp('wx-load-')
    const host = await loadExtensions({
      config: ConfigSchema.parse({ orchestrator: { extensions: join(home, 'extensions') } }),
      home,
      env: {},
    })
    // With no key, a judge is absent rather than pretending: it says what it
    // needs and offers nothing, and everything else is exactly as it was.
    expect(host.list().map((one) => [one.name, one.state])).toEqual([
      ['checks', 'ready'],
      ['deps', 'ready'],
      // Ready with nothing set up: the local intake door needs no key, no
      // endpoint and no account, and being ready is having a home to read.
      // What it may do is the owner's grant, which is off.
      ['intake', 'ready'],
      ['jev', 'needs setup'],
      // No `gh` and no token in this environment: it says what to do and
      // stops nothing else.
      ['review', 'needs setup'],
      ['sentry', 'needs setup'],
      ['resources', 'ready'],
    ])
    expect(host.specs('orchestrator').some((spec) => spec.name.startsWith('jev_'))).toBe(false)
  })

  it('lists the tools Tade wrote for itself, and loads only the ones turned on', async () => {
    const root = tmp('wx-written-')
    writeFileSync(
      join(root, 'standup.ts'),
      '// Reads out yesterday.\nexport default function () {}\n',
    )
    writeFileSync(join(root, 'notes.ts'), '// Writes the week up.\nexport default function () {}\n')
    // A whole extension is a folder, and the window holds those; these are
    // the single files the orchestrator loads.
    mkdirSync(join(root, 'release-notes'), { recursive: true })
    writeFileSync(join(root, 'release-notes', 'extension.ts'), 'export default {}\n')

    expect(writtenTools(root)).toEqual([
      { name: 'notes', why: 'Writes the week up.', path: join(root, 'notes.ts') },
      { name: 'standup', why: 'Reads out yesterday.', path: join(root, 'standup.ts') },
    ])
    // Sitting there is not being on: nothing loads until somebody says so.
    expect(enabledTools(root, {})).toEqual([])
    expect(enabledTools(root, { standup: { enabled: true }, notes: { enabled: false } })).toEqual([
      join(root, 'standup.ts'),
    ])
  })

  it('moves what was in active/ and proposed/ into the one folder, and keeps what was running on', async () => {
    const root = tmp('wx-onefolder-')
    const config = join(tmp('wx-onefolder-home-'), 'config.yaml')
    mkdirSync(join(root, 'active', 'release-notes'), { recursive: true })
    writeFileSync(join(root, 'active', 'release-notes', 'extension.ts'), 'export default {}\n')
    mkdirSync(join(root, 'proposed'), { recursive: true })
    writeFileSync(join(root, 'proposed', 'standup.ts'), '// Reads out yesterday.\n')
    // Turned down once: it stays turned down, and is never moved back in.
    mkdirSync(join(root, 'rejected'), { recursive: true })
    writeFileSync(join(root, 'rejected', 'shouty.ts'), '// No.\n')

    expect(oneExtensionsFolder(root, config).sort()).toEqual(['release-notes', 'standup'])
    expect(existsSync(join(root, 'release-notes', 'extension.ts'))).toBe(true)
    expect(existsSync(join(root, 'standup.ts'))).toBe(true)
    expect(existsSync(join(root, 'active'))).toBe(false)
    expect(existsSync(join(root, 'proposed'))).toBe(false)
    expect(existsSync(join(root, 'rejected', 'shouty.ts'))).toBe(true)
    // What was in `active/` was running, so it keeps running; what was only
    // proposed stays off until somebody turns it on.
    expect(readFileSync(config, 'utf8')).toContain('release-notes')
    const after = await loadConfig(config)
    expect(after.ok && after.config.extensions['release-notes']?.enabled).toBe(true)
    expect(after.ok && after.config.extensions.standup).toBeUndefined()
    // Run again, it has nothing left to do.
    expect(oneExtensionsFolder(root, config)).toEqual([])
  })
})

// Sentry is two halves of one decision — where Tade sends its own trouble, and
// which Sentry it reads back — and somebody looking for either goes to
// Settings. A key the extension declares and Settings does not show is one
// only the extension page can reach, which is where nobody looked.
describe('setting Sentry up', () => {
  it('shows every setting the Sentry extension has in the Telemetry category', () => {
    const sentry = BUILTIN_EXTENSIONS.find((one) => one.name === 'sentry')
    if (!sentry) throw new Error('no Sentry extension')
    // Its token is a credential, so it is a field in Keys and tokens rather
    // than a line in the Telemetry group — the same config key either way,
    // which is the point: what the extension declares, Settings has somewhere
    // to put.
    const secrets = (sentry.settings ?? [])
      .filter((setting) => setting.kind === 'secret')
      .map((setting) => ({
        path: `extensions.sentry.${setting.key}`,
        title: `Sentry ${setting.key}`,
        means: setting.means,
        value: '',
        from: null,
      }))
    const groups = settingsOf(ConfigSchema.parse({}), secrets)
    const shown = new Set(
      groups
        .filter((one) => one.id === 'telemetry' || one.id === 'credentials')
        .flatMap((one) => one.settings)
        .map((setting) => setting.path),
    )
    for (const setting of sentry.settings ?? []) {
      expect(shown, setting.key).toContain(`extensions.sentry.${setting.key}`)
    }
    // And turning the extension itself off, which is a setting like any other.
    expect(shown).toContain('extensions.sentry.enabled')
  })
})
