import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
// Biome plugins don't run in --stdin mode, so probe with a real file — never
// one in the checkout: it breaks R3 on purpose, and a `biome ci .` run beside
// the suite (the `format` check, another agent's hook) read it and went red.
// The repository's own config goes with it, its plugins made absolute.
const probeDir = mkdtempSync(join(tmpdir(), 'tade-lint-probe-'))
const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'))
writeFileSync(
  join(probeDir, 'biome.json'),
  JSON.stringify({
    ...config,
    plugins: config.plugins.map((plugin: string) => resolve(root, plugin)),
    vcs: { enabled: false },
  }),
)

function lint(source: string) {
  const file = join(probeDir, 'probe.ts')
  writeFileSync(file, source)
  const r = spawnSync(
    'pnpm',
    ['exec', 'biome', 'lint', '--colors=off', `--config-path=${probeDir}`, file],
    { cwd: root, encoding: 'utf8' },
  )
  const out = `${r.stdout}${r.stderr}`
  // A probe biome skipped would pass every "allows" below without a look.
  if (!out.includes('Checked 1 file')) throw new Error(`biome did not lint the probe:\n${out}`)
  return out
}

afterAll(() => rmSync(probeDir, { recursive: true, force: true }))

// R3: capabilities are declared, never sniffed. This test guards the lint rule itself.
describe('R3 lint rule', () => {
  it('rejects branching on a driver id', () => {
    expect(lint("export const f = (driver: { id: string }) => driver.id === 'tmux'\n")).toContain(
      'R3',
    )
  })

  it('rejects branching on a worker adapter id, either side', () => {
    expect(
      lint("export const f = (workerAdapter: { id: string }) => 'acp' !== workerAdapter.id\n"),
    ).toContain('R3')
  })

  it('rejects this.driver.id', () => {
    expect(
      lint("export class A { driver = { id: '' }; f() { return this.driver.id == 'x' } }\n"),
    ).toContain('R3')
  })

  it('rejects branching on a transport id', () => {
    // What a transport can do here is `capabilities.spawns`, never whether it
    // happens to be called `stdio`.
    expect(
      lint("export const f = (transport: { id: string }) => transport.id === 'stdio'\n"),
    ).toContain('R3')
  })

  it('allows branching on capabilities', () => {
    expect(
      lint(
        'export const f = (driver: { capabilities: { focus: boolean } }) => driver.capabilities.focus\n',
      ),
    ).not.toContain('R3')
  })

  it('allows id comparisons on non-port objects', () => {
    expect(lint("export const f = (task: { id: string }) => task.id === 'x'\n")).not.toContain('R3')
  })
})
