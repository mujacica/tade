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
  remotePresses,
} from '../src/panels/settings/remotes.ts'
import { type SettingsPanel, settingsKey } from '../src/panels/settings/state.ts'
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

/** A machine holding two of four projects here, one of the other two being opened there now. */
const MOVING: RemoteShown = {
  ...VPS,
  list: null,
  moves: [
    { project: 'docs', there: false, said: 'not on vps yet', next: 'open' },
    { project: 'app', there: true, said: 'on vps as tade · 1 running here', next: 'hand' },
    {
      project: 'web',
      there: true,
      said: 'on vps as web · nothing of it is working here',
      next: 'close',
    },
    { project: 'shop', there: false, said: 'moving to vps…', next: null },
  ],
}

/** Both folds open. */
const OPEN = ['remote:fold:vps:moves', 'remote:fold:vps:not-there']

/**
 * The form's own columns at a width — past the list, its scrollbar and the
 * line between, short of the form's scrollbar — one string a row, every row
 * of the panel held to its width on the way.
 */
const formRows = (remote: RemoteShown, width: number, over: Partial<SettingsPanel>) => {
  const rows = plainRows(
    drawnAt(
      'remotes',
      { remotes: [remote], width, height: 120 },
      panelFor('remotes', { focus: 'form', ...over }),
    ),
  )
  const inner = visibleWidth(rows[0] ?? '') - 2
  const side = sideWidth(inner)
  for (const row of rows) expect(visibleWidth(row), `at ${width}`).toBe(inner + 2)
  // Short of the border, and of the two rows at the foot, which are the panel's.
  return rows.slice(1, -3).map((row) => sliceByColumn(row, side + 3, inner - side - 3))
}

