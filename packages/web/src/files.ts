import type { IncomingMessage, ServerResponse } from 'node:http'
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
  let worker: Served | null = null
  return {
    async asset(req, res, path) {
      assets ??= await readAssets()
      const file = assetFor(path, assets)
      if (file === null) return false
      const headers = headersFor('asset', file.type, file.etag)
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
