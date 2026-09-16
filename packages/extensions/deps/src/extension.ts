import { fileURLToPath } from 'node:url'
import {
  type ExtensionContext,
  list,
  object,
  oneOf,
  type ProjectRef,
  string,
  type ToolContext,
  type WilcoExtension,
} from '@wilco/extensions-core'
import {
  applyUpdate,
  type Change,
  check,
  describeReport,
  installCommands,
  type Level,
  planUpdate,
  type Report,
} from './check.ts'
import { PUBLIC_REGISTRIES, type Registries } from './registries.ts'

// Dependencies: what a project uses that is out of date, vulnerable or
// deprecated, and an agent to bring it up to date.
//
// Checking is a question and can be asked by anyone, anywhere. Updating is
// work, so it happens where work happens: with an agent that installs, runs
// the tests and fixes what the new versions broke, wherever Wilco has its
// agents work — the checkout, or a worktree of its own.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function registries(ctx: ExtensionContext): Registries {
  const npm =
    typeof ctx.settings.registry === 'string' ? ctx.settings.registry : ctx.env.npm_config_registry
  return { ...PUBLIC_REGISTRIES, ...(npm ? { npm: npm.replace(/\/+$/, '') } : {}) }
}

function ignored(ctx: ExtensionContext): string[] {
  return Array.isArray(ctx.settings.ignore) ? ctx.settings.ignore.map(String) : []
}

