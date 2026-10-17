import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui'
import { KEYS_TO_REMOTE, TALK_TO_REMOTE } from '@tade/core'
import type { Checklist } from '@tade/workbench/carry'
import { describe, expect, it } from 'vitest'
import { type Machine, NO_DETAIL, unheard } from '../src/machines.ts'
import { sideWidth } from '../src/panels/cells.ts'
import {
  CLOSE_AFTER_MOVE,
  type RemoteShown,
  remoteActions,
  remoteChoice,
} from '../src/panels/settings/remotes.ts'
import { settingsKey } from '../src/panels/settings/state.ts'
import { drawnAt, panelFor, plainRows, WIDTHS } from './settings-panel.ts'

// Settings › Remotes: each other machine's Tade this one is an owner of, and
// the checklist `tade remote add` ends with — what was carried, what that
// machine changed itself, what waits on a press, whether its tab here takes a
// message, and each harness's own sign-in there — with the presses beside each.

const LIST: Checklist = {
  remote: 'vps',
  machine: 'box-1',
  unreached: null,
  carried: ['agents.commit', 'approvals.mode', 'persona reviewer'],
  written: 1,
  theirs: [{ what: 'queue.holds', theirs: 'ask', ours: 'orchestrator' }],
  refused: [],
  waiting: ['extensions.jev.key', 'telemetry.dsn'],
  sent: [],
  nextStart: ['approvals.mode'],
  signIns: [
    { harness: 'claude-code', account: null, signedIn: true, told: true, lasts: '27 days left' },
    { harness: 'codex', account: null, signedIn: false, told: true, lasts: 'not signed in' },
    { harness: 'pi', account: null, signedIn: false, told: false, lasts: 'it did not say' },
  ],
  talk: null,
  here: [
    { what: 'projects', why: 'a project is a folder on this machine' },
    { what: 'agents.workspace', why: 'where agents work is decided for the machine' },
  ],
  holds: [],
}

const VPS: RemoteShown = {
  name: 'vps',
  address: 'me@vps.example.com',
  link: '● linked',
  live: true,
  list: LIST,
  at: Date.UTC(2026, 9, 17, 14, 2),
  busy: false,
  machine: null,
}

const NOW = Date.UTC(2026, 9, 17, 14, 10)

/** The VPS as this window folds it: heard from a few seconds ago, with what it said it is. */
const vpsMachine = (over: Partial<Machine> = {}): Machine => ({
  ...unheard('vps', null),
  link: 'live',
  heard: true,
  asOf: NOW - 4_000,
  detail: {
    ...NO_DETAIL,
    warnings: ['tade: git could not read the checkout: locked'],
    about: {
      at: NOW - 30_000,
      roundTrip: 38,
      version: '0.2.3',
      newer: 'Tade 0.2.4 is out',
      public: {
        name: 'tade.example.com',
        up: true,
        health: [{ said: 'certificate: 9 days left of 45, renewing is late', loud: true }],
      },
      problems: [{ from: 'extension', at: null, said: 'Sentry needs setting up: no token' }],
      schedules: [
        {
          id: 'new-sentry-errors',
          name: 'New Sentry errors',
          project: 'tade',
          kind: 'watch',
          when: 'every hour',
          paused: false,
          next: null,
          watch: {
            id: 'sentry.new-errors',
            looks: [{ at: NOW - 600_000, found: 3, fresh: 2, problem: null, said: null, on: null }],
            found: [],
          },
        },
      ],
      documents: [],
    },
  },
  ...over,
})

/** The page at `NOW`, its runs of spaces made one: what a row says, not where its columns are. */
const at = (remotes: RemoteShown[]) =>
  plainRows(drawnAt('remotes', { remotes, now: NOW }, panelFor('remotes', { focus: 'form' })))
    .join('\n')
    .replace(/ +/g, ' ')

const page = (remotes: RemoteShown[], over = {}) =>
  plainRows(drawnAt('remotes', { remotes }, panelFor('remotes', { focus: 'form', ...over }))).join(
    '\n',
  )

