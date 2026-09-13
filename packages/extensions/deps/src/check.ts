import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Dependency, ecosystemOf, readManifests, rewrite } from './manifests.ts'
import { latest, type Registries, vulnerabilities } from './registries.ts'
import { type Behind, behind, type Ecosystem, parseVersion, readRequirement } from './versions.ts'

// Checking a project's dependencies, and moving them forward.

export interface Finding {
  dependency: Dependency
  /** The newest release, when the registry said. */
  latest: string | null
  behind: Behind | null
  /** The requirement with its version moved to the newest release, when it can be moved. */
  to: string | null
  /** Why it was not moved: a range, a ceiling, no version at all. */
  leftAlone: string | null
  vulnerabilities: string[]
  deprecated: string | null
  /** Why nothing could be found out about it. */
  problem: string | null
}

export interface Report {
  manifests: string[]
  findings: Finding[]
  /** Whether vulnerabilities were looked up — false when OSV could not be asked. */
  checkedVulnerabilities: boolean
}

export type Level = 'patch' | 'minor' | 'major'

const WITHIN: Record<Level, readonly Behind[]> = {
  patch: ['patch'],
  minor: ['patch', 'minor'],
  major: ['patch', 'minor', 'major'],
}

/** At most this many registry questions at once. */
const AT_ONCE = 8

export async function check(options: {
  root: string
  files: readonly string[]
  fetch: typeof fetch
  registries: Registries
  ignore?: readonly string[]
  vulnerabilities?: boolean
  onProgress?: (text: string) => void
}): Promise<Report> {
  const manifests = options.files.filter(
    (file) => ecosystemOf(file) !== null && !/(^|\/)node_modules\//.test(file),
  )
  const dependencies = readManifests(options.root, manifests).filter(
    (dependency) => !(options.ignore ?? []).includes(dependency.name),
  )

  // One question per package, however many manifests name it.
  const asked = new Map<string, ReturnType<typeof latest>>()
  const keys = [
    ...new Set(dependencies.map((dependency) => `${dependency.ecosystem}\0${dependency.name}`)),
  ]
  let done = 0
  await pool(keys, AT_ONCE, async (key) => {
    const [ecosystem, name] = key.split('\0') as [Ecosystem, string]
    const exact = dependencies.find((one) => one.ecosystem === ecosystem && one.name === name)
    const version = exact ? readRequirement(ecosystem, exact.spec)?.version : null
    const current = version ? `${version.major}.${version.minor}.${version.patch}` : null
    const answer = latest(options.fetch, options.registries, ecosystem, name, current)
    asked.set(key, answer)
    await answer
    done++
    if (done % 10 === 0 || done === keys.length)
      options.onProgress?.(`asked about ${done} of ${keys.length} packages`)
  })

  const findings: Finding[] = []
  for (const dependency of dependencies) {
    const found = await asked.get(`${dependency.ecosystem}\0${dependency.name}`)
    const requirement = readRequirement(dependency.ecosystem, dependency.spec)
    const newest = found?.version ? parseVersion(found.version) : null
    if (!requirement) {
      findings.push({
        dependency,
        latest: found?.version ?? null,
        behind: null,
        to: null,
        leftAlone: 'names no version',
        vulnerabilities: [],
        deprecated: null,
        problem: null,
      })
      continue
    }
    const far = newest ? behind(requirement.version, newest) : null
    const moved =
      newest && requirement.rewrite && far && far !== 'current' ? requirement.rewrite(newest) : null
    findings.push({
      dependency,
      latest: found?.version ?? null,
      behind: far,
      to: moved && moved !== dependency.spec ? moved : null,
      leftAlone:
        requirement.leftAlone ??
        (far === 'major' && dependency.ecosystem === 'go'
          ? 'a new major is a new module path in Go'
          : null),
      vulnerabilities: [],
      deprecated: found?.deprecated ?? null,
      problem: found?.problem ?? null,
    })
  }

  let checkedVulnerabilities = false
  if (options.vulnerabilities !== false) {
    const exact = findings.filter((finding) => {
      const version = readRequirement(
        finding.dependency.ecosystem,
        finding.dependency.spec,
      )?.version
      return version !== undefined && version.parts === 3
    })
    const found = await vulnerabilities(
      options.fetch,
      options.registries,
      exact.map((finding) => {
        const version = readRequirement(
          finding.dependency.ecosystem,
          finding.dependency.spec,
        )?.version
        return {
          ecosystem: finding.dependency.ecosystem,
          name: finding.dependency.name,
          version: version ? `${version.major}.${version.minor}.${version.patch}` : '',
        }
      }),
    )
    if (found) {
      checkedVulnerabilities = true
      exact.forEach((finding, i) => {
        finding.vulnerabilities = found[i] ?? []
      })
    }
  }
  return { manifests, findings, checkedVulnerabilities }
}

export interface Change {
  manifest: string
  name: string
  from: string
  to: string
  behind: Behind
}

