import { compareVersions, type Ecosystem, isStable, parseVersion } from './versions.ts'

// Asking each ecosystem's registry what the newest release is, and OSV which
// versions have known vulnerabilities. Every question degrades to "could not
// tell", with the reason: a registry being down is not a reason to report
// nothing about everything else.

export interface Latest {
  /** The newest release, or null when it could not be found out. */
  version: string | null
  /** The version you require has been deprecated, and what its authors said. */
  deprecated: string | null
  /** Why there is no answer. */
  problem: string | null
}

export interface Registries {
  /** npm's registry, or a mirror of it. */
  npm: string
  pypi: string
  crates: string
  go: string
  osv: string
}

export const PUBLIC_REGISTRIES: Registries = {
  npm: 'https://registry.npmjs.org',
  pypi: 'https://pypi.org',
  crates: 'https://crates.io',
  go: 'https://proxy.golang.org',
  osv: 'https://api.osv.dev',
}

const TIMEOUT_MS = 15_000

async function getJson(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { 'user-agent': 'tade-dependency-check', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (response.status === 404) throw new Error('not found in its registry')
  if (!response.ok) throw new Error(`its registry answered ${response.status}`)
  return response.json()
}

/**
 * How old an npm release must be before it is proposed: pnpm installs nothing
 * younger than its `minimumReleaseAge` without writing a permanent exemption
 * for it into `pnpm-workspace.yaml`, so a younger one is not an update yet.
 */
export interface Cooldown {
  minutes: number
  now: number
}

/** The newest release of a package, and whether the version you use is deprecated. */
export async function latest(
  fetcher: typeof fetch,
  registries: Registries,
  ecosystem: Ecosystem,
  name: string,
  current: string | null,
  cooldown: Cooldown | null = null,
): Promise<Latest> {
  try {
    switch (ecosystem) {
      case 'npm': {
        const url = `${registries.npm}/${name.replace('/', '%2f')}`
        const doc = (await getJson(fetcher, url, {
          // The abbreviated document: versions and dist-tags, without every readme.
          accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
        })) as {
          'dist-tags'?: { latest?: string }
          versions?: Record<string, { deprecated?: string }>
          modified?: string
        }
        const tagged = doc['dist-tags']?.latest ?? null
        const deprecated = current ? (doc.versions?.[current]?.deprecated ?? null) : null
        const found =
          tagged && cooldown ? await settled(fetcher, url, doc, tagged, cooldown) : tagged
        return {
          version: found,
          deprecated: deprecated || null,
          problem: found
            ? null
            : tagged
              ? `every release up to ${tagged} is younger than ${cooldown?.minutes} minutes, pnpm's minimumReleaseAge`
              : 'it lists no latest release',
        }
      }
      case 'pypi': {
        const doc = (await getJson(
          fetcher,
          `${registries.pypi}/pypi/${encodeURIComponent(name)}/json`,
        )) as {
          info?: { version?: string }
          releases?: Record<string, unknown>
        }
        // `info.version` is the newest upload, which can be a pre-release.
        const releases = Object.keys(doc.releases ?? {})
          .map((version) => ({ version, parsed: parseVersion(version) }))
          .filter((one) => one.parsed && isStable(one.parsed))
        const newest = releases.sort((a, b) => compareParsed(b.parsed, a.parsed))[0]?.version
        const found = newest ?? doc.info?.version ?? null
        return { version: found, deprecated: null, problem: found ? null : 'it lists no releases' }
      }
      case 'cargo': {
        const doc = (await getJson(
          fetcher,
          `${registries.crates}/api/v1/crates/${encodeURIComponent(name)}`,
        )) as {
          crate?: { max_stable_version?: string; newest_version?: string }
        }
        const found = doc.crate?.max_stable_version ?? doc.crate?.newest_version ?? null
        return { version: found, deprecated: null, problem: found ? null : 'it lists no releases' }
      }
      case 'go': {
        const doc = (await getJson(fetcher, `${registries.go}/${goEscape(name)}/@latest`)) as {
          Version?: string
        }
        const found = doc.Version ?? null
        return { version: found, deprecated: null, problem: found ? null : 'it lists no releases' }
      }
    }
  } catch (err) {
    return {
      version: null,
      deprecated: null,
      problem: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * The newest stable release up to `tagged` that is older than the cooldown,
 * or null when none is. Only the full document says when each version was
 * published, and it can be megabytes, so it is asked for only when the
 * abbreviated one was modified inside the cooldown. A registry that says
 * nothing of either is taken at its `latest`, as before.
 */
async function settled(
  fetcher: typeof fetch,
  url: string,
  doc: { modified?: string },
  tagged: string,
  cooldown: Cooldown,
): Promise<string | null> {
  const cutoff = cooldown.now - cooldown.minutes * 60_000
  const modified = doc.modified ? Date.parse(doc.modified) : Number.NaN
  if (cooldown.minutes <= 0 || !(modified > cutoff)) return tagged
  const full = (await getJson(fetcher, url, { accept: 'application/json' })) as {
    time?: Record<string, string>
    versions?: Record<string, unknown>
  }
  const time = full.time
  const ceiling = parseVersion(tagged)
  if (!time || !ceiling) return tagged
  const old = Object.keys(full.versions ?? time)
    .map((version) => ({
      version,
      parsed: parseVersion(version),
      at: Date.parse(time[version] ?? ''),
    }))
    .filter(
      (one) =>
        one.parsed &&
        isStable(one.parsed) &&
        compareVersions(one.parsed, ceiling) <= 0 &&
        one.at <= cutoff,
    )
  old.sort((a, b) => (a.parsed && b.parsed ? compareVersions(b.parsed, a.parsed) : 0))
  return old[0]?.version ?? null
}

/** OSV's names for the ecosystems. */
const OSV_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  cargo: 'crates.io',
  go: 'Go',
}

/**
 * Known vulnerabilities affecting each package at a version, by index. One
 * question for all of them. Null when OSV could not be asked: unknown is not
 * the same as none.
 */
export async function vulnerabilities(
  fetcher: typeof fetch,
  registries: Registries,
  packages: readonly { ecosystem: Ecosystem; name: string; version: string }[],
): Promise<string[][] | null> {
  if (packages.length === 0) return []
  try {
    const response = await fetcher(`${registries.osv}/v1/querybatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'tade-dependency-check' },
      body: JSON.stringify({
        queries: packages.map((one) => ({
          package: { ecosystem: OSV_ECOSYSTEM[one.ecosystem], name: one.name },
          version: one.version.replace(/^v/, one.ecosystem === 'go' ? 'v' : ''),
        })),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    const doc = (await response.json()) as { results?: { vulns?: { id?: string }[] }[] }
    return packages.map((_, i) =>
      (doc.results?.[i]?.vulns ?? []).map((vuln) => vuln.id ?? '').filter((id) => id !== ''),
    )
  } catch {
    return null
  }
}

/** The Go module proxy writes capitals as `!` and the lowercase letter. */
export function goEscape(module: string): string {
  return module.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`)
}

function compareParsed(
  a: ReturnType<typeof parseVersion>,
  b: ReturnType<typeof parseVersion>,
): number {
  if (!a || !b) return 0
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}
