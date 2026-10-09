import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { intakeSpool, newFindings } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { extensionConformance } from '@tade/extensions-core/conformance'
import { beforeEach, describe, expect, it } from 'vitest'
import { intakeExtension } from '../src/extension.ts'
import { bodyHash, newestOf, readReplies, readSpool, spool, spoolIdProblem } from '../src/spool.ts'

// The local intake door, against a real folder.
//
// Nothing here is mocked and nothing here reaches the network, which is the
// point of this source existing: the look, the re-check and the reply are the
// real ones, and what they read is a folder a person could have written by
// hand.

function home(): string {
  return mkdtempSync(join(tmpdir(), 'tade-intake-'))
}

async function host(root: string, where: string) {
  return ExtensionHost.load({
    builtin: [intakeExtension],
    config: { extensions: {}, projects: { app: { root } } },
    home: where,
    env: {},
    fetch: async () => {
      throw new Error('the intake door reached the network')
    },
  })
}

extensionConformance(() => intakeExtension, { project: mkdtempSync(join(tmpdir(), 'tade-conf-')) })

describe('the spool', () => {
  let where: string

  beforeEach(() => {
    where = home()
  })

  it('writes one file per revision, and never edits one', async () => {
    const first = await spool(where, {
      id: 'req-1',
      project: 'app',
      requester: { id: 'kim', label: '', bot: false },
      body: 'the export 500s',
      url: '',
      attachments: [],
      closed: false,
    })
    const second = await spool(where, {
      id: 'req-1',
      project: 'app',
      requester: { id: 'kim', label: '', bot: false },
      body: 'the export 500s when the selection is empty',
      url: '',
      attachments: [],
      closed: false,
    })
    expect(first.entry.revision).toBe(1)
    expect(second.entry.revision).toBe(2)
    expect(first.file).not.toBe(second.file)
    const read = await readSpool(where)
    // Both are still there: the first revision is the immutable record of what
    // the text was when a task may have been made from it.
    expect(read.entries.map((one) => one.revision)).toEqual([1, 2])
    expect(bodyHash(read.entries[0]?.body ?? '')).not.toBe(bodyHash(read.entries[1]?.body ?? ''))
  })

  it('names a file it could not read rather than passing over it', async () => {
    await spool(where, {
      id: 'req-1',
      project: 'app',
      requester: { id: 'kim', label: '', bot: false },
      body: 'a',
      url: '',
      attachments: [],
      closed: false,
    })
    writeFileSync(join(intakeSpool(where), 'hand-edited.json'), '{ not json')
    const read = await readSpool(where)
    expect(read.entries).toHaveLength(1)
    expect(read.broken.map((one) => one.file)).toEqual(['hand-edited.json'])
  })

  it('refuses an id that would reach outside the spool', () => {
    expect(spoolIdProblem('../../etc/passwd')).toContain('not a usable request id')
    expect(spoolIdProblem('ok-1')).toBeNull()
  })

  it('takes the newest revision by number, not by the way a string sorts', () => {
    const at = '2026-10-09T00:00:00.000Z'
    const one = (revision: number) => ({
      id: 'req-1',
      revision,
      project: 'app',
      requester: { id: 'kim', label: '', bot: false },
      body: '',
      url: '',
      attachments: [],
      closed: false,
      at,
      correlation: `req-1-${revision}`,
      file: `req-1.${revision}.json`,
    })
    expect(newestOf([one(9), one(10)]).get('req-1')?.revision).toBe(10)
    expect(newestOf([one(10), one(9)]).get('req-1')?.revision).toBe(10)
  })
})

