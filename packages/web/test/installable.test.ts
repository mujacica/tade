import { describe, expect, it } from 'vitest'
import { type Asset, etagOf, readAssets, WORKER_FILE } from '../src/assets.ts'
import {
  CACHE_PREFIX,
  cacheName,
  keepingOf,
  MANIFEST_FILE,
  OFF_VERSION,
  preludeOf,
  servedWorker,
  shellOf,
  VIEW_CACHE,
  workerBytes,
} from '../src/installable.ts'

// The version a shell is cached under, and what the worker is handed.
//
// The failure this file is against has one shape and several spellings: **the
// bytes on a phone and the version naming them stop agreeing.** A constant
// somebody forgot to bump, a file added to the folder and not to the list, a
// version computed from something that is not the bytes. Each of them is right
// on the machine that wrote it and wrong in the published tarball, and the
// symptom is a page a week out of date with nothing anywhere saying why.
//
// So every test here is some form of *the version moves when and only when the
// shell does*.

function asset(body: string): Asset {
  const bytes = Buffer.from(body, 'utf8')
  return { path: 'x', bytes, type: 'text/plain', etag: etagOf(bytes) }
}

function folder(files: Record<string, string>): Map<string, Asset> {
  return new Map(
    Object.entries(files).map(([name, body]) => [name, { ...asset(body), path: name }]),
  )
}

const ON = { serving: true }
const SHELL = folder({ 'index.html': '<html>', 'boot.js': 'go()', 'away.css': 'body{}' })

describe('the version is the shell’s own bytes', () => {
  it('is the same for the same files, twice', () => {
    expect(shellOf(SHELL, ON).version).toBe(
      shellOf(
        folder(
          Object.fromEntries([...SHELL].map(([name, one]) => [name, one.bytes.toString('utf8')])),
        ),
        ON,
      ).version,
    )
  })

  it('moves when a file’s contents move', () => {
    const changed = folder({ 'index.html': '<html>', 'boot.js': 'go2()', 'away.css': 'body{}' })
    expect(shellOf(changed, ON).version).not.toBe(shellOf(SHELL, ON).version)
  })

  it('moves when a file arrives or leaves, which a hash of contents alone would miss', () => {
    // The name is in the hash as well as the bytes. Without it, renaming a
    // module — or adding one whose contents happen to match another's — would
    // leave a phone precaching a list it no longer has.
    const more = folder({
      'index.html': '<html>',
      'boot.js': 'go()',
      'away.css': 'body{}',
      'rows.js': 'rows()',
    })
    const renamed = folder({ 'index.html': '<html>', 'start.js': 'go()', 'away.css': 'body{}' })
    expect(shellOf(more, ON).version).not.toBe(shellOf(SHELL, ON).version)
    expect(shellOf(renamed, ON).version).not.toBe(shellOf(SHELL, ON).version)
  })

  it('does not move because the files were read in another order', () => {
    const backwards = new Map([...SHELL].reverse())
    expect(shellOf(backwards, ON).version).toBe(shellOf(SHELL, ON).version)
  })
})

describe('what the worker is told to cache', () => {
  it('is the document at `/` and every file under `/assets/`', () => {
    expect(shellOf(SHELL, ON).files).toEqual(['/', '/assets/away.css', '/assets/boot.js'])
  })

  it('never contains a route of the machine’s, because it is a folder', () => {
    const { files } = shellOf(SHELL, ON)
    for (const path of files) expect(path === '/' || path.startsWith('/assets/')).toBe(true)
  })

  it('leaves the worker’s own source out', () => {
    // Its bytes are the prelude plus the file, and the prelude is made from
    // this version — so a worker that precached itself would be caching a
    // version of itself. The browser already compares the script's bytes,
    // which is the job this version would be doing twice.
    const withWorker = folder({ 'index.html': '<html>', [WORKER_FILE]: 'self.SHELL' })
    expect(shellOf(withWorker, ON).files).toEqual(['/'])
  })

  it('is nothing at all, under one constant name, when it is off', () => {
    const off = shellOf(SHELL, { serving: false })
    expect(off).toEqual({
      version: OFF_VERSION,
      files: [],
      serving: false,
      cache: cacheName(OFF_VERSION),
      prefix: CACHE_PREFIX,
      view: VIEW_CACHE,
    })
  })
})

describe('the names everything of ours is kept under', () => {
  it('are all one prefix, so a clear-out is one loop', () => {
    expect(cacheName('abc').startsWith(CACHE_PREFIX)).toBe(true)
    expect(VIEW_CACHE.startsWith(CACHE_PREFIX)).toBe(true)
    expect(cacheName('abc')).not.toBe(VIEW_CACHE)
  })

  it('travel with the worker rather than being spelt in its source', () => {
    const shell = shellOf(SHELL, ON)
    expect(shell.cache).toBe(cacheName(shell.version))
    expect(shell.prefix).toBe(CACHE_PREFIX)
    expect(shell.view).toBe(VIEW_CACHE)
  })
})

