import type { RemoteConfig, TadeEvent } from '@tade/core'
import { heldFor, lost } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { lineFor, linkOf, linksSeen, REMOTE_LINKS, remoteOf, wordOf } from '../src/remotes.ts'

// The registry, and what the journal says about links: written on a change of
// word and never on a redial, and folded back by `tade remote status`.

const CONFIG: RemoteConfig = {
  ssh: 'vps',
  tade: 'tade',
  device: 'ab12cd34',
  session: 'ab12cd34.secret',
  csrf: 'token',
  host: 'localhost:7654',
}

function line(seq: number, type: string, detail: Record<string, string>): TadeEvent {
  return {
    seq,
    ts: `2026-10-17T0${seq}:00:00.000Z`,
    type,
    urgency: 'routine',
    task: null,
    lane: null,
    run: null,
    detail,
  } as TadeEvent
}

describe('the remote links there are', () => {
  it('reaches every configured remote over ssh, and registers a scripted one for nobody', () => {
    expect(Object.keys(REMOTE_LINKS).sort()).toEqual(['scripted', 'ssh'])
    expect(linkOf(CONFIG)).toBe('ssh')
    for (const [name, make] of Object.entries(REMOTE_LINKS))
      expect(make({ home: '/h' }).id).toBe(name)
  })

  it('tells a link the block as a remote, the session under its own names', () => {
    expect(remoteOf('vps', CONFIG)).toEqual({
      name: 'vps',
      address: 'vps',
      tade: 'tade',
      session: {
        device: 'ab12cd34',
        cookie: 'ab12cd34.secret',
        csrf: 'token',
        host: 'localhost:7654',
      },
    })
  })
})

describe('what the journal is told', () => {
  it('has a word for up, down and ended, and none for in between', () => {
    const idle = heldFor('vps')
    expect(wordOf(idle)).toBeNull()
    expect(wordOf({ ...idle, link: { kind: 'dialling', since: 1, tries: 0 } })).toBeNull()
    // Live, but nothing held yet: the status line came before the snapshot.
    expect(wordOf({ ...idle, link: { kind: 'live', since: 1 } })).toBeNull()
    expect(
      wordOf({ ...idle, link: { kind: 'live', since: 1 }, cursor: { epoch: 'e', rev: 1 } }),
    ).toBe('up')
    expect(wordOf(lost(idle, 'timed out', 'quiet', 1))).toBe('down')
    expect(wordOf({ ...idle, link: { kind: 'ended', since: 1, said: 'signed out' } })).toBe('ended')
  })

  it('writes what a person would ask about: which remote, its epoch, or why', () => {
    const up = {
      ...heldFor('vps'),
      link: { kind: 'live' as const, since: 1 },
      cursor: { epoch: 'e1', rev: 4 },
    }
    expect(lineFor(up, 'up')).toEqual({
      type: 'remote_linked',
      detail: { remote: 'vps', epoch: 'e1' },
    })
    expect(lineFor(lost(up, 'timed out', 'its stream went quiet', 2), 'down')).toEqual({
      type: 'remote_unlinked',
      detail: { remote: 'vps', state: 'down', problem: 'timed out', said: 'its stream went quiet' },
    })
    const over = { ...up, link: { kind: 'ended' as const, since: 3, said: 'signed out there' } }
    expect(lineFor(over, 'ended').detail).toEqual({
      remote: 'vps',
      state: 'ended',
      said: 'signed out there',
    })
  })

  it('writes what the remote said as text, since a shell prints it', () => {
    const up = {
      ...heldFor('vps'),
      link: { kind: 'live' as const, since: 1 },
      cursor: { epoch: 'e1\x1b]0;pwned\x07', rev: 4 },
    }
    expect(lineFor(up, 'up').detail.epoch).toBe('e1␛')
    const said = 'refused\x1b[2J\u009b6n by the remote'
    expect(lineFor(lost(up, 'failed', said, 2), 'down').detail.said).toBe('refused␛ by the remote')
    const over = { ...up, link: { kind: 'ended' as const, since: 3, said } }
    expect(lineFor(over, 'ended').detail.said).toBe('refused␛ by the remote')
  })

  it('folds the newest word per remote back out of the journal', () => {
    const seen = linksSeen([
      line(1, 'remote_linked', { remote: 'vps', epoch: 'e1' }),
      line(2, 'remote_unlinked', {
        remote: 'vps',
        state: 'down',
        problem: 'failed',
        said: 'nothing answers',
      }),
      line(3, 'remote_linked', { remote: 'box', epoch: 'e2' }),
      line(4, 'warning', { message: 'unrelated' }),
      line(5, 'remote_unlinked', { remote: 'box', state: 'ended', said: 'signed out' }),
      line(6, 'remote_linked', { epoch: 'no remote named' }),
    ])
    expect([...seen.keys()].sort()).toEqual(['box', 'vps'])
    expect(seen.get('vps')).toEqual({
      word: 'down',
      at: '2026-10-17T02:00:00.000Z',
      said: 'nothing answers',
      problem: 'failed',
    })
    expect(seen.get('box')?.word).toBe('ended')
  })
})