describe('the look', () => {
  let where: string

  beforeEach(() => {
    where = home()
  })

  const write = (over: Record<string, unknown> = {}) =>
    spool(where, {
      id: 'req-1',
      project: 'app',
      requester: { id: 'kim', label: 'Kim', bot: false },
      body: 'the export button 500s when the selection is empty',
      url: 'https://example.invalid/req-1',
      attachments: [],
      closed: false,
      ...over,
    } as never)

  it('finds a request for its own project, with the envelope on it', async () => {
    await write()
    const looked = await (await host(where, where)).look('intake.cli', {
      project: 'app',
      input: {},
      since: null,
      turnedOn: new Date(0).toISOString(),
    })
    expect(looked.found).toHaveLength(1)
    const [found] = looked.found
    expect(found?.key).toBe('cli:req-1:1')
    expect(found?.intake).toMatchObject({
      source: 'cli',
      externalId: 'req-1',
      from: 'app',
      verbatim: 'the export button 500s when the selection is empty',
    })
    // It carries no grant and no template: there is no field in which a
    // connector could ask for either.
    expect(found?.intake && 'grant' in found.intake).toBe(false)
    expect(found?.intake && 'template' in found.intake).toBe(false)
  })

  it('tells an agent nothing of the body, in either of the two things it says', async () => {
    await write()
    const looked = await (await host(where, where)).look('intake.cli', {
      project: 'app',
      input: {},
      since: null,
      turnedOn: new Date(0).toISOString(),
    })
    const agent = await looked.agent(looked.found[0] as never)
    expect(agent.prompt).not.toContain('export button')
    expect(agent.title).not.toContain('export button')
    expect(agent.prompt).toContain('req-1')
  })

  it('finds nothing for a project nothing was written for, and says so', async () => {
    await write({ project: 'other' })
    const looked = await (await host(where, where)).look('intake.cli', {
      project: 'app',
      input: {},
      since: null,
      turnedOn: new Date(0).toISOString(),
    })
    expect(looked.found).toEqual([])
    expect(looked.said).toContain('nothing in the intake spool')
  })

  it('finds only the newest revision, so one edit is not two findings', async () => {
    await write()
    await write()
    const looked = await (await host(where, where)).look('intake.cli', {
      project: 'app',
      input: {},
      since: null,
      turnedOn: new Date(0).toISOString(),
    })
    expect(looked.found.map((one) => one.key)).toEqual(['cli:req-1:2'])
  })

  it('keeps looking with no network, because this door reaches nothing', async () => {
    // Declared, never sniffed, and the right answer for a local door: a watch
    // that said `network` would be held by the scheduler while the wifi is
    // off, and a request somebody typed at this machine is still there.
    const offer = (await host(where, where)).watches().find((one) => one.id === 'intake.cli')
    expect(offer?.network).toBe(false)
    expect(offer?.intake).toBe('cli')
    expect(offer?.rechecks).toBe(true)
  })

  it('finds a request written while nothing was looking, and finds it once', async () => {
    // Resume, and it is by key rather than by where the last look left off: a
    // look that returned no `since` finds everything there is, and Tade's own
    // record of what it has found is what keeps that from being work twice.
    await write()
    const loaded = await host(where, where)
    const look = {
      project: 'app',
      input: {},
      since: null,
      turnedOn: new Date(0).toISOString(),
    }
    const first = await loaded.look('intake.cli', look)
    expect(first.found.map((one) => one.key)).toEqual(['cli:req-1:1'])
    // The same look again, as a window opened an hour later would take it:
    // the same finding, with the same key, which `newFindings` then reads as
    // nothing new.
    const again = await loaded.look('intake.cli', { ...look, since: first.since })
    expect(again.found.map((one) => one.key)).toEqual(['cli:req-1:1'])
    expect(newFindings(again.found, new Set(first.found.map((one) => one.key)), 2)).toMatchObject({
      acting: [],
      left: 0,
    })
  })

  it('finds nothing once a request is withdrawn', async () => {
    await write()
    await write({ closed: true, body: '' })
    const looked = await (await host(where, where)).look('intake.cli', {
      project: 'app',
      input: {},
      since: null,
      turnedOn: new Date(0).toISOString(),
    })
    expect(looked.found).toEqual([])
  })
})

