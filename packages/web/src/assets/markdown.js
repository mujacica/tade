// Markdown, drawn as the page's own nodes: what Tade and an agent write, read
// as they meant it — headings, lists, emphasis, links, code and tables.
//
// **The words are somebody else's, so they never become markup.** A reply
// quotes what a tool answered, a tool answered what a page or an issue said,
// and any of it can carry a `<script>`. So this is a reader of a small subset
// and a builder of nodes, and nothing else:
//
// - **Every character reaches the page through a text node** (`document`'s
//   `createTextNode`, `el`'s `textContent`). There is no string here that
//   becomes HTML: raw HTML in the words is drawn as the words it is, which
//   `test/markdown-client.test.ts` throws `<script>`, `<img onerror>` and the
//   rest at, and `test/assets.test.ts` holds the folder to never reaching for
//   `innerHTML`.
// - **The elements are a closed list** (`TAGS`), each made by this file with
//   attributes this file chose. The only value from the words that lands in an
//   attribute is a link's address, and only one that `hrefOf` lets through:
//   `http:`, `https:` and `mailto:` — never `javascript:`, `data:` or a path
//   on this page — with `rel="noopener noreferrer"` beside it.
// - **No picture is fetched.** `![a](b)` is drawn as a link to the picture,
//   named by its words: a remote image is a request somebody else's words
//   could make this page send, and the content policy refuses one anyway.
//
// **Streaming is patched, not redrawn.** A reply grows while it is written, a
// beat at a time, and `markdownIn` keeps what it drew for each part of the text
// (`partsOf`: runs of lines between blank lines, a fenced block whole) and
// draws again only the parts that changed — which, for words being added at
// the end, is the last one. So a long reply costs the same per beat at its
// thousandth word as at its tenth, nothing above the part being written is
// touched, and a selection somebody is making in it survives.
//
// Pure but for `markdownIn` and the builders, which only make nodes.

import { el } from './dom.js'

/** Every element this file makes, and none other. */
export const TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]

/** How deep a quote in a list in a quote may go before the rest is read as words. */
const DEEPEST = 6

/** A fence: three backticks or tildes, and what language it says it is, which is only ever a word. */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/
const DELIMITER = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/
const BLANK = /^[ \t]*$/

/**
 * The address a link may go to, or null where it may go nowhere.
 *
 * An allow-list of three schemes rather than a deny-list of the bad ones,
 * because a deny-list is the shape every `javascript:` bypass was written
 * against: `jav&#x09;ascript:`, a leading space, a capital letter. Anything
 * with a character that is not printable is refused outright.
 */
export function hrefOf(address) {
  if (typeof address !== 'string') return null
  const trimmed = address.trim()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (trimmed === '' || /[\u0000- \u007f-\u009f]/.test(trimmed)) return null
  return /^(?:https?:\/\/[^/]|mailto:[^/])/i.test(trimmed) ? trimmed : null
}

/**
 * The text as its parts: runs of lines between blank lines, with a fenced block
 * kept whole wherever its blank lines are. `from` is where to start reading,
 * which is the last part's start when the text only grew at its end.
 */
export function partsOf(text, from = 0) {
  const parts = []
  let start = -1
  let fence = null
  let at = from
  while (at <= text.length) {
    const end = text.indexOf('\n', at)
    const stop = end < 0 ? text.length : end
    const line = text.slice(at, stop)
    if (fence !== null) {
      if (closes(line, fence)) fence = null
    } else if (BLANK.test(line)) {
      if (start >= 0) parts.push({ start, src: text.slice(start, at - 1) })
      start = -1
    } else {
      if (start < 0) start = at
      const open = FENCE.exec(line)
      if (open !== null) fence = open[1]
    }
    if (end < 0) break
    at = end + 1
  }
  if (start >= 0) parts.push({ start, src: text.slice(start) })
  return parts
}

