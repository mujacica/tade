import { createHash } from 'node:crypto'
import { type Asset, etagOf, WORKER_FILE } from './assets.ts'
import { NOT_NOTIFYING, type Notifying, notifyingOf } from './pushing.ts'

// What makes the away view a thing a phone can keep: the static shell, the
// version it is cached under, and the worker that is handed both.
//
// **Everything here is about the shell and nothing here is about the work.**
// The list below is files out of `assets/` — markup, styles, modules, icons —
// and a projection is never in it. That is not a convention to be careful
// about: the list is built from the asset map, the asset map is the folder,
// and `/api` is not a folder. A route that answered a projection out of a
// cache would have to be written on purpose, and `test/worker.test.ts` runs
// the worker against a fake scope to show that it never writes one.
//
// **The version is derived, never stamped.** It is a hash over the path and
// the etag of every file in the shell, so it changes exactly when the shell
// changes and never otherwise. A constant somebody bumps by hand is the drift
// this whole file exists to make impossible: it is right on the machine that
// wrote it, wrong in the published tarball, and the symptom is a phone serving
// last week's page out of its own disk with nothing anywhere saying why.
//
// **The worker is served with that version in front of it.** The source in
// `assets/sw.js` has no version of its own; `/sw.js` answers with a prelude
// and then the source. Two things fall out, and both are the point:
//
// - A browser decides there is an update by **comparing the bytes** of the
//   script. The prelude changes when the shell does, so an updated shell is an
//   updated worker, with nothing to remember.
// - The source is **not served as a file**. `assetFor` refuses
//   `/assets/sw.js`, because a worker's URL decides its scope: one registered
//   from `/assets/` could never control the page, and one with no prelude
//   would cache nothing while looking exactly like the real thing.
//
// **Turning it off serves an uninstalling worker, not a 404.** w3c/ServiceWorker
// issue 204 was closed in 2017 as *will not do*: an update that fetches the
// script and gets a non-ok status leaves the existing registration exactly
// where it was, because the alternative is a data centre's bad afternoon
// unregistering everybody. So the only deactivation that works is one the
// device is *told*: the same URL, different bytes, and those bytes delete the
// caches and unregister. It still only happens when that phone next reaches
// this machine — `INSTALLED_IS_NOT_REVOCABLE` is the sentence about what that
// does not cover, and it is said where somebody is deciding rather than
// implied here.

/** The manifest, which is generated beside the icons (`scripts/icons.ts`). */
export const MANIFEST_FILE = 'tade.webmanifest'

/**
 * The one prefix everything this page stores is named with.
 *
 * Signing out, being revoked and turning the setting off all clear *every*
 * cache whose name starts with this — not a list of the ones somebody
 * remembered. A cache from a version of Tade that no longer exists is still
 * ours and still goes.
 */
export const CACHE_PREFIX = 'tade-'

/** The shell's cache, one per version, so an upgrade is a new name. */
export function cacheName(version: string): string {
  return `${CACHE_PREFIX}shell-${version}`
}

/**
 * The cache the page keeps a redacted last view in, if it is turned on.
 *
 * Named under the same prefix so it is cleared by the same loop, and **not**
 * versioned: it holds one small record that is rewritten, never a set of files
 * that have to match a release.
 */
export const VIEW_CACHE = `${CACHE_PREFIX}view`

/** The version an uninstalling worker carries, so its bytes are a constant. */
export const OFF_VERSION = 'off'

/**
 * What the worker is born knowing.
 *
 * The three names are in here rather than being spelt again in `sw.js`,
 * because a cache name written in two languages is two names the day one of
 * them is edited — and the half that is wrong is the half that *keeps* a cache
 * nobody meant to keep. One decision, in the file that has the argument, handed
 * over with everything else.
 */
export interface Shell {
  /** A hash of the files below, or `off`. */
  version: string
  /** Every path it precaches, document first. */
  files: readonly string[]
  /** Whether it caches anything at all, or exists to remove itself. */
  serving: boolean
  /** This version's own cache. An upgrade is a new name, never a new content. */
  cache: string
  /** Everything of ours is named under this, which is what a clear-out loops over. */
  prefix: string
  /** Where the page keeps a redacted last view. The worker only spares it. */
  view: string
}

/**
 * The shell a set of assets is, at the version those bytes make it.
 *
 * `/` is in the list and `index.html` is not, because the document is served
 * at `/` and a cache is keyed by the URL that was asked for. Everything else
 * is `/assets/<name>`, which is where the page asks for it.
 *
 * Each line of the hash's input is a JSON pair rather than two strings with a
 * separator between them, so a file name that happened to contain the
 * separator could not make two different folders hash the same. Cheap, and the
 * alternative is a rule about what an asset may be called.
 *
 * The worker's own source is **left out**. Its bytes change with the prelude,
 * which is made from this version — so including it would be a version of
 * itself, and the browser already compares the script's bytes for exactly the
 * purpose the version serves here.
 */
