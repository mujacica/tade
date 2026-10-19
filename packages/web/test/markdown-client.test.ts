import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StillDocument, type StillElement } from '../scripts/still-dom.ts'
import { answersWith, callIn, callRow } from '../src/assets/conversation.js'
import { keyed } from '../src/assets/dom.js'
import {
  blocksOf,
  hrefOf,
  inlineOf,
  markdownIn,
  PLAIN_READ,
  partsOf,
  plainOf,
  TAGS,
} from '../src/assets/markdown.js'
import { createChatLine, fillChatLine, saidOn } from '../src/assets/talk.js'

// The conversation's words, drawn as markdown — and what makes that safe.
//
// **The words are attacker-controlled**: a reply quotes a tool, a tool answers
// with a web page or an issue somebody wrote. So most of this file throws
// markup at the reader and asks what came out: only the elements it may make,
// only the attributes it chose, no handler, no address but `http`, `https` and
// `mailto`, and every `<script>` still there to read as the words it is.
//
// In the stand-in document (`scripts/still-dom.ts`), which builds nodes the
// way a browser's API does and has no HTML parser at all — so a test passing
// here cannot be a test that a parser happened to sanitise. Whether a browser
// runs any of it is the harness's (`scripts/browser.ts`), which loads the page
// under a content policy with no `unsafe-inline`.

const was = { document: Reflect.get(globalThis, 'document') }
let doc: StillDocument

beforeEach(() => {
  doc = new StillDocument()
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    value: was.document,
    configurable: true,
    writable: true,
  })
})

/** Every element under a node, the node itself left out. */
function all(node: StillElement): StillElement[] {
  return node.children.flatMap((child) => [child, ...all(child)])
}

function drawn(text: string): StillElement {
  const node = doc.createElement('div')
  markdownIn(node, text)
  return node
}

/** The attributes the reader may write, and nothing a handler or a style could ride in on. */
const ATTRIBUTES = [
  'aria-hidden',
  'aria-label',
  'class',
  'href',
  'rel',
  'role',
  'scope',
  'start',
  'tabindex',
  'target',
]

const HOSTILE = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<style>body{display:none}</style>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click]( javascript:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[click](vbscript:msgbox(1))',
  '[click](/api/ask/ask)',
  '[click](//evil.example/x)',
  '![x](https://evil.example/track.png)',
  '![x](javascript:alert(1))',
  '<https://ok.example/a> and <javascript:alert(1)>',
  '**<b onmouseover=alert(1)>bold</b>**',
  '`<script>alert(1)</script>`',
  '```html\n<script>alert(1)</script>\n```',
  '| a | <img src=x onerror=1> |\n|---|---|\n| <svg onload=alert(1)> | b |',
  '> <script>quoted</script>',
  '- <script>listed</script>\n- [x] <img src=x onerror=1>',
  '# <h1 onclick=alert(1)>heading</h1>',
  '```<script>\nnot a language\n```',
].join('\n\n')

describe('what the reader makes of somebody else’s markup', () => {
  it('makes only its own elements, with only its own attributes, and never a handler', () => {
    const node = drawn(HOSTILE)
    const elements = all(node)
    expect(elements.length).toBeGreaterThan(20)
    for (const one of elements) {
      expect(TAGS, one.tagName).toContain(one.tagName.toLowerCase())
      for (const name of one.getAttributeNames()) {
        expect(ATTRIBUTES, `${one.tagName} ${name}`).toContain(name)
      }
    }
    for (const tag of ['script', 'img', 'iframe', 'style', 'svg', 'b', 'h1']) {
      expect(node.querySelectorAll(tag), tag).toEqual([])
    }
  })

  it('keeps every piece of markup as the words it is', () => {
    const said = drawn(HOSTILE).textContent
    expect(said).toContain('<script>alert(1)</script>')
    expect(said).toContain('<img src=x onerror=alert(1)>')
    expect(said).toContain('<style>body{display:none}</style>')
    expect(said).toContain('<svg onload=alert(1)>')
  })

  it('gives a link an address only where it is http, https or mailto, and leaves this page', () => {
    const links = drawn(HOSTILE).querySelectorAll('a')
    expect(links.map((one) => one.getAttribute('href'))).toEqual([
      'https://evil.example/track.png',
      'https://ok.example/a',
    ])
    for (const one of links) {
      expect(one.getAttribute('rel')).toBe('noopener noreferrer')
      expect(one.getAttribute('target')).toBe('_blank')
    }
  })

  it('fetches no picture: one is a link to it, named as a picture', () => {
    const node = drawn('![a cat](https://example.invalid/cat.png)')
    expect(node.querySelectorAll('img')).toEqual([])
    expect(node.querySelector('a')?.textContent).toBe('picture: a cat')
  })

  it('refuses every spelling of an address that is not one of the three', () => {
    for (const ok of ['http://a.example', 'https://a.example/b?c#d', 'mailto:a@example.invalid']) {
      expect(hrefOf(ok), ok).toBe(ok)
    }
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'https://a.example/\u0000',
      'data:text/html,x',
      'vbscript:x',
      'file:///etc/passwd',
      '/api/ask/ask',
      '//evil.example',
      'https:/evil.example',
      'https://',
      '',
      null,
      42,
    ]) {
      expect(hrefOf(bad), String(bad)).toBeNull()
    }
  })

  it('puts nothing from the words in an attribute but a checked address and a language word', () => {
    const node = drawn('```js" onload="x\ncode\n```\n\n```ts\ncode\n```')
    expect(
      node.querySelectorAll('[aria-label]').map((one) => one.getAttribute('aria-label')),
    ).toEqual(['Code', 'Code, ts'])
  })
})

