import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PICTURES, REEL } from '../scripts/pictures.ts'
import { SCENARIOS } from './screens/scenarios.ts'

// The README's pictures.
//
// They are drawn from the scenarios above by `pnpm screens --assets`, which is
// what keeps the page showing the window Tade actually has. What can still go
// wrong is the paperwork: a picture drawn from a scenario nobody has any more,
// a file the README asks for that was never written, or a file left behind in
// the repository that nothing shows. Each of those is a broken README that
// every other test passes, so they are checked here.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const images = join(repo, 'images')
const readme = readFileSync(join(repo, 'README.md'), 'utf8')

const wanted = [...readme.matchAll(/(?<!\/)images\/([a-z0-9-]+\.svg)/g)].map((match) => match[1])
const drawn = [REEL.file, ...PICTURES.map((picture) => picture.file)]

describe('the pictures the README is made of', () => {
  it('draws each one from a scenario that still exists', () => {
    const names = new Set(SCENARIOS.map((scenario) => scenario.name))
    const missing = [
      ...PICTURES.map((one) => one.scenario),
      ...REEL.frames.map((one) => one.scenario),
    ].filter((name) => !names.has(name))
    expect(missing).toEqual([])
  })

  it('says what each one shows, for anybody who cannot see it', () => {
    for (const picture of [...PICTURES, REEL]) expect(picture.about.length).toBeGreaterThan(40)
  })

  it('has every picture the README asks for, written down', () => {
    expect(wanted.filter((file) => !drawn.includes(file!))).toEqual([])
    expect(wanted.filter((file) => !existsSync(join(images, file!)))).toEqual([])
  })

  it('keeps no picture nothing shows', () => {
    const files = readdirSync(images).filter((file) => file.endsWith('.svg'))
    expect(files.filter((file) => !wanted.includes(file))).toEqual([])
    expect(drawn.filter((file) => !files.includes(file))).toEqual([])
  })
})
