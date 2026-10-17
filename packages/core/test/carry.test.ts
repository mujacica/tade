import { describe, expect, it } from 'vitest'
import {
  CARRY_SECTIONS,
  type CarryLeaf,
  ConfigSchema,
  carriedSays,
  carryDecision,
  carryOf,
  changedThere,
  HOME_HOLDS,
  KEYS_TO_REMOTE,
  keyDigest,
  leavesOf,
  SEEN_BY_AGENTS,
  settingReach,
  settingsOf,
  textOf,
} from '../src/index.ts'

// What another machine's Tade is given of this one's (`carry.ts`). What is held
// here is the shape: every section decided, keys never by themselves, this
// machine's own never at all, and a value that machine changed itself never
// written over without somebody pressing for it.

describe('what is carried', () => {
  it('has a decision for every section of the config', () => {
    // Unnamed is `here`, which is safe and silent — so a section added to the
    // schema fails here until somebody has said whether it travels.
    expect(Object.keys(ConfigSchema.parse({})).sort()).toEqual([...CARRY_SECTIONS].sort())
  })

  it('carries the preferences, and keeps each machine’s own', () => {
    const decided = (path: string) => carryOf(path).carry
    for (const path of [
      'agents.commit',
      'agents.push',
      'agents.instructions',
      'orchestrator.harness',
      'orchestrator.model',
      'workers.default',
      'workers.routes.default.model',
      'workers.routes.default.provider',
      'approvals.mode',
      'checks.before',
      'queue.holds',
      'queue.hold_scheduled',
      'notes.keep_days',
      'documents.keep_days',
      'surfaces.voice.attention.quiet',
      'surfaces.voice.talk.key',
      'surfaces.window.editor',
      'surfaces.search.context',
      'telemetry.errors',
      'extensions.sentry.enabled',
      'extensions.sentry.org',
      'prices',
    ]) {
      expect(decided(path), path).toBe('kept')
    }
    for (const path of [
      'projects.app.root',
      'projects.app.brief',
      'workspace.driver',
      'drivers.pty.scrollback',
      'agents.workspace',
      'agents.keep_awake',
      'remotes.vps.session',
      'surfaces.web.public',
      'surfaces.web.push_key',
      'surfaces.voice.mic.device',
      'surfaces.voice.stt.model',
      'orchestrator.extensions',
      'telemetry.environment',
      'checks.run_here',
      'journal.max_mb',
      'budget.usd_per_day',
    ]) {
      expect(decided(path), path).toBe('here')
    }
  })

  it('never carries a key by itself, wherever it is', () => {
    for (const path of [
      'extensions.jev.key',
      'extensions.sentry.token',
      'extensions.intake.slack_token',
      'extensions.intake.linear_key',
      'accounts.work.key',
      'telemetry.dsn',
      'mcp.servers.github',
      'surfaces.intake',
    ]) {
      expect(carryOf(path).carry, path).toBe('pressed')
    }
    // A key an extension declared under a name that does not say so.
    expect(carryOf('extensions.acme.auth').carry).toBe('kept')
    expect(carryOf('extensions.acme.auth', true).carry).toBe('pressed')
    // The talk key is a key on a keyboard.
    expect(carryOf('surfaces.voice.talk.key').carry).toBe('kept')
  })

  it('decides every credential and every door Settings offers as never-tier the right way', () => {
    // `never` to the orchestrator is not "never carried": approvals, which
    // extensions are on, a route's provider and the accounts are the person's
    // own preferences and go with them. Written out, because which side each
    // is on is the whole of the decision.
    const config = ConfigSchema.parse({
      projects: { app: { root: '/src/app' } },
      extensions: { sentry: {} },
    })
    const never: Record<string, string> = {}
    for (const group of settingsOf(config)) {
      for (const setting of group.settings) {
        if (settingReach(setting.path).reach === 'never')
          never[setting.path] = carryOf(setting.path).carry
      }
    }
    for (const [path, carry] of Object.entries(never)) {
      if (path.startsWith('surfaces.web.') || path.startsWith('projects.'))
        expect(carry, path).toBe('here')
      else if (path === 'telemetry.dsn' || path.startsWith('surfaces.intake.'))
        expect(carry, path).toBe('pressed')
      else if (path.startsWith('extensions.') && /(?:^|_)(?:key|token)$/.test(path))
        expect(carry, path).toBe('pressed')
      else expect(['kept', 'here'], path).toContain(carry)
    }
  })

  it('says, in the inventory, what becomes of every kind of thing a home holds', () => {
    const kinds = new Set(HOME_HOLDS.map((one) => one.carry))
    expect([...kinds].sort()).toEqual(['guided', 'here', 'kept', 'pressed'])
    const signIns = HOME_HOLDS.find((one) => one.carry === 'guided')
    expect(signIns?.how).toMatch(/never copied/)
  })
})