export function shellOf(assets: ReadonlyMap<string, Asset>, opts: { serving: boolean }): Shell {
  const files: string[] = ['/']
  const parts: string[] = []
  const shell = assets.get('index.html')
  if (shell !== undefined) parts.push(JSON.stringify(['/', shell.etag]))
  // Sorted by name, so a folder read in another order is the same version:
  // `readdir` makes no promise about order, and a version that depended on it
  // would differ between two machines holding identical files.
  for (const [name, asset] of [...assets].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (name === WORKER_FILE || name === 'index.html') continue
    files.push(`/assets/${name}`)
    parts.push(JSON.stringify([`/assets/${name}`, asset.etag]))
  }
  if (!opts.serving) return named({ version: OFF_VERSION, files: [], serving: false })
  return named({
    version: createHash('sha256').update(parts.join('\n')).digest('base64url').slice(0, 16),
    files,
    serving: true,
  })
}

/** The three names, put on a shell in the one place they are decided. */
function named(shell: Omit<Shell, 'cache' | 'prefix' | 'view'>): Shell {
  return { ...shell, cache: cacheName(shell.version), prefix: CACHE_PREFIX, view: VIEW_CACHE }
}

/**
 * The line in front of the worker's source.
 *
 * `self.SHELL` rather than a bare `const`: the source is linted as an ordinary
 * module in `assets/` (`noUndeclaredVariables` is an error there, and has
 * already caught the one bug this folder has no typechecker for), and a name
 * that only exists because something is pasted in front of it is exactly what
 * that rule is for. `self` is a global the worker has anyway.
 *
 * JSON rather than source, so nothing in a file name could ever be read as
 * code: `JSON.stringify` of a value whose fields are ours and whose strings
 * are paths out of a folder on this machine.
 */
export function preludeOf(shell: Shell): string {
  return `self.SHELL = ${JSON.stringify(shell)}\n`
}

/** The worker, as it is served: the prelude, then the source, unchanged. */
export function workerBytes(source: Buffer, shell: Shell): Buffer {
  return Buffer.concat([Buffer.from(preludeOf(shell), 'utf8'), source])
}

/** The worker as it goes out: the bytes, their type, and an etag over them. */
export interface Served {
  bytes: Buffer
  type: string
  etag: string
}

/**
 * The worker a listener serves, built once.
 *
 * Once, and not per request, because the whole of what decides it — the files
 * in the folder and the setting — is fixed for the life of a listener: the
 * asset map is read at `listen` and the route table is built with the server.
 * A hash over every etag on every request would be a handler doing work, and
 * the window draws on this thread.
 *
 * The etag is over the **served** bytes rather than over the source, so a
 * phone that already has this version revalidates to a `304` and a machine
 * whose shell changed hands over a new script. An etag over the source alone
 * would say *unchanged* to a browser whose worker is now a version behind.
 */
export function servedWorker(
  assets: ReadonlyMap<string, Asset>,
  opts: { serving: boolean },
): Served | null {
  const source = assets.get(WORKER_FILE)
  if (source === undefined) return null
  const bytes = workerBytes(source.bytes, shellOf(assets, opts))
  return { bytes, type: source.type, etag: etagOf(bytes) }
}

/**
 * What the page is told about keeping anything.
 *
 * It goes out beside the device list rather than in the shell, because the
 * shell is the same bytes for everybody and this is a fact about the machine.
 *
 * **Booleans and one key, and no cache names.** The cache names are spelt in the page's own
 * files and held equal to the ones here by a test, because the two moments
 * they matter most are the two where there is nothing to ask: a cold open with
 * no answer, and a session that has just been refused. A name that arrived on
 * the wire would be a name the page does not have exactly when it needs it.
 */
export interface Keeping {
  /** Whether to register the worker at all, where there is not one already. */
  install: boolean
  /** Whether the page may keep a redacted last view beside it. */
  keepsView: boolean
  /**
   * What this machine offers about notifications: whether a device may
   * subscribe, and the public key to do it with.
   *
   * Beside the other two and the same kind of thing: a fact about the machine,
   * the same for every device, which is why all of `Keeping` goes out beside
   * the device list rather than in the shell. Whether *this* phone is
   * subscribed is not here and not anywhere — the browser knows that better
   * (`pushing.ts` has the argument).
   */
  notifying: Notifying
}

/** What a surface means for a page, which is three facts and no settings. */
export function keepingOf(
  surface: { installing: boolean; keepsView: boolean; pushing?: boolean },
  key = '',
): Keeping {
  return {
    install: surface.installing,
    keepsView: surface.keepsView,
    notifying: surface.pushing === true ? notifyingOf({ pushing: true, key }) : NOT_NOTIFYING,
  }
}