function closes(line, fence) {
  const found = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  return found !== null && found[1][0] === fence[0] && found[1].length >= fence.length
}

/** The blocks of a piece of text. */
export function blocksOf(text, depth = 0) {
  return readBlocks(text.replace(/\r\n?/g, '\n').split('\n'), depth)
}

function readBlocks(lines, depth) {
  const blocks = []
  let at = 0
  while (at < lines.length) {
    const line = lines[at]
    if (BLANK.test(line)) {
      at += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const body = []
      at += 1
      while (at < lines.length && !closes(lines[at], fence[1])) {
        body.push(lines[at])
        at += 1
      }
      // An unclosed fence runs to the end: a block still being written.
      at += 1
      blocks.push({ type: 'code', lang: langOf(fence[2]), text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] ?? '' })
      at += 1
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      at += 1
      continue
    }
    if (depth < DEEPEST && QUOTE.test(line)) {
      const inner = []
      while (at < lines.length && QUOTE.test(lines[at])) {
        inner.push(lines[at].replace(QUOTE, ''))
        at += 1
      }
      blocks.push({ type: 'quote', blocks: readBlocks(inner, depth + 1) })
      continue
    }
    if (depth < DEEPEST && ITEM.test(line)) {
      at = readList(lines, at, depth, blocks)
      continue
    }
    if (at + 1 < lines.length && line.includes('|') && DELIMITER.test(lines[at + 1])) {
      const head = cellsOf(line)
      const align = cellsOf(lines[at + 1]).map(alignOf)
      if (head.length === align.length) {
        at += 2
        const rows = []
        while (at < lines.length && !BLANK.test(lines[at]) && lines[at].includes('|')) {
          rows.push(cellsOf(lines[at]))
          at += 1
        }
        blocks.push({ type: 'table', head, align, rows })
        continue
      }
    }
    const said = [line]
    at += 1
    while (at < lines.length && !BLANK.test(lines[at]) && !startsBlock(lines, at, depth)) {
      said.push(lines[at])
      at += 1
    }
    blocks.push({ type: 'para', text: said.join('\n') })
  }
  return blocks
}

/** Whether a line ends the paragraph above it by starting something else. */
function startsBlock(lines, at, depth) {
  const line = lines[at]
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    (depth < DEEPEST && (QUOTE.test(line) || ITEM.test(line))) ||
    (at + 1 < lines.length && line.includes('|') && DELIMITER.test(lines[at + 1]))
  )
}

/** One list: its items, each its own blocks, read from the lines indented under it. */
function readList(lines, at, depth, blocks) {
  const first = ITEM.exec(lines[at])
  const ordered = /\d/.test(first[2])
  const mark = ordered ? first[2].slice(-1) : first[2]
  const items = []
  while (at < lines.length) {
    const found = ITEM.exec(lines[at])
    if (found === null) break
    const same = ordered ? /\d/.test(found[2]) && found[2].endsWith(mark) : found[2] === mark
    if (!same) break
    const indent = found[1].length + found[2].length + 1
    const body = [found[3] ?? '']
    at += 1
    while (at < lines.length) {
      const line = lines[at]
      if (BLANK.test(line)) {
        // A blank line keeps the item open only where what follows is indented under it.
        const next = lines[at + 1]
        if (next === undefined || leading(next) < indent) break
        body.push('')
        at += 1
        continue
      }
      if (leading(line) >= indent) {
        body.push(line.slice(indent))
        at += 1
        continue
      }
      // A line that starts nothing new carries on the item's words.
      if (ITEM.test(line) || startsBlock(lines, at, depth)) break
      body.push(line.trim())
      at += 1
    }
    const task = /^\[([ xX])\][ \t]+/.exec(body[0])
    if (task !== null) body[0] = body[0].slice(task[0].length)
    items.push({
      task: task === null ? null : task[1] !== ' ',
      blocks: readBlocks(body, depth + 1),
    })
  }
  blocks.push({ type: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items })
  return at
}

