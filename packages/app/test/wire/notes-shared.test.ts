import { GRANTS, SCOPES, digestOf as secretDigest, writeDevices } from '@tade/web'
import { Memory } from '@tade/workbench/memory'
import { answerNotes, type NotesAsk } from '@tade/workbench/notes-shared'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { SharedNotes, type SharedNotesDeps } from '../../src/wire/notes-shared.ts'
import { closeAll, DEVICE, machine, SECRET, shared, waitFor } from './away-harness.ts'

// The person's notes shared with another machine, from the window that holds
// the link (`wire/notes-shared.ts`): end to end into a real far window — its
// listener, an owner's session, its workbench's own memory and journal — and
// then when it shares by itself: a link come up, this home's file moved, what
// the remote's projection says of its notes moved, and every ten minutes.

afterEach(closeAll)

const NOW = Date.parse('2026-10-17T09:00:00Z')

/** An owner device in the far home's file, as `tade web pair --owner` writes one. */
async function owner(home: string, port: number): Promise<void> {
  await writeDevices(home, [
    {
      kind: 'paired',
      device: DEVICE,
      at: new Date().toISOString(),
      label: 'mac',
      digest: secretDigest(SECRET),
      host: `127.0.0.1:${port}`,
      csrf: 'x'.repeat(43),
      until: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: [...SCOPES],
      projects: null,
      granted: [...GRANTS],
      from: '',
      owner: true,
    },
  ])
}

type Line = Parameters<SharedNotesDeps['log']>[0]

describe('sharing notes with a real far window', () => {
  it('leaves both homes holding both, each saying where, and both journals saying how many', async () => {
    const far = await machine()
    await owner(far.home, far.port)
    await far.away.open()
    far.client.remember('the nightly runs at two', 'vps/nightly', 'orchestrator')
    const near = Memory.open(tmp('tade-near-'))
    near.remember('deploys freeze on Fridays', null, 'voice', NOW)
    const logged: Line[] = []
    const notes = new SharedNotes({
      memory: () => near,
      reach: () => ({
        link: {
          request: (_name: string, _path: string, body: unknown) =>
            shared(far.port, body as Record<string, unknown>),
        } as never,
        remote: {} as never,
        live: true,
      }),
      from: () => 'mac',
      log: async (line) => {
        logged.push(line)
      },
      say: (said) => {
        throw new Error(`nothing should be said: ${said}`)
      },
      now: () => NOW,
    })

    expect(await notes.share('vps')).toMatchObject({ took: 1, gave: 1, left: 0 })
    expect(Object.fromEntries(near.all().map((n) => [n.text, n.from ?? null]))).toEqual({
      'the nightly runs at two': 'vps',
      'deploys freeze on Fridays': null,
    })
    // The far window's own memory: what its agents and orchestrator are told from now on.
    const there = far.client.recallAll().find((n) => n.text === 'deploys freeze on Fridays')
    expect(there?.from).toBe('mac')
    expect((await waitFor(far.client, 'notes_shared'))[0]?.detail).toEqual({
      with: 'mac',
      took: 1,
      refused: 0,
      device: DEVICE,
    })
    expect(logged).toEqual([
      { type: 'notes_shared', detail: { with: 'vps', took: 1, notes: 1, gave: 1, refused: 0 } },
    ])
    // Never a note's words in either journal.
    expect(JSON.stringify(await far.client.events({ types: ['notes_shared'] }))).not.toContain(
      'Fridays',
    )

    // The same again moves nothing, and nothing more is written down.
    expect(await notes.share('vps')).toMatchObject({ same: true })
    expect(logged).toHaveLength(1)
  })
})

/** A window sharing with `vps`, answered in-process by a far home of its own. */
function sharing(over: { status?: number } = {}) {
  const near = Memory.open(tmp('tade-near-'))
  const far = Memory.open(tmp('tade-far-'))
  const state = { now: NOW, live: true, notes: [] as string[] }
  const asked: NotesAsk[] = []
  const said: string[] = []
  const notes = new SharedNotes({
    memory: () => near,
    reach: () => ({
      link: {
        request: async (_name: string, _path: string, body: unknown) => {
          const ask = JSON.parse(JSON.stringify(body)) as NotesAsk
          asked.push(ask)
          if (over.status !== undefined) return { status: over.status, body: { error: 'no_such' } }
          const answer = answerNotes(far, ask, ask.from, 'vps', state.now)
          return { status: 200, body: JSON.parse(JSON.stringify(answer)) }
        },
      } as never,
      remote: {} as never,
      live: state.live,
    }),
    from: () => 'mac',
    log: async () => {},
    say: (one) => said.push(one),
    now: () => state.now,
  })
  /** What the remote's projection says of its notes, as `Remotes` hands it over on every move. */
  const projected = () =>
    notes.moved('vps', {
      projection: { notes: state.notes.map((id) => ({ id })) },
    } as never)
  /** Looks asked: the first request of each exchange is the one that carries a sum. */
  const looks = () => asked.filter((one) => one.sum !== undefined).length
  return { near, far, state, notes, said, projected, looks }
}

describe('when a window shares by itself', () => {
  it('shares with a linked remote at once, then not again until something moves or ten minutes pass', async () => {
    const { notes, state, looks } = sharing()
    await notes.beat(['vps'])
    expect(looks()).toBe(1)
    await notes.beat(['vps'])
    expect(looks()).toBe(1)
    state.now += 10 * 60_000
    await notes.beat(['vps'])
    expect(looks()).toBe(2)
  })

  it('shares nothing with a remote whose link is not up', async () => {
    const { notes, state, looks } = sharing()
    state.live = false
    await notes.beat(['vps'])
    expect(looks()).toBe(0)
  })

  it('shares when a link comes up again, and when what the remote says of its notes moved', async () => {
    const { notes, projected, state, looks } = sharing()
    state.notes = ['a#0']
    projected()
    await notes.beat(['vps'])
    notes.up('vps')
    await notes.beat(['vps'])
    expect(looks()).toBe(2)
    // The same notes, told again with everything else that moved, owe nothing.
    projected()
    await notes.beat(['vps'])
    expect(looks()).toBe(2)
    state.notes = ['a#0', 'b#0']
    projected()
    await notes.beat(['vps'])
    expect(looks()).toBe(3)
  })

  it('shares when this home’s notes moved — from a shell, or from another machine', async () => {
    const { near, far, notes, looks } = sharing()
    await notes.beat(['vps'])
    expect(looks()).toBe(1)
    near.remember('taken here, from a shell', null, 'cli', NOW)
    // The look that sees it is the beat's, and the share it owes is the next one's.
    await notes.beat(['vps'])
    await notes.beat(['vps'])
    expect(looks()).toBe(2)
    expect(far.all().map((n) => n.text)).toEqual(['taken here, from a shell'])
  })

  it('says once that a remote would not share, for as long as it is the same trouble', async () => {
    const { notes, state, said } = sharing({ status: 404 })
    await notes.beat(['vps'])
    state.now += 10 * 60_000
    await notes.beat(['vps'])
    expect(said).toEqual([
      "Notes are not shared with vps: vps's Tade does not share notes: it is older than this one, or its window is not open there — update it, or open it",
    ])
  })
})
