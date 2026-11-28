import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { matchesEtag } from './assets.ts'
import { DRAW_PREFIX, type Drawing } from './drawing.ts'
import { encodingFor, packing } from './files.ts'
import { COMPANIONS, CSP, headersFor } from './headers.ts'
import { header } from './request.ts'

// The window's drawing, answered: what `/draw` serves (`drawing.ts` builds it).
//
// - `/draw/` is the **document** a browser draws the window in — the full
//   view (§10 T4): the import map, inline because a browser takes no other
//   kind, and a policy that is the page's own with that one script's hash
//   added to `script-src` — the map is allowed and nothing else inline is.
//   The full view's own stylesheet and module (`assets/full.css`,
//   `assets/full.js`) are the away page's files, linked like any; where the
//   drawing starts is in a `<meta>`, so the page decides when to import it.
// - `/draw/<version>/<path>` is **a module**, `immutable`: its URL changes
//   with any byte of what is served, so a phone that has it never asks again,
//   and a version that is not this one's is a `404` rather than a guess.
// - `/draw/<version>/importmap.json` is the map, for a page that is already
//   open (the overview) to read what it would import.
//
// Built the first time it is asked for, never at `listen`: a few hundred files
// read and stripped is work for whoever opens the full view, not for every
// window that starts. A build that failed is tried again on the next ask.
//
// **Never minified, and its own ceiling** — `change-the-window` says why: what
// a phone pays is the brotli of it, once per Tade version.

/** What answers `/draw`. `true` where it wrote an answer, `false` for no such file. */
export interface DrawingDoor {
  answer(req: IncomingMessage, res: ServerResponse, rest: string): Promise<boolean>
}

/** The door, over a drawing built when it is first asked for. */
export function drawingDoor(build: () => Promise<Drawing>): DrawingDoor {
  let built: Promise<Drawing> | null = null
  let page: { html: Buffer; csp: string; etag: string } | null = null
  const packed = packing()
  const drawing = (): Promise<Drawing> => {
    // A failed build is forgotten, so the next ask tries again, and still
    // thrown, so the listener says what went wrong.
    built ??= build().then(undefined, (problem: unknown) => {
      built = null
      page = null
      throw problem
    })
    return built
  }
  return {
    async answer(req, res, rest) {
      const made = await drawing()
      if (rest === '') {
        page ??= documentOf(made)
        res.writeHead(200, {
          ...headersFor('asset', 'text/html; charset=utf-8', page.etag),
          'content-security-policy': page.csp,
          'content-length': String(page.html.length),
        })
        res.end(page.html)
        return true
      }
      const slash = rest.indexOf('/')
      if (slash < 0 || rest.slice(0, slash) !== made.version) return false
      const path = rest.slice(slash + 1)
      if (path === 'importmap.json') {
        const bytes = Buffer.from(JSON.stringify(made.importMap))
        res.writeHead(200, { ...immutable('application/json; charset=utf-8') })
        res.end(bytes)
        return true
      }
      const found = made.files.get(path)
      if (found === undefined) return false
      let how = encodingFor(header(req, 'accept-encoding'), found)
      let file = found as typeof found
      if (how !== null) {
        try {
          file = { ...found, ...(await packed.of(found, how)) }
        } catch {
          // A file that would not compress is served as it is, never not at all.
          how = null
        }
      }
      const headers = {
        ...immutable(file.type),
        etag: file.etag,
        vary: 'accept-encoding',
        ...(how === null ? {} : { 'content-encoding': how }),
      }
      if (matchesEtag(header(req, 'if-none-match'), file.etag)) {
        res.writeHead(304, headers)
        res.end()
        return true
      }
      res.writeHead(200, { ...headers, 'content-length': String(file.bytes.length) })
      res.end(file.bytes)
      return true
    },
  }
}

/** The headers of a file whose URL is its version: kept for good, by anybody. */
function immutable(type: string): Record<string, string> {
  return {
    ...COMPANIONS,
    'content-type': type,
    'cache-control': 'public, max-age=31536000, immutable',
  }
}

/**
 * The document: the map inline, and the policy that allows exactly it. The
 * page's own policy, `script-src` widened by the map's hash and by nothing else.
 */
export function documentOf(made: Drawing): { html: Buffer; csp: string; etag: string } {
  const map = JSON.stringify(made.importMap)
  const hash = createHash('sha256').update(map).digest('base64')
  const html = Buffer.from(
    [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      '<meta name="color-scheme" content="dark">',
      '<meta name="theme-color" content="#1c1c1c">',
      '<title>Tade</title>',
      '<link rel="manifest" href="/assets/tade.webmanifest">',
      '<link rel="icon" href="/assets/icon-192.png">',
      '<link rel="apple-touch-icon" href="/assets/icon-180.png">',
      '<link rel="stylesheet" href="/assets/tokens.css">',
      '<link rel="stylesheet" href="/assets/full.css">',
      `<meta name="tade-drawing" content="${made.roots[0] ?? ''}">`,
      `<script type="importmap">${map}</script>`,
      // The full view (`assets/full.js`): after the map, which a module needs
      // in place before it loads, and it imports the drawing when it is ready.
      '<script type="module" src="/assets/full.js"></script>',
      '</head>',
      '<body></body>',
      '</html>',
      '',
    ].join('\n'),
  )
  const csp = CSP.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`)
  if (csp === CSP) throw new Error("the page's policy has no script-src 'self' to widen")
  const etag = `"${createHash('sha256').update(html).update(csp).digest('base64url').slice(0, 27)}"`
  return { html, csp, etag }
}

export { DRAW_PREFIX }
