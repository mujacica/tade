// Version numbers, and what a dependency's requirement says about them.
//
// Not a full semver or PEP 440 implementation: what matters here is which
// version a requirement starts from, how far behind the newest release that
// is, and whether the requirement can be moved forward by changing its number
// alone. Anything cleverer than one operator and one version — a range, an
// `||`, a wildcard — is reported and left exactly as written, because
// rewriting a constraint somebody chose is not a dependency update.

export type Ecosystem = 'npm' | 'pypi' | 'cargo' | 'go'

export interface Version {
  major: number
  minor: number
  patch: number
  /** A pre-release label, or empty for a release. */
  pre: string
  /** How many numbers were written: `1.2` is 2. */
  parts: number
}

/** How far a requirement is behind the newest release. */
export type Behind = 'current' | 'patch' | 'minor' | 'major'

const VERSION =
  /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[.-]?((?:a|b|rc|alpha|beta|pre|dev|post|next|canary)[.\w-]*|-[\w.-]+))?(?:\+[\w.-]+)?$/i

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim())
  if (!match) return null
  const parts = match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre: (match[4] ?? '').replace(/^-/, ''),
    parts,
  }
}

/** A release, as opposed to a beta or a release candidate. Post-releases count as releases. */
export function isStable(version: Version): boolean {
  return version.pre === '' || /^post/i.test(version.pre)
}

export function compareVersions(a: Version, b: Version): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    // A release sorts after its own pre-releases.
    (a.pre === '' ? (b.pre === '' ? 0 : 1) : b.pre === '' ? -1 : a.pre.localeCompare(b.pre))
  )
}

export function behind(current: Version, latest: Version): Behind {
  if (compareVersions(latest, current) <= 0) return 'current'
  if (latest.major !== current.major) return 'major'
  if (latest.minor !== current.minor) return 'minor'
  return 'patch'
}

/** A version written with as many numbers as another was: `~1.2` moves to `~2.0`, not `~2.0.1`. */
export function writeLike(like: Version, version: Version, prefix = ''): string {
  const numbers = [version.major, version.minor, version.patch].slice(0, Math.max(1, like.parts))
  return `${prefix}${numbers.join('.')}`
}

/** What a requirement says: the version it starts from, and how to move it. */
export interface Requirement {
  /** The version the requirement starts from. */
  version: Version
  /** The requirement with its version moved to another, operator and precision kept. Null when it cannot be. */
  rewrite: ((to: Version) => string) | null
  /** Why it is left alone, when it is. */
  leftAlone: string | null
}

/**
 * Read a requirement as one ecosystem writes it. Null when it names no version
 * at all — a git URL, a path, `workspace:*`, `*`.
 */
export function readRequirement(ecosystem: Ecosystem, raw: string): Requirement | null {
  const spec = raw.trim()
  if (spec === '' || spec === '*' || spec === 'latest') return null
  if (
    ecosystem === 'npm' &&
    /^(workspace:|file:|link:|portal:|catalog:|git|github:|https?:|[\w-]+\/[\w.-]+$)/.test(spec)
  ) {
    return null
  }
  if (ecosystem === 'go') {
    const version = parseVersion(spec)
    if (!version) return null
    return {
      version,
      // A new major is a new module path in Go, not a new number.
      rewrite: (to) => (to.major === version.major ? `v${to.major}.${to.minor}.${to.patch}` : spec),
      leftAlone: null,
    }
  }

  // One operator and one version, nothing else.
  const operators =
    ecosystem === 'pypi'
      ? ['===', '==', '~=', '>=']
      : ecosystem === 'cargo'
        ? ['^', '~', '=', '>=']
        : ['^', '~', '>=', '=', 'v']
  const single = /^(?<operator>[~^=<>!v]*)\s*(?<version>[\w.+-]+)$/.exec(spec)
  const range = /[\s,|]|\|\|/.test(spec) || /[xX*]/.test(single?.groups?.version ?? '')
  // A wildcard's version is the numbers before it: `1.x` starts from 1.
  const written = single?.groups?.version ?? spec.replace(/^[^\d]*/, '').split(/[\s,|<]/)[0] ?? ''
  const version = parseVersion(written.replace(/\.[xX*].*$/, ''))
  if (!version) return null
  const operator = single?.groups?.operator ?? ''
  if (range || !single) {
    return { version, rewrite: null, leftAlone: 'a range, left as written' }
  }
  if (operator !== '' && !operators.includes(operator)) {
    return { version, rewrite: null, leftAlone: `"${operator}" is a ceiling, left as written` }
  }
  return {
    version,
    rewrite: (to) => writeLike(version, to, operator === 'v' ? '' : operator),
    leftAlone: null,
  }
}