function leading(line) {
  return /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length
}

function cellsOf(line) {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells = []
  let cell = ''
  for (let at = 0; at < row.length; at += 1) {
    if (row[at] === '\\' && row[at + 1] === '|') {
      cell += '|'
      at += 1
    } else if (row[at] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += row[at]
    }
  }
  cells.push(cell.trim())
  return cells
}

function alignOf(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  return left && right ? 'mid' : right ? 'end' : null
}

/** A fence's language, where it is a word: it is put in a label, and nothing else may be. */
function langOf(said) {
  return /^[\w+#.-]{1,20}$/.test(said) ? said : ''
}

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

// Sticky, so each is asked at one place and never copies the rest of the words.
const TICKS = /`+/y
const AUTO = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/iy
const BARE = /https?:\/\/[^\s<>"'`]+/iy
const TARGET = /\(\s*<?([^\s()<>]*)>?(?:\s+"[^"\n]*")?\s*\)/y

/**
 * How far a link's words or an emphasis may be looked for: past this an
 * opening mark is its own character. A bound, so somebody's thousand
 * unclosed `*` cost a thousand short looks rather than a thousand long ones.
 */
const REACH = 2_000
const TRIES = 64

function execAt(sticky, text, at) {
  sticky.lastIndex = at
  return sticky.exec(text)
}

function matchAt(sticky, text, at) {
  return execAt(sticky, text, at)?.[0] ?? ''
}

/**
 * The inline parts of a line of words: text, code, emphasis, links and breaks.
 *
 * Read left to right with no backtracking past the end of a match, so a
 * delimiter that never closes is its own character and the cost is the length
 * of the words, not the square of it.
 */
export function inlineOf(text, depth = 0) {
  const out = []
  let plain = ''
  const flush = () => {
    if (plain !== '') out.push({ t: 'text', v: plain })
    plain = ''
  }
  let at = 0
  while (at < text.length) {
    const one = text[at]
    if (one === '\\' && PUNCTUATION.test(text[at + 1] ?? '')) {
      plain += text[at + 1]
      at += 2
      continue
    }
    if (one === '\n') {
      flush()
      out.push({ t: 'br' })
      at += 1
      continue
    }
    if (one === '`') {
      const run = matchAt(TICKS, text, at)
      const close = text.indexOf(run, at + run.length)
      if (close > at) {
        flush()
        let code = text.slice(at + run.length, close).replace(/\n/g, ' ')
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1)
        out.push({ t: 'code', v: code })
        at = close + run.length
        continue
      }
      plain += run
      at += run.length
      continue
    }
    if (depth < DEEPEST && (one === '[' || (one === '!' && text[at + 1] === '['))) {
      const link = linkAt(text, one === '!' ? at + 1 : at)
      if (link !== null) {
        flush()
        out.push({
          t: 'link',
          href: hrefOf(link.address),
          picture: one === '!',
          c: inlineOf(link.words, depth + 1),
        })
        at = link.end
        continue
      }
    }
    if (one === '<') {
      const auto = execAt(AUTO, text, at)
      if (auto !== null) {
        flush()
        out.push({
          t: 'link',
          href: hrefOf(auto[1]),
          picture: false,
          c: [{ t: 'text', v: auto[1] }],
        })
        at += auto[0].length
        continue
      }
    }
    if ((one === 'h' || one === 'H') && !/\w/.test(text[at - 1] ?? '')) {
      const bare = execAt(BARE, text, at)
      if (bare !== null) {
        // A sentence's full stop or bracket is not the address's.
        const address = bare[0].replace(/[.,;:!?)\]]+$/, '')
        flush()
        out.push({
          t: 'link',
          href: hrefOf(address),
          picture: false,
          c: [{ t: 'text', v: address }],
        })
        at += address.length
        continue
      }
    }
    if (depth < DEEPEST && (one === '*' || one === '_' || one === '~')) {
      const span = emphasisAt(text, at)
      if (span !== null) {
        flush()
        out.push({ t: span.t, c: inlineOf(span.inner, depth + 1) })
        at = span.end
        continue
      }
    }
    plain += one
    at += 1
  }
  flush()
  return out
}

