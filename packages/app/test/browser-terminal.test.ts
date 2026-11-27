import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as real from '@earendil-works/pi-tui/dist/terminal-image.js'
import { describe, expect, it } from 'vitest'
import * as standIn from '../src/browser-terminal.ts'

// `browser-terminal.ts` is what a browser is given in place of pi-tui's
// `terminal-image.js` (the swap in `wire/drawing.ts`). It must answer every
// name the drawing imports from the real one, and answer the two that are
// pi-tui's own code the way pi-tui does.

const MARKDOWN = fileURLToPath(
  import.meta.resolve('@earendil-works/pi-tui/dist/components/markdown.js'),
)

describe("the browser's terminal-image", () => {
  it('has every name the drawing imports from the real one', () => {
    const line = /import \{([^}]*)\} from "\.\.\/terminal-image\.js"/.exec(
      readFileSync(MARKDOWN, 'utf8'),
    )
    const names = (line?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names)
      expect(typeof (standIn as Record<string, unknown>)[name], name).toBe('function')
  })

  it("wraps a link and knows an image line as pi-tui's does", () => {
    for (const url of ['https://tade.sh', 'x'.repeat(9000), '']) {
      expect(standIn.hyperlink('text', url)).toBe(real.hyperlink('text', url))
    }
    for (const line of ['plain', '\x1b_Gf=100\x1b\\', 'up\x1b[2A\x1b]1337;File=x', '']) {
      expect(standIn.isImageLine(line)).toBe(real.isImageLine(line))
    }
  })

  it('says what the page told it, and nothing it detected', () => {
    expect(standIn.getCapabilities()).toEqual({ images: null, trueColor: false, hyperlinks: false })
    const told = { images: null, trueColor: true, hyperlinks: true } as const
    standIn.setCapabilities(told)
    expect(standIn.getCapabilities()).toBe(told)
  })
})