describe('asking again at the moment work would start', () => {
  let where: string

  beforeEach(() => {
    where = home()
  })

  const write = (over: Record<string, unknown> = {}) =>
    spool(where, {
      id: 'req-1',
      project: 'app',
      requester: { id: 'kim', label: '', bot: false },
      body: 'a request',
      url: '',
      attachments: [],
      closed: false,
      ...over,
    } as never)

  it('says a request still stands while it is the revision work was made for', async () => {
    await write()
    await expect(
      (await host(where, where)).recheck('intake.cli', {
        project: 'app',
        input: {},
        key: 'cli:req-1:1',
      }),
    ).resolves.toEqual({ still: true })
  })

  it('says it does not, with why, once it has been withdrawn', async () => {
    await write()
    await write({ closed: true, body: '' })
    const answer = await (await host(where, where)).recheck('intake.cli', {
      project: 'app',
      input: {},
      key: 'cli:req-1:1',
    })
    expect(answer.still).toBe(false)
    expect(answer.still === false && answer.because).toContain('withdrawn')
  })

  it('says it does not once the text has moved on to a newer revision', async () => {
    await write()
    await write({ body: 'a different request' })
    const answer = await (await host(where, where)).recheck('intake.cli', {
      project: 'app',
      input: {},
      key: 'cli:req-1:1',
    })
    expect(answer.still).toBe(false)
    expect(answer.still === false && answer.because).toContain('revision 2')
  })

  it('never says yes about something it has never heard of', async () => {
    const answer = await (await host(where, where)).recheck('intake.cli', {
      project: 'app',
      input: {},
      key: 'cli:nothing:1',
    })
    expect(answer.still).toBe(false)
  })
})

describe('saying something back', () => {
  const asked = (mark: string) => ({
    project: 'app',
    input: {},
    key: 'cli:req-1:1',
    say: 'Queued.',
    mark,
  })

  const written = async (where: string): Promise<void> => {
    await spool(where, {
      id: 'req-1',
      project: 'app',
      requester: { id: 'kim', label: '', bot: false },
      body: 'a request',
      url: '',
      attachments: [],
      closed: false,
    })
  }

  it('writes it beside the spool, and only ever the sentence it was handed', async () => {
    const where = home()
    await written(where)
    const receipt = await (await host(where, where)).reply(
      'intake.cli',
      asked('tade:cli:req-1:accepted'),
    )
    expect(receipt).toMatchObject({ posted: 'tade:cli:req-1:accepted' })
    // Nothing it was not handed: no revision, because writing a line beside
    // the spool moves no request's counter, and this door says so by not
    // claiming one.
    expect(receipt.revision).toBeUndefined()
    expect(await readReplies(where)).toEqual([
      expect.objectContaining({
        key: 'cli:req-1:1',
        mark: 'tade:cli:req-1:accepted',
        said: 'Queued.',
      }),
    ])
  })

  it('posts one status once, however many times the same marker is handed over', async () => {
    // **Crash after posting.** A window that died between the post and its
    // journal line comes back with the status due again and hands over the
    // same marker. One status at the source, and the second answer says the
    // source already had it — which is what the journal then records, rather
    // than a second comment somebody has to read.
    const where = home()
    await written(where)
    const loaded = await host(where, where)
    await loaded.reply('intake.cli', asked('tade:cli:req-1:accepted'))
    const again = await loaded.reply('intake.cli', asked('tade:cli:req-1:accepted'))
    expect(again.already).toBe(true)
    expect(await readReplies(where)).toHaveLength(1)
  })

  it('tells two statuses about one request apart, because the marker carries which', async () => {
    const where = home()
    await written(where)
    const loaded = await host(where, where)
    await loaded.reply('intake.cli', asked('tade:cli:req-1:accepted'))
    const next = await loaded.reply('intake.cli', {
      ...asked('tade:cli:req-1:finished'),
      say: 'Finished.',
    })
    expect(next.already).toBeUndefined()
    expect((await readReplies(where)).map((one) => one.said)).toEqual(['Queued.', 'Finished.'])
  })

  it('cannot read back a word it said: a status is not a request', async () => {
    // The loop closed by shape rather than by a filter. `replies.jsonl` is
    // not a `.json` file, so the look that reads the spool cannot see it —
    // and the bot check on a requester is the second line, not the first,
    // because a source Tade posts to as the signed-in person has no bot flag
    // to check.
    const where = home()
    await written(where)
    const loaded = await host(where, where)
    await loaded.reply('intake.cli', asked('tade:cli:req-1:accepted'))
    const read = await readSpool(where)
    expect(read.entries).toHaveLength(1)
    expect(read.broken).toEqual([])
    const looked = await loaded.look('intake.cli', {
      project: 'app',
      input: {},
      since: null,
      turnedOn: new Date(0).toISOString(),
    })
    expect(looked.found).toHaveLength(1)
    expect(looked.found[0]?.intake?.verbatim).toBe('a request')
  })
})
