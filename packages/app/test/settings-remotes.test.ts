import { KEYS_TO_REMOTE, TALK_TO_REMOTE } from '@tade/core'
import type { Checklist } from '@tade/workbench/carry'
import { describe, expect, it } from 'vitest'
import { type RemoteShown, remoteActions, remoteChoice } from '../src/panels/settings/remotes.ts'
import { settingsKey } from '../src/panels/settings/state.ts'
import { drawnAt, panelFor, plainRows } from './settings-panel.ts'

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
}

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