describe('the prelude, and the bytes that go out', () => {
  it('is one line of JSON on a global the linter knows about', () => {
    const line = preludeOf(shellOf(SHELL, ON))
    expect(line.startsWith('self.SHELL = ')).toBe(true)
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line.slice('self.SHELL = '.length))).toEqual(shellOf(SHELL, ON))
  })

  it('leaves the source exactly as it is', () => {
    const source = Buffer.from('// the worker\n')
    const bytes = workerBytes(source, shellOf(SHELL, ON))
    expect(bytes.toString('utf8').endsWith(source.toString('utf8'))).toBe(true)
  })

  it('answers nothing where there is no worker in the folder', () => {
    expect(servedWorker(folder({ 'index.html': '<html>' }), ON)).toBeNull()
  })

  it('tags the served bytes, not the source, so a changed shell is a changed script', () => {
    // An etag over the source alone would tell a browser *unchanged* while the
    // shell it is holding is a version behind — which is the quietest possible
    // version of this whole file being wrong.
    const files = folder({ 'index.html': '<html>', [WORKER_FILE]: 'self.SHELL' })
    const on = servedWorker(files, ON)
    const off = servedWorker(files, { serving: false })
    expect(on?.etag).not.toBe(off?.etag)
    expect(on?.etag).toBe(etagOf(on?.bytes ?? Buffer.alloc(0)))
    expect(on?.type).toBe('text/plain')
  })
})

describe('what the page is told', () => {
  it('is booleans and one key, and no names at all', () => {
    // The names are spelt in the page's own files, because the two moments
    // they matter are the two where there is nothing to ask.
    expect(keepingOf({ installing: true, keepsView: false })).toEqual({
      install: true,
      keepsView: false,
      notifying: { offered: false, key: '' },
    })
  })

  it('offers notifications only with the setting on **and** a key', () => {
    // Both halves, because a page told *offered* with nothing to subscribe
    // with would draw a control whose only possible outcome is a browser
    // throwing. The key is the public one and is meant to leave the machine;
    // it is the only value in this subsystem that is.
    expect(keepingOf({ installing: true, keepsView: false, pushing: true })).toMatchObject({
      notifying: { offered: false, key: '' },
    })
    expect(keepingOf({ installing: true, keepsView: false, pushing: true }, 'BKey')).toEqual({
      install: true,
      keepsView: false,
      notifying: { offered: true, key: 'BKey' },
    })
    // And the setting off takes the key out of the answer too: a page that was
    // handed one by a listener serving no notification route would draw a
    // control with nothing behind it.
    expect(keepingOf({ installing: true, keepsView: false }, 'BKey')).toMatchObject({
      notifying: { offered: false, key: '' },
    })
  })
})

describe('the real folder', () => {
  it('precaches the manifest and the icons, and the document as `/`', async () => {
    const assets = await readAssets()
    const { files } = shellOf(assets, ON)
    expect(files[0]).toBe('/')
    expect(files).not.toContain('/assets/index.html')
    expect(files).toContain(`/assets/${MANIFEST_FILE}`)
    expect(files).toContain('/assets/icon-180.png')
    expect(files).not.toContain(`/assets/${WORKER_FILE}`)
    // Every file in the folder, the worker aside — the document counted once,
    // as `/`. The whole shell, with no second list anywhere to keep in step:
    // a file added to `assets/` is a file a phone precaches, and nobody has to
    // remember that.
    expect(files.length).toBe(assets.size - 1)
  })

  it('moves when the protocol the page speaks does', async () => {
    // **The old-shell-against-a-new-protocol case, and why it is not a special
    // one.** The version a page speaks is `SPEAKS`, which lives in `store.js`
    // — a file in this folder. So a protocol change *is* a shell change: the
    // version moves, the worker's bytes move with it, and the browser's own
    // update check offers the page that can read the new frames. The other
    // half is already true without any of this — a page refuses a frame whose
    // version it does not know and says so rather than guessing
    // (`test/store.test.ts`) — so the worst case is a sentence, not a wrong
    // number on a screen.
    const assets = await readAssets()
    expect(shellOf(assets, ON).files).toContain('/assets/store.js')
    const store = assets.get('store.js')
    if (store === undefined) throw new Error('no store.js in the folder')
    const later = new Map(assets)
    later.set('store.js', { ...store, etag: '"a protocol later"' })
    expect(shellOf(later, ON).version).not.toBe(shellOf(assets, ON).version)
  })

  it('is small enough to precache on a phone’s data', async () => {
    const assets = await readAssets()
    const bytes = [...assets.values()].reduce((sum, one) => sum + one.bytes.length, 0)
    // The whole away view, every module, every icon. A megabyte here would be
    // a first visit somebody notices on a train, and would mean the folder had
    // grown something that does not belong in it.
    expect(bytes).toBeLessThan(400 * 1024)
  })
})
