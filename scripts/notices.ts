import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NOTICES, stampFor } from './notices-stamp.ts'

// Writes THIRD_PARTY_NOTICES.md: every package Tade installs, with its licence
// and the licence text it ships, then the programs, services and data Tade
// uses without installing them. Run it after changing dependencies:
//
//   pnpm notices
//
// Generated from what is actually installed, so it cannot drift from the
// lockfile the way a hand-kept list would — and stamped with what it was
// generated from, so a test can say when somebody changed a dependency and
// did not run this. `notices-stamp.ts` says what that holds and what it does
// not.

interface Licensed {
  name: string
  versions: string[]
  paths: string[]
  license: string
  author?: string
  homepage?: string
}

const root = new URL('..', import.meta.url).pathname

function listed(prodOnly: boolean): Licensed[] {
  const out = execFileSync(
    'pnpm',
    ['licenses', 'list', '--json', ...(prodOnly ? ['--prod'] : [])],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  return Object.values(JSON.parse(out) as Record<string, Licensed[]>).flat()
}

/** The licence text a package ships, if it ships one. */
function licenceText(paths: readonly string[]): string | null {
  for (const dir of paths) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const file = names.find((name) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(name))
    if (file && existsSync(join(dir, file))) return readFileSync(join(dir, file), 'utf8').trim()
  }
  return null
}

// Everything, then which of it Tade needs to run rather than only to be developed.
const running = new Set(listed(true).map((one) => one.name))
const packages = new Map<string, Licensed & { dev: boolean }>()
for (const one of listed(false)) {
  const known = packages.get(one.name)
  if (known) known.versions = [...new Set([...known.versions, ...one.versions])]
  else packages.set(one.name, { ...one, dev: !running.has(one.name) })
}

const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
const counts = new Map<string, number>()
for (const one of sorted) counts.set(one.license, (counts.get(one.license) ?? 0) + 1)

const lines: string[] = [
  '# Third-party notices',
  '',
  'Tade is MIT licensed (see [LICENSE](LICENSE)). It is built on, runs, and talks to the work of',
  'many other people, listed here with their licences.',
  '',
  stampFor(root),
  '',
  '## Programs Tade runs',
  '',
  'Tade starts these as separate programs when they are installed, and ships none of them itself —',
  'with one exception. pi is also a dependency: the published `tade-sh` declares',
  '`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, so installing Tade installs pi',
  'with it. Its packages are in the Packages table below, with their licence and author.',
  '',
  '| Program | Used for | Licence |',
  '|---|---|---|',
  '| [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) | an agent harness, and the one the orchestrator runs in | MIT |',
  "| [Claude Code](https://code.claude.com) (`claude`) | an agent harness, run unmodified and signed in with your own account | Anthropic's [Commercial](https://www.anthropic.com/legal/commercial-terms) or [Consumer](https://www.anthropic.com/legal/consumer-terms) Terms, as your plan says |",
  "| [Codex](https://developers.openai.com/codex) (`codex`) | an agent harness, run unmodified and signed in with your own account | OpenAI's [Services Agreement](https://openai.com/policies/services-agreement/) or [Terms of Use](https://openai.com/policies/terms-of-use/), as your plan says |",
  '| [git](https://git-scm.com) | worktrees, branches, status, search | GPL-2.0 |',
  '| [tmux](https://github.com/tmux/tmux) | lanes that outlive the window | ISC |',
  '| [GitHub CLI](https://cli.github.com) (`gh`) | the credential Tade reads reviews and checks with, per account and host | MIT |',
  '| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | local speech to text | MIT |',
  '| [Whisper models](https://github.com/openai/whisper) (ggml conversions) | the model whisper.cpp listens with | MIT |',
  '| [FFmpeg](https://ffmpeg.org) | recording from the microphone | LGPL-2.1-or-later (GPL builds: GPL-2.0-or-later) |',
  '| macOS `say`, `afplay`, `osascript`, `open` | speech, earcons, the clipboard, opening links | Apple system software |',
  '| [wl-clipboard](https://github.com/bugaevc/wl-clipboard), [xclip](https://github.com/astrand/xclip) | reading a pasted screenshot on Linux | GPL-3.0, GPL-2.0-or-later |',
  '| [sentry-cli](https://github.com/getsentry/sentry-cli) and the [Sentry CLI](https://github.com/getsentry/cli) | Tade reads the credentials they store, never their code | see their repositories |',
  '| Your editor (VS Code, Cursor, Zed, …) | opening a file at a line | see each editor |',
  '',
  '## Services and data',
  '',
  '| Service | Used for | Terms |',
  '|---|---|---|',
  '| [OSV.dev](https://osv.dev) | known vulnerabilities, in the dependencies extension | data under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/); vulnerability data © the OSV contributors and the databases it aggregates |',
  '| [npm registry](https://www.npmjs.com), [PyPI](https://pypi.org), [crates.io](https://crates.io), [Go module proxy](https://proxy.golang.org) | newest releases, in the dependencies extension | each registry’s terms of use |',
  '| [GitHub](https://github.com) API (REST and GraphQL) | reviews, their checks and their conversations, in the reviews extension, with your own credential | [GitHub’s terms](https://docs.github.com/site-policy/github-terms/github-terms-of-service) |',
  '| [Sentry](https://sentry.io) API | issues, events, traces, logs, metrics and Seer, in the Sentry extension | [Sentry’s terms](https://sentry.io/terms/) |',
  '| [TypeSafe](https://typesafe.ai) API (Jev) | judging diffs, logs, requests, plans and queues, in the Jev extension, with your own key | [TypeSafe’s terms](https://typesafe.ai) |',
  '| Model providers (Anthropic, OpenAI, OpenRouter, …) | through pi, with your own credentials | each provider’s terms |',
  '',
  'The Sentry extension’s use of the API follows what Sentry’s own',
  '[sentry-mcp](https://github.com/getsentry/sentry-mcp) and [CLI](https://github.com/getsentry/cli) do;',
  'they were read as a reference, and no code was copied from them.',
  '',
  '## Packages',
  '',
  `${sorted.length} packages are installed to develop Tade, and every one of them is listed here.`,
  'What `tade-sh` installs is a subset: the *dev* marker is pnpm’s own production/development',
  'split, which reads wider than what ships, because a package carrying a conformance suite',
  'declares `vitest` as a dependency (R4) and its whole tree then counts as production. So this',
  'credits more than Tade distributes, never less. Their licences:',
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([license, n]) => `${n} ${license}`)
    .join(', '),
  '',
  '| Package | Version | Licence | Author |',
  '|---|---|---|---|',
  ...sorted.map(
    (one) =>
      `| ${one.homepage ? `[${one.name}](${one.homepage})` : one.name}${one.dev ? ' *dev*' : ''} | ${one.versions.join(', ')} | ${one.license} | ${(one.author ?? '').replace(/\|/g, '\\|')} |`,
  ),
  '',
  '## Licence texts',
  '',
  'As each package ships it.',
  '',
]

for (const one of sorted) {
  const text = licenceText(one.paths)
  lines.push(`### ${one.name} ${one.versions.join(', ')}`, '', `Licence: ${one.license}`, '')
  if (text) lines.push('```', text.replace(/```/g, "'''"), '```', '')
  else
    lines.push(
      'The package ships no licence file; its package.json declares the licence above.',
      '',
    )
}

writeFileSync(join(root, NOTICES), `${lines.join('\n')}\n`)
console.log(`${NOTICES}: ${sorted.length} packages`)
