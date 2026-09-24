// What to say to a Node too old to run Tade.
//
// `engines` is a warning and not a gate. `npm i -g tade-sh` on Node 20 prints
// one line nobody reads and installs anyway, and what the person then gets is
// a TypeError out of the middle of a dependency — `TEXT_ENCODINGS.union is not
// a function`, from execa, naming a file they do not have and a Node version
// nowhere at all. The published package is this source with its types taken
// off and nothing else, so it is written against the Node this repository is
// written against, and that is the sentence to say.
//
// It is checked at the door rather than anywhere further in: `bin.ts` runs it
// before it loads anything, because everything past that point is code written
// for a Node this one is not.

/**
 * `22.19.0` out of `v22.19.0`, `>=22.19`, or `22.19.1-nightly…`.
 *
 * Only the numbers, because that is all either side of this comparison is:
 * what Node says it is, and the floor the manifest declares. A missing part is
 * a zero — `>=22.19` is `22.19.0`, which is what it means everywhere.
 */
function numbers(text: string): [number, number, number] | null {
  const found = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text)
  if (found === null) return null
  return [Number(found[1]), Number(found[2] ?? 0), Number(found[3] ?? 0)]
}

/** Whether `running` is below `floor`, compared as numbers: 22.9 is not above 22.19. */
function below(running: [number, number, number], floor: [number, number, number]): boolean {
  for (const [at, want] of floor.entries()) {
    const has = running[at] ?? 0
    if (has !== want) return has < want
  }
  return false
}

/**
 * What to tell somebody running Tade on a Node it cannot run on, or null.
 *
 * `required` is `engines.node` as the manifest writes it, and only `>=x.y.z`
 * is read: a range this half-understood is a refusal it cannot justify, and
 * refusing wrongly is worse here than not refusing at all — the person would
 * at least have got an error with a cause in it. Everything it cannot read is
 * null, which is exactly what happened before this existed.
 */
export function nodeTooOld(running: string, required: string | null, where: string): string | null {
  if (required === null || !required.trimStart().startsWith('>=')) return null
  const floor = numbers(required)
  const has = numbers(running)
  if (floor === null || has === null || !below(has, floor)) return null
  const wanted = `${floor[0]}.${floor[1]}${floor[2] === 0 ? '' : `.${floor[2]}`}`
  return `${[
    `Tade needs Node ${wanted} or newer, and this is Node ${running}.`,
    '',
    `  ${where}`,
    '',
    'That is not a preference. Tade runs TypeScript with no build step — it is how the',
    'extensions in ~/.tade/extensions are loaded — and an older Node cannot. The package',
    'says so in `engines`, but npm treats that as a warning, so the install went ahead.',
    '',
    '  nvm    nvm install 22 && nvm use 22',
    '  fnm    fnm install 22 && fnm use 22',
    '  brew   brew install node@22',
    '  else   https://nodejs.org/en/download',
  ].join('\n')}\n`
}
