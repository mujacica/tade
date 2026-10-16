import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { awayProblems } from '../src/away.ts'
import { checksFor } from '../src/checks.ts'
import { ConfigSchema, updateCheckEvery } from '../src/config.ts'
import { loadConfig, parseConfig, writeSetting } from '../src/config-file.ts'
import {
  pushDefault,
  pushFor,
  pushNeedsABranch,
  pushProblems,
  workspaceFor,
} from '../src/project.ts'

describe('parseConfig', () => {
  it('fills defaults for an empty file', () => {
    const r = parseConfig('')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.workspace.driver).toBe('pty')
    expect(r.config.workers.default).toBe('default')
    expect(r.config.workers.routes.default?.harness).toBe('pi')
    expect(r.config.projects).toEqual({})
  })

  it('starts muted, and keeps a person’s own answer to it', () => {
    // A Tade nobody has heard yet makes no sound until somebody unmutes it.
    const fresh = parseConfig('')
    expect(fresh.ok && fresh.config.surfaces.voice.muted).toBe(true)
    const unmuted = parseConfig('surfaces: { voice: { muted: false } }')
    expect(unmuted.ok && unmuted.config.surfaces.voice.muted).toBe(false)
    const refused = parseConfig('surfaces: { voice: { muted: sometimes } }')
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.issues[0]?.path).toBe('surfaces.voice.muted')
  })

  it('accepts a fully populated config', () => {
    const r = parseConfig(`
workspace: { driver: tmux, adopt: true }
orchestrator: { harness: pi, provider: anthropic, model: claude-opus-5 }
workers:
  default: cheap
  routes:
    cheap: { provider: openrouter, model: deepseek/deepseek-v3 }
    subscription: { provider: anthropic, model: claude-opus-5, thinking: high }
surfaces:
  voice:
    stt: { driver: groq, language: en, api_key_env: GROQ_API_KEY }
    mic: { driver: ffmpeg, device: ":1" }
projects:
  checkout: { root: ~/src/checkout, brief: "Payments.", worker: subscription, max_parallel: 2 }
`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.projects.checkout?.max_parallel).toBe(2)
    expect(r.config.workers.routes.subscription?.thinking).toBe('high')
  })

  it('ignores a setting Tade no longer has, and says so rather than refusing the file', () => {
    // Sandboxes are gone, and people have them written down. Refusing the
    // whole file over one would take away everything else they wrote at the
    // same time, and accepting it silently would read like a promise.
    const r = parseConfig(`
workers:
  routes:
    default: { model: claude-opus-5, sandbox: seatbelt }
mcp:
  servers:
    linear: { enabled: true, sandbox: bwrap }
projects:
  checkout: { root: ~/src/checkout }
`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Everything beside it survives, which is the whole point of not refusing.
    expect(r.config.workers.routes.default?.model).toBe('claude-opus-5')
    expect(r.config.mcp.servers.linear?.enabled).toBe(true)
    expect(r.config.projects.checkout?.root).toBe('~/src/checkout')
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toContain('workers.routes.default.sandbox')
    expect(r.warnings[0]).toContain('sandboxes are gone')
    expect(r.warnings[1]).toContain('mcp.servers.linear.sandbox')
  })

  it('says nothing about a config that names no setting Tade has dropped', () => {
    const r = parseConfig('workers:\n  routes:\n    default: { model: claude-opus-5 }\n')
    expect(r.ok && r.warnings).toEqual([])
  })

  it('leaves a key called sandbox alone where no rule names one', () => {
    // The rules are shapes, not the word: `mcp.servers.<name>.env.sandbox` is
    // somebody's environment variable and none of Tade's business.
    const r = parseConfig(
      'mcp:\n  servers:\n    linear: { enabled: true, env: { sandbox: "yes" } }\n',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toEqual([])
    expect(r.config.mcp.servers.linear?.env).toEqual({ sandbox: 'yes' })
  })

  it('ignores from_ci and says what is true instead, at either level', () => {
    // It chose what a reading of somebody's CI was good for, because a reading
    // was a guess and `.tade/checks.yaml` was the definition. The reading is
    // the definition now, there is no manifest to adopt into, and so there is
    // nothing left for the key to choose between. Ignored rather than refused:
    // somebody wrote it, and refusing the file takes away everything else they
    // wrote at the same time.
    const r = parseConfig(
      'checks:\n  from_ci: run\nprojects:\n  demo:\n    root: /tmp/demo\n    checks:\n      from_ci: off\n',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings.join('\n')).toContain('checks.from_ci is ignored')
    expect(r.warnings.join('\n')).toContain('projects.demo.checks.from_ci is ignored')
    expect(r.warnings.join('\n')).toContain('read from its CI workflows and its commit hook')
    expect('from_ci' in r.config.checks).toBe(false)
  })

  it('lets one project answer the checks rules for itself', () => {
    const r = parseConfig(
      ['projects:', '  demo:', '    root: /tmp/demo', '    checks:', '      on_red: tell', ''].join(
        '\n',
      ),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(checksFor(r.config, 'demo').on_red).toBe('tell')
    // Anything it does not answer still follows the rule above it.
    expect(checksFor(r.config, 'demo').before).toBe(r.config.checks.before)
    const bad = parseConfig(
      [
        'projects:',
        '  demo:',
        '    root: /tmp/demo',
        '    checks:',
        '      on_red: shout',
        '',
      ].join('\n'),
    )
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.issues[0]?.path).toBe('projects.demo.checks.on_red')
  })

  it('names a bad enum value by its dotted key', () => {
    const r = parseConfig('workspace:\n  driver: screen\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.path).toBe('workspace.driver')
  })

  it('takes an editor by name, and only one it knows how to open', () => {
    const none = parseConfig('')
    expect(none.ok && none.config.surfaces.window.editor).toBeUndefined()
    const cursor = parseConfig('surfaces:\n  window:\n    editor: cursor\n')
    expect(cursor.ok && cursor.config.surfaces.window.editor).toBe('cursor')
    const notepad = parseConfig('surfaces:\n  window:\n    editor: notepad\n')
    expect(notepad.ok).toBe(false)
    if (notepad.ok) return
    expect(notepad.issues[0]?.path).toBe('surfaces.window.editor')
  })

  it('asks what is current once a day unless told otherwise, and only on a clock it knows', () => {
    const none = parseConfig('')
    expect(none.ok && none.config.surfaces.window.check_updates).toBe('daily')
    expect(updateCheckEvery('daily')).toBe(24 * 60 * 60 * 1000)
    expect(updateCheckEvery('weekly')).toBe(7 * 24 * 60 * 60 * 1000)
    // Never is an answer, and not a very long interval.
    expect(updateCheckEvery('never')).toBeNull()
    const hourly = parseConfig('surfaces:\n  window:\n    check_updates: hourly\n')
    expect(hourly.ok).toBe(false)
    if (hourly.ok) return
    expect(hourly.issues[0]?.path).toBe('surfaces.window.check_updates')
  })

  it('holds the machine awake only when somebody has said so', () => {
    // Off is the decision rather than the absence of one: an anti-sleep hold
    // is somebody deciding about their own laptop, and Tade never decides it
    // for them because it happens to suit the agents.
    const none = parseConfig('')
    expect(none.ok && none.config.agents.keep_awake).toBe(false)
    const on = parseConfig('agents:\n  keep_awake: true\n')
    expect(on.ok && on.config.agents.keep_awake).toBe(true)
    const bad = parseConfig('agents:\n  keep_awake: sometimes\n')
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.issues[0]?.path).toBe('agents.keep_awake')
  })

  it('lowers the agents only by as much as somebody asked for', () => {
    // Off is the decision again, and for a sharper reason than keep_awake's:
    // a lowered check suite takes longer under load, and a check with a
    // timeout can go from slow to `timed out`, which is a worse answer than a
    // slow green one.
    const none = parseConfig('')
    expect(none.ok && none.config.agents.give_way).toBe(0)
    const five = parseConfig('agents:\n  give_way: 5\n')
    expect(five.ok && five.config.agents.give_way).toBe(5)
    // Past what nice itself can do, and refused by the dotted path rather
    // than clamped silently into something nobody wrote.
    const far = parseConfig('agents:\n  give_way: 25\n')
    expect(far.ok).toBe(false)
    if (far.ok) return
    expect(far.issues[0]?.path).toBe('agents.give_way')
  })

  it('puts what is happening in front of a reader unless somebody says not to', () => {
    // On, because without it a sentence is answered out of names — and said
    // out loud where the key that would read it is pasted, not only here.
    const on = parseConfig('')
    expect(on.ok && on.config.surfaces.search.context).toBe(true)
    const off = parseConfig('surfaces:\n  search:\n    context: false\n')
    expect(off.ok && off.config.surfaces.search.context).toBe(false)
    const wrong = parseConfig('surfaces:\n  search:\n    context: sometimes\n')
    expect(wrong.ok).toBe(false)
    if (wrong.ok) return
    expect(wrong.issues[0]?.path).toBe('surfaces.search.context')
  })

  it('names an unknown (typo) key', () => {
    const r = parseConfig('workspace:\n  drivr: pty\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.path).toBe('workspace.drivr')
  })

  it('names a key inside a project record', () => {
    const r = parseConfig('projects:\n  checkout:\n    root: ~/x\n    max_parallel: -1\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.path).toBe('projects.checkout.max_parallel')
  })

  it('runs one suite at a time on the machine unless somebody says more', () => {
    const r = parseConfig('')
    expect(r.ok && r.config.checks.suites).toBe(1)
    const two = parseConfig('checks:\n  suites: 2\n')
    expect(two.ok && two.config.checks.suites).toBe(2)
    const none = parseConfig('checks:\n  suites: 0\n')
    expect(!none.ok && none.issues[0]?.path).toBe('checks.suites')
  })

  it('has no project answer how many suites the machine runs', () => {
    // A bound each project set for itself is one per project, which is six
    // suites for six projects — the thing this setting exists to stop.
    const r = parseConfig('projects:\n  checkout:\n    root: ~/x\n    checks:\n      suites: 3\n')
    expect(!r.ok && r.issues[0]?.path).toBe('projects.checkout.checks.suites')
  })

  it('has no MCP server in it until somebody writes one', () => {
    const r = parseConfig('')
    expect(r.ok && r.config.mcp.servers).toEqual({})
  })

  it('takes a server that is written out, and one that leans on the catalogue', () => {
    const r = parseConfig(
      'mcp:\n  servers:\n    linear:\n      enabled: true\n      transport: stdio\n      command: linear-mcp\n      args: ["--stdio"]\n      auth: env\n      auth_name: LINEAR_API_KEY\n      tools: [mcp_linear_search]\n      scope: window\n    sentry: {}\n',
    )
    expect(r.ok && r.config.mcp.servers.linear).toEqual({
      enabled: true,
      transport: 'stdio',
      command: 'linear-mcp',
      args: ['--stdio'],
      auth: 'env',
      auth_name: 'LINEAR_API_KEY',
      tools: ['mcp_linear_search'],
      scope: 'window',
    })
    // Nothing said about it: the catalogue fills it in, and it is still off.
    expect(r.ok && r.config.mcp.servers.sentry).toEqual({})
  })

  it('names a typo inside a server, rather than keeping a setting nothing reads', () => {
    const r = parseConfig('mcp:\n  servers:\n    linear:\n      transprt: stdio\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.path).toBe('mcp.servers.linear.transprt')
  })

  it('refuses a transport and a name it has no meaning for', () => {
    const transport = parseConfig(
      'mcp:\n  servers:\n    linear:\n      transport: carrier-pigeon\n',
    )
    expect(!transport.ok && transport.issues[0]?.path).toBe('mcp.servers.linear.transport')
    // A server's name has to leave room for its tools' names, and be the
    // letters every harness can take.
    const named = parseConfig('mcp:\n  servers:\n    A_Very_Long_Server:\n      transport: stdio\n')
    expect(named.ok).toBe(false)
  })

  it('reports unparseable YAML as a file-level issue', () => {
    const r = parseConfig('workspace: [unclosed\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.path).toBe('')
    expect(r.issues[0]?.message).toMatch(/invalid YAML/)
  })
})

describe('how long decided documents are kept', () => {
  it('keeps them thirty days unless told otherwise', () => {
    const r = parseConfig('')
    expect(r.ok && r.config.documents).toEqual({ keep_days: 30 })
  })

  it('takes a number of days, and refuses none at all', () => {
    const r = parseConfig('documents:\n  keep_days: 7\n')
    expect(r.ok && r.config.documents).toEqual({ keep_days: 7 })
    const bad = parseConfig('documents:\n  keep_days: 0\n')
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.issues[0]?.path).toBe('documents.keep_days')
  })
})

describe('how long a note about gone work is still told', () => {
  it('keeps telling it three days unless told otherwise', () => {
    const r = parseConfig('')
    expect(r.ok && r.config.notes).toEqual({ keep_days: 3 })
  })

  it('takes a number of days, and refuses none at all', () => {
    const r = parseConfig('notes:\n  keep_days: 14\n')
    expect(r.ok && r.config.notes).toEqual({ keep_days: 14 })
    const bad = parseConfig('notes:\n  keep_days: 0\n')
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.issues[0]?.path).toBe('notes.keep_days')
  })
})

describe('who decides about held queued work', () => {
  it('leaves it to the orchestrator unless the person said to ask them', () => {
    const r = parseConfig('')
    expect(r.ok && r.config.queue).toEqual({ holds: 'orchestrator' })
  })

  it('takes asking the person, and refuses anybody else', () => {
    const r = parseConfig('queue:\n  holds: ask\n')
    expect(r.ok && r.config.queue.holds).toBe('ask')
    const bad = parseConfig('queue:\n  holds: agents\n')
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.issues[0]?.path).toBe('queue.holds')
  })
})

describe('what the journal keeps', () => {
  it('lets the file reach 16 MB before anything is dropped, unasked', () => {
    const r = parseConfig('')
    expect(r.ok && r.config.journal).toEqual({ max_mb: 16 })
  })

  it('takes the number somebody wrote', () => {
    const r = parseConfig('journal:\n  max_mb: 64\n')
    expect(r.ok && r.config.journal).toEqual({ max_mb: 64 })
  })

  it('refuses a ceiling of nothing, which would be a setting that empties the journal', () => {
    for (const [yaml, path] of [
      ['journal:\n  max_mb: 0\n', 'journal.max_mb'],
      ['journal:\n  max_md: 16\n', 'journal.max_md'],
    ] as const) {
      const r = parseConfig(yaml)
      expect(r.ok, yaml).toBe(false)
      if (r.ok) continue
      expect(r.issues[0]?.path).toBe(path)
    }
  })
})

describe('what a lane keeps to scroll back through', () => {
  it('is 10,000 lines unasked, which is what it was before it was a setting', () => {
    const r = parseConfig('')
    expect(r.ok && r.config.drivers.pty.scrollback).toBe(10_000)
  })

  it('takes the number somebody wrote', () => {
    const r = parseConfig('drivers:\n  pty:\n    scrollback: 2000\n')
    expect(r.ok && r.config.drivers.pty.scrollback).toBe(2_000)
  })

  it('refuses none, a fraction, more than the machine should hold, and a misspelling', () => {
    for (const [yaml, path] of [
      ['drivers:\n  pty:\n    scrollback: 0\n', 'drivers.pty.scrollback'],
      ['drivers:\n  pty:\n    scrollback: 2.5\n', 'drivers.pty.scrollback'],
      ['drivers:\n  pty:\n    scrollback: 1000000\n', 'drivers.pty.scrollback'],
      ['drivers:\n  pty:\n    scrolback: 2000\n', 'drivers.pty.scrolback'],
      ['drivers:\n  ghostty: {}\n', 'drivers.ghostty'],
    ] as const) {
      const r = parseConfig(yaml)
      expect(r.ok, yaml).toBe(false)
      if (r.ok) continue
      expect(r.issues[0]?.path).toBe(path)
    }
  })
})

describe('loadConfig', () => {
  it('treats a missing file as defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-cfg-'))
    const r = await loadConfig(join(dir, 'nope.yaml'))
    expect(r.ok && !r.exists).toBe(true)
  })

  it('reads a file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-cfg-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, 'workers:\n  default: codex\n')
    const r = await loadConfig(path)
    expect(r.ok && r.config.workers.default).toBe('codex')
  })
})

