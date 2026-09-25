import { ConfigSchema, namedBy, settingReach, settingsOf, wordsFor } from '@tade/core'
import { describe, expect, it } from 'vitest'

// How far the orchestrator's arm reaches into the config.
//
// The rule is pure, so it is tested as a rule: a path in, a tier out. What is
// being held here is not the list — lists change — but the shape of it, which
// is that everything dangerous is a *subtree* and nothing dangerous is a lone
// key somebody has to remember.

describe('what no words reach', () => {
  it('refuses the gate, whichever key of it is named', () => {
    for (const path of ['approvals.mode', 'approvals.auto_allow', 'approvals.rules']) {
      expect(settingReach(path).reach, path).toBe('never')
    }
  })

  it('refuses a sign-in, an account, and the key an account is paid for with', () => {
    for (const path of ['accounts.work', 'accounts.work.key', 'workers.accounts.pi']) {
      expect(settingReach(path).reach, path).toBe('never')
    }
  })

  it('refuses where a route sends work, while leaving what it thinks with', () => {
    expect(settingReach('workers.routes.default.provider').reach).toBe('never')
    // A model is not a permission: the route's own model, thinking and harness
    // are ordinary settings that happen to live beside a dangerous one.
    expect(settingReach('workers.routes.default.model').reach).toBe('asked')
    expect(settingReach('workers.routes.default.thinking').reach).toBe('asked')
    expect(settingReach('workers.routes.default.harness').reach).toBe('asked')
  })

  it('refuses a whole extension, not only the switch that turns it on', () => {
    // The subtree is the point. `enabled` hands somebody's code to your
    // agents; `org` points an extension that is already on at somebody else's
    // data; `key` is a credential. One rule covers all three, and covers the
    // next key an extension declares on the day it declares it.
    for (const path of ['extensions.sentry.enabled', 'extensions.sentry.org', 'extensions.jev.key'])
      expect(settingReach(path).reach, path).toBe('never')
  })

  it('refuses an MCP server, and the folder its own tools are read from', () => {
    expect(settingReach('mcp.servers.linear.enabled').reach).toBe('never')
    expect(settingReach('orchestrator.extensions').reach).toBe('never')
    // The rest of the orchestrator's own block is ordinary.
    expect(settingReach('orchestrator.model').reach).toBe('asked')
  })

  it('refuses where telemetry is sent, while letting it be turned off', () => {
    // A DSN is an endpoint, not a credential, and this is not about secrecy:
    // it is that changing where Tade sends anything, on the strength of a page
    // it read, is exfiltration whatever the payload. Sending less is not.
    expect(settingReach('telemetry.dsn').reach).toBe('never')
    expect(settingReach('telemetry.errors').reach).toBe('asked')
    expect(settingReach('telemetry.driver').reach).toBe('asked')
  })

  it('refuses moving a project, and allows the rest of its block', () => {
    expect(settingReach('projects.checkout.root').reach).toBe('never')
    expect(settingReach('projects.checkout.brief').reach).toBe('asked')
    expect(settingReach('projects.checkout.budget.usd_per_day').reach).toBe('asked')
    expect(settingReach('projects.checkout.checks.before').reach).toBe('asked')
    // Where a project's agents work is the machine-wide setting asked of one
    // project, and that is `asked`: it decides where the next agent works and
    // widens nothing any agent may do. `root` above stays refused.
    expect(settingReach('projects.checkout.workspace').reach).toBe('asked')
  })

  it('says why, in a clause somebody can be told', () => {
    for (const path of ['approvals.mode', 'mcp.servers.linear.enabled', 'telemetry.dsn']) {
      expect(settingReach(path).because.length, path).toBeGreaterThan(20)
    }
    // Nothing to explain where nothing is refused.
    expect(settingReach('surfaces.window.sidebar_width').because).toBe('')
  })
})

describe('what an ordinary request reaches', () => {
  it('is the short list where the worst case is something they are looking at', () => {
    for (const path of [
      'surfaces.window.sidebar_width',
      'surfaces.window.strip_height',
      'surfaces.window.editor',
    ]) {
      expect(settingReach(path).reach, path).toBe('open')
    }
  })

  it('does not include anything that changes how the work is done', () => {
    for (const path of [
      'agents.commit',
      'agents.workspace',
      'agents.instructions',
      'checks.before',
    ])
      expect(settingReach(path).reach, path).toBe('asked')
  })

  it('does not include what the journal keeps, though the worst it can reach is a byte count', () => {
    // `asked`, decided rather than defaulted into. It widens nothing an agent
    // may do, hands nobody tools or a credential, changes who is asked and
    // changes nowhere Tade sends anything — so it is not `never`. And the only
    // lines it can reach are the sampled byte counts, which nothing reads
    // back: there is no wording of it that deletes a commit, a check or a
    // dollar. But it is the size of somebody's own history, which is not a
    // cosmetic annoyance they are looking at, so it is not `open` either.
    expect(settingReach('journal.max_mb').reach).toBe('asked')
  })
})