/** What an update to this level would change, without changing it. */
export function planUpdate(report: Report, level: Level, only: readonly string[] = []): Change[] {
  return report.findings
    .filter((finding) => finding.to && finding.behind && WITHIN[level].includes(finding.behind))
    .filter((finding) => only.length === 0 || only.includes(finding.dependency.name))
    .map((finding) => ({
      manifest: finding.dependency.manifest,
      name: finding.dependency.name,
      from: finding.dependency.spec,
      to: finding.to ?? finding.dependency.spec,
      behind: finding.behind ?? 'patch',
    }))
}

/** Write the changes into the manifests under a folder, each in place. */
export function applyUpdate(root: string, report: Report, changes: readonly Change[]): void {
  const byManifest = new Map<string, Finding[]>()
  for (const finding of report.findings) {
    const change = changes.find(
      (one) =>
        one.manifest === finding.dependency.manifest &&
        one.name === finding.dependency.name &&
        one.from === finding.dependency.spec,
    )
    if (!change) continue
    byManifest.set(finding.dependency.manifest, [
      ...(byManifest.get(finding.dependency.manifest) ?? []),
      finding,
    ])
  }
  for (const [manifest, findings] of byManifest) {
    const path = join(root, manifest)
    const text = readFileSync(path, 'utf8')
    writeFileSync(
      path,
      rewrite(
        text,
        findings.map((finding) => ({
          start: finding.dependency.start,
          end: finding.dependency.end,
          to: finding.to ?? finding.dependency.spec,
        })),
      ),
    )
  }
}

/** The command that brings a lockfile in line with its manifests, by the lockfiles a project has. */
export function installCommands(files: readonly string[]): string[] {
  const has = (name: string) => files.some((file) => file === name || file.endsWith(`/${name}`))
  const commands: string[] = []
  if (has('pnpm-lock.yaml')) commands.push('pnpm install')
  else if (has('yarn.lock')) commands.push('yarn install')
  else if (has('bun.lock') || has('bun.lockb')) commands.push('bun install')
  else if (has('package-lock.json') || has('package.json')) commands.push('npm install')
  if (has('uv.lock')) commands.push('uv lock')
  else if (has('poetry.lock')) commands.push('poetry lock')
  if (has('Cargo.toml')) commands.push('cargo update --workspace')
  if (has('go.mod')) commands.push('go mod tidy')
  return commands
}

/** The report, as something to read. */
export function describeReport(project: string, report: Report, limit = 80): string {
  const { findings } = report
  const behindOnes = findings.filter((finding) => finding.behind && finding.behind !== 'current')
  const count = (kind: Behind) => behindOnes.filter((finding) => finding.behind === kind).length
  const vulnerable = findings.filter((finding) => finding.vulnerabilities.length > 0)
  const deprecated = findings.filter((finding) => finding.deprecated)
  const unknown = findings.filter((finding) => finding.problem)

  // Workspace packages, paths and git URLs have no release to be behind.
  const versioned = findings.filter((finding) => finding.leftAlone !== 'names no version')
  const local = findings.length - versioned.length
  const summary = [
    `${versioned.length} dependencies in ${report.manifests.length} manifest${report.manifests.length === 1 ? '' : 's'}${local > 0 ? ` (and ${local} from the workspace, a path or git)` : ''}`,
    behindOnes.length === 0
      ? 'all current'
      : `${behindOnes.length} behind (${[`${count('major')} major`, `${count('minor')} minor`, `${count('patch')} patch`].filter((part) => !part.startsWith('0 ')).join(', ')})`,
    report.checkedVulnerabilities
      ? `${vulnerable.length} with known vulnerabilities`
      : 'vulnerabilities not checked',
    ...(deprecated.length > 0 ? [`${deprecated.length} deprecated`] : []),
  ]
  const lines = [`**${project}**: ${summary.join(' · ')}`]

  const notable = findings.filter(
    (finding) =>
      (finding.behind && finding.behind !== 'current') ||
      finding.vulnerabilities.length > 0 ||
      finding.deprecated,
  )
  let manifest = ''
  for (const finding of notable.slice(0, limit)) {
    if (finding.dependency.manifest !== manifest) {
      manifest = finding.dependency.manifest
      lines.push('', `${manifest}`)
    }
    const parts = [`- ${finding.dependency.name} ${finding.dependency.spec}`]
    if (finding.latest && finding.behind !== 'current')
      parts.push(`→ ${finding.latest} (${finding.behind})`)
    if (finding.leftAlone && finding.behind !== 'current') parts.push(`— ${finding.leftAlone}`)
    if (finding.vulnerabilities.length > 0)
      parts.push(`· vulnerable: ${finding.vulnerabilities.join(', ')}`)
    if (finding.deprecated) parts.push(`· deprecated: ${finding.deprecated}`)
    lines.push(parts.join(' '))
  }
  if (notable.length > limit) lines.push('', `…and ${notable.length - limit} more`)
  if (unknown.length > 0) {
    lines.push(
      '',
      `Could not check ${unknown.length}: ${unknown
        .slice(0, 10)
        .map((finding) => `${finding.dependency.name} (${finding.problem})`)
        .join(', ')}${unknown.length > 10 ? ', …' : ''}`,
    )
  }
  return lines.join('\n')
}

async function pool<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]
        if (item !== undefined) await work(item)
      }
    }),
  )
}
