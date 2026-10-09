import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type Schedule } from '@tade/core'
import type { ExtensionHost, Finding } from '@tade/extensions-core'
import { Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { sayBackFor } from '../../src/wire/intake-reply.ts'

// Telling a source its request was taken in — which, with the grant off, is
// telling nobody anything, and that is the case this file is mostly about.

const schedule: Schedule = {
  id: 'intake-cli',
  name: 'intake cli',
  project: 'app',
  said: '',
  when: { every: '5m' },
  does: { kind: 'watch', watch: 'intake.cli', input: {}, found: 'agent', most: 1 },
  missed: 'skip',
  by: 'you',
  created: '2026-10-01T08:00:00.000Z',
}

const finding = (): Finding => ({
  key: 'cli:req-1:1',
  title: 'cli req-1',
  intake: {
    source: 'cli',
    externalId: 'req-1',
    revision: '1',
    url: '',
    requester: { id: 'kim', label: '', bot: false },
    from: 'app',
    verbatim: 'the export button 500s',
    material: { ref: 'req-1.0001.json', hash: 'sha256:aaa' },
    attachments: [],
    sourceAt: '',
    seenAt: '',
    correlation: 'req-1-1',
  },
})

describe('saying a status back to a source', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench
  let posted: { key: string; say: string }[]

  const host = (
    over: { reply?: (id: string, req: Record<string, unknown>) => Promise<void> } = {},
  ) =>
    ({
      reply:
        over.reply ??
        (async (_id, req) => {
          posted.push({ key: String(req.key), say: String(req.say) })
        }),
    }) as unknown as ExtensionHost

  const open = async (grant: string[]): Promise<void> => {
    await client?.close().catch(() => {})
    writeFileSync(
      join(home, 'config.yaml'),
      `${[
        'projects:',
        '  app:',
        `    root: ${repo.root}`,
        'surfaces:',
        '  intake:',
        '    enabled: true',
        '    sources:',
        '      cli:',
        '        accept: true',
        '        projects: [app]',
        '        from: [kim]',
        ...grant.map((line) => `        ${line}`),
      ].join('\n')}\n`,
    )
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
  }

  const say = (one: { host?: ExtensionHost | null; found?: Finding } = {}) =>
    sayBackFor({
      client,
      config: client.config,
      host: one.host === undefined ? host() : one.host,
      now: Date.now(),
      schedule,
      watch: 'intake.cli',
      finding: one.found ?? finding(),
      task: 'app/cli-req-1',
    })

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-say-back-')
    posted = []
    await open([])
  })

  afterEach(async () => {
    await client?.close().catch(() => {})
  })

  it('posts nothing, and says nothing about it, while the grant is off', async () => {
    // The ordinary case, and it must be silent: a line every look about a
    // capability nobody turned on is noise that teaches people to ignore lines.
    expect(await say()).toBeNull()
    expect(posted).toEqual([])
  })

  it('posts one of Tade’s own sentences once the owner grants it', async () => {
    await open(['reply: true'])
    expect(await say()).toBeNull()
    expect(posted).toHaveLength(1)
    // `propose` is the mode, so what the source is told is that it is waiting
    // for a person — never that it is running.
    expect(posted[0]?.say).toContain('Waiting for a person')
    expect(posted[0]?.say).not.toContain('export button')
    expect(posted[0]?.key).toBe('cli:req-1:1')
  })

  it('says it is queued where the owner granted the queue that source', async () => {
    await open(['reply: true', 'mode: queue'])
    expect(await say()).toBeNull()
    expect(posted[0]?.say).toContain('Queued as app/cli-req-1')
  })

  it('says why a reply could not go out, rather than swallowing it', async () => {
    await open(['reply: true'])
    const quiet = await say({
      host: host({
        reply: async () => {
          throw new Error('intake.cli has no way of saying anything back to its source')
        },
      }),
    })
    expect(quiet).toContain('no way of saying anything back')
  })

  it('does nothing at all for a finding that is not intake, or with no extensions', async () => {
    await open(['reply: true'])
    expect(await say({ found: { key: 'TADE-1', title: 'an error' } })).toBeNull()
    expect(await say({ host: null })).toBeNull()
    expect(posted).toEqual([])
  })
})