describe('Settings › Remotes', () => {
  it('is a page only while there is a remote', () => {
    // Tall enough that the whole side is on screen, Updates under it included.
    const side = (remotes: RemoteShown[]) =>
      plainRows(drawnAt('agents', { remotes, height: 90 })).join('\n')
    expect(side([])).toContain('Updates')
    expect(side([])).not.toContain('Remotes')
    expect(side([VPS])).toContain('Remotes')
  })

  it('draws the checklist: carried, what waits for a start there, changed there, on a press, each sign-in, and this machine’s own', () => {
    const drawn = page([VPS])
    expect(drawn).toContain('vps')
    expect(drawn).toContain('● linked')
    expect(drawn).toContain(
      'ssh me@vps.example.com · it calls itself box-1 · carried 2026-10-17 14:02',
    )
    expect(drawn).toContain('3 settings and files, kept in step')
    expect(drawn).toMatch(/Next start +approvals\.mode/)
    expect(drawn).toContain('queue.holds — there ask · here orchestrator')
    expect(drawn).toContain('Send this machine’s')
    expect(drawn).toContain('extensions.jev.key, telemetry.dsn')
    expect(drawn).toContain('Send them…')
    expect(drawn).toContain('● 27 days left')
    expect(drawn).toContain('○ not signed in')
    expect(drawn).toContain('· it did not say')
    expect(drawn).toContain('projects, agents.workspace')
    expect(drawn).toContain('Carry again')
  })

  it('offers a sign-in only where that machine said there is none', () => {
    const ids = remoteActions([VPS]).map((one) => one.id)
    expect(ids).toEqual([
      'remote:ours:vps:queue.holds',
      'remote:keys:vps',
      'remote:sign-in:vps:codex:',
      'remote:again:vps',
    ])
  })

  it('walks moving a project there one press at a time, and asks twice before closing it here', () => {
    const moving: RemoteShown = {
      ...VPS,
      list: null,
      moves: [
        { project: 'docs', said: 'not on vps yet', next: 'open' },
        { project: 'app', said: 'on vps as tade · 1 running here', next: 'hand' },
        { project: 'web', said: 'on vps as web · nothing of it is working here', next: 'close' },
        { project: 'shop', said: 'moving to vps…', next: null },
      ],
    }
    const drawn = page([moving]).replace(/ +/g, ' ')
    expect(drawn).toContain('Move docs not on vps yet')
    expect(drawn).toContain('Open it on vps')
    expect(drawn).toContain('Hand its work over')
    expect(drawn).toContain('Close it here…')
    expect(drawn).toContain('moving to vps…')
    expect(remoteActions([moving]).map((one) => one.id)).toEqual([
      'remote:move-open:vps:docs',
      'remote:move-hand:vps:app',
      'remote:move-close:vps:web',
      'remote:again:vps',
    ])
    const first = remoteChoice(panelFor('remotes'), 'remote:move-close:vps:web')
    expect('submit' in first && first.submit).toBeFalsy()
    const asked = page([moving], { confirm: 'remote:move-close:vps:web' }).replace(/\s+/g, ' ')
    expect(asked).toContain('Press again to close it here')
    expect(asked).toContain(CLOSE_AFTER_MOVE.slice(0, 40))
    expect(remoteChoice(panelFor('remotes'), 'remote:move-open:vps:docs')).toMatchObject({
      submit: true,
      choice: 'remote:move-open:vps:docs',
    })
  })

  it('asks twice before keys go, saying what that means between the two presses', () => {
    const first = remoteChoice(panelFor('remotes'), 'remote:keys:vps')
    expect('submit' in first && first.submit).toBeFalsy()
    const asked = first.panel as ReturnType<typeof panelFor>
    expect(asked.confirm).toBe('remote:keys:vps')
    const drawn = page([VPS], { confirm: 'remote:keys:vps' })
    expect(drawn).toContain('Press again to send')
    expect(drawn.replace(/\s+/g, ' ')).toContain(KEYS_TO_REMOTE.slice(0, 40))
    const second = remoteChoice(asked, 'remote:keys:vps')
    expect(second).toMatchObject({ submit: true, choice: 'remote:keys:vps' })
  })

  it('says all of what sending keys means, the way out at its end included, at every width', () => {
    // From the narrowest width at which each of its words fits on a line.
    for (const width of WIDTHS.filter((one) => one >= 56)) {
      const rows = plainRows(
        drawnAt(
          'remotes',
          { remotes: [VPS], width, height: 90 },
          panelFor('remotes', { focus: 'form', confirm: 'remote:keys:vps' }),
        ),
      )
      // The form's own columns — past the list, its scrollbar and the line
      // between, short of the form's scrollbar — as one flowing string: where
      // it wrapped is not what the page is held to.
      const inner = visibleWidth(rows[0] ?? '') - 2
      const side = sideWidth(inner)
      const said = rows
        .map((row) => sliceByColumn(row, side + 3, inner - side - 3))
        .join(' ')
        .replace(/\s+/g, ' ')
      expect(said, `at ${width}`).toContain(KEYS_TO_REMOTE)
    }
  })

  it('lists Talk to Tade until it is on there, and asks twice before turning it on', () => {
    const off: RemoteShown = { ...VPS, list: { ...LIST, talk: 'off' } }
    expect(page([off])).toMatch(/Talk to Tade +off there: its tab here takes no message/)
    expect(remoteActions([off]).map((one) => one.id)).toContain('remote:talk:vps')
    const first = remoteChoice(panelFor('remotes'), 'remote:talk:vps')
    expect('submit' in first && first.submit).toBeFalsy()
    const drawn = page([off], { confirm: 'remote:talk:vps' })
    expect(drawn).toContain('Press again to turn on')
    expect(drawn.replace(/\s+/g, ' ')).toContain(TALK_TO_REMOTE.slice(0, 40))
    const asked = first.panel as ReturnType<typeof panelFor>
    expect(remoteChoice(asked, 'remote:talk:vps')).toMatchObject({
      submit: true,
      choice: 'remote:talk:vps',
    })
    // Turned on is said once, and on is nothing to list or to press.
    const turning: RemoteShown = { ...VPS, list: { ...LIST, talk: 'turning on' } }
    expect(page([turning])).toMatch(/Talk to Tade +turned on there, on your press/)
    for (const talk of ['on', 'turning on', null] as const) {
      const ids = remoteActions([{ ...VPS, list: { ...LIST, talk } }]).map((one) => one.id)
      expect(ids).not.toContain('remote:talk:vps')
    }
    expect(page([{ ...VPS, list: { ...LIST, talk: 'on' } }])).not.toContain('Talk to Tade')
  })

  it('walks the presses with the keyboard, and presses the one it is on', () => {
    const inputs = { remoteActions: remoteActions([VPS]) }
    const panel = panelFor('remotes', { focus: 'form', row: 0 })
    const down = settingsKey(panel, 'down', '', inputs).panel as ReturnType<typeof panelFor>
    expect(down.row).toBe(1)
    const pressed = settingsKey({ ...down, row: 3 }, 'enter', '\r', inputs)
    expect(pressed).toMatchObject({ submit: true, choice: 'remote:again:vps' })
  })

  it('says how each machine stands: heard from, the round trip, its Tade, its public name, its problems and its watches', () => {
    const drawn = at([{ ...VPS, machine: vpsMachine() }])
    expect(drawn).toContain('Heard 4s ago · 38 ms there and back')
    expect(drawn).toContain('Tade 0.2.3 · Tade 0.2.4 is out')
    expect(drawn).toContain('Public name tade.example.com')
    expect(drawn).toContain('certificate: 9 days left of 45, renewing is late')
    expect(drawn).toContain('Problems 2')
    expect(drawn).toContain('· Sentry needs setting up: no token')
    expect(drawn).toContain('· tade: git could not read the checkout: locked')
    expect(drawn).toContain('◎ New Sentry errors in tade · every hour · 2 new')
  })

  it('says a machine that stopped answering as of its last answer, never as one with nothing wrong', () => {
    const down = vpsMachine({ link: 'down', asOf: NOW - 3_600_000 })
    const drawn = at([{ ...VPS, live: false, machine: down }])
    expect(drawn).toContain('Heard as of 2026-10-17 13:10, 1h 0m ago · 38 ms there and back')
    expect(drawn).toMatch(/Tade 0\.2\.3 · Tade 0\.2\.4 is out · as of /)
    expect(drawn).toContain('Problems 2')
    // An older Tade there has no such door: said, and nothing invented in its place.
    const older = vpsMachine({
      detail: {
        ...NO_DETAIL,
        aboutSaid: 'vps runs a Tade that does not say what it is yet: update it there',
      },
    })
    const said = at([{ ...VPS, machine: older }])
    expect(said).toContain('vps runs a Tade that does not say what it is yet')
    expect(said).not.toContain('Problems')
  })

  it('says why nothing was carried, rather than drawing an empty list', () => {
    const down: RemoteShown = {
      ...VPS,
      link: '○ down · its stream went quiet',
      live: false,
      list: {
        ...LIST,
        unreached: 'nothing answers on localhost:7654 there',
        carried: [],
        theirs: [],
      },
    }
    const drawn = page([down])
    expect(drawn).toContain('○ nothing answers on localhost:7654 there')
    expect(remoteActions([down]).map((one) => one.id)).not.toContain('remote:keys:vps')
  })
})