/** The files git knows about in a folder: what it tracks, and what it would. */
async function files(ctx: ExtensionContext, root: string): Promise<string[]> {
  const listed = await ctx.exec('git', [
    '-C',
    root,
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
  if (listed.code !== 0) throw new Error(`${root} is not a git repository: ${listed.stderr.trim()}`)
  return listed.stdout.split('\0').filter((file) => file !== '')
}

/** Where a call works: the agent's own worktree, or the project's checkout. */
function where(
  input: Record<string, unknown>,
  ctx: ToolContext,
): { project: ProjectRef; root: string } {
  if (ctx.caller.kind === 'agent') {
    const project = ctx.projects.find(
      (one) => one.name === (ctx.caller as { project: string }).project,
    )
    return {
      project: project ?? { name: ctx.caller.project, root: ctx.caller.cwd },
      root: ctx.caller.cwd,
    }
  }
  const project = ctx.project(input.project ? String(input.project) : null)
  return { project, root: project.root }
}

async function report(
  ctx: ExtensionContext,
  root: string,
  progress: (text: string) => void,
): Promise<{ report: Report; files: string[] }> {
  const found = await files(ctx, root)
  progress('reading manifests')
  return {
    files: found,
    report: await check({
      root,
      files: found,
      fetch: ctx.fetch,
      registries: registries(ctx),
      ignore: ignored(ctx),
      vulnerabilities: ctx.settings.vulnerabilities !== false,
      onProgress: progress,
    }),
  }
}

function changeList(changes: readonly Change[]): string {
  let manifest = ''
  const lines: string[] = []
  for (const change of changes) {
    if (change.manifest !== manifest) {
      manifest = change.manifest
      lines.push('', manifest)
    }
    lines.push(`- ${change.name}: ${change.from} → ${change.to} (${change.behind})`)
  }
  return lines.join('\n').trim()
}

const project = string('project name, as configured; the one you are in when there is only one')

export const depsExtension: WilcoExtension = {
  name: 'deps',
  title: 'Dependencies',
  description:
    'Finds what a project depends on that is out of date, vulnerable or deprecated, and updates it in an agent’s worktree.',
  root: ROOT,
  settings: [
    {
      key: 'registry',
      kind: 'string',
      means: 'the npm registry to ask, when it is not the public one',
    },
    { key: 'ignore', kind: 'list', means: 'packages never reported or updated' },
    {
      key: 'vulnerabilities',
      kind: 'boolean',
      means: 'look up known vulnerabilities in OSV (true unless set false)',
    },
    {
      key: 'brief',
      kind: 'boolean',
      means:
        'mention vulnerable dependencies in the brief (it asks the network, so off unless set)',
    },
  ],
  ready: async (ctx) => {
    const git = await ctx.exec('git', ['--version'])
    return git.code === 0 ? null : 'git is needed to find a project’s manifests'
  },
  tools: [
    {
      name: 'deps_check',
      description:
        "Check a project's dependencies against their registries: npm (including pnpm catalogs), PyPI, crates.io and Go modules. Says which are behind and by how much (patch, minor, major), which have known vulnerabilities, and which are deprecated. Reads only; changes nothing. Use it to verify dependencies, and before deps_update.",
      parameters: object({ project }),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const at = where(input, ctx)
        const found = await report(ctx, at.root, ctx.progress)
        return { text: describeReport(at.project.name, found.report), data: found.report.findings }
      },
    },
    {
      name: 'deps_update',
      description:
        "Update a project's dependencies to their newest releases, up to a level: patch, minor (the default) or major. From the orchestrator this starts an agent with the manifests already updated, which installs, runs the tests, fixes what broke and commits. From an agent it updates the manifests where that agent works. Ranges and ceilings are left as written.",
      parameters: object({
        project,
        level: oneOf(
          ['patch', 'minor', 'major'],
          'how far to go: major includes breaking releases',
        ),
        packages: list(string('a package name'), 'only these packages, when not all of them'),
      }),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const level = (input.level as Level | undefined) ?? 'minor'
        const only = Array.isArray(input.packages) ? input.packages.map(String) : []
        const at = where(input, ctx)
        const found = await report(ctx, at.root, ctx.progress)
        const changes = planUpdate(found.report, level, only)
        if (changes.length === 0) {
          return {
            text: `Nothing to update in ${at.project.name} up to ${level} releases.\n\n${describeReport(at.project.name, found.report)}`,
          }
        }
        const install = installCommands(found.files)
        const listed = changeList(changes)

        if (ctx.caller.kind === 'agent') {
          applyUpdate(at.root, found.report, changes)
          return {
            text: `Updated ${changes.length} requirement${changes.length === 1 ? '' : 's'} in your worktree:\n\n${listed}\n\nNow run ${install.join(' and ') || 'the install'}${at.project.test ? `, then \`${at.project.test}\`` : ', then the tests'}.`,
          }
        }
        if (!ctx.wilco)
          throw new Error('updating starts an agent, which needs the Wilco window open')
        const majors = changes.filter((change) => change.behind === 'major')
        const started = await ctx.wilco.startAgent({
          project: at.project.name,
          title: `update dependencies ${level}`,
          prompt: [
            `The dependencies in this worktree were just updated to their newest ${level} releases (${changes.length} change${changes.length === 1 ? '' : 's'}, listed in .wilco/context.md).`,
            `Run ${install.map((command) => `\`${command}\``).join(' and ') || 'the install'} so the lockfiles match,`,
            `then ${at.project.test ? `\`${at.project.test}\`` : 'the tests'}.`,
            majors.length > 0
              ? `${majors.length} are major releases: read their changelogs for breaking changes before you fix anything.`
              : '',
            'Fix what the updates broke without pinning anything back unless there is no other way, and say so when you do. Commit when the tests pass.',
          ]
            .filter((part) => part !== '')
            .join(' '),
          context: [
            `# Dependency update, up to ${level}`,
            '',
            'Already applied to the manifests in this worktree:',
            '',
            listed,
            '',
            '## Before the update',
            '',
            describeReport(at.project.name, found.report),
          ].join('\n'),
          prepare: async (worktree) => applyUpdate(worktree, found.report, changes),
        })
        return {
          text: `Started ${started.task} on ${changes.length} update${changes.length === 1 ? '' : 's'} (${majors.length} major). It installs, runs the tests and fixes what breaks, in ${started.worktree}.\n\n${listed}`,
          data: { task: started.task, changes },
        }
      },
    },
  ],
  watches: [
    {
      id: 'vulnerabilities',
      title: 'Vulnerable dependencies',
      means:
        'Checks what a project depends on against OSV, and starts an agent on each package with a known vulnerability to move it forward, install, test and commit.',
      every: '1d',
      input: object({
        level: oneOf(
          ['patch', 'minor', 'major'],
          'how far an update may go; minor unless said, and major only where nothing else fixes it',
        ),
      }),
      check: async (ctx) => {
        const found = await report(ctx, ctx.watching.root, () => {})
        // Nothing found because nothing could be asked is not nothing found.
        if (!found.report.checkedVulnerabilities) {
          throw new Error(
            ctx.settings.vulnerabilities === false
              ? 'vulnerability lookups are off: unset extensions.deps.vulnerabilities'
              : 'OSV could not be asked about these dependencies',
          )
        }
        return {
          found: found.report.findings
            .filter((one) => one.vulnerabilities.length > 0)
            .map((one) => {
              const ids = [...one.vulnerabilities].sort()
              const dep = one.dependency
              return {
                // The same package with the same advisories is the same finding;
                // a new advisory against it is a new one.
                key: `${dep.ecosystem}:${dep.name}:${ids.join('+')}`,
                title: `${dep.name} ${dep.spec}: ${ids.join(', ')}`,
                detail: [
                  `# ${dep.name} ${dep.spec}`,
                  '',
                  [
                    `In \`${dep.manifest}\` (${dep.group}).`,
                    one.latest
                      ? `The newest release is ${one.latest}${one.behind ? ` (${one.behind} ahead)` : ''}.`
                      : '',
                    one.leftAlone ? `Its requirement ${one.leftAlone}.` : '',
                  ]
                    .filter((part) => part !== '')
                    .join(' '),
                  '',
                  'Known vulnerabilities:',
                  '',
                  ...ids.map((id) => `- ${id}: https://osv.dev/vulnerability/${id}`),
                ].join('\n'),
                links: ids.map((id) => ({
                  title: id,
                  url: `https://osv.dev/vulnerability/${id}`,
                })),
              }
            }),
        }
      },
      agent: (finding, ctx) => {
        const name = finding.key.split(':')[1] ?? finding.title
        const level = typeof ctx.input.level === 'string' ? ctx.input.level : 'minor'
        return {
          title: `update ${name}`,
          prompt: [
            `${name} has a known vulnerability, in .wilco/context.md with its advisories.`,
            `Read them first, then call deps_update with packages ["${name}"] and level ${level} to move it forward in this worktree.`,
            'If that is not enough to clear the advisory, say so and go as far as it takes, reading the changelog for what breaks.',
            `Then install${ctx.watching.test ? `, run \`${ctx.watching.test}\`` : ' and run the tests'}, fix what the update broke, and commit.`,
          ].join(' '),
          ...(finding.detail ? { context: finding.detail } : {}),
          ...(finding.links ? { links: finding.links } : {}),
        }
      },
    },
  ],
  actions: [
    { id: 'check', title: 'Check dependencies', tool: 'deps_check', project: true },
    {
      id: 'update',
      title: 'Update dependencies (minor)',
      tool: 'deps_update',
      input: { level: 'minor' },
      project: true,
    },
    {
      id: 'update-major',
      title: 'Update dependencies (major)',
      tool: 'deps_update',
      input: { level: 'major' },
      project: true,
    },
  ],
  brief: async (ctx) => {
    if (ctx.settings.brief !== true) return []
    const items = []
    for (const one of ctx.projects) {
      const found = await report(ctx, one.root, () => {}).catch(() => null)
      const vulnerable =
        found?.report.findings.filter((finding) => finding.vulnerabilities.length > 0) ?? []
      if (vulnerable.length === 0) continue
      items.push({
        said: `${vulnerable.length} ${vulnerable.length === 1 ? 'dependency has' : 'dependencies have'} known vulnerabilities in ${one.name}`,
        ask: `Check the dependencies in ${one.name} and update the vulnerable ones`,
      })
    }
    return items
  },
  orchestrator: () =>
    'When asked to check, verify or update the dependencies of a project, call deps_check first and say what it found briefly — how many are behind, the majors, anything vulnerable. To update, call deps_update with the level the human asked for (minor unless they said everything or major): it starts an agent that installs, tests and fixes, so tell them which agent is on it. Never update in the project’s own checkout.',
  agents: () =>
    'deps_check lists which dependencies of your worktree are out of date, vulnerable or deprecated; deps_update moves them forward in your worktree, after which you install and run the tests.',
  setup: () => ({
    guide: [
      'Nothing is needed: dependencies are checked against the public registries, and vulnerabilities against OSV.',
      'Change these only when the defaults do not suit this machine.',
    ],
    fields: [
      {
        key: 'registry',
        label: 'npm registry',
        kind: 'text',
        placeholder: 'https://registry.npmjs.org',
        help: 'a mirror or private registry, when you use one',
      },
      {
        key: 'ignore',
        label: 'Ignore',
        kind: 'list',
        placeholder: 'react, typescript',
        help: 'packages never reported or updated',
      },
      {
        key: 'vulnerabilities',
        label: 'Vulnerabilities',
        kind: 'flag',
        help: 'look them up in OSV (on unless turned off)',
      },
      {
        key: 'brief',
        label: 'In the brief',
        kind: 'flag',
        help: 'mention vulnerable dependencies (asks the network each time)',
      },
    ],
    links: [{ title: 'OSV', url: 'https://osv.dev' }],
  }),
  harness: { pi: { skills: ['skills/update-dependencies'] } },
}