// The config can hold a DSN, and a DSN is a credential: a file anybody on the
// machine can read is the leak nobody notices.
describe('writing a setting', () => {
  it('makes the file the owner’s alone to read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-cfg-'))
    const path = join(dir, 'config.yaml')
    writeSetting(path, 'telemetry.dsn', 'https://k@o1.ingest.sentry.io/2')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('narrows one that was already readable by everybody', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-cfg-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, '# mine\nworkspace: { driver: tmux }\n')
    await chmod(path, 0o644)
    writeSetting(path, 'telemetry.dsn', 'https://k@o1.ingest.sentry.io/2')
    expect((await stat(path)).mode & 0o077).toBe(0)
    // And the file is still the one its owner wrote, comment and all.
    expect(await readFile(path, 'utf8')).toContain('# mine')
  })
})

describe('accounts', () => {
  const accounts = (yaml: string) => parseConfig(yaml, '/x/config.yaml')

  it('have none but each harness’s own sign-in by default', () => {
    const r = accounts('')
    expect(r.ok && r.config.accounts).toEqual({})
    expect(r.ok && r.config.workers.accounts).toEqual({})
  })

  it('name a second sign-in for a harness, and which one its new agents use', () => {
    const r = accounts(
      'accounts:\n  work:\n    harness: claude-code\nworkers:\n  accounts:\n    claude-code: work\n',
    )
    expect(r.ok && r.config.accounts.work).toEqual({
      harness: 'claude-code',
      kind: 'subscription',
      share: true,
    })
    expect(r.ok && r.config.workers.accounts['claude-code']).toBe('work')
  })

  it('refuse to have new agents use an account that is not there, or not theirs', () => {
    const missing = accounts('workers:\n  accounts:\n    claude-code: work\n')
    expect(!missing.ok && missing.issues[0]?.path).toBe('workers.accounts.claude-code')
    const wrong = accounts(
      'accounts:\n  work:\n    harness: claude-code\nworkers:\n  accounts:\n    pi: work\n',
    )
    expect(!wrong.ok && wrong.issues[0]?.message).toContain('claude-code account')
  })

  it("keep 'default' for each harness's own sign-in", () => {
    const r = accounts('accounts:\n  default:\n    harness: claude-code\n')
    expect(!r.ok && r.issues[0]?.path).toBe('accounts.default')
  })
})

