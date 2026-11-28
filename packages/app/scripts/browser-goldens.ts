import { readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCapabilities } from '@earendil-works/pi-tui'
import { checksExtension } from '@tade/extension-checks'
import { depsExtension } from '@tade/extension-deps'
import { jevExtension } from '@tade/extension-jev'
import { sentryExtension } from '@tade/extension-sentry'
import type { TadeExtension } from '@tade/extensions-core'
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
// output — with what they import that the drawing does not given to the
// browser by swaps beside the drawing's own. `test/screens/colours.ts`, which
// registers the machine's highlight.js, is `browser-colours.ts`, which
// registers the same version's ES build. And each barrel a scenario reaches
// that reaches Node — `@tade/core`'s, `@tade/web`'s, `@tade/mcp-core`'s, the
// extensions' — is a file in `browser-stand-ins/` re-exporting only that
// package's browser-safe files, unchanged; each says why it is what it is.
//
// **Each scenario file is a root of its own**, the ones `scenarios.ts` gathers,
// so one that comes to reach Node is named, with the file the build stopped
// at, and its screens counted as not drawn — rather than the build refusing
// every screen for one file's import, which is how this check went unrun from
// the day it was written. A module that reads `process` as it loads, or a
// name a stand-in does not have, is a page error.
//
// **It needs a browser, and says `unrun` when there is none**, as the away
// view's own harness does (`packages/web/scripts/browser.ts` says why
// Playwright is the machine's and not the lockfile's): the version is
// `PLAYWRIGHT_AT` in `packages/web/test/browser-plan.ts`, which its `INSTALL`
// line puts there with its chromium — another Playwright wants another
// chromium. Exit 0 every screen drawn and equal, 1 a screen differs, the page
// threw or the drawing is over its ceiling, 2 unrun — no browser, or a
// scenario file that cannot load in one, so some screens were not drawn.

