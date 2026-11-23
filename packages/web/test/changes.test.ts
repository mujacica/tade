import { describe, expect, it } from 'vitest'
import {
  type ChangesIn,
  ChangesOutSchema,
  changesHere,
  hunksOf,
  type WebChanges,
} from '../src/changes.ts'
import { namesOnly, type Reach } from '../src/reach.ts'
import type { WebReading } from '../src/reading.ts'
import { ROUTES } from '../src/routes.ts'

// One agent's changes from away: the window's Show changes, on `lanes`.

const params = { project: 'tade', task: 'away-agent' }
const bare = namesOnly('00112233445566aa')
const seeing: Reach = { ...bare, granted: ['lanes'] }

function reading(here: boolean): (reach: Reach) => WebReading {
  return () => ({ agent: () => ({ here }) }) as unknown as WebReading
}

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' const kept = 1',
  "-const old = '/Users/someone/secret/place'",
  '+const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
  '',
].join('\n')

const ADDED = [
  'diff --git a/new.md b/new.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.md',
  '@@ -0,0 +1 @@',
  '+hello',
  '',
].join('\n')

function window(read: ChangesIn, asked: string[] = []): WebChanges {
  return {
    read: (task) => {
      asked.push(task)
      return Promise.resolve(read)
    },
    known: () => [],
  }
}

describe('an agent’s changes, from away', () => {
  it('is a route that reads and changes nothing', () => {
    const route = ROUTES.find((one) => one.name === 'agent changes')
    expect(route).toMatchObject({
      method: 'GET',
      path: '/api/agent/:project/:task/changes',
      needs: 'read',
      mutates: false,
    })
  })

  it('is every file and the whole of its diff from its first hunk, cleaned', async () => {
    const out = await changesHere(params, seeing, {
      readingFor: reading(true),
      changes: window({
        base: 'main',
        files: [
          { path: 'src/a.ts', mark: 'M', added: 1, removed: 1, text: DIFF },
          { path: 'new.md', mark: '?', added: 1, removed: 0, text: ADDED },
        ],
      }),
    })
    expect(ChangesOutSchema.parse(out)).toEqual(out)
    expect(out).toMatchObject({ says: 'files', base: 'main', task: 'tade/away-agent' })
    const [a, added] = out.files
    expect(a?.says).toBe('lines')
    // git's header is the page's to say, by the file's name: the text starts at the hunk.
    expect(a?.text?.startsWith('@@ -1,2 +1,2 @@')).toBe(true)
    expect(a?.text).toContain(' const kept = 1')
    // A machine path and a key are taken out at the boundary, and counted.
    expect(a?.text).not.toContain('/Users/someone')
    expect(a?.text).not.toContain('sk-ant-api03')
    expect(a?.taken).toBeGreaterThanOrEqual(2)
    // A new file's `--- /dev/null` never reaches the cleaning as a path to elide.
    expect(added?.text).toBe('@@ -0,0 +1 @@\n+hello\n')
  })

  it('says per file what git could not show, rather than dropping it', async () => {
    const out = await changesHere(params, seeing, {
      readingFor: reading(true),
      changes: window({
        base: null,
        files: [
          {
            path: 'logo.png',
            mark: 'M',
            added: null,
            removed: null,
            text: 'Binary files a and b differ\n',
          },
          { path: 'gone.ts', mark: 'M', added: 0, removed: 0, text: null },
          { path: 'slow.ts', mark: 'M', added: 3, removed: 0, text: 'unread' },
        ],
      }),
    })
    expect(out.files.map((one) => [one.path, one.says, one.text])).toEqual([
      ['logo.png', 'binary', null],
      ['gone.ts', 'nothing', null],
      ['slow.ts', 'unread', null],
    ])
  })

  it('tells nothing changed, not looked yet and could not be read apart', async () => {
    const at = (read: ChangesIn) =>
      changesHere(params, seeing, { readingFor: reading(true), changes: window(read) })
    expect((await at('none')).says).toBe('none')
    expect((await at({ base: 'main', files: [] })).says).toBe('none')
    expect((await at('not looked')).says).toBe('not looked')
    expect((await at('unread')).says).toBe('unread')
    expect((await at(null)).says).toBe('not here')
    expect((await changesHere(params, seeing, { readingFor: reading(true) })).says).toBe('unread')
  })

  it('is told only to a device granted an agent’s bytes, about a task it reads, and asks git nothing else', async () => {
    const asked: string[] = []
    const changes = window({ base: 'main', files: [] }, asked)
    const out = await changesHere(params, bare, { readingFor: reading(true), changes })
    expect(out).toMatchObject({ says: 'not granted', files: [] })
    const away = await changesHere(params, seeing, { readingFor: reading(false), changes })
    expect(away).toMatchObject({ says: 'not here', files: [] })
    expect(asked).toEqual([])
  })

  it('throws on a window that broke, so the server says it at the machine and no words of it here', async () => {
    await expect(
      changesHere(params, seeing, {
        readingFor: reading(true),
        changes: { read: () => Promise.reject(new Error('the disk is full')), known: () => [] },
      }),
    ).rejects.toThrow('the disk is full')
  })
})

describe('a diff from its first hunk', () => {
  it('drops git’s header, says binary where git does, and null where there is no hunk', () => {
    expect(String(hunksOf(DIFF)).startsWith('@@')).toBe(true)
    expect(hunksOf('diff --git a/x b/x\nBinary files a/x and b/x differ\n')).toBe('binary')
    expect(hunksOf('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toBeNull()
  })
})
