import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assetFor,
  assetsDir,
  etagOf,
  folderIn,
  matchesEtag,
  readAssets,
  typeOf,
  WORKER_FILE,
} from '../src/assets.ts'
import { CSP } from '../src/headers.ts'

// The rules about what may be in `src/assets/`, each one a bug that would
// otherwise appear only on somebody else's machine or only in a browser.

const DIR = assetsDir()

function files(dir = DIR, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const at = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...files(dir, at))
    else out.push(at)
  }
  return out
}

const ALL = files()
const TEXT = ALL.filter((name) => /\.(html|css|js|json|webmanifest|svg)$/.test(name))

describe('what may be in the folder', () => {
  it('has the shell, the tokens and the entry in it', () => {
    expect(ALL).toContain('index.html')
    expect(ALL).toContain('boot.js')
    // The worker, the manifest and the icons: generated beside each other by
    // `node packages/web/scripts/icons.ts`, and all four checked by the rules
    // below like any other file here.
    expect(ALL).toContain(WORKER_FILE)
    expect(ALL).toContain('tade.webmanifest')
    expect(ALL).toContain('icon-180.png')
    // The palette and the type scale are their own file, so the arithmetic in
    // `design.test.ts` has one place to read them from.
    expect(ALL).toContain('tokens.css')
    expect(ALL).toContain('frame.css')
    expect(ALL).toContain('away.css')
  })

  it('keeps every module small enough to be read rather than trusted', () => {
    // The whole away view is here and it is still meant to be read in an
    // afternoon. A file over this is a file that has stopped being one thing.
    for (const name of TEXT) {
      const lines = readFileSync(join(DIR, name), 'utf8').split('\n').length
      expect(lines, `${name} is ${lines} lines`).toBeLessThan(950)
    }
  })

  it('has no .ts file, ever', () => {
    // `stage.ts` renames `.ts` to `.js` when it builds the published tarball,
    // so a `.ts` asset is served under one name here and another after
    // publishing — a bug that appears only on somebody else's machine.
    expect(ALL.filter((name) => name.endsWith('.ts'))).toEqual([])
  })

  it('has no file of a kind that would be served as something it is not', () => {
    for (const name of ALL) expect(typeOf(name), name).not.toBeNull()
  })

  it('has no third-party file in it', () => {
    // `pnpm notices` is generated from the lockfile and cannot see a committed
    // `.js`, so a vendored library would make the notices file quietly untrue.
    for (const name of TEXT) {
      const text = readFileSync(join(DIR, name), 'utf8')
      for (const smell of ['Copyright (c)', 'Licensed under the', '@license', 'sourceMappingURL'])
        expect(text, `${name} contains ${smell}`).not.toContain(smell)
    }
  })

  it('is small enough that somebody reads it rather than trusting it', () => {
    for (const name of ALL) expect(statSync(join(DIR, name)).size, name).toBeLessThan(64 * 1024)
  })
})

