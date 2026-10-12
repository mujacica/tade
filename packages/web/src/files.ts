import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import { type Asset, assetFor, matchesEtag, readAssets } from './assets.ts'
import { headersFor } from './headers.ts'
import { type Served, servedWorker } from './installable.ts'
import { header } from './request.ts'

// The two answers that are a file: one out of the folder, and one with a line
// of JSON in front of it.
//
// **Out of `server.ts` because it is a different subject**, and because the
// two pieces of state it needs were two `let`s in a nine-hundred-line closure:
// the asset map, read once, and the worker, built once. Both are fixed for the
// life of a listener — the folder is read at `listen` and the setting is read
// with the route table — so building either per request would be a handler
// doing work, and the window draws on this thread.
//
// **Neither answers a refusal.** They answer `true` for *I wrote a response*
// and `false` for *there is no such file*, and the listener turns the second
// into its own `404` — so there is one place that writes a refusal and one
// place that decides what a refusal says.

/** The files a listener serves, with everything it reads them from kept once. */
export interface Files {
  /** A file, with a `304` where the browser already has it. False for none. */
  asset(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
  /** The worker, with its version in front of it. False for a folder with none. */
  worker(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  /** Forget what was read, so the next request reads the folder again (`reloading.ts`). */
  reset(): void
}

/**
 * The files, read on demand and kept.
 *
 * `serving` is `surfaces.web.install`, and it decides which worker `/sw.js`
 * answers with. There is no third answer and in particular **no `404`**: a
 * worker's script answering a non-ok status leaves the installed one exactly
 * where it was (w3c/ServiceWorker issue 204), so turning the setting off is
 * something the device has to be *told*, which is what `shellOf` answers with.
 */
export function filesFor(opts: { serving: boolean }): Files {
  let assets: Map<string, Asset> | null = null
  let packed = packing()
  let worker: Served | null = null
  return {
    reset() {
      assets = null
      worker = null
      packed = packing()
    },
    async asset(req, res, path) {
      assets ??= await readAssets()
      const found = assetFor(path, assets)
      if (found === null) return false
      // **Compressed for whoever can take it**: the page is a few hundred
      // kilobytes of text a phone on a mobile network pays for once per
      // version, and brotli makes it a third of that. Static files with no
      // secret in them, so there is nothing for a compression oracle to
      // find; each encoding is its own entity with its own etag, and `Vary`
      // tells any cache between here and the phone to keep them apart.
      let how = encodingFor(header(req, 'accept-encoding'), found)
      let file = found
      if (how !== null) {
        try {
          file = await packed.of(found, how)
        } catch {
          // A file that would not compress is served as it is, never not at all.
          how = null
        }
      }
      const headers = {
        ...headersFor('asset', file.type, file.etag),
        vary: 'accept-encoding',
        ...(how === null ? {} : { 'content-encoding': how }),
      }
      if (matchesEtag(header(req, 'if-none-match'), file.etag)) {
        res.writeHead(304, headers)
        res.end()
        return true
      }
      res.writeHead(200, { ...headers, 'content-length': String(file.bytes.length) })
      // No `HEAD` branch, because no `HEAD` reaches here: the table carries
      // three methods and a request under any other finds no route and is a
      // `404`. A browser needs none for this page, and a branch that cannot
      // run reads as a capability there is no test for.
      res.end(file.bytes)
      return true
    },
    async worker(req, res) {
      assets ??= await readAssets()
      // Made once and kept: the files and the setting are both fixed for the
      // life of a listener. Still null afterwards is a folder with no worker
      // in it — a broken install, answered like any other file that is not
      // there.
      //
      // Served like an asset in every other way — `no-cache`, an etag, a
      // `304` — because that is exactly what a worker's script wants: a
      // browser revalidates it on navigations and decides there is an update
      // by comparing the bytes, so an etag over the **served** bytes makes the
      // comparison free when nothing changed.
      worker ??= servedWorker(assets, { serving: opts.serving })
      if (worker === null) return false
      const headers = headersFor('asset', worker.type, worker.etag)
      if (matchesEtag(header(req, 'if-none-match'), worker.etag)) {
        res.writeHead(304, headers)
        res.end()
        return true
      }
      res.writeHead(200, { ...headers, 'content-length': String(worker.bytes.length) })
      res.end(worker.bytes)
      return true
    },
  }
}

/** The two encodings served, best first. */
export type Encoding = 'br' | 'gzip'

/**
 * Which encoding to answer a request in, or null for the bytes as they are.
 *
 * Text only — an image is compressed already — and only an encoding the
 * request named with a weight above nought. Pure, so the reading of the
 * header is a test and not a guess.
 */
export function encodingFor(accepts: string | null, file: Pick<Asset, 'type'>): Encoding | null {
  if (accepts === null || file.type.startsWith('image/')) return null
  const named = new Map<string, number>()
  for (const part of accepts.split(',')) {
    const [name, ...rest] = part.trim().toLowerCase().split(';')
    const q = rest.map((one) => one.trim()).find((one) => one.startsWith('q='))
    named.set(name ?? '', q === undefined ? 1 : Number(q.slice(2)) || 0)
  }
  for (const one of ['br', 'gzip'] as const) {
    if ((named.get(one) ?? named.get('*') ?? 0) > 0) return one
  }
  return null
}

const brotli = promisify(brotliCompress)
const gzipped = promisify(gzip)

/**
 * Each file in each encoding, made the first time it is asked for and kept
 * for the life of the listener — the files never change under one, so this is
 * once per file per encoding, and off the thread (`zlib`'s pool), so the
 * window that draws on this thread never waits on it.
 */
function packing() {
  const held = new Map<string, Promise<Asset>>()
  return {
    of(file: Asset, how: Encoding): Promise<Asset> {
      const key = `${file.path}|${how}`
      let made = held.get(key)
      if (made === undefined) {
        made = (
          how === 'br'
            ? brotli(file.bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })
            : gzipped(file.bytes, { level: 9 })
        ).then((bytes) => ({
          ...file,
          bytes,
          // The same entity in another encoding is another entity: its own
          // validator, so a `304` is never answered for bytes it did not send.
          etag: `${file.etag.slice(0, -1)}-${how}"`,
        }))
        held.set(key, made)
        // A failure is not kept: the next ask tries again rather than
        // inheriting a rejection for the life of the listener.
        made.catch(() => held.delete(key))
      }
      return made
    },
  }
}
