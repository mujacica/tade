import { request } from 'node:http'
import type { HistoryAsk, HistoryItem, HistoryPage } from '@tade/harnesses-core'
import { ChatPageSchema, SnapshotSchema, TurnsPageSchema } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { type Entry, emptyTranscript, type Transcript } from '../../src/transcript.ts'
import { COOKIE, closeAll, machine, paired } from './away-harness.ts'

// A conversation read back to its beginning from away: everything said in
// Tade's conversation and on an agent's page can be read on the phone, with
// nothing only in the window.
//
// **Real listener, real workbench, real device list, the window's own
// scrollback** (`Earlier`); what stands in is the two records, Tade's and an
// agent's, because what is under test is that a page asking further back than
// it holds is answered out of them, and what of them leaves the machine.

afterEach(closeAll)

/** One `GET`, with everything the guard asks of a read on it. */
function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, cookie: COOKIE, 'sec-fetch-site': 'same-origin' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          done({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          })
        })
      },
    )
    req.on('error', failed)
    req.end()
  })
}

const AT = Date.parse('2026-10-08T14:00:00.000Z')

/** The newest 150 lines the window holds, with more in the record before them. */
function held(): Transcript {
  const entries: Entry[] = Array.from({ length: 150 }, (_, n) => ({
    kind: 'said',
    text: `held ${n}`,
    streaming: false,
    by: 'orchestrator',
    at: AT + (60 + n) * 1000,
  }))
  return { ...emptyTranscript(), entries, earlier: { cursor: '4096', asking: false } }
}

/** The orchestrator's record before what is held: sixty replies, and its beginning. */
function record(asked: (string | null)[]): (ask: HistoryAsk) => Promise<HistoryPage> {
  return async (ask) => {
    asked.push(ask.before ?? null)
    const items: HistoryItem[] = Array.from({ length: 60 }, (_, n) => ({
      kind: 'reply',
      text: `from the record ${n}`,
      at: AT + n * 1000,
    }))
    return { items, earlier: null }
  }
}

describe('the conversation with Tade, further back than a page holds', () => {
  it('is read out of the record the window reads its own scrollback from, to its first line', async () => {
    const asked: (string | null)[] = []
    const one = await machine({ talking: true, transcript: held(), history: record(asked) })
    await paired(one.home, one.port, ['read'], ['talk'])
    await one.away.open()

    const snapshot = SnapshotSchema.parse((await get(one.port, '/api/snapshot')).body)
    // The newest stretch, and the snapshot says there is more before it.
    expect(snapshot.chat).toHaveLength(120)
    expect(snapshot.you.talk?.earlier).toBe(true)
    expect(snapshot.pages.chat.omitted).toBe(30)

    const oldest = snapshot.chat[0]?.id ?? ''
    const page = ChatPageSchema.parse(
      (await get(one.port, `/api/chat?before=${encodeURIComponent(oldest)}`)).body,
    )
    // The thirty the snapshot left out and the sixty the record held: every
    // line before the oldest one the page had, oldest first.
    expect(page.rows.map((row) => row.text?.words)).toEqual([
      ...Array.from({ length: 60 }, (_, n) => `from the record ${n}`),
      ...Array.from({ length: 30 }, (_, n) => `held ${n}`),
    ])
    expect(page).toMatchObject({ earlier: false, why: null })
    expect(asked).toEqual(['4096'])
    // Read into the window's own conversation, so it is the window's too.
    expect(one.transcript().entries).toHaveLength(210)
    expect(one.transcript().earlier).toBeNull()

    // At the beginning, asking again reads nothing more.
    const first = page.rows[0]?.id ?? ''
    const none = ChatPageSchema.parse(
      (await get(one.port, `/api/chat?before=${encodeURIComponent(first)}`)).body,
    )
    expect(none).toMatchObject({ rows: [], earlier: false, why: null })
    expect(asked).toEqual(['4096'])
  })

  it('reads nothing out of the record for a device not granted the conversation', async () => {
    const asked: (string | null)[] = []
    const one = await machine({ talking: true, transcript: held(), history: record(asked) })
    await paired(one.home, one.port, ['read'], [])
    await one.away.open()
    const page = ChatPageSchema.parse(
      (await get(one.port, `/api/chat?before=${encodeURIComponent('2026-10-08T14:01:00.000Z#0')}`))
        .body,
    )
    expect(page).toMatchObject({ rows: [], why: 'not granted' })
    expect(asked).toEqual([])
    expect(one.transcript().entries).toHaveLength(150)
  })
})

describe('an agent’s conversation, further back than its page holds', () => {
  it('pages back through its record by the cursor its newest page gave, its paths shortened as Tade’s are', async () => {
    const asked: (string | null)[] = []
    let root = ''
    const one = await machine({
      agentHistory: async (_task, ask) => {
        asked.push(ask.before ?? null)
        if (ask.before === '2048') {
          return {
            items: [
              { kind: 'sent', text: 'Fix the migration.', images: [], at: AT },
              {
                kind: 'tool',
                id: 'toolu_read',
                tool: 'Read',
                input: { file_path: `${root}/db/NAMES.md` },
                ok: true,
                result: 'names',
                at: AT + 1000,
              },
            ],
            earlier: null,
          }
        }
        return {
          items: [{ kind: 'reply', text: 'Done.', at: AT + 9000 }],
          earlier: '2048',
        }
      },
    })
    root = one.root
    one.running(one.task)
    await paired(one.home, one.port, ['read'], ['lanes'])
    await one.away.open()
    // Asking is looking: the newest page is read on the beat after.
    await get(one.port, `/api/agent/${one.task}`)
    one.away.beat()
    let answer: Record<string, unknown> = {}
    for (let tries = 0; tries < 50; tries += 1) {
      answer = (await get(one.port, `/api/agent/${one.task}`)).body as Record<string, unknown>
      if ((answer.conversation as { turns?: unknown[] } | null)?.turns?.length) break
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(answer.conversation).toMatchObject({ before: '2048' })

    const page = TurnsPageSchema.parse(
      (await get(one.port, `/api/agent/${one.task}/earlier?before=2048`)).body,
    )
    expect(page).toMatchObject({ before: null, why: null })
    expect(page.turns.map((turn) => turn.kind)).toEqual(['sent', 'tool'])
    expect(asked.at(-1)).toBe('2048')
    // Where the task works is `.`, as an approval's command and Tade's own
    // conversation say it — never a name behind `…/` alone.
    expect(page.turns[1]?.call?.brief).toBe('./db/NAMES.md')
  })
})