describe('what the client may never do', () => {
  it('never touches innerHTML, outerHTML or insertAdjacentHTML', () => {
    // The page renders text a person typed, text an agent wrote and — later —
    // text from a forge. Every value reaches the DOM through `textContent` or
    // `setAttribute`, and this is the line that holds it, because the content
    // policy has no `unsafe-inline` to fall back on.
    for (const name of TEXT) {
      const text = readFileSync(join(DIR, name), 'utf8')
      // Reached, not mentioned: `.innerHTML` or `['innerHTML']`, never the
      // word. The files themselves name it in the comment that forbids it,
      // and a test that failed on its own explanation is one somebody deletes.
      for (const banned of [
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'write',
        'eval',
        'Function',
      ])
        for (const reached of [`.${banned}`, `['${banned}']`, `["${banned}"]`])
          expect(text, `${name} reaches ${reached}`).not.toContain(reached)
      expect(text, `${name} calls eval`).not.toMatch(/\beval\s*\(/)
      expect(text, `${name} builds a function`).not.toMatch(/\bnew Function\b/)
    }
  })

  it('has no inline script and no inline style, which the policy forbids anyway', () => {
    const html = readFileSync(join(DIR, 'index.html'), 'utf8')
    // A `<script>` with a body, as against one with a `src`.
    expect(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html)).toBe(false)
    expect(/\sstyle\s*=/.test(html)).toBe(false)
    expect(/<style[\s>]/.test(html)).toBe(false)
    expect(/\son[a-z]+\s*=/.test(html)).toBe(false)
    // And the policy that would have refused them, so the two cannot drift.
    expect(CSP).not.toContain('unsafe-inline')
  })

  it('reaches nothing off this machine', () => {
    for (const name of TEXT) {
      const text = readFileSync(join(DIR, name), 'utf8')
      for (const off of ['http://', 'https://', '//cdn', 'fonts.googleapis'])
        expect(text, `${name} reaches ${off}`).not.toContain(off)
    }
  })

  it('every src and href resolves to a file that is here', () => {
    const html = readFileSync(join(DIR, 'index.html'), 'utf8')
    const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((found) => found[1] ?? '')
    expect(referenced.length).toBeGreaterThan(1)
    for (const url of referenced) {
      expect(url, url).toMatch(/^\/assets\//)
      expect(ALL, url).toContain(url.slice('/assets/'.length))
    }
  })

  it('every import between the modules resolves to a file that is here', () => {
    // The HTML's `src` is checked above, but a module the page pulls in
    // through another module is not in the HTML at all — and a relative
    // import that does not resolve is a page with no script, in a browser,
    // with the policy refusing to tell anybody why.
    for (const name of TEXT.filter((one) => one.endsWith('.js'))) {
      const text = readFileSync(join(DIR, name), 'utf8')
      const specs = [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
        (found) => found[1] ?? '',
      )
      for (const spec of specs) {
        // A bare specifier has no importmap behind it and would be a network
        // request the policy refuses: relative, always.
        expect(spec, `${name} imports ${spec}`).toMatch(/^\.\.?\//)
        expect(spec, `${name} imports ${spec}`).toMatch(/\.js$/)
        expect(ALL, `${name} imports ${spec}`).toContain(spec.replace(/^\.\//, ''))
      }
    }
  })

  it('names the credential nowhere, because the page never reads it', () => {
    // An `HttpOnly` cookie is not readable by script, so a client that names
    // it is a client that thinks it can read one.
    for (const name of TEXT) {
      const text = readFileSync(join(DIR, name), 'utf8')
      expect(text, name).not.toContain('document.cookie')
      expect(text, name).not.toContain('localStorage')
      expect(text, name).not.toContain('sessionStorage')
    }
  })

  it('takes the ticket out of the address bar as it reads it', () => {
    const boot = readFileSync(join(DIR, 'boot.js'), 'utf8')
    expect(boot).toContain('location.hash')
    expect(boot).toContain('history.replaceState')
    // And never puts it in a query string, which is where it would reach an
    // access log, a `Referer` and the browser's history.
    expect(boot).not.toMatch(/[?&]t=/)
  })
})

describe('reading them into a map', () => {
  it('reads every file with its type and a strong etag', async () => {
    const assets = await readAssets()
    expect(assets.size).toBe(ALL.length)
    const shell = assets.get('index.html')
    expect(shell?.type).toBe('text/html; charset=utf-8')
    expect(shell?.etag).toMatch(/^"[\w-]{27}"$/)
    expect(shell?.etag).toBe(etagOf(readFileSync(join(DIR, 'index.html'))))
  })

  it('is no files at all for a folder that is not there', async () => {
    expect((await readAssets('/nowhere-at-all')).size).toBe(0)
  })

  it('finds them under a path with a space in it, which a URL would encode', async () => {
    // The bug this is for: `new URL(...).pathname` percent-encodes, so
    // installed anywhere with a space in the path — `~/Library/Application
    // Support/…`, a Windows `Program Files`, a person whose account is two
    // words — the folder handed to `readdir` was `…Application%20Support…`,
    // which is not there. `walk` answers a folder it cannot read with no
    // files, so the map came back empty, every page and every asset was a
    // `404`, and nothing anywhere said why. Real directories on both sides,
    // because the whole failure was between a URL and the filesystem.
    const lib = mkdtempSync(join(tmpdir(), 'tade assets '))
    cpSync(DIR, join(lib, 'assets'), { recursive: true })
    // Through the URL, the way the module reaches its own folder: a path
    // handed straight to `readAssets` never crosses the seam that was broken.
    const assets = await readAssets(folderIn(pathToFileURL(join(lib, 'assets.js')).href))
    expect(assets.size).toBe(ALL.length)
    expect(assets.get('index.html')?.bytes.length).toBeGreaterThan(0)
  })

  it('turns a module URL into a path and never into a URL’s pathname', () => {
    // The conversion on its own, against a URL this machine does not have, so
    // the rule holds on a laptop whose own checkout has no space in it — which
    // is every machine this has ever been run on, and is why it shipped.
    expect(folderIn('file:///Users/two%20words/lib/x/assets.js')).toBe(
      '/Users/two words/lib/x/assets/',
    )
    expect(folderIn('file:///plain/lib/assets.js')).toBe('/plain/lib/assets/')
    expect(assetsDir()).not.toContain('%')
  })

  it('serves the shell for both of the document paths', async () => {
    const assets = await readAssets()
    expect(assetFor('/', assets)?.path).toBe('index.html')
    expect(assetFor('/pair', assets)?.path).toBe('index.html')
  })

  it('serves the worker’s source as no file at all', async () => {
    // It is read with everything else — one `readdir`, one set of etags, and
    // the shell's version is a hash over them — and it is answered at `/sw.js`
    // with that version in front of it. Served here as well, it would be a
    // second URL for the same script: scope `/assets/`, so it could never
    // control the page, and no prelude, so it would cache nothing while
    // looking exactly like the real thing.
    const assets = await readAssets()
    expect(assets.has(WORKER_FILE)).toBe(true)
    expect(assetFor(`/assets/${WORKER_FILE}`, assets)).toBeNull()
  })

  it('serves nothing for a path that is not in the map', async () => {
    const assets = await readAssets()
    // A lookup, not a join: a traversal reaches a `Map.get` that answers
    // nothing rather than a filesystem call that has to refuse it.
    for (const path of [
      '/assets/../../config.yaml',
      '/assets/../index.html',
      '/assets/',
      '/assets/nothing.js',
      '/config.yaml',
      '/api/snapshot',
    ])
      expect(assetFor(path, assets), path).toBeNull()
  })

  it('tells a browser that already has the file, including the list form', () => {
    const etag = '"abc"'
    expect(matchesEtag(etag, etag)).toBe(true)
    expect(matchesEtag(`W/${etag}`, etag)).toBe(true)
    expect(matchesEtag(`"other", ${etag}`, etag)).toBe(true)
    expect(matchesEtag('*', etag)).toBe(true)
    expect(matchesEtag('"other"', etag)).toBe(false)
    expect(matchesEtag(null, etag)).toBe(false)
  })
})
