import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draw } from '../src/view.ts'
import { SCENARIOS } from '../test/screens/scenarios.ts'
import { ansiToHtml } from './ansi-html.ts'

// A page of every protected screen, in colour, for a person to look at.
//
//   pnpm screens [out.html]
//
// Each screen is drawn from the scenarios the golden tests use. Where the
// drawing no longer matches its golden file, the page shows both, the golden
// one first, so reviewing a change to how Wilco looks means looking at it.

const here = dirname(fileURLToPath(import.meta.url))
const goldens = join(here, '..', 'test', 'screens', '__screens__')
const out = resolve(process.argv[2] ?? join(process.cwd(), 'wilco-screens.html'))

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const pre = (rows: string[]) => `<pre>${rows.map(ansiToHtml).join('\n')}</pre>`

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
  `<title>Wilco Screens</title>
<style>
  body { background: #121212; color: #ddd; font: 15px/1.5 system-ui, sans-serif; padding: 24px 20px 80px; }
  h1 { font-weight: 600; } h2 { font-size: 18px; margin: 36px 0 4px; } h2 small { color: #888; font-weight: 400; }
  h3 { font-size: 13px; color: #888; margin: 8px 0; } p { color: #aaa; margin: 0 0 10px; }
  pre { background: #1c1c1c; color: #dadada; font: 12.5px/1.2 "JetBrains Mono", Menlo, monospace; padding: 12px; overflow-x: auto; border-radius: 6px; margin: 0; }
  .changed h2 { color: #d7af5f; } .new h2 { color: #5fd7d7; }
  .pair { display: grid; gap: 12px; }
</style>
<h1>Wilco screens</h1>
<p>${SCENARIOS.length} screens. Drawn from <code>packages/app/test/screens/scenarios.ts</code>.</p>
${sections.join('\n')}`,
)
process.stdout.write(`${out}\n`)