describe('the values carried', () => {
  const byPath = (leaves: CarryLeaf[]) =>
    Object.fromEntries(leaves.map((one) => [one.path, one.carry]))

  it('carries only what was written, never a default', () => {
    expect(leavesOf({})).toEqual([])
    expect(leavesOf({ agents: { commit: 'as-you-go' } })).toEqual([
      { path: 'agents.commit', value: 'as-you-go', carry: 'kept', because: '' },
    ])
  })

  it('cuts at what is one value, and keeps each machine’s own as one row', () => {
    const leaves = leavesOf({
      prices: { 'gpt-4.1': { input: 2, output: 8 } },
      mcp: { servers: { github: { command: 'gh-mcp', env: { GH_TOKEN: 'ghp_x' } } } },
      projects: { app: { root: '/src/app', brief: 'the app' } },
      surfaces: { web: { enabled: true, port: 7654 }, window: { editor: 'zed' } },
      approvals: { auto_allow: ['read', 'grep'] },
      extensions: { jev: { enabled: true, key: 'jev_x' } },
    })
    expect(byPath(leaves)).toEqual({
      prices: 'kept',
      'mcp.servers.github': 'pressed',
      projects: 'here',
      'surfaces.web': 'here',
      'surfaces.window.editor': 'kept',
      'approvals.auto_allow': 'kept',
      'extensions.jev.enabled': 'kept',
      'extensions.jev.key': 'pressed',
    })
  })

  it('takes a key the caller knows is one as one, and a name with a dot as this machine’s', () => {
    const leaves = leavesOf(
      { extensions: { acme: { auth: 'sekrit', 'a.b': 1 } } },
      new Set(['extensions.acme.auth']),
    )
    expect(byPath(leaves)).toEqual({
      'extensions.acme.auth': 'pressed',
      'extensions.acme.a.b': 'here',
    })
  })

  it('says the same value the same way, however its keys were ordered', () => {
    expect(textOf({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(textOf({ a: [2, { c: 2, d: 1 }], b: 1 }))
    expect(textOf('plain')).toBe('plain')
    expect(textOf(undefined)).toBe('')
    expect(textOf(true)).toBe('true')
  })

  it('never says a pressed value on the line that records it', () => {
    // Whether there is one, as every writer says a key: not even how long it is.
    expect(carriedSays('pressed', 'sk-live-123456')).toBe('set')
    expect(carriedSays('pressed', { env: { TOKEN: 'x' } })).toBe('set')
    expect(carriedSays('pressed', undefined)).toBe('not set')
    expect(carriedSays('kept', 'own-files')).toBe('own-files')
    expect(carriedSays('kept', undefined)).toBe('')
  })
})

describe('writing over what is there', () => {
  const value = (v: unknown) => ({ value: v })

  it('writes where nothing is, and says when it is already so', () => {
    const base = { carry: 'kept' as const, last: null, force: false }
    expect(carryDecision({ ...base, incoming: value('as-you-go'), current: undefined })).toBe(
      'written',
    )
    expect(carryDecision({ ...base, incoming: value('as-you-go'), current: 'as-you-go' })).toBe(
      'same',
    )
  })

  it('leaves a value that machine changed itself, and writes it on a press', () => {
    const theirs = { carry: 'kept' as const, current: 'never' }
    // Somebody there set it.
    const set = { now: 'never', carried: false }
    expect(
      carryDecision({ ...theirs, incoming: value('own-files'), last: set, force: false }),
    ).toBe('theirs')
    // A carry set it, and the file was edited by hand since.
    const edited = { now: 'own-files', carried: true }
    expect(
      carryDecision({ ...theirs, incoming: value('as-you-go'), last: edited, force: false }),
    ).toBe('theirs')
    // Written there before anything wrote lines.
    expect(
      carryDecision({ ...theirs, incoming: value('own-files'), last: null, force: false }),
    ).toBe('theirs')
    expect(carryDecision({ ...theirs, incoming: value('own-files'), last: set, force: true })).toBe(
      'written',
    )
    // A carry set it and nothing has touched it since: kept in step.
    const carried = { now: 'never', carried: true }
    expect(
      carryDecision({ ...theirs, incoming: value('own-files'), last: carried, force: false }),
    ).toBe('written')
  })

  it('takes a value away only where it is still the one carried', () => {
    const away = { carry: 'kept' as const, incoming: value(null), force: false }
    expect(carryDecision({ ...away, current: 'x', last: { now: 'x', carried: true } })).toBe(
      'written',
    )
    expect(carryDecision({ ...away, current: 'y', last: { now: 'x', carried: true } })).toBe(
      'theirs',
    )
    // Somebody there cleared one a carry had set: theirs, so it is not set again.
    expect(
      carryDecision({
        carry: 'kept',
        incoming: value('x'),
        current: undefined,
        last: { now: '', carried: false },
        force: false,
      }),
    ).toBe('theirs')
  })

  it('compares a key by its digest and never writes one that only came as a digest', () => {
    const pressed = { carry: 'pressed' as const, last: null, force: false }
    expect(
      carryDecision({ ...pressed, incoming: { digest: keyDigest('sk-1') }, current: 'sk-1' }),
    ).toBe('same')
    expect(
      carryDecision({ ...pressed, incoming: { digest: keyDigest('sk-1') }, current: 'sk-2' }),
    ).toBe('waiting')
    expect(
      carryDecision({ ...pressed, incoming: { digest: keyDigest('sk-1') }, current: undefined }),
    ).toBe('waiting')
    // On the press it goes, over whatever was there, and says which.
    expect(carryDecision({ ...pressed, incoming: value('sk-1'), current: undefined })).toBe(
      'written',
    )
    expect(carryDecision({ ...pressed, incoming: value('sk-1'), current: 'sk-2' })).toBe('replaced')
  })

  it('refuses what is that machine’s own, whatever is sent', () => {
    expect(
      carryDecision({
        carry: 'here',
        incoming: value('/src/app'),
        current: undefined,
        last: null,
        force: true,
      }),
    ).toBe('refused')
  })

  it('counts nothing written as nobody’s', () => {
    expect(changedThere(undefined, null)).toBe(false)
    expect(changedThere('x', null)).toBe(true)
  })
})

describe('what is said where keys are sent', () => {
  it('says agents read them there too, in the one clause, with the way out', () => {
    expect(KEYS_TO_REMOTE).toContain(SEEN_BY_AGENTS)
    expect(KEYS_TO_REMOTE).toMatch(/export its variable there instead/)
    expect(KEYS_TO_REMOTE).not.toMatch(/only you/i)
  })
})
