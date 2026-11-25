import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The rehearsal's npm registry, on each box: what lets a box be *behind* the
// Mac and be moved forward the way a person's would be. `tade host upgrade
// --to <version>` runs the install's own command pinned to that version
// (`npm install --global tade-sh@<version>`), and a version the rehearsal
// staged is on no public registry — so the box's npm is pointed here
// (`~/.npmrc`), which answers for `tade-sh` out of a folder of staged tarballs
// and hands every other package, and every other request, to the real
// registry, so the dependencies come from where they always do.
//
// The folder holds what `scripts/rehearse-remote.sh ahead` put there: for each
// version, `tade-sh-<version>.tgz` (what `npm pack` made) and
// `tade-sh-<version>.json` (the staged package.json, which is the manifest npm
// resolves dependencies from). The newest by its file's time is `latest`.
//
// Node and nothing else, because on a box it runs as `node registry.ts` from
// /opt/rehearsal with no node_modules beside it: REHEARSAL_REGISTRY_DIR
// (/opt/rehearsal/registry), REHEARSAL_REGISTRY_PORT (4873).

/** The one package this registry answers for itself. */
export const PACKAGE = 'tade-sh'
const UPSTREAM = 'https://registry.npmjs.org'
const TARBALL = new RegExp(`^/${PACKAGE}/-/(${PACKAGE}-[0-9A-Za-z.+-]+\\.tgz)$`)

export interface Registry {
  url: string
  close(): Promise<void>
}

/** The versions staged in `dir`, oldest first: each with its manifest and its tarball's path. */
function staged(dir: string): { version: string; manifest: Record<string, unknown>; at: number }[] {
  if (!existsSync(dir)) return []
  const prefix = `${PACKAGE}-`
  return readdirSync(dir)
    .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
    .flatMap((file) => {
      const version = file.slice(prefix.length, -'.json'.length)
      const tarball = join(dir, `${prefix}${version}.tgz`)
      if (!existsSync(tarball)) return []
      const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
      return [{ version, manifest, at: statSync(tarball).mtimeMs }]
    })
    .sort((a, b) => a.at - b.at)
}

/** What npm asks for by the package's name: every staged version, each with where its tarball is. */
function packument(dir: string, base: string): Record<string, unknown> | null {
  const versions = staged(dir)
  const newest = versions.at(-1)
  if (newest === undefined) return null
  const out: Record<string, unknown> = {}
  for (const { version, manifest } of versions) {
    const file = `${PACKAGE}-${version}.tgz`
    const bytes = readFileSync(join(dir, file))
    out[version] = {
      ...manifest,
      name: PACKAGE,
      version,
      _id: `${PACKAGE}@${version}`,
      dist: {
        tarball: `${base}/${PACKAGE}/-/${file}`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        shasum: createHash('sha1').update(bytes).digest('hex'),
      },
    }
  }
  return { name: PACKAGE, 'dist-tags': { latest: newest.version }, versions: out }
}

export async function startRegistry(opts: {
  dir: string
  port?: number
  upstream?: string
}): Promise<Registry> {
  const upstream = (opts.upstream ?? UPSTREAM).replace(/\/+$/, '')
  const server: Server = createServer((req, res) => {
    res.on('error', () => {})
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
      const base = `http://${req.headers.host ?? '127.0.0.1'}`
      if (path === `/${PACKAGE}`) {
        const answer = packument(opts.dir, base)
        res.writeHead(answer === null ? 404 : 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer ?? { error: `no ${PACKAGE} is staged in ${opts.dir}` }))
        return
      }
      const tarball = TARBALL.exec(path)?.[1]
      if (tarball !== undefined) {
        const at = join(opts.dir, tarball)
        if (!existsSync(at)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: `${tarball} is not staged in ${opts.dir}` }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(readFileSync(at))
        return
      }
      // Everything else is the real registry's: asked as it was asked of us.
      const method = req.method ?? 'GET'
      const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks)
      const headers: Record<string, string> = {}
      for (const name of ['accept', 'content-type', 'npm-command', 'user-agent']) {
        const value = req.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      fetch(`${upstream}${req.url ?? '/'}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(60_000),
      })
        .then(async (answer) => {
          // fetch has already undone any compression, so its length and encoding are not this body's.
          const type = answer.headers.get('content-type')
          res.writeHead(answer.status, type === null ? {} : { 'content-type': type })
          res.end(Buffer.from(await answer.arrayBuffer()))
        })
        .catch((err: unknown) => {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: `${upstream} could not be asked: ${String(err)}` }))
        })
    })
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.env.REHEARSAL_REGISTRY_DIR ?? '/opt/rehearsal/registry'
  const port = Number(process.env.REHEARSAL_REGISTRY_PORT ?? 4873)
  const running = await startRegistry({ dir, port })
  process.stdout.write(
    `the rehearsal's npm registry for ${PACKAGE}, at ${running.url}, from ${dir}\n`,
  )
}
