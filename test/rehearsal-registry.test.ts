import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from './fixtures/mkrepo.ts'
import { PACKAGE, type Registry, startRegistry } from './fixtures/rehearsal/registry.ts'

// The rehearsal's npm registry (`test/fixtures/rehearsal/registry.ts`) is what
// moves a box forward in `scripts/rehearse-remote.sh ahead`, and that only
// runs on a box. What it promises can be held here: `tade-sh` answered out of
// a folder of staged tarballs, newest by its file's time as `latest`, with an
// integrity npm accepts, and everything else handed to the real registry as
// it was asked — which here is a stand-in, because the suite has no network.

interface Asked {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

/** A stand-in for registry.npmjs.org: what it was asked, and an answer per path. */
async function upstream(answers: Record<string, { type: string; body: Buffer | string }>) {
  const asked: Asked[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = req.url ?? '/'
      asked.push({
        method: req.method ?? 'GET',
        url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const answer = answers[url.split('?')[0] ?? url]
      if (answer === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not found"}')
        return
      }
      res.writeHead(200, { 'content-type': answer.type })
      res.end(answer.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    asked,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** An npm tarball of `manifest` and one file, the way `npm pack` lays it out: under `package/`. */
function pack(dir: string, manifest: Record<string, unknown>, file: string, text: string): Buffer {
  const root = join(dir, `src-${String(manifest.name)}-${String(manifest.version)}`)
  mkdirSync(join(root, 'package'), { recursive: true })
  writeFileSync(join(root, 'package', 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(root, 'package', file), text)
  const out = join(root, 'out.tgz')
  const made = spawnSync('tar', ['-czf', out, '-C', root, 'package'], { encoding: 'utf8' })
  expect(made.status, made.stderr).toBe(0)
  return readFileSync(out)
}

/** Stage `version` in `dir` as `ahead` does: its tarball and its manifest beside it, the tarball dated `at`. */
function stage(dir: string, version: string, at: number, extra: Record<string, unknown> = {}) {
  const manifest = { name: PACKAGE, version, ...extra }
  const bytes = pack(dir, manifest, 'index.js', `module.exports = '${version}'\n`)
  const tarball = join(dir, `${PACKAGE}-${version}.tgz`)
  writeFileSync(tarball, bytes)
  writeFileSync(join(dir, `${PACKAGE}-${version}.json`), JSON.stringify(manifest))
  utimesSync(tarball, at, at)
  return bytes
}

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((one) => one.close()))
})

async function registryOver(dir: string, up: { url: string; close(): Promise<void> }) {
  open.push(up)
  const registry: Registry = await startRegistry({ dir, upstream: `${up.url}/` })
  open.push(registry)
  return registry
}

describe("the rehearsal's npm registry", () => {
  it('answers for tade-sh with every staged version, the newest by its time as latest', async () => {
    const dir = tmp('tade-registry-')
    // Named so that by name the older would sort last: latest is the file's time, not its version.
    const newer = stage(dir, '0.4.4-rehearsal.10', 2_000_000)
    stage(dir, '0.4.4-rehearsal.9', 1_000_000)
    // A manifest whose tarball never arrived is not a version anybody can install.
    writeFileSync(join(dir, `${PACKAGE}-0.4.4-rehearsal.11.json`), '{}')
    const registry = await registryOver(dir, await upstream({}))

    const answer = await fetch(`${registry.url}/${PACKAGE}`)
    expect(answer.status).toBe(200)
    const packument = (await answer.json()) as {
      name: string
      'dist-tags': { latest: string }
      versions: Record<
        string,
        {
          name: string
          version: string
          _id: string
          dist: { tarball: string; integrity: string; shasum: string }
        }
      >
    }
    expect(packument.name).toBe(PACKAGE)
    expect(packument['dist-tags'].latest).toBe('0.4.4-rehearsal.10')
    expect(Object.keys(packument.versions).sort()).toEqual([
      '0.4.4-rehearsal.10',
      '0.4.4-rehearsal.9',
    ])
    const version = packument.versions['0.4.4-rehearsal.10']
    expect(version?._id).toBe(`${PACKAGE}@0.4.4-rehearsal.10`)
    expect(version?.dist).toEqual({
      tarball: `${registry.url}/${PACKAGE}/-/${PACKAGE}-0.4.4-rehearsal.10.tgz`,
      integrity: `sha512-${createHash('sha512').update(newer).digest('base64')}`,
      shasum: createHash('sha1').update(newer).digest('hex'),
    })

    const tarball = await fetch(version?.dist.tarball ?? '')
    expect(tarball.status).toBe(200)
    expect(Buffer.from(await tarball.arrayBuffer()).equals(newer)).toBe(true)
  })

  it('says what is not staged rather than asking the real registry for it', async () => {
    const empty = tmp('tade-registry-')
    const up = await upstream({})
    const registry = await registryOver(join(empty, 'never-made'), up)

    const packument = await fetch(`${registry.url}/${PACKAGE}`)
    expect(packument.status).toBe(404)
    expect(((await packument.json()) as { error: string }).error).toContain('no tade-sh is staged')
    const tarball = await fetch(`${registry.url}/${PACKAGE}/-/${PACKAGE}-9.9.9.tgz`)
    expect(tarball.status).toBe(404)
    expect(((await tarball.json()) as { error: string }).error).toContain('is not staged')
    expect(up.asked).toEqual([])
  })

  it('hands every other request to the real registry as it was asked', async () => {
    const dir = tmp('tade-registry-')
    const up = await upstream({
      '/left-pad': { type: 'application/json', body: '{"name":"left-pad"}' },
    })
    const registry = await registryOver(dir, up)

    const got = await fetch(`${registry.url}/left-pad?write=true`, {
      headers: { accept: 'application/vnd.npm.install-v1+json', 'npm-command': 'install' },
    })
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('application/json')
    expect(await got.json()).toEqual({ name: 'left-pad' })

    const posted = await fetch(`${registry.url}/-/npm/v1/security/advisories/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"left-pad":["1.3.0"]}',
    })
    expect(posted.status).toBe(404)

    expect(up.asked.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'GET', url: '/left-pad?write=true', body: '' },
      { method: 'POST', url: '/-/npm/v1/security/advisories/bulk', body: '{"left-pad":["1.3.0"]}' },
    ])
    expect(up.asked[0]?.headers.accept).toBe('application/vnd.npm.install-v1+json')
    expect(up.asked[0]?.headers['npm-command']).toBe('install')
    expect(up.asked[1]?.headers['content-type']).toBe('application/json')
  })

  it('answers 502 with what went wrong when the real registry cannot be asked', async () => {
    const dir = tmp('tade-registry-')
    const gone = await upstream({})
    await gone.close()
    const registry = await registryOver(dir, { url: gone.url, close: async () => {} })

    const got = await fetch(`${registry.url}/left-pad`)
    expect(got.status).toBe(502)
    expect(((await got.json()) as { error: string }).error).toContain('could not be asked')
  })

  // What `tade host upgrade --to` runs on a box, against the registry the box's
  // ~/.npmrc names: the staged version comes from the folder, and its
  // dependency from the real registry through it.
  it('is a registry npm installs a staged tade-sh and its dependency from', async () => {
    const dir = tmp('tade-registry-')
    const dependency = { name: 'rehearsal-dep', version: '1.0.0' }
    const depBytes = pack(dir, dependency, 'index.js', "module.exports = 'dep'\n")
    // Read per request, so the packument can name its tarball on the stand-in once its address is known.
    const answers: Record<string, { type: string; body: Buffer | string }> = {
      '/rehearsal-dep/-/rehearsal-dep-1.0.0.tgz': {
        type: 'application/octet-stream',
        body: depBytes,
      },
    }
    const up = await upstream(answers)
    answers['/rehearsal-dep'] = {
      type: 'application/json',
      body: JSON.stringify({
        name: 'rehearsal-dep',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            ...dependency,
            dist: {
              tarball: `${up.url}/rehearsal-dep/-/rehearsal-dep-1.0.0.tgz`,
              integrity: `sha512-${createHash('sha512').update(depBytes).digest('base64')}`,
            },
          },
        },
      }),
    }
    stage(dir, '0.4.4-rehearsal.2', 1_000_000, { dependencies: { 'rehearsal-dep': '^1.0.0' } })
    const registry = await registryOver(dir, up)
    const prefix = tmp('tade-registry-prefix-')
    const home = tmp('tade-registry-home-')
    writeFileSync(join(home, '.npmrc'), `registry=${registry.url}/\n`)
    writeFileSync(join(home, 'globalrc'), '')
    // A box's npm reads its ~/.npmrc and nothing else; this machine's may have
    // `NPM_CONFIG_REGISTRY` and the like set, which win over any file.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)),
    )
    // Not spawnSync: the registry and its stand-in answer on this process's event loop.
    // It rejects with npm's own words when the install fails.
    await promisify(execFile)(
      'npm',
      [
        'install',
        '--global',
        `${PACKAGE}@0.4.4-rehearsal.2`,
        '--prefix',
        prefix,
        '--cache',
        join(home, 'cache'),
        '--userconfig',
        join(home, '.npmrc'),
        '--globalconfig',
        join(home, 'globalrc'),
        '--no-audit',
        '--no-fund',
        '--no-update-notifier',
      ],
      { encoding: 'utf8', timeout: 120_000, env: { ...env, HOME: home } },
    )
    const at = join(prefix, 'lib', 'node_modules', PACKAGE)
    expect(JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')).version).toBe(
      '0.4.4-rehearsal.2',
    )
    expect(readFileSync(join(at, 'node_modules', 'rehearsal-dep', 'index.js'), 'utf8')).toBe(
      "module.exports = 'dep'\n",
    )
    const upstreamWasAsked = up.asked.map(({ url }) => url.split('?')[0])
    expect(upstreamWasAsked).toContain('/rehearsal-dep')
    expect(upstreamWasAsked.filter((url) => url?.includes(PACKAGE))).toEqual([])
  })
})