const HERE = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const SCREENS = HERE('../test/screens/__screens__/')
const ROOT = HERE('../../../')

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
// What a scenario imports that the drawing does not, given to the browser as
// `browser-stand-ins/` says: a barrel that reaches Node is a file re-exporting
// only its package's own browser-safe modules, unchanged.
const STAND_INS = HERE('./browser-stand-ins/')
const standIn = (name: string) => `${STAND_INS}${name}.ts`
const swaps = {
  ...plan.swaps,
  [HERE('../test/screens/colours.ts')]: HERE('./browser-colours.ts'),
  [HERE('../../core/src/index.ts')]: standIn('core'),
  [HERE('../../core/src/home.ts')]: standIn('home'),
  [HERE('../../web/src/index.ts')]: standIn('web'),
  [HERE('../../mcp/core/src/index.ts')]: standIn('mcp'),
  ...Object.fromEntries(
    ['checks', 'deps', 'jev', 'resources', 'sentry'].map((name) => [
      HERE(`../../extensions/${name}/src/index.ts`),
      standIn('extensions'),
    ]),
  ),
}
// What the window draws of an extension is what it declared, read here off the
// real ones and handed to the page for `browser-stand-ins/extensions.ts`.
const declared = Object.fromEntries(
  Object.entries({ checksExtension, depsExtension, jevExtension, sentryExtension }).map(
    ([name, one]: [string, TadeExtension]) => [
      name,
      {
        name: one.name,
        title: one.title,
        description: one.description,
        workflow: one.workflow,
        tools: one.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          for: tool.for,
        })),
        actions: one.actions?.map((action) => ({ id: action.id, title: action.title })),
        watches: one.watches?.map((watch) => ({
          id: watch.id,
          title: watch.title,
          means: watch.means,
          every: watch.every,
        })),
      },
    ],
  ),
)
// The files `scenarios.ts` gathers, read out of it so a new one is checked too.
const gathered = [
  ...readFileSync(HERE('../test/screens/scenarios.ts'), 'utf8').matchAll(
    /import \{ (\w+_SCREENS) \} from '\.\/(scenarios\/[\w-]+\.ts)'/g,
  ),
].map(([, list, path]) => ({ list: list!, file: HERE(`../test/screens/${path}`) }))
const loads: typeof gathered = []
const cannot: { file: string; list: string; why: string }[] = []
for (const one of gathered) {
  try {
    await drawingFor({ roots: [...plan.roots, { file: one.file }], swaps })
    loads.push(one)
  } catch (problem) {
    const why = problem instanceof Error ? problem.message : String(problem)
    cannot.push({ ...one, why: why.replaceAll(ROOT, '') })
  }
}
const built = await drawingFor({
  roots: [...plan.roots, ...loads.map((one) => ({ file: one.file }))],
  swaps,
})
// A stand-in re-exports other packages' files by relative path, and a browser
// resolves one by URL — `pkg/@tade/app/scripts/browser-stand-ins/../../../mcp/
// core/src/catalogue.ts` is `pkg/@tade/mcp/core/…` — while every file is
// served under its package's name, `pkg/@tade/mcp-core/…`. The page's import
// map takes the one URL to the other, as it takes a swapped file's.
const servedAs = new Map([...built.files.values()].map((one) => [one.file, one.path]))
const across: Record<string, string> = {}
for (const one of built.files.values()) {
  if (!one.file.startsWith(`${realpathSync(STAND_INS)}/`)) continue
  for (const [, spec] of readFileSync(one.file, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
    const path = servedAs.get(realpathSync(join(dirname(one.file), spec!)))
    if (path === undefined) continue
    const naive = new URL(spec!, `http://here/draw/${built.version}/${one.path}`).pathname
    if (naive !== `/draw/${built.version}/${path}`) across[naive] = `/draw/${built.version}/${path}`
  }
}
const served = { ...built, importMap: { imports: { ...built.importMap.imports, ...across } } }
const door = drawingDoor(async () => served)
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

// The ceiling is the drawing's, what a page is served: the scenarios and their
// fixtures are this check's own roots, and no phone is ever sent them.
const alone = await drawingFor(plan)
const wire = await wireBytes(alone)
const urlOf = (file: string): string => {
  const served = [...built.files.values()].find((one) => one.file === realpathSync(file))
  if (served === undefined) throw new Error(`${file} is not in what the drawing serves`)
  return `/draw/${built.version}/${served.path}`
}
const lists = loads.map((one) => ({ list: one.list, url: urlOf(one.file) }))
const over = wire.raw > DRAWING_CEILING.rawKb * 1024 || wire.wire > DRAWING_CEILING.wireKb * 1024
process.stdout.write(
  `the drawing: ${alone.files.size} files, ${(wire.raw / 1024).toFixed(1)} KB raw ` +
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
// A page that throws — a module reading `process` as it loads, say — is a
// page error like any other, said with the rest rather than ending the run.
const drawn = (await page
  .evaluate(`(async () => {
  const entry = document.querySelector('meta[name="tade-drawing"]').content
  const window = await import(entry)
  window.setCapabilities(${capabilities})
  globalThis.TADE_EXTENSIONS = ${JSON.stringify(declared)}
  const drawn = []
  for (const { list, url } of ${JSON.stringify(lists)}) {
    const scenarios = (await import(url))[list]
    for (const one of scenarios) drawn.push({ name: one.name, rows: window.draw(one.state, one.frame).rows })
  }
  return drawn
})()`)
  .catch((problem: unknown) => {
    errors.push(String(problem))
    return []
  })) as { name: string; rows: string[] }[]

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
// What could not be drawn is counted from Node, where every scenario loads.
let notDrawn = 0
for (const one of cannot) {
  const count = ((await import(one.file)) as Record<string, unknown[]>)[one.list]?.length ?? 0
  notDrawn += count
  process.stdout.write(`not drawn: ${count} screens of ${relative(ROOT, one.file)} — ${one.why}\n`)
}
process.stdout.write(
  `${drawn.length - differ} of ${drawn.length + notDrawn} screens byte for byte the golden` +
    `${notDrawn > 0 ? `, ${notDrawn} not drawn in a browser` : ''}\n`,
)
await context.close()
await made.close()
server.close()
const failed = differ > 0 || errors.length > 0 || over || drawn.length === 0
process.exit(failed ? 1 : notDrawn > 0 || cannot.length > 0 ? 2 : 0)