/** The form at a width as one flowing string: where it wrapped is not what the page is held to. */
const form = (remote: RemoteShown, width: number, over: Partial<SettingsPanel>) =>
  formRows(remote, width, over).join(' ')

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
    const drawn = page([MOVING], { opened: OPEN }).replace(/ +/g, ' ')
    expect(drawn).toContain('Move app on vps as tade · 1 running here')
    expect(drawn).toContain('Open it on vps')
    expect(drawn).toContain('Hand its work over')
    expect(drawn).toContain('Close it here…')
    expect(drawn).toContain('moving to vps…')
    expect(
      remotePresses(remoteActions([MOVING]), panelFor('remotes', { opened: OPEN })).map(
        (one) => one.id,
      ),
    ).toEqual([
      'remote:fold:vps:moves',
      'remote:move-hand:vps:app',
      'remote:move-close:vps:web',
      'remote:fold:vps:not-there',
      'remote:move-open:vps:docs',
      'remote:again:vps',
    ])
    const first = remoteChoice(panelFor('remotes'), 'remote:move-close:vps:web')
    expect('submit' in first && first.submit).toBeFalsy()
    const asked = page([MOVING], { opened: OPEN, confirm: 'remote:move-close:vps:web' }).replace(
      /\s+/g,
      ' ',
    )
    expect(asked).toContain('Press again to close it here')
    expect(asked).toContain(CLOSE_AFTER_MOVE.slice(0, 40))
    expect(remoteChoice(panelFor('remotes'), 'remote:move-open:vps:docs')).toMatchObject({
      submit: true,
      choice: 'remote:move-open:vps:docs',
    })
  })

  it('folds the Move rows under one line per machine, a row only for what that machine holds, opened on a press', () => {
    // Shut: one line saying how many it holds, and the press that opens it.
    const shut = page([MOVING]).replace(/ +/g, ' ')
    expect(shut).toContain('Move projects 2 of 4 here are on vps')
    expect(shut).toContain('Show')
    expect(shut).not.toContain('Move app')
    expect(shut).not.toContain('Not there yet')
    const walked = (panel: ReturnType<typeof panelFor>) =>
      remotePresses(remoteActions([MOVING]), panel).map((one) => one.id)
    expect(walked(panelFor('remotes'))).toEqual(['remote:fold:vps:moves', 'remote:again:vps'])

    // A press opens it, and the keyboard walks what it opened.
    const pressed = settingsKey(panelFor('remotes', { focus: 'form', row: 0 }), 'enter', '\r', {
      remoteActions: remoteActions([MOVING]),
    })
    expect('submit' in pressed && pressed.submit).toBeFalsy()
    const opened = pressed.panel as ReturnType<typeof panelFor>
    expect(opened.opened).toEqual(['remote:fold:vps:moves'])
    const moves = page([MOVING], { opened: opened.opened }).replace(/ +/g, ' ')
    expect(moves).toContain('Hide')
    expect(moves).toContain('Move app on vps as tade · 1 running here')
    expect(moves).toContain('Move web on vps as web · nothing of it is working here')
    // The projects it does not hold are one line, not a row each.
    expect(moves).toContain('Not there yet docs, shop')
    expect(moves).toContain('Open one there…')
    expect(moves).not.toContain('Move docs')
    expect(moves).not.toContain('Open it on vps')
    expect(walked(opened)).toEqual([
      'remote:fold:vps:moves',
      'remote:move-hand:vps:app',
      'remote:move-close:vps:web',
      'remote:fold:vps:not-there',
      'remote:again:vps',
    ])
    const down = settingsKey({ ...opened, row: 4 }, 'down', '', {
      remoteActions: remoteActions([MOVING]),
    }).panel as ReturnType<typeof panelFor>
    expect(down.row).toBe(4)

    // And shut again by the same press, which nothing outside the page hears of.
    const again = remoteChoice(opened, 'remote:fold:vps:moves')
    expect('submit' in again && again.submit).toBeFalsy()
    expect((again.panel as ReturnType<typeof panelFor>).opened).toEqual([])

    // Shut outside, what is open inside it is neither drawn nor walked.
    const inner = panelFor('remotes', { opened: ['remote:fold:vps:not-there'] })
    expect(walked(inner)).toEqual(['remote:fold:vps:moves', 'remote:again:vps'])

    // A machine holding none of them says so, and has nothing else to fold.
    const none: RemoteShown = {
      ...MOVING,
      moves: [{ project: 'docs', there: false, said: 'not on vps yet', next: 'open' }],
    }
    expect(page([none]).replace(/ +/g, ' ')).toContain('Move projects none of 1 here is on vps')
    // And one with no projects here has no line at all.
    expect(page([{ ...MOVING, moves: [] }])).not.toContain('Move projects')
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

  it('says the whole of each sentence asked between two presses, the way out at its end included, at every width', () => {
    const asked = [
      { sentence: KEYS_TO_REMOTE, remote: VPS, confirm: 'remote:keys:vps' },
      {
        sentence: TALK_TO_REMOTE,
        remote: { ...VPS, list: { ...LIST, talk: 'off' as const } },
        confirm: 'remote:talk:vps',
      },
      { sentence: CLOSE_AFTER_MOVE, remote: MOVING, confirm: 'remote:move-close:vps:web' },
    ]
    for (const { sentence, remote, confirm } of asked) {
      for (const width of WIDTHS) {
        const said = form(remote, width, { confirm, opened: OPEN })
        // Every character of it, in order: at the narrowest a word longer than
        // the column is broken across two rows, which is where it wrapped and
        // not what it says.
        expect(said.replace(/\s+/g, ''), `${confirm} at ${width}`).toContain(
          sentence.replace(/\s+/g, ''),
        )
      }
    }
  })

  it('stacks a label over what it says where there is no room beside it, and runs nothing past the edge', () => {
    const off: RemoteShown = { ...VPS, list: { ...LIST, talk: 'off' } }
    for (const width of WIDTHS) {
      const rows = formRows(off, width, { confirm: 'remote:talk:vps' })
      // Whatever the width, a label never runs into what it says.
      const said = rows.join('\n').replace(/ +/g, ' ')
      expect(said, `at ${width}`).not.toMatch(/…[a-z]/)
      // And every row stops short of the form's last column, so nothing is cut at its edge.
      for (const row of rows)
        expect(row.trimEnd().length, `${row} at ${width}`).toBeLessThan(row.length)
    }
    // From the narrowest width with room for its whole label, the label stands whole.
    for (const width of WIDTHS.filter((one) => one >= 48)) {
      const said = formRows(off, width, {}).join(' ').replace(/\s+/g, ' ')
      expect(said, `at ${width}`).toContain('Talk to Tade off there:')
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

  it('draws the records its public name needs as of its own look, whole, with a press that looks again', () => {
    const records = {
      at: NOW - 60_000,
      name: 'tade.example.com',
      head: 'tade.example.com, in the zone example.com, answered for by ns1.dns.example',
      lines: [
        {
          record: 'A' as const,
          state: 'right' as const,
          said: 'A: tade.example.com → 203.0.113.7, this machine',
          add: null,
          remove: [],
          loud: false,
        },
        {
          record: 'CAA' as const,
          state: 'missing' as const,
          said: 'CAA: none, so any CA may issue for it',
          add: 'tade.example.com. CAA 0 issue "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/2104831; validationmethods=tls-alpn-01,http-01"',
          remove: [],
          loud: true,
        },
      ],
      cannot: null,
    }
    const machine = vpsMachine({ detail: { ...vpsMachine().detail, records } })
    const drawn = at([{ ...VPS, machine }])
    expect(drawn).toContain('Records as of 2026-10-17 14:09')
    expect(drawn).toContain('✓ A: tade.example.com → 203.0.113.7, this machine')
    expect(drawn).toContain('▲ CAA: none, so any CA may issue for it')
    // A record to type in at a registrar is never cut: every character of it, in order,
    // read down the page's own column.
    const column = drawn
      .split('\n')
      .map((row) => row.split('│')[2] ?? '')
      .join('')
      .replace(/[\s▕█]/g, '')
    expect(column).toContain(`add ${records.lines[1]?.add}`.replace(/\s/g, ''))
    expect(remoteActions([{ ...VPS, machine }]).map((one) => one.id)).toContain(
      'remote:records:vps',
    )
    expect(drawn).toContain('Look again')
  })

  it('says it is looking, why there are none, and offers no look where it has no public name or no link', () => {
    const looking = vpsMachine({ detail: { ...vpsMachine().detail, recordsLooking: true } })
    expect(at([{ ...VPS, machine: looking }])).toContain('Records looking at them on vps…')
    expect(
      remoteActions([{ ...VPS, machine: looking }]).find((one) => one.id === 'remote:records:vps')
        ?.label,
    ).toBe('Looking…')
    const failed = vpsMachine({
      detail: {
        ...vpsMachine().detail,
        recordsSaid: 'vps answered 500 when asked to look at its records',
      },
    })
    expect(at([{ ...VPS, machine: failed }])).toContain(
      'vps answered 500 when asked to look at its records',
    )
    const nameless = vpsMachine()
    const none = {
      ...nameless,
      detail: { ...nameless.detail, about: { ...nameless.detail.about!, public: null } },
    }
    expect(at([{ ...VPS, machine: none }])).not.toContain('Records')
    expect(remoteActions([{ ...VPS, machine: none }]).map((one) => one.id)).not.toContain(
      'remote:records:vps',
    )
    expect(
      remoteActions([{ ...VPS, live: false, machine: vpsMachine() }]).map((one) => one.id),
    ).not.toContain('remote:records:vps')
  })
})
