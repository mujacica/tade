import { describe, expect, it } from 'vitest'
import {
  CARRY_SECTIONS,
  type CarryLeaf,
  type ChangeSeen,
  ConfigSchema,
  carriedSays,
  carryDecision,
  carryOf,
  changesIn,
  compareStamps,
  conflictSays,
  editedSince,
  HOME_HOLDS,
  handEdits,
  KEYS_TO_REMOTE,
  keyDigest,
  leavesOf,
  lineStamp,
  PICKED_BY_HARNESS,
  peerMayWrite,
  personBy,
  pickedByHarness,
  pinnedHere,
  type Register,
  registerAt,
  registersHere,
  SEEN_BY_AGENTS,
  type Stamp,
  settingReach,
  settingsOf,
  settle,
  stampOf,
  stampText,
  textOf,
  tick,
  whoChanged,
} from '../src/index.ts'

// What another machine's Tade is given of this one's (`carry.ts`). What is held
// here is the shape: every section decided, keys never by themselves, this
// machine's own never at all, and every kept setting a register whose latest
// change stands on both machines — said where two were made apart.

describe('what is carried', () => {
  it('has a decision for every section of the config', () => {
    // Unnamed is `here`, which is safe and silent — so a section added to the
    // schema fails here until somebody has said whether it travels.
    expect(Object.keys(ConfigSchema.parse({})).sort()).toEqual([...CARRY_SECTIONS].sort())
  })

  it('names every section, and what becomes of it', () => {
    // Written out rather than read back, so a section's decision changing is a
    // line somebody changes here on purpose. A section whose subtree is split
    // says what its bare name decides, and the split is held below.
    const sections: Record<string, string> = {
      workspace: 'here',
      drivers: 'here',
      orchestrator: 'kept',
      workers: 'kept',
      accounts: 'kept',
      approvals: 'kept',
      agents: 'kept',
      surfaces: 'here',
      telemetry: 'kept',
      journal: 'here',
      documents: 'kept',
      notes: 'kept',
      queue: 'kept',
      budget: 'here',
      checks: 'kept',
      prices: 'kept',
      projects: 'here',
      remotes: 'here',
      machine: 'here',
      backup: 'here',
      mcp: 'pressed',
      extensions: 'kept',
    }
    expect(Object.keys(sections).sort()).toEqual(Object.keys(ConfigSchema.parse({})).sort())
    for (const [section, carry] of Object.entries(sections)) {
      expect(carryOf(section).carry, section).toBe(carry)
    }
    // `surfaces` is unnamed whole: each surface is decided on its own.
    expect(carryOf('surfaces.window.editor').carry).toBe('kept')
    expect(carryOf('surfaces.web.port').carry).toBe('here')
    expect(carryOf('surfaces.intake').carry).toBe('pressed')
  })

  it('carries the preferences, and keeps each machine’s own', () => {
    const decided = (path: string) => carryOf(path).carry
    for (const path of [
      'agents.commit',
      'agents.push',
      'agents.instructions',
      'agents.close_when_done',
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
      'projects.app.close_when_done',
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
      'machine.pinned',
    ]) {
      expect(decided(path), path).toBe('here')
    }
  })

  it('keeps the GitHub App on the machine it was made for, key and all', () => {
    // Its webhook and callbacks are this machine's public name, so another
    // machine given it would be reading as an App whose deliveries go here.
    for (const leaf of ['github_app_id', 'github_app_key', 'github_app_slug']) {
      expect(carryOf(`extensions.intake.${leaf}`).carry, leaf).toBe('here')
    }
    expect(carryOf('extensions.intake.github_webhook_secret').carry).toBe('pressed')
  })

  it('keeps the Slack app’s client on the machine it was made for', () => {
    // Its redirect and its Request URL are this machine's public name.
    for (const leaf of ['slack_client_id', 'slack_client_secret']) {
      expect(carryOf(`extensions.intake.${leaf}`).carry, leaf).toBe('here')
    }
    expect(carryOf('extensions.intake.slack_signing_secret').carry).toBe('pressed')
  })

  it('keeps the Linear app and its refresh token on the machine it was made for', () => {
    // A refresh token is spent by its first refresh, so a copy on another
    // machine would break this one's connection the first time it was used.
    for (const leaf of ['linear_client_id', 'linear_refresh_token']) {
      expect(carryOf(`extensions.intake.${leaf}`).carry, leaf).toBe('here')
    }
    expect(carryOf('extensions.intake.linear_webhook_secret').carry).toBe('pressed')
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
      if (
        path.startsWith('surfaces.web.') ||
        path.startsWith('projects.') ||
        path.startsWith('machine.')
      )
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
    // Shared both ways since notes went over the link (`notes-shared.ts`).
    expect(HOME_HOLDS.find((one) => one.what === 'notes')?.carry).toBe('kept')
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

describe('a key, and this machine’s own', () => {
  const value = (v: unknown) => ({ value: v })

  it('compares a key by its digest and never writes one that only came as a digest', () => {
    const pressed = { carry: 'pressed' as const }
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
    expect(carryDecision({ carry: 'here', incoming: value('/src/app'), current: undefined })).toBe(
      'refused',
    )
  })
})

describe('the stamp a change carries', () => {
  it('never goes back past anything it was handed, whatever the wall clock says', () => {
    const first = tick(null, 1_000, 'mac')
    expect(first).toEqual({ wall: 1_000, count: 0, machine: 'mac' })
    // The same millisecond, and a clock that went backwards: still later.
    expect(tick(first, 1_000, 'mac')).toEqual({ wall: 1_000, count: 1, machine: 'mac' })
    expect(tick(first, 400, 'mac')).toEqual({ wall: 1_000, count: 1, machine: 'mac' })
    // A box whose clock runs slow, handed the Mac's stamp, writes after it.
    const handed = { wall: 9_000, count: 3, machine: 'mac' }
    const slow = tick(handed, 5_000, 'vps')
    expect(compareStamps(slow, handed)).toBeGreaterThan(0)
  })

  it('orders by time, then count, then machine, and nothing before everything', () => {
    const at = (wall: number, count = 0, machine = 'a'): Stamp => ({ wall, count, machine })
    expect(compareStamps(at(1), at(2))).toBeLessThan(0)
    expect(compareStamps(at(2, 1), at(2, 0))).toBeGreaterThan(0)
    expect(compareStamps(at(2, 0, 'mac'), at(2, 0, 'vps'))).toBeLessThan(0)
    expect(compareStamps(null, at(0))).toBeLessThan(0)
    expect(compareStamps(null, null)).toBe(0)
  })

  it('reads back as it was written, and a line from before stamps as its wall time', () => {
    const stamp = { wall: 1_763_800_000_000, count: 2, machine: 'ipax-box' }
    expect(stampOf(stampText(stamp))).toEqual(stamp)
    expect(stampOf('not a stamp')).toBeNull()
    expect(stampOf(42)).toBeNull()
    expect(lineStamp({}, '2026-11-22T10:00:00.000Z')).toEqual({
      wall: Date.parse('2026-11-22T10:00:00.000Z'),
      count: 0,
      machine: '',
    })
    expect(lineStamp({ hlc: stampText(stamp) }, '2026-11-22T10:00:00.000Z')).toEqual(stamp)
    expect(lineStamp({})).toBeNull()
  })
})

describe('the latest change stands', () => {
  const at = (wall: number, machine: string): Stamp => ({ wall, count: 0, machine })
  const reg = (value: unknown, stamp: Stamp | null, over: Stamp | null = null): Register => ({
    value,
    stamp,
    over,
    by: 'window',
  })

  it('takes the later one, from either side, and the same pair settles the same way on both', () => {
    const mac = reg('auto', at(5, 'mac'))
    const vps = reg('ask', at(2, 'vps'))
    expect(settle(vps, mac).keep).toBe('incoming')
    expect(settle(mac, vps).keep).toBe('here')
    expect(settle(mac, reg('auto', at(9, 'vps'))).keep).toBe('same')
  })

  it('says a conflict only where neither had seen the other’s change', () => {
    // Apart: the Mac changed it over nothing the box wrote.
    const apart = settle(reg('ask', at(2, 'vps')), reg('auto', at(5, 'mac'), at(1, 'mac')))
    expect(apart).toEqual({ keep: 'incoming', conflict: true })
    // Behind: the Mac changed it over the box's own change, so the box is just catching up.
    const behind = settle(reg('ask', at(2, 'vps')), reg('auto', at(5, 'mac'), at(2, 'vps')))
    expect(behind).toEqual({ keep: 'incoming', conflict: false })
    // A machine that never had it is not a change that lost.
    expect(settle(reg(undefined, null), reg('auto', at(5, 'mac'))).conflict).toBe(false)
  })

  it('breaks a tie of stamps the same way on both machines', () => {
    const a = reg('one', null)
    const b = reg('two', null)
    expect(settle(a, b).keep).toBe('incoming')
    expect(settle(b, a).keep).toBe('here')
  })

  it('takes a value away as a change like any other', () => {
    expect(settle(reg('x', at(1, 'vps')), reg(undefined, at(4, 'mac'))).keep).toBe('incoming')
    expect(settle(reg('x', at(6, 'vps')), reg(undefined, at(4, 'mac'))).keep).toBe('here')
  })

  it('never lets what a harness picked, because nothing was chosen, beat a value somebody chose', () => {
    // The Mac's person chose opus long ago; a new box kept its harness's own pick just now.
    const chosen = reg('opus', at(1, 'mac'))
    const picked: Register = { ...reg('sonnet', at(9, 'ipax')), by: PICKED_BY_HARNESS }
    expect(settle(chosen, picked)).toEqual({ keep: 'here', conflict: false })
    expect(settle(picked, chosen)).toEqual({ keep: 'incoming', conflict: false })
    // Passed on through another machine, it is still the harness's pick.
    const relayed: Register = { ...picked, by: `${PICKED_BY_HARNESS} on ipax` }
    expect(pickedByHarness(relayed.by)).toBe(true)
    expect(settle(chosen, relayed).keep).toBe('here')
    // Two harnesses' picks, or a pick against a value taken away, are the latest that stands.
    const older: Register = { ...reg('haiku', at(2, 'mac')), by: PICKED_BY_HARNESS }
    expect(settle(older, picked).keep).toBe('incoming')
    expect(settle(picked, reg(undefined, at(4, 'mac'))).keep).toBe('here')
  })

  it('reads a register’s stamp from a line at it, around it or inside it, whichever is latest', () => {
    const changes = changesIn([
      line('accounts.work', 'set', 'window', stampText(at(3, 'mac'))),
      line('accounts.work.method', 'api-key', 'window', stampText(at(7, 'mac'))),
      line('prices.gpt.input', '2', 'window', stampText(at(9, 'mac'))),
      line('agents.push', 'never', 'window', stampText(at(1, 'mac'))),
    ])
    expect(registerAt('accounts.work.harness', 'codex', changes).stamp).toEqual(at(3, 'mac'))
    expect(registerAt('accounts.work.method', 'api-key', changes).stamp).toEqual(at(7, 'mac'))
    expect(registerAt('prices', {}, changes).stamp).toEqual(at(9, 'mac'))
    expect(registerAt('agents.commit', 'own-files', changes).stamp).toBeNull()
  })

  it('folds the newest line per path, with its stamp, what it was over and who changed it', () => {
    const [one] = changesIn([
      line('approvals.mode', 'ask', 'window', stampText(at(1, 'mac'))),
      {
        type: 'config_changed',
        ts: '2026-11-22T10:00:00.000Z',
        detail: {
          path: 'approvals.mode',
          now: 'auto',
          by: 'device d1',
          carried: 'vps',
          hlc: stampText(at(4, 'vps')),
          over: stampText(at(1, 'mac')),
          origin: 'orchestrator',
        },
      },
    ])
    expect(one).toMatchObject({
      path: 'approvals.mode',
      now: 'auto',
      carried: true,
      device: 'd1',
      stamp: at(4, 'vps'),
      over: at(1, 'mac'),
      by: 'orchestrator',
    })
  })
})

describe('what is kept in step, and what is not', () => {
  const at = (wall: number): Stamp => ({ wall, count: 0, machine: 'mac' })

  it('is every kept setting written, every one taken away, and nothing pinned, keyed or here', () => {
    const written = {
      agents: { commit: 'as-you-go' },
      checks: { before: 'push' },
      workspace: { driver: 'tmux' },
      extensions: { jev: { key: 'jev_x', enabled: true } },
      machine: { pinned: ['checks'] },
    }
    const changes = changesIn([
      line('queue.holds', '', 'window', stampText(at(5))),
      line('agents.commit', 'as-you-go', 'window', stampText(at(2))),
      line('checks.parallel', '', 'window', stampText(at(3))),
    ])
    const registers = registersHere(written, changes, new Set())
    expect([...registers.keys()].sort()).toEqual([
      'agents.commit',
      'extensions.jev.enabled',
      'queue.holds',
    ])
    expect(registers.get('queue.holds')).toMatchObject({ value: undefined, stamp: at(5) })
    expect(registers.get('agents.commit')?.stamp).toEqual(at(2))
  })

  it('is pinned by a section, a path inside one, or the section written with a star', () => {
    expect(pinnedHere('checks.before', ['checks'])).toBe(true)
    expect(pinnedHere('checks.before', ['checks.*'])).toBe(true)
    expect(pinnedHere('queue.holds', ['queue.holds'])).toBe(true)
    expect(pinnedHere('queue.hold_scheduled', ['queue.holds'])).toBe(false)
    // A table carried whole is pinned by a part of it.
    expect(pinnedHere('prices', ['prices.gpt'])).toBe(true)
    expect(pinnedHere('agents.commit', [])).toBe(false)
  })

  it('finds an edit by hand since the newest line, and never one there is no line for', () => {
    const carried = { now: 'never', carried: true }
    const local = { now: 'read, grep', carried: false }
    expect(editedSince('never', carried)).toBe(false)
    expect(editedSince('own-files', carried)).toBe(true)
    expect(editedSince(undefined, carried)).toBe(true)
    // A line written here says what was typed, so only whether there is one counts.
    expect(editedSince(['read', 'grep'], local)).toBe(false)
    expect(editedSince(undefined, local)).toBe(true)
    expect(editedSince('x', { now: '', carried: false })).toBe(true)
    expect(editedSince('anything', null)).toBe(false)
    const changes: ChangeSeen[] = changesIn([
      {
        type: 'config_changed',
        detail: { path: 'agents.commit', now: 'never', by: 'device d', carried: 'mac' },
      },
      { type: 'config_changed', detail: { path: 'extensions.jev.key', now: 'set', by: 'window' } },
    ])
    expect(handEdits({ agents: { commit: 'own-files' } }, changes, new Set())).toEqual([
      { path: 'agents.commit', was: 'never', now: 'own-files' },
    ])
  })
})

describe('a peer’s change to what widens agents', () => {
  it('lands only where the person made it', () => {
    expect(personBy('window')).toBe(true)
    expect(personBy('cli')).toBe(true)
    expect(personBy('file')).toBe(true)
    expect(personBy('device 7f3a')).toBe(true)
    expect(personBy('orchestrator')).toBe(false)
    expect(personBy(null)).toBe(false)
    expect(peerMayWrite('approvals.mode', 'orchestrator')).toBe(false)
    expect(peerMayWrite('approvals.mode', 'window')).toBe(true)
    expect(peerMayWrite('extensions.sentry.enabled', null)).toBe(false)
    // What does not widen agents goes whoever changed it.
    expect(peerMayWrite('agents.commit', 'orchestrator')).toBe(true)
  })

  it('is passed on as who first changed it, not the carry that brought it', () => {
    expect(whoChanged({ by: 'orchestrator' })).toBe('orchestrator')
    expect(whoChanged({ by: 'device d1', carried: 'mac', origin: 'window' })).toBe('window')
    expect(whoChanged({ by: 'device d1', carried: 'mac' })).toBeNull()
  })
})

describe('a conflict, said', () => {
  const hm = (wall: number) => (wall === 1 ? '14:02' : '14:05')

  it('says both values, both machines and when, and whose stood', () => {
    const said = conflictSays(
      {
        path: 'approvals.mode',
        kept: { value: 'auto', machine: 'mac', at: { wall: 2, count: 0, machine: 'mac' } },
        lost: { value: 'ask', machine: 'box-1', at: { wall: 1, count: 0, machine: 'box-1' } },
        mine: 'kept',
      },
      hm,
      'vps',
    )
    expect(said).toBe(
      'approvals.mode: vps set ask at 14:02, this machine set auto at 14:05; this machine’s kept.',
    )
  })

  it('names each side as the person does, not by a host name both may share', () => {
    const said = conflictSays(
      {
        path: 'queue.holds',
        kept: { value: 'orchestrator', machine: 'mac', at: { wall: 2, count: 0, machine: 'mac' } },
        lost: { value: 'ask', machine: 'mac', at: { wall: 1, count: 0, machine: 'mac' } },
        mine: 'lost',
      },
      hm,
      'vps',
    )
    expect(said).toBe(
      'queue.holds: this machine set ask at 14:02, vps set orchestrator at 14:05; vps’s kept.',
    )
  })
})

function line(path: string, now: string, by: string, hlc: string) {
  return { type: 'config_changed', detail: { path, now, by, hlc } }
}

describe('what is said where keys are sent', () => {
  it('says agents read them there too, in the one clause, with the way out', () => {
    expect(KEYS_TO_REMOTE).toContain(SEEN_BY_AGENTS)
    expect(KEYS_TO_REMOTE).toMatch(/export its variable there instead/)
    expect(KEYS_TO_REMOTE).not.toMatch(/only you/i)
  })
})