describe('the shape of the rule', () => {
  it('has an opinion about every section of the config', () => {
    // The default is `asked`, which is safe for an ordinary key and wrong for
    // a dangerous one — and every dangerous thing there is today is a subtree,
    // so a new key inside one is already covered. What is not covered is a new
    // *section*, and that is what this holds: adding one to the schema fails
    // here until somebody has decided which side of the line it is on.
    const decided = new Set([
      'accounts',
      'agents',
      'approvals',
      'checks',
      'extensions',
      'journal',
      'mcp',
      'orchestrator',
      'projects',
      'surfaces',
      'telemetry',
      'workers',
      'workspace',
    ])
    expect(Object.keys(ConfigSchema.parse({})).sort()).toEqual([...decided].sort())
  })

  it('is exactly this much of what Settings offers, and no more', () => {
    // Every path the page has a field for, sorted into tiers. Written out
    // rather than counted, because the whole of this change is which side of
    // the line each of them is on: moving one is a diff somebody reads.
    const groups = settingsOf(
      ConfigSchema.parse({
        projects: { app: { root: '/src/app' } },
        extensions: { sentry: {} },
      }),
    )
    const byTier: Record<string, string[]> = { open: [], asked: [], never: [] }
    for (const group of groups) {
      for (const setting of group.settings) {
        byTier[settingReach(setting.path).reach]?.push(setting.path)
      }
    }
    expect(byTier.open).toEqual([
      'surfaces.window.sidebar_width',
      'surfaces.window.strip_height',
      'surfaces.window.editor',
    ])
    expect(byTier.never?.sort()).toEqual([
      'approvals.mode',
      'extensions.sentry.brief',
      'extensions.sentry.brief_query',
      'extensions.sentry.enabled',
      'extensions.sentry.org',
      'extensions.sentry.projects',
      'extensions.sentry.token_env',
      'extensions.sentry.url',
      'projects.app.root',
      'telemetry.dsn',
    ])
    // The rest — and it is most of them — needs the person's own words.
    expect(byTier.asked?.length).toBeGreaterThan(30)
  })
})

describe('whether the person themselves named it', () => {
  const setting = {
    path: 'agents.commit',
    title: 'Commit rule',
    keywords: ['commit', 'git'] as const,
  }

  it('finds the setting in a line they actually said', () => {
    expect(namedBy(setting, ['make the agents commit as they go'])).toBe(
      'make the agents commit as they go',
    )
    expect(namedBy(setting, ['set agents.commit to never'])).toBe('set agents.commit to never')
  })

  it('finds nothing in a line about something else', () => {
    expect(namedBy(setting, ['how is the refunds agent getting on?'])).toBeNull()
  })

  it('refuses rather than guessing when they said it in other words', () => {
    // The safe direction, and said plainly because it is the cost of the rule:
    // somebody who says "stop saving my work for me" has named nothing, and is
    // asked to say which setting rather than having one guessed at.
    expect(namedBy(setting, ['stop saving my work for me'])).toBeNull()
  })

  it('will not take a word out of the middle of another one', () => {
    expect(namedBy({ path: 'x.commit', title: 'Commit' }, ['recommitted the branch'])).toBeNull()
  })

  it('drops path segments too short to identify anything', () => {
    // `stt` names nothing anybody would say; `voice` does. Five letters is
    // the line. The title always counts, however short it is: it is the name
    // the setting actually has, and a person saying it has named it.
    const words = wordsFor({ path: 'surfaces.voice.stt.driver', title: 'Speech to text' })
    expect(words).toContain('voice')
    expect(words).toContain('speech to text')
    expect(words).not.toContain('stt')
  })

  it('never counts the section, because a section names everything under it', () => {
    expect(wordsFor({ path: 'agents.commit', title: 'Commit rule' })).not.toContain('agents')
    expect(namedBy(setting, ['how are the agents getting on?'])).toBeNull()
  })

  it('is empty-handed with nothing to look at', () => {
    expect(namedBy(setting, [])).toBeNull()
  })
})