/** `[words](address "title")` from `at`, or null where it is not one. */
function linkAt(text, at) {
  let level = 0
  let close = -1
  for (let n = at; n < Math.min(text.length, at + REACH); n += 1) {
    if (text[n] === '\\') {
      n += 1
      continue
    }
    if (text[n] === '[') level += 1
    if (text[n] === ']') {
      level -= 1
      if (level === 0) {
        close = n
        break
      }
    }
  }
  if (close < 0 || text[close + 1] !== '(') return null
  const target = execAt(TARGET, text, close + 1)
  if (target === null) return null
  return { words: text.slice(at + 1, close), address: target[1], end: close + 1 + target[0].length }
}

/** `**strong**`, `*em*`, `~~struck~~` and their underscore spellings, from `at`. */
function emphasisAt(text, at) {
  const one = text[at]
  const double = text[at + 1] === one
  if (one === '~' && !double) return null
  const mark = double ? one + one : one
  const from = at + mark.length
  // Opens only where words follow at once, and an underscore only at a word's edge.
  if (from >= text.length || /\s/.test(text[from])) return null
  if (one === '_' && /[\p{L}\p{N}]/u.test(text[at - 1] ?? '')) return null
  let n = from
  for (let tries = 0; tries < TRIES; tries += 1) {
    const found = text.indexOf(mark, n)
    if (found < 0 || found > at + REACH) return null
    const after = text[found + mark.length] ?? ''
    const fits =
      found > from &&
      !/\s/.test(text[found - 1]) &&
      (double || after !== one) &&
      (one !== '_' || !/[\p{L}\p{N}]/u.test(after))
    if (fits) {
      const t = one === '~' ? 'del' : double ? 'strong' : 'em'
      return { t, inner: text.slice(from, found), end: found + mark.length }
    }
    n = found + 1
  }
  return null
}

/** The nodes for some inline parts. */
function inlineNodes(parts) {
  const nodes = []
  for (const part of parts) {
    if (part.t === 'text') nodes.push(document.createTextNode(part.v))
    else if (part.t === 'br') nodes.push(el('br'))
    else if (part.t === 'code') nodes.push(el('code', { text: part.v }))
    else if (part.t === 'link') nodes.push(linkNode(part))
    else {
      const node = el(part.t)
      node.append(...inlineNodes(part.c))
      nodes.push(node)
    }
  }
  return nodes
}

/**
 * A link that may go somewhere is an `<a>` that leaves this page; one that may
 * not is its words, so what somebody wrote is still there to read.
 */
function linkNode(part) {
  const words = inlineNodes(part.c)
  if (part.href === null) {
    const node = el('span')
    node.append(...words)
    return node
  }
  const node = el('a', {
    attrs: { href: part.href, rel: 'noopener noreferrer', target: '_blank' },
  })
  // A picture is never fetched: it is a link to one, named as a picture.
  if (part.picture) node.append(document.createTextNode('picture: '))
  node.append(...words)
  return node
}

/** The nodes for some blocks. */
export function blockNodes(blocks) {
  return blocks.map(blockNode)
}

