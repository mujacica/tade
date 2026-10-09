import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeFor } from './routes.ts'

// The browser's files: read into a map once, served from it for ever after.
//
// **There is no path arithmetic here, and that is the point.** The map is built
// by walking `src/assets/` at startup and keying each file by its served path;
// a request is a **lookup in that map**, so a request for
// `/assets/../../config.yaml` does not reach a filesystem call that has to
// refuse it — it reaches a `Map.get` that returns nothing. A traversal is not
// refused, it is unrepresentable.
//
// Read once rather than per request for the other half of the same reason: the
// window draws four times a second on one thread, and a route that reads a file
// is a route that can make it stop.
//
// **What is in the folder is the whole away view**: the shell, the design
// tokens, the screens' stylesheet, and the modules that draw them. Nothing in
// any of them reads or draws a projection of its own — every value on the page
// arrives from a route that needs a session — which is what makes serving all
// of it to anybody who can reach the port a safe thing to do.
//
// The rules, each held by `test/assets.test.ts`:
//
// - **No `.ts` file, ever.** `stage.ts` renames `.ts` to `.js` when it builds
//   the published tarball, so a `.ts` asset would be served under one name here
//   and another after publishing — a bug that appears only on somebody else's
//   machine.
// - **Every `src=` and `href=` resolves** to a file that is actually here.
// - **The string `innerHTML` appears nowhere**, nor `eval`, nor an inline
//   `<script>` or `style=`: the content policy has no `unsafe-inline`, so a
//   page that needed one would simply not work, and the test says so before a
//   browser does.
// - **No third-party file.** `pnpm notices` is generated from the lockfile and
//   cannot see a committed `.js`, so a vendored library would make the notices
//   file quietly untrue.

/** One file, ready to serve. */
export interface Asset {
  path: string
  bytes: Buffer
  type: string
  /** Strong, over the bytes. A weak one would make 304 a guess. */
  etag: string
}

/** Where the files are, relative to this file. */
export function assetsDir(): string {
  return folderIn(import.meta.url)
}

/**
 * The `assets/` folder beside a module, as a **path** and not as a URL's
 * pathname.
 *
 * Its own function so the conversion can be tested with a URL this machine
 * does not have, and `fileURLToPath` rather than `.pathname` because a URL
 * percent-encodes: installed under `~/Library/Application Support/…` or any
 * other folder with a space in it, `.pathname` hands back `…Application%20Sup…`
 * and every `readdir` of it misses. What made that worth a named function is
 * how it failed — `walk` answers a folder it cannot read with no files, so the
 * map came back empty, every page and every file was a `404`, and nothing
 * anywhere said why. It is the one bug in this package that appears only on
 * somebody else's machine, which is the same reason `.ts` is banned in
 * `assets/`.
 */
export function folderIn(url: string): string {
  return fileURLToPath(new URL('assets/', url))
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.ico': 'image/vnd.microsoft.icon',
}

/**
 * The type for a file, or null for a kind of file this does not serve.
 *
 * An allow-list, so a file somebody drops in the folder is served as what it is
 * or not served at all. `application/octet-stream` as a fallback would be a
 * way of serving anything, which is the shape this is avoiding.
 */
export function typeOf(path: string): string | null {
  return TYPES[extname(path).toLowerCase()] ?? null
}

/** Every file under `assets/`, keyed by the path it is served at. */
export async function readAssets(dir = assetsDir()): Promise<Map<string, Asset>> {
  const out = new Map<string, Asset>()
  for (const name of await walk(dir)) {
    const type = typeOf(name)
    if (type === null) continue
    const bytes = await readFile(join(dir, name))
    out.set(name, { path: name, bytes, type, etag: etagOf(bytes) })
  }
  return out
}

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  try {
    for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
      const at = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) out.push(...(await walk(dir, at)))
      else if (entry.isFile()) out.push(at)
    }
  } catch {
    // A folder that is not there is a folder with no files in it. The one
    // caller reads this once at startup and the test that every `src=`
    // resolves is what turns a missing folder into a failure somebody sees.
    return []
  }
  return out
}

/** A strong `ETag` over the bytes. Quoted, as the header wants it. */
export function etagOf(bytes: Buffer): string {
  return `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`
}

/**
 * The asset a request path is for, or null.
 *
 * **Every screen's path is the shell**, and which paths those are is asked of
 * the route table rather than listed again here: two lists of the same thing is
 * a deep link that `404`s on the day somebody adds a screen to only one of
 * them. Everything else under `/assets/` is looked up by the rest of its path —
 * a lookup, not a join.
 *
 * A document path carries a project or a task name in it and **nothing here
 * reads one**: the answer is the same bytes whatever the name was, so a deep
 * link to a project that is not there is not a way of finding out that it is
 * not there.
 */
export function assetFor(path: string, assets: ReadonlyMap<string, Asset>): Asset | null {
  if (routeFor('GET', path)?.route.document === true) return assets.get('index.html') ?? null
  if (!path.startsWith('/assets/')) return null
  return assets.get(path.slice('/assets/'.length)) ?? null
}

/**
 * Whether a request's `If-None-Match` already has this version.
 *
 * Handles the list form and `*`, because a browser may send either and a
 * comparison against the whole header would answer "no" to a cache that was
 * perfectly up to date — a page that revalidates and always re-downloads,
 * which looks like nothing at all going wrong.
 */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false
  if (header.trim() === '*') return true
  return header
    .split(',')
    .map((one) => one.trim().replace(/^W\//, ''))
    .includes(etag)
}
