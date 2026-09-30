import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { drawPictures, PICTURES, REEL } from '../scripts/pictures.ts'
import { SCENARIOS } from './screens/scenarios.ts'

// The README's pictures.
//
// They are drawn from the scenarios above by `pnpm screens --assets`, which is
// what keeps the page showing the window Tade actually has — for exactly as
// long as somebody remembers to run it. Nothing made anybody, and a page
// showing a window Tade no longer has was a lie every other test passed. So
// the last test here draws every picture again and holds `images/` to it: a
// change to how the window looks that was not redrawn fails at the commit
// rather than being found by whoever next reads the README.
//
// In memory, rather than regenerating and looking for a dirty tree. Four
// agents share this checkout, so a dirty tree is somebody else's uncommitted
// work as often as it is a stale picture — and a comparison can say *which*
// picture, which `git diff --exit-code` cannot.
//
// The rest is the paperwork, and just as capable of breaking the page on its
// own: a picture drawn from a scenario nobody has any more, a file the README
// asks for that was never written, or a file left behind in the repository
// that nothing shows.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const images = join(repo, 'images')
const readme = readFileSync(join(repo, 'README.md'), 'utf8')

// Absolute, and the lookbehind that used to keep this to repo-relative paths
// went with them. The README ships in the tarball and `images/` does not —
// nothing but the markdown goes in — so a relative link is a broken picture
// everywhere the page is read except this repository's own GitHub page. The
// URL is the one form that renders on npm, on GitHub and in the tarball alike,
// which is why this counts that form and the test below refuses the other.
const AT = 'https://raw.githubusercontent.com/mujacica/tade/main/images/'
const wanted = [
  ...readme.matchAll(
    /raw\.githubusercontent\.com\/mujacica\/tade\/main\/images\/([a-z0-9-]+\.svg)/g,
  ),
].map((match) => match[1])
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

  it('asks for each one by a URL, because the README ships and the pictures do not', () => {
    // A relative `images/x.svg` renders only on this repository's own GitHub
    // page: not on npm, and not in the tarball, where the README is beside no
    // `images/` at all. Adding a picture the old way fails here rather than
    // being found by whoever opens the package page after a release.
    expect(
      [...readme.matchAll(/(?<![\w./-])images\/[a-z0-9-]+\.svg/g)].map((one) => one[0]),
    ).toEqual([])
    for (const file of wanted) expect(readme).toContain(`${AT}${file}`)
  })

  it('keeps no picture nothing shows', () => {
    const files = readdirSync(images).filter((file) => file.endsWith('.svg'))
    expect(files.filter((file) => !wanted.includes(file))).toEqual([])
    expect(drawn.filter((file) => !files.includes(file))).toEqual([])
  })

  it('holds the file on disk to what the renderer draws today', () => {
    // Drawing every picture is ~170ms over 36 scenarios, which is what this
    // rule costs the suite. The goldens already prove `draw` gives the same
    // bytes on every machine; everything after it here is arithmetic over a
    // grid, with no clock, no randomness and no path in it.
    //
    // Thrown rather than expected, for `modularity.test.ts`'s reason: a diff
    // of two hundred-kilobyte SVGs teaches nobody, and the name of the picture
    // and the command to run are the whole of what somebody needs here.
    const stale = drawPictures()
      .filter((one) => {
        let onDisk: string
        try {
          onDisk = readFileSync(join(images, one.file), 'utf8')
        } catch {
          return true
        }
        return onDisk !== one.svg
      })
      .map((one) => one.file)
    if (stale.length > 0)
      throw new Error(
        `\n\nimages/ no longer shows the window this code draws: ${stale.join(', ')}.\n` +
          'Run `pnpm screens --assets` and commit the pictures with the change that moved them.\n' +
          'The recipe, including how to look at what changed before accepting it, is the\n' +
          '`redraw-the-pictures` skill.\n',
      )
  })
})
