import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draw } from '../src/view.ts'
import { SCENARIOS } from '../test/screens/scenarios.ts'
import { ansiToHtml } from './ansi-html.ts'
import { cropGrid, shot } from './ansi-svg.ts'
import { capture, TAKES, unchanged, unreadable } from './capture.ts'
import { panelBox, writePictures } from './pictures.ts'

// A page of every protected screen, in colour, for a person to look at, the
// pictures the README is made of, and a photograph of the running window.
//
//   pnpm screens [out.html]          the page
//   pnpm screens --assets [dir]      the README's pictures, as SVG
//   pnpm screens --live [dir]        the real `tade`, run and photographed
//
// `--live` is the check on the other two: it starts the actual binary in a
// real terminal on a disposable home with real repositories in it, presses
// real keys, and writes what the program painted. Use it after a change to
// how the window looks — the pictures come from the scenarios, and this says
// whether the scenarios still come from the program. `--live <dir> --home
// ~/.tade` photographs your own window instead of a seeded one.
//
// Each screen is drawn from the scenarios the golden tests use. Where the
// drawing no longer matches its golden file, the page shows both, the golden
// one first, so reviewing a change to how Tade looks means looking at it.
//
// The pictures come from the same scenarios, which is what keeps the README
// showing the window Tade actually has: they are regenerated, never taken by
// hand. `images/` at the top of the repository is where they live, because
// that is where the README and the site built from it look for them.

const here = dirname(fileURLToPath(import.meta.url))
const goldens = join(here, '..', 'test', 'screens', '__screens__')
const repo = join(here, '..', '..', '..')
const args = process.argv.slice(2)

const live = args.indexOf('--live')
if (live >= 0) {
  const next = args[live + 1]
  const dir = resolve(next && !next.startsWith('--') ? next : join(process.cwd(), 'tade-live'))
  const at = args.indexOf('--home')
  const home = at >= 0 ? args[at + 1] : undefined
  mkdirSync(dir, { recursive: true })
  const taken = await capture(TAKES, {
    ...(home ? { home } : {}),
    onTake: (take, n, of) => process.stdout.write(`${String(n).padStart(2)}/${of}  ${take.name}\n`),
  })
  for (const one of taken) {
    const grid = one.take.crop
      ? cropGrid(one.grid, one.take.crop === 'panel' ? panelBox(one.grid) : one.take.crop)
      : one.grid
    const svg = shot(grid, one.take.title === undefined ? {} : { title: one.take.title })
    writeFileSync(join(dir, `${one.take.name}.svg`), svg)
    writeFileSync(join(dir, `${one.take.name}.ansi`), `${one.rows.join('\n')}\n`)
  }
  const missed = unreadable(taken)
  // Said, never swallowed: a picture drawn from a stream nobody could read
  // looks exactly like one that was read, and so does one of the screen
  // before it.
  if (missed.length > 0) process.stdout.write(`could not read: ${missed.join(', ')}\n`)
  const same = unchanged(taken)
  if (same.length > 0) process.stdout.write(`showed the screen before it: ${same.join(', ')}\n`)
  process.stdout.write(`${dir} · ${taken.length} photographed\n`)
  process.exit(0)
}

const assets = args.indexOf('--assets')
if (assets >= 0) {
  const dir = resolve(args[assets + 1] ?? join(repo, 'images'))
  let total = 0
  for (const written of writePictures(dir)) {
    total += written.bytes
    process.stdout.write(`${written.file.padEnd(20)} ${(written.bytes / 1024).toFixed(1)} KB\n`)
  }
  process.stdout.write(`${dir} · ${(total / 1024).toFixed(0)} KB in all\n`)
  process.exit(0)
}

const out = resolve(args[0] ?? join(process.cwd(), 'tade-screens.html'))

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const pre = (rows: string[]) => `<pre>${rows.map((row) => ansiToHtml(row)).join('\n')}</pre>`

const sections = SCENARIOS.map((scenario) => {
  const rows = draw(scenario.state, scenario.frame).rows
  const golden = read(join(goldens, `${scenario.name}.ansi`))
  const changed = golden !== null && golden !== `${rows.join('\n')}\n`
  const status = golden === null ? 'new' : changed ? 'changed' : 'unchanged'
  const body = changed
    ? `<div class="pair"><div><h3>Golden</h3>${pre(golden.trimEnd().split('\n'))}</div><div><h3>Now</h3>${pre(rows)}</div></div>`
    : pre(rows)
  return `<section class="${status}"><h2>${scenario.name} <small>${status} · ${scenario.frame.width}×${scenario.frame.height}</small></h2><p>${scenario.about}</p>${body}</section>`
})

mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  `<title>Tade Screens</title>
<style>
  body { background: #121212; color: #ddd; font: 15px/1.5 system-ui, sans-serif; padding: 24px 20px 80px; }
  h1 { font-weight: 600; } h2 { font-size: 18px; margin: 36px 0 4px; } h2 small { color: #888; font-weight: 400; }
  h3 { font-size: 13px; color: #888; margin: 8px 0; } p { color: #aaa; margin: 0 0 10px; }
  pre { background: #1c1c1c; color: #dadada; font: 12.5px/1.2 "JetBrains Mono", Menlo, monospace; padding: 12px; overflow-x: auto; border-radius: 6px; margin: 0; }
  .changed h2 { color: #d7af5f; } .new h2 { color: #5fd7d7; }
  .pair { display: grid; gap: 12px; }
</style>
<h1>Tade screens</h1>
<p>${SCENARIOS.length} screens. Drawn from <code>packages/app/test/screens/scenarios.ts</code>.</p>
${sections.join('\n')}`,
)
process.stdout.write(`${out}\n`)
