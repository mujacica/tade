import { readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { getCapabilities } from '@earendil-works/pi-tui'
import { drawingDoor } from '@tade/web'
import { DRAWING_CEILING, drawingFor, wireBytes } from '@tade/web/drawing'
import { drawingPlan } from '../src/wire/drawing.ts'

// The window's drawing, in a real browser, against the goldens (§10 T2's
// "done when"): every golden scenario built and drawn **in the page**, by the
// files the away view serves at `/draw`, through its import map, and each
// screen held byte for byte to the `.ansi` golden Node drew.
//
//   node packages/app/scripts/browser-goldens.ts
//   TADE_BROWSER=/path/to/chrome node packages/app/scripts/browser-goldens.ts
//
// The scenarios themselves are loaded in the page too — the same modules, so
// "from the same state" is the same code making it rather than a copy of its
// output — with one swap beside the drawing's own: `test/screens/colours.ts`,
// which registers the machine's highlight.js, is `browser-colours.ts`, which
// registers the same version's ES build. A scenario that cannot load in a
// browser is a scenario reaching Node, and the build says which file.
//
// **It needs a browser, and says `unrun` when there is none**, as the away
// view's own harness does (`packages/web/scripts/browser.ts` says why
// Playwright is the machine's and not the lockfile's). Exit 0 all equal, 1 a
// screen differs or the drawing is over its ceiling, 2 unrun.

const HERE = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const SCREENS = HERE('../test/screens/__screens__/')

interface Engine {
  newContext: (
    opts: object,
  ) => Promise<{ newPage: () => Promise<Page>; close: () => Promise<void> }>
  close: () => Promise<void>
}

interface Page {
  on: (event: 'pageerror', hear: (problem: unknown) => void) => void
  goto: (url: string) => Promise<unknown>
  /** The snippet is a string: it runs in the browser, not in this program. */
  evaluate: (body: string) => Promise<unknown>
}

const PLAYWRIGHT = 'playwright'

async function browser(): Promise<{ made: Engine | null; why: string }> {
  let loaded: { chromium: { launch: (opts: object) => Promise<Engine> } }
  try {
    loaded = await import(PLAYWRIGHT)
  } catch {
    return { made: null, why: 'playwright is not installed on this machine' }
  }
  const here = process.env.TADE_BROWSER
  const opts = { headless: true, ...(here === undefined ? {} : { executablePath: here }) }
  try {
    return { made: await loaded.chromium.launch(opts), why: '' }
  } catch (problem) {
    return { made: null, why: `a browser could not be started: ${String(problem)}` }
  }
}

const plan = await drawingPlan()
const scenarios = HERE('../test/screens/scenarios.ts')
const built = await drawingFor({
  roots: [...plan.roots, { file: scenarios }],
  swaps: { ...plan.swaps, [HERE('../test/screens/colours.ts')]: HERE('./browser-colours.ts') },
})
const door = drawingDoor(async () => built)
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://here').pathname
  const rest = path.startsWith('/draw/') ? path.slice('/draw/'.length) : null
  const answered = rest === null ? Promise.resolve(false) : door.answer(req, res, rest)
  void answered.then(
    (served) => {
      if (!served) res.writeHead(404).end()
    },
    (problem: unknown) => {
      process.stderr.write(`${String(problem)}\n`)
      res.writeHead(500).end()
    },
  )
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0

const wire = await wireBytes(built)
const scenariosServed = [...built.files.values()].find(
  (one) => one.file === realpathSync(scenarios),
)
if (scenariosServed === undefined)
  throw new Error('the scenarios are not in what the drawing serves')
const scenariosUrl = `/draw/${built.version}/${scenariosServed.path}`
const over = wire.raw > DRAWING_CEILING.rawKb * 1024 || wire.wire > DRAWING_CEILING.wireKb * 1024
process.stdout.write(
  `the drawing: ${built.files.size} files, ${(wire.raw / 1024).toFixed(1)} KB raw ` +
    `(ceiling ${DRAWING_CEILING.rawKb}), ${(wire.wire / 1024).toFixed(1)} KB brotli ` +
    `(ceiling ${DRAWING_CEILING.wireKb})${over ? ' — OVER' : ''}\n`,
)

const { made, why } = await browser()
if (made === null) {
  process.stdout.write(`unrun: ${why}\n`)
  server.close()
  process.exit(2)
}
const context = await made.newContext({})
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (problem) => errors.push(String(problem)))
await page.goto(`http://127.0.0.1:${port}/draw/`)
// What the machine's terminal detection answers here is what the goldens were
// drawn under, so the page is told the same before anything is laid out.
const capabilities = JSON.stringify(getCapabilities())
const drawn = (await page.evaluate(`(async () => {
  const entry = document.querySelector('meta[name="tade-drawing"]').content
  const window = await import(entry)
  window.setCapabilities(${capabilities})
  const { SCENARIOS } = await import(${JSON.stringify(scenariosUrl)})
  return SCENARIOS.map((one) => ({ name: one.name, rows: window.draw(one.state, one.frame).rows }))
})()`)) as { name: string; rows: string[] }[]

let differ = 0
for (const one of drawn) {
  const golden = readFileSync(`${SCREENS}${one.name}.ansi`, 'utf8')
  const here = `${one.rows.join('\n')}\n`
  if (here === golden) continue
  differ++
  const lines = golden.split('\n')
  const at = here.split('\n').findIndex((row, index) => row !== lines[index])
  process.stdout.write(`differs: ${one.name}, first at row ${at}\n`)
}
for (const problem of errors) process.stdout.write(`page error: ${problem}\n`)
process.stdout.write(
  `${drawn.length - differ} of ${drawn.length} screens byte for byte the golden\n`,
)
await context.close()
await made.close()
server.close()
process.exit(differ > 0 || errors.length > 0 || over || drawn.length === 0 ? 1 : 0)