function blockNode(block) {
  switch (block.type) {
    case 'heading': {
      // Under the screen's own headings: a reply's `#` is a heading inside a
      // section, never the page's title.
      const node = el(`h${Math.min(6, block.level + 2)}`, { class: 'ui-md-h' })
      node.append(...inlineNodes(inlineOf(block.text)))
      return node
    }
    case 'code': {
      const frame = el('div', {
        class: 'ui-md-code scrolls',
        attrs: {
          role: 'region',
          tabindex: '0',
          'aria-label': block.lang === '' ? 'Code' : `Code, ${block.lang}`,
        },
      })
      const pre = el('pre')
      pre.append(el('code', { text: block.text }))
      frame.append(pre)
      return frame
    }
    case 'rule':
      return el('hr')
    case 'quote': {
      const node = el('blockquote')
      node.append(...blockNodes(block.blocks))
      return node
    }
    case 'list': {
      const node = el(block.ordered ? 'ol' : 'ul', {
        attrs: { start: block.ordered && block.start !== 1 ? String(block.start) : null },
      })
      for (const item of block.items) {
        const li = el('li')
        if (item.task !== null) {
          li.classList.add('is-task')
          // Drawn and said: a box is a glyph to a screen reader without its word.
          li.append(
            el('span', { attrs: { 'aria-hidden': 'true' }, text: item.task ? '☑ ' : '☐ ' }),
            el('span', { class: 'sr-only', text: item.task ? 'done: ' : 'not done: ' }),
          )
        }
        // An item that is one paragraph is its words, not a paragraph in a bullet.
        const only = item.blocks.length === 1 && item.blocks[0].type === 'para'
        if (only) li.append(...inlineNodes(inlineOf(item.blocks[0].text)))
        else li.append(...blockNodes(item.blocks))
        node.append(li)
      }
      return node
    }
    case 'table':
      return tableNode(block)
    default: {
      const node = el('p')
      node.append(...inlineNodes(inlineOf(block.text)))
      return node
    }
  }
}

function tableNode(block) {
  const frame = el('div', {
    class: 'ui-md-table scrolls',
    attrs: { role: 'region', tabindex: '0', 'aria-label': 'Table' },
  })
  const table = el('table')
  const head = el('thead')
  const top = el('tr')
  block.head.forEach((cell, at) => {
    const th = el('th', { attrs: { scope: 'col' } })
    alignIn(th, block.align[at])
    th.append(...inlineNodes(inlineOf(cell)))
    top.append(th)
  })
  head.append(top)
  const body = el('tbody')
  for (const row of block.rows) {
    const tr = el('tr')
    // As many cells as the heading has: a short row is filled, a long one cut.
    for (let at = 0; at < block.head.length; at += 1) {
      const td = el('td')
      alignIn(td, block.align[at])
      td.append(...inlineNodes(inlineOf(row[at] ?? '')))
      tr.append(td)
    }
    body.append(tr)
  }
  table.append(head, body)
  frame.append(table)
  return frame
}

function alignIn(cell, align) {
  if (align === 'end') cell.classList.add('is-end')
  if (align === 'mid') cell.classList.add('is-mid')
}

/** What each container last drew: its text, and each part's source, start and node. */
const drawn = new WeakMap()

/**
 * Some words, drawn as markdown into a container that holds nothing else.
 *
 * Patched rather than redrawn (`partsOf`): a part whose source is what it was
 * keeps its node, and where the text only grew at its end only its last part is
 * read again — so streaming is the cost of the part being written.
 */
export function markdownIn(node, text) {
  const said = typeof text === 'string' ? text : ''
  const was = drawn.get(node)
  if (was !== undefined && was.text === said) return
  const old = was?.parts ?? []
  const grew = was !== undefined && old.length > 0 && said.startsWith(was.text)
  const from = grew ? old[old.length - 1].start : 0
  const parts = [...(grew ? old.slice(0, -1) : []), ...partsOf(said, from)]
  const kept = []
  parts.forEach((part, at) => {
    const before = old[at]
    if (before !== undefined && before.src === part.src && before.start === part.start) {
      kept.push(before)
      return
    }
    const box = el('div')
    box.append(...blockNodes(blocksOf(part.src)))
    if (before !== undefined) before.box.replaceWith(box)
    else node.append(box)
    kept.push({ src: part.src, start: part.start, box })
  })
  for (const gone of old.slice(parts.length)) gone.box.remove()
  drawn.set(node, { text: said, parts: kept })
}
