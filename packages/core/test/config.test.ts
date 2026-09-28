import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checksFor } from '../src/checks.ts'
import { ConfigSchema, loadConfig, parseConfig, writeSetting } from '../src/config.ts'
import { workspaceFor } from '../src/project.ts'

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