describe('the orchestrator’s harness', () => {
  it('is any harness that can be run under Tade’s own protocol', () => {
    const r = parseConfig('orchestrator:\n  harness: claude-code\n')
    expect(r.ok && r.config.orchestrator.harness).toBe('claude-code')
  })

  it('is refused as a typo, like any other harness that does not exist', () => {
    const r = parseConfig('orchestrator:\n  harness: clod\n')
    expect(!r.ok && r.issues[0]?.path).toBe('orchestrator.harness')
  })
})

describe('how full the orchestrator’s context may get', () => {
  it('is 80% unless somebody says otherwise', () => {
    const r = parseConfig('')
    expect(r.ok && r.config.orchestrator.compact_at).toBe(80)
  })

  it('takes a percentage, and 0 for leaving it to the harness', () => {
    const r = parseConfig('orchestrator:\n  compact_at: 0\n')
    expect(r.ok && r.config.orchestrator.compact_at).toBe(0)
  })

  it('is refused past the whole of it', () => {
    const r = parseConfig('orchestrator:\n  compact_at: 120\n')
    expect(!r.ok && r.issues[0]?.path).toBe('orchestrator.compact_at')
  })
})

describe('where a project’s agents work', () => {
  it('means exactly what it meant before the key existed', () => {
    // A config written before this: no project says anything, so every project
    // is the machine's answer, and the machine's default is still `checkout`.
    const before = ConfigSchema.parse({ projects: { shop: { root: '~/src/shop' } } })
    expect(before.agents.workspace).toBe('checkout')
    expect(before.projects.shop?.workspace).toBeUndefined()
    expect(workspaceFor(before, 'shop')).toBe('checkout')
  })

  it('is one project’s to answer, over the machine’s', () => {
    const config = ConfigSchema.parse({
      agents: { workspace: 'checkout' },
      projects: {
        shop: { root: '~/src/shop' },
        docs: { root: '~/src/docs', workspace: 'worktree' },
      },
    })
    expect(workspaceFor(config, 'shop')).toBe('checkout')
    expect(workspaceFor(config, 'docs')).toBe('worktree')
    // Nothing else changes meaning: a project Tade does not have, and no
    // project at all, are still the machine's answer.
    expect(workspaceFor(config, 'ghost')).toBe('checkout')
    expect(workspaceFor(config, null)).toBe('checkout')
  })

  it('refuses a word that is not one of the two, rather than accepting and ignoring it', () => {
    const wrong = ConfigSchema.safeParse({
      projects: { shop: { root: '~/src/shop', workspace: 'worktrees' } },
    })
    expect(wrong.success).toBe(false)
  })
})