describe('what the reader understands', () => {
  it('reads headings, lists, quotes, rules, code and tables as blocks', () => {
    const blocks = blocksOf(
      [
        '## Plan',
        'Two things:',
        '1. first',
        '2. second',
        '   - under it',
        '',
        '3) a new list',
        '',
        '> said once',
        '',
        '---',
        '',
        '```ts',
        'const a = 1',
        '',
        'const b = 2',
        '```',
        '',
        '| name | cost |',
        '| :--- | ---: |',
        '| one | $1 |',
        '| two |',
      ].join('\n'),
    )
    expect(blocks.map((one) => one.type)).toEqual([
      'heading',
      'para',
      'list',
      'list',
      'quote',
      'rule',
      'code',
      'table',
    ])
    expect(blocks[0]).toEqual({ type: 'heading', level: 2, text: 'Plan' })
    expect(blocks[2].items[1].blocks.map((one: { type: string }) => one.type)).toEqual([
      'para',
      'list',
    ])
    expect(blocks[3]).toMatchObject({ ordered: true, start: 3 })
    expect(blocks[6]).toEqual({ type: 'code', lang: 'ts', text: 'const a = 1\n\nconst b = 2' })
    expect(blocks[7]).toMatchObject({
      head: ['name', 'cost'],
      align: [null, 'end'],
      rows: [['one', '$1'], ['two']],
    })
  })

  it('reads emphasis, code, links and breaks inside a line', () => {
    const parts = inlineOf('a **b** *c* ~~d~~ `e*f*` [g](https://g.example) h\ni snake_case_name')
    expect(parts.map((one) => one.t)).toEqual([
      'text',
      'strong',
      'text',
      'em',
      'text',
      'del',
      'text',
      'code',
      'text',
      'link',
      'text',
      'br',
      'text',
    ])
    expect(parts.at(-1)).toEqual({ t: 'text', v: 'i snake_case_name' })
    expect(inlineOf('see https://a.example/x.')).toEqual([
      { t: 'text', v: 'see ' },
      {
        t: 'link',
        href: 'https://a.example/x',
        picture: false,
        c: [{ t: 'text', v: 'https://a.example/x' }],
      },
      { t: 'text', v: '.' },
    ])
    expect(inlineOf('2 * 3 * 4 and \\*not em\\*')).toEqual([
      { t: 'text', v: '2 * 3 * 4 and *not em*' },
    ])
  })

  it('draws a table no wider than its own box, and a code block in one that scrolls', () => {
    const node = drawn('| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nlong\n```')
    const table = node.querySelector('.ui-md-table')
    const code = node.querySelector('.ui-md-code')
    for (const frame of [table, code]) {
      expect(frame?.classList.contains('scrolls')).toBe(true)
      // A named region a keyboard can reach, so it can be scrolled without a pointer.
      expect(frame?.getAttribute('role')).toBe('region')
      expect(frame?.getAttribute('tabindex')).toBe('0')
    }
    expect(node.querySelectorAll('th').map((one) => one.getAttribute('scope'))).toEqual([
      'col',
      'col',
    ])
  })

  it('puts a reply’s headings under the screen’s own, never as the page’s title', () => {
    const node = drawn('# One\n\n## Two\n\n###### Six')
    expect(
      all(node)
        .filter((one) => /^H\d$/.test(one.tagName))
        .map((one) => one.tagName),
    ).toEqual(['H3', 'H4', 'H6'])
  })

  it('costs the length of the words, whatever is left open in them', () => {
    // A thousand marks that never close, and links that never end: read once
    // each, never searched to the end again for every one of them.
    const nasty = `${'*a _b [c ~~d `'.repeat(2_000)}`
    const started = performance.now()
    inlineOf(nasty)
    blocksOf(`${'- '.repeat(500)}x\n${'> '.repeat(500)}y`)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe('a reply while it is written', () => {
  it('splits the words into parts at blank lines, keeping a fenced block whole', () => {
    expect(partsOf('a\nb\n\n```\nc\n\nd\n```\n\ne').map((one) => one.src)).toEqual([
      'a\nb',
      '```\nc\n\nd\n```',
      'e',
    ])
  })

  it('draws only the part being written, and leaves every part above it alone', () => {
    const node = doc.createElement('div')
    let text = ''
    let made = 0
    const make = doc.createElement.bind(doc)
    doc.createElement = (tag: string) => {
      made += 1
      return make(tag)
    }
    const per: number[] = []
    let top: unknown = null
    for (let n = 0; n < 300; n += 1) {
      text += `Paragraph ${n} has **some** words`
      markdownIn(node, text)
      text += ` and more.\n\n`
      made = 0
      markdownIn(node, text)
      per.push(made)
      // The part at the top, once finished, is the same node to the end: never redrawn.
      top ??= node.children[0]
      expect(node.children[0]).toBe(top)
    }
    expect(node.children.length).toBe(300)
    // The same few elements per beat at the three-hundredth paragraph as at the first.
    expect(Math.max(...per)).toBe(per[0])
    // A beat that changed nothing makes nothing.
    made = 0
    markdownIn(node, text)
    expect(made).toBe(0)
  })

  it('draws again from the start when the words were replaced rather than added to', () => {
    const node = drawn('one\n\ntwo\n\nthree')
    expect(node.children.length).toBe(3)
    markdownIn(node, 'one\n\nTWO')
    expect(node.children.map((one) => one.textContent)).toEqual(['one', 'TWO'])
  })
})

describe('a line of the conversation on one line', () => {
  const said = (kind: string, words: string, more = false) =>
    saidOn({ kind, text: { words, more }, tool: null, from: kind === 'asked' ? 'you' : null })

  it("reads a model's words with the marks taken off, as the drawing takes them off", () => {
    expect(said('reply', '**bold** and `code`')).toBe('bold and code')
    expect(said('tade', '## Done\n\n- one *thing*\n- [the review](https://x.dev/1)')).toBe(
      'Done one thing the review',
    )
    expect(said('reply', '| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```')).toBe(
      'a b 1 2 const x = 1',
    )
    // A mark the drawing would leave, it leaves; and nothing is marked as cut.
    expect(said('reply', '2 * 3 and a_b_c', true)).toBe('2 * 3 and a_b_c')
    expect(plainOf('<script>x</script> ![a cat](https://x.dev/c.png)')).toBe(
      '<script>x</script> picture a cat',
    )
  })

  it("keeps a person's own marks, which were theirs to mean", () => {
    expect(said('asked', '**not bold** `as typed`')).toBe('**not bold** `as typed`')
  })

  it('reads no further than a preview shows, however long the reply', () => {
    expect(plainOf(`**${'w'.repeat(PLAIN_READ * 10)}**`).length).toBeLessThanOrEqual(PLAIN_READ)
  })
})

describe('a tool call', () => {
  const view = { asOf: '2026-10-08T14:30:00.000Z', frozen: false }

  /** What the page asked the machine, and the machine's answer to each. */
  const asked: string[] = []
  const answering = (answers: Record<string, unknown>) => {
    asked.length = 0
    answersWith(async (_method, path) => {
      asked.push(path)
      const body = answers[path]
      return body === undefined ? { status: 0, body: null } : { status: 200, body }
    })
  }
  /** Every answer the page asked for has come back. */
  const settled = () => new Promise((done) => setTimeout(done, 0))
  const texts = (row: StillElement) =>
    row.querySelectorAll('pre').map((one: StillElement) => one.textContent)

  it('is a button with its own words that opens onto what it was handed and, read then, answered', async () => {
    answering({
      '/api/talk/answer/toolu_1': {
        v: 1,
        call: 'toolu_1',
        says: 'words',
        text: 'no such project <script>x</script>',
        taken: 0,
      },
    })
    const row = callRow()
    callIn(
      row,
      {
        tool: 'tade_status',
        outcome: 'failed',
        call: {
          brief: 'project payments',
          input: { words: 'project: payments', more: false },
          answered: 'words',
          id: 'toolu_1',
        },
      },
      '/api/talk/answer',
    )
    const press = row.querySelector('button')
    expect(press.hidden).toBe(false)
    // Named by what it shows, with no label apart from it.
    expect(press.getAttribute('aria-label')).toBeNull()
    // The tool's name as the window reads it: `tade_status` is "status".
    expect(press.textContent).toContain('status')
    expect(press.textContent).toContain('project payments')
    expect(press.textContent).toContain('failed')
    expect(row.classList.contains('is-failed')).toBe(true)
    const body = row.querySelector('.ui-call-body')
    expect(body.hidden).toBe(true)
    expect(press.getAttribute('aria-expanded')).toBe('false')
    // Nothing is asked for a row nobody opened.
    expect(asked).toEqual([])
    press.click()
    expect(body.hidden).toBe(false)
    expect(press.getAttribute('aria-expanded')).toBe('true')
    expect(body.getAttribute('id')).toBe(press.getAttribute('aria-controls'))
    expect(body.textContent).toContain('Reading what it answered')
    await settled()
    expect(asked).toEqual(['/api/talk/answer/toolu_1'])
    expect(texts(row)).toEqual(['project: payments', 'no such project <script>x</script>'])
    expect(row.querySelectorAll('script')).toEqual([])
    // Opened again, it is not asked for again.
    press.click()
    press.click()
    await settled()
    expect(asked).toHaveLength(1)
  })

  it('opens onto the whole of a five-thousand-line answer, as text, with nothing saying there was more', async () => {
    const whole = Array.from({ length: 5_000 }, (_, n) => `<b>line ${n + 1}</b>`).join('\n')
    answering({
      '/api/agent/app/search/answer/call_1': {
        v: 1,
        call: 'call_1',
        says: 'words',
        text: whole,
        taken: 0,
      },
    })
    const row = callRow()
    callIn(
      row,
      {
        tool: 'Read',
        outcome: 'ok',
        call: {
          brief: 'a.ts',
          input: { words: 'path: a.ts', more: false },
          answered: 'words',
          id: 'call_1',
        },
      },
      '/api/agent/app/search/answer',
    )
    row.querySelector('button').click()
    await settled()
    const [, answer] = texts(row)
    expect(answer).toBe(whole)
    expect(answer?.split('\n')).toHaveLength(5_000)
    expect(row.querySelectorAll('b')).toEqual([])
    // Drawn in the box that scrolls, and nothing anywhere says it was cut.
    const frame = row.querySelectorAll('.ui-call-text')[1]
    expect(frame?.classList.contains('scrolls')).toBe(true)
    expect(row.textContent).not.toMatch(/more than|not kept|more lines|not written down/)
  })

  it('says a call that answered nothing answered nothing, and one nobody kept was not written down', async () => {
    answering({})
    const opened = (answered: string, outcome = 'ok') => {
      const row = callRow()
      callIn(
        row,
        {
          tool: 'shell',
          outcome,
          call: {
            brief: 'rm',
            input: { words: 'command: rm -r old', more: false },
            answered,
            id: 'c1',
          },
        },
        '/api/talk/answer',
      )
      row.querySelector('button').click()
      return row
    }
    const nothing = opened('nothing')
    expect(nothing.querySelector('.ui-call-body').textContent).toContain('It answered nothing')
    expect(nothing.querySelector('.ui-call-body').textContent).not.toContain('not written down')
    expect(
      nothing.querySelectorAll('pre').filter((one: StillElement) => !one.parentElement?.hidden),
    ).toHaveLength(1)
    const unkept = opened('none', 'none')
    expect(unkept.querySelector('.ui-call-body').textContent).toContain('not written down')
    expect(unkept.querySelector('.ui-call-body').textContent).not.toContain('answered nothing')
    // Neither is asked for: there is nothing to read.
    await settled()
    expect(asked).toEqual([])
    // A record that does not say how it went is neither a tick nor a failure.
    const unknown = opened('words', 'unknown')
    expect(unknown.querySelector('button').textContent).toContain('cannot tell')
    expect(unknown.classList.contains('is-failed')).toBe(false)
  })

  it('opens a call with no id onto the whole answer it came with, asking for nothing', async () => {
    answering({})
    const whole = Array.from({ length: 5_000 }, (_, n) => `<i>line ${n + 1}</i>`).join('\n')
    const row = callRow()
    callIn(
      row,
      {
        tool: 'deps_check',
        outcome: 'failed',
        call: {
          brief: null,
          input: null,
          answered: 'words',
          id: null,
          answer: { words: whole, more: false },
        },
      },
      '/api/talk/answer',
    )
    row.querySelector('button').click()
    await settled()
    expect(asked).toEqual([])
    expect(texts(row).at(-1)).toBe(whole)
    expect(row.querySelectorAll('i')).toEqual([])
    expect(row.querySelector('.ui-call-body').textContent).not.toMatch(
      /not on this page|Reading|not written down|more than/,
    )
  })

  it('says an answer that could not be read, and reads it again the next time it is opened', async () => {
    answering({
      '/api/talk/answer/c1': { v: 1, call: 'c1', says: 'unread', text: null, taken: 0 },
    })
    const row = callRow()
    callIn(
      row,
      {
        tool: 'shell',
        outcome: 'ok',
        call: { brief: 'ls', input: null, answered: 'words', id: 'c1' },
      },
      '/api/talk/answer',
    )
    const press = row.querySelector('button')
    press.click()
    await settled()
    expect(row.querySelector('.ui-call-body').textContent).toContain('could not be read')
    answering({
      '/api/talk/answer/c1': { v: 1, call: 'c1', says: 'words', text: 'a\nb', taken: 0 },
    })
    press.click()
    press.click()
    await settled()
    expect(texts(row).at(-1)).toBe('a\nb')
  })

  it('stays open while the call it is about answers, and is nothing to press with nothing to open', async () => {
    answering({
      '/api/talk/answer/c9': { v: 1, call: 'c9', says: 'words', text: 'a\nb', taken: 0 },
    })
    const row = callRow()
    const one = {
      tool: 'Bash',
      outcome: 'running',
      call: {
        brief: 'ls',
        input: { words: 'command: ls', more: false },
        answered: 'none',
        id: 'c9',
      },
    }
    callIn(row, one, '/api/talk/answer')
    row.querySelector('button').click()
    callIn(
      row,
      { ...one, outcome: 'ok', call: { ...one.call, answered: 'words' } },
      '/api/talk/answer',
    )
    expect(row.querySelector('.ui-call-body').hidden).toBe(false)
    // Open when it answered, so its answer is read then.
    await settled()
    expect(texts(row).at(-1)).toBe('a\nb')
    // No call crossed — not granted: the same words, and no press.
    callIn(row, { tool: 'Bash', outcome: 'ok', call: null })
    expect(row.querySelector('button').hidden).toBe(true)
    expect(row.querySelector('.ui-call-body').hidden).toBe(true)
    expect(row.querySelector('.is-still').textContent).toContain('Bash')
  })

  it('in a long conversation, fills a line again without making anything it already made', () => {
    const list = doc.createElement('ul')
    const lines = Array.from({ length: 120 }, (_, n) => ({
      id: `2026-10-08T14:00:${String(n % 60).padStart(2, '0')}.000Z#${Math.floor(n / 60)}`,
      at: '2026-10-08T14:00:00.000Z',
      kind: n % 3 === 0 ? 'tool' : n % 3 === 1 ? 'reply' : 'asked',
      from: n % 3 === 2 ? 'you' : null,
      text:
        n % 3 === 0
          ? null
          : { words: `line ${n} with \`code\` and a [link](https://a.example)`, more: false },
      tool: n % 3 === 0 ? 'tade_status' : null,
      outcome: n % 3 === 0 ? 'ok' : null,
      call:
        n % 3 === 0
          ? { brief: 'x', input: { words: 'x: 1', more: false }, answered: 'none', id: null }
          : null,
      streaming: false,
    }))
    const fill = (rows: typeof lines) =>
      keyed(
        list,
        rows,
        (row) => row.id,
        createChatLine,
        (node, row) => fillChatLine(node, row, view),
      )
    fill(lines)
    expect(list.children.length).toBe(120)
    let made = 0
    const make = doc.createElement.bind(doc)
    doc.createElement = (tag: string) => {
      made += 1
      return make(tag)
    }
    fill(lines)
    expect(made).toBe(0)
    // The newest reply grows: only its own new part is drawn.
    const last = lines.length - 2
    const grown = lines.map((line, at) =>
      at === last && line.text !== null
        ? {
            ...line,
            text: { words: `${line.text.words}\n\nand **one** more`, more: false },
            streaming: true,
          }
        : line,
    )
    fill(grown)
    expect(made).toBeLessThan(6)
  })
})
