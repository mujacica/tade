import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

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
// **What is here now is a bootstrap, and `away-readonly-ui` owns the rest.**
// Three files: the shell, enough CSS that it is legible on a phone at night,
// and the script that pairs a device or signs one out. They are what makes the
// two session-lifecycle routes usable by a person — a device cannot pair
// without a page to pair from — and nothing in them reads or draws any
// projection, which is what makes serving them unauthenticated safe. The eight
// screens, the design tokens and the accessibility work are a later slice's,
// and they land in this same folder under the same rules.
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
  return new URL('assets/', import.meta.url).pathname
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
 * `/` and `/pair` are both the shell, because the client decides which screen
 * it is on. Everything else under `/assets/` is looked up by the rest of its
 * path — a lookup, not a join.
 */
export function assetFor(path: string, assets: ReadonlyMap<string, Asset>): Asset | null {
  if (path === '/' || path === '/pair') return assets.get('index.html') ?? null
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