describe('what a project pushes', () => {
  it('is answered by where the agents work, where nobody has said', () => {
    // The person's own answer, in as many words: a worktree each is a branch
    // of the agent's own that nobody else is on, so finished work goes up for
    // review; a shared checkout has no such branch, so it is still committed
    // and left. Nothing is written down to get either — `agents.push` carries
    // no schema default, which is what makes "nobody said" a state at all.
    const bare = ConfigSchema.parse({ projects: { shop: { root: '~/src/shop' } } })
    expect(bare.agents.push).toBeUndefined()
    expect(bare.projects.shop?.push).toBeUndefined()
    expect(pushFor(bare, 'shop', 'worktree').mode).toBe('branch-and-review')
    expect(pushFor(bare, 'shop', 'checkout').mode).toBe('never')
    // Including for a project Tade does not have and for no project at all,
    // which is the same question with nothing to read on either side of it.
    expect(pushDefault('worktree')).toBe('branch-and-review')
    expect(pushDefault('checkout')).toBe('never')
    expect(pushFor(bare, 'ghost', 'worktree').mode).toBe('branch-and-review')
    expect(pushFor(bare, null, 'checkout').mode).toBe('never')
  })

  it('keeps a `never` somebody wrote, in the workspace that would push by default', () => {
    // The half that makes the default safe to have: a word in the file is a
    // decision and the default never argues with it. Either level does it —
    // one project refusing, or the machine refusing for all of them — and in
    // the workspace whose default is the opposite of what was asked.
    const project = ConfigSchema.parse({
      agents: { workspace: 'worktree' },
      projects: { shop: { root: '~/src/shop', push: 'never' } },
    })
    expect(pushFor(project, 'shop', 'worktree').mode).toBe('never')
    expect(pushFor(project, 'shop', 'worktree').problem).toBeNull()
    const machine = ConfigSchema.parse({
      agents: { workspace: 'worktree', push: 'never' },
      projects: { shop: { root: '~/src/shop' } },
    })
    expect(machine.agents.push).toBe('never')
    expect(pushFor(machine, 'shop', 'worktree').mode).toBe('never')
  })

  it('is one project’s to answer, over the machine’s', () => {
    const config = ConfigSchema.parse({
      agents: { push: 'never' },
      projects: {
        shop: { root: '~/src/shop' },
        docs: { root: '~/src/docs', push: 'branch' },
        api: { root: '~/src/api', workspace: 'worktree', push: 'branch-and-review' },
      },
    })
    // (c) nothing is pushed, which is what the machine here says; (b) the
    // branch the agents are on, in a shared checkout; (a) each agent's own
    // branch with a review opened on it, in a worktree each.
    expect(pushFor(config, 'shop', 'checkout').mode).toBe('never')
    expect(pushFor(config, 'docs', 'checkout').mode).toBe('branch')
    expect(pushFor(config, 'api', 'worktree').mode).toBe('branch-and-review')
    // And nothing else changes meaning: a project Tade does not have, and no
    // project at all, are still the machine's answer.
    expect(pushFor(config, 'ghost', 'worktree').mode).toBe('never')
    expect(pushFor(config, null, 'worktree').mode).toBe('never')
  })

  it('is asked of the workspace it is given, not of the config’s answer today', () => {
    // A task keeps the workspace it was made with, so the resolution has to be
    // given one: reading the config here would move an agent that is already
    // working the moment somebody changed the setting under it.
    const config = ConfigSchema.parse({
      agents: { workspace: 'checkout' },
      projects: { api: { root: '~/src/api', workspace: 'worktree', push: 'branch-and-review' } },
    })
    expect(pushFor(config, 'api', 'worktree').mode).toBe('branch-and-review')
    expect(pushFor(config, 'api', 'checkout').mode).toBe('never')
  })

  it('pushes nothing rather than pushing a shared branch it was not asked to', () => {
    // The one pairing that cannot hold: there is no branch of an agent's own to
    // open a review for. It resolves to `never` and never to `branch` — pushing
    // straight to the branch everybody shares is *more* on the remote than was
    // asked for, which is the one wrong answer here.
    const config = ConfigSchema.parse({
      projects: { api: { root: '~/src/api', push: 'branch-and-review' } },
    })
    const pushes = pushFor(config, 'api', 'checkout')
    expect(pushes.mode).toBe('never')
    expect(pushes.asked).toBe('branch-and-review')
    expect(pushes.problem).toBe(pushNeedsABranch('api'))
    // Said rather than accepted and ignored, and said where a hand-written file
    // is read: `tade config --check` prints these.
    const read = parseConfig(
      'projects:\n  api:\n    root: ~/src/api\n    push: branch-and-review\n',
    )
    expect(read.ok && read.warnings).toEqual([pushNeedsABranch('api')])
  })

  it('says nothing about a project whose mode can mean what it says', () => {
    const read = parseConfig(
      'agents:\n  workspace: worktree\nprojects:\n  api:\n    root: ~/src/api\n    push: branch-and-review\n',
    )
    expect(read.ok && read.warnings).toEqual([])
    expect(pushProblems(ConfigSchema.parse({ projects: { api: { root: '~/a' } } }))).toEqual([])
    // And no default can produce the pairing that cannot hold, whichever
    // workspace a file asks for: the one that opens reviews is only ever the
    // answer where there is a branch of the agent's own to open one for.
    expect(
      pushProblems(
        ConfigSchema.parse({
          agents: { workspace: 'worktree' },
          projects: { api: { root: '~/a' } },
        }),
      ),
    ).toEqual([])
  })

  it('says an away-view key that is on and cannot mean what it says', () => {
    // The one way somebody turns notifications on, waits, hears nothing and
    // has no sentence anywhere to read: `push` is narrowed under `install`,
    // because a notification is delivered to the worker the installed page
    // registers. A warning and never an issue — refusing the file would take
    // away everything else they wrote in it.
    const read = parseConfig('surfaces:\n  web:\n    enabled: true\n    install: false\n')
    expect(read.ok).toBe(true)
    expect(read.ok && read.warnings.join(' ')).toContain('surfaces.web.push is on')
    expect(read.ok && read.warnings.join(' ')).toContain('install is off')
  })

  it('is off, and everything under it on, so turning it on is one switch', () => {
    // The person's ask: the away view itself stays off by default, and every
    // capability under it is on, so turning it on is a working setup rather
    // than a second page of switches. `bind` is a choice of network and stays
    // on this machine — `lan` is the clear.
    const web = ConfigSchema.parse({}).surfaces.web
    expect(web.enabled).toBe(false)
    expect(web.bind).toBe('loopback')
    for (const key of [
      'acting',
      'orchestrator',
      'drafts',
      'settings',
      'install',
      'offline',
      'push',
      'push_details',
    ] as const) {
      expect(web[key], key).toBe(true)
    }
    // And turned on alone, nothing is left that cannot mean what it says.
    const read = parseConfig('surfaces:\n  web:\n    enabled: true\n')
    expect(read.ok && read.warnings).toEqual([])
  })

  it('takes a public name, none by default, and refuses what is not a name', () => {
    expect(ConfigSchema.parse({}).surfaces.web.public).toBe('')
    const named = parseConfig('surfaces:\n  web:\n    public: tade.example.com\n')
    expect(named.ok && named.config.surfaces.web.public).toBe('tade.example.com')
    // Each of these would put something other than a name into a site block,
    // a certificate request or a passkey's relying party.
    for (const value of [
      'https://tade.example.com',
      'tade.example.com:443',
      'tade.example.com/away',
      '203.0.113.7',
      'localhost',
      '-tade.example.com',
      'tade example.com',
    ]) {
      const read = parseConfig(`surfaces:\n  web:\n    public: '${value}'\n`)
      expect(read.ok, value).toBe(false)
      if (!read.ok) expect(read.issues[0]?.path, value).toBe('surfaces.web.public')
    }
  })

  it('says each of the three pairings that cannot hold, and nothing otherwise', () => {
    const on = (over: Record<string, unknown>) =>
      awayProblems({
        enabled: true,
        install: false,
        offline: false,
        push: false,
        push_details: false,
        ...over,
      })
    expect(on({ offline: true }).join(' ')).toContain('surfaces.web.offline is on')
    expect(on({ push: true }).join(' ')).toContain('surfaces.web.push is on')
    expect(on({ install: true, push_details: true }).join(' ')).toContain('push_details is on')
    // Each key on with what it is narrowed under also on: nothing to say.
    expect(on({ install: true, offline: true, push: true, push_details: true })).toEqual([])
    expect(on({})).toEqual([])
    // **Nothing listening is said once, by the first decision**, and not four
    // times over: every surface that draws these already says the away view is
    // off, and a sentence per key would be four about one off switch.
    expect(
      awayProblems({
        enabled: false,
        install: false,
        offline: true,
        push: true,
        push_details: true,
      }),
    ).toEqual([])
  })

  it('refuses a mode that is not one of the three, rather than accepting and ignoring it', () => {
    const wrong = ConfigSchema.safeParse({
      projects: { shop: { root: '~/src/shop', push: 'pr' } },
    })
    expect(wrong.success).toBe(false)
    expect(!wrong.success && wrong.error.issues[0]?.path).toEqual(['projects', 'shop', 'push'])
    expect(ConfigSchema.safeParse({ agents: { push: 'yes' } }).success).toBe(false)
  })
})
