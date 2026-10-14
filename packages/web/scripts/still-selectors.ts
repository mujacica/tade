// The selectors the away view's page asks of its own document, read and matched
// for `still-dom.ts`'s stand-in — and **only those**: a tag, an id, classes,
// attributes, `:not(…)`, `:checked`, and the descendant and child combinators.
// Anything else throws, naming the selector, because a matcher that quietly
// answered "no match" for one it did not understand would be a picture missing
// a region with nothing saying why.

/** What matching reads of an element. */
export interface Matched {
  readonly localName: string
  readonly id: string
  readonly checked: boolean
  readonly parentNode: Matched | null
  readonly classList: { contains(name: string): boolean }
  getAttribute(name: string): string | null
}

interface Compound {
  tag: string | null
  id: string | null
  classes: string[]
  attrs: { name: string; value: string | null }[]
  not: Complex[]
  checked: boolean
}

export interface Complex {
  /** Right to left: the subject first, and what it is inside or under after it. */
  parts: { compound: Compound; joined: ' ' | '>' }[]
}

const parsed = new Map<string, Complex[]>()

/** A selector list, split at its top-level commas, each read right to left. */
export function parseSelectors(text: string): Complex[] {
  const known = parsed.get(text)
  if (known !== undefined) return known
  const made = splitTop(text, ',').map((one) => complexOf(one.trim(), text))
  parsed.set(text, made)
  return made
}

function splitTop(text: string, by: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let from = 0
  for (let at = 0; at < text.length; at++) {
    const ch = text[at]
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === by && depth === 0) {
      out.push(text.slice(from, at))
      from = at + 1
    }
  }
  out.push(text.slice(from))
  return out
}

function complexOf(text: string, whole: string): Complex {
  // Combinators as tokens of their own, so `li>a` and `li > a` read the same.
  const spaced = text.replace(/\s*>\s*/g, ' > ')
  if (/[+~]/.test(spaced.replace(/\[[^\]]*\]|\([^)]*\)/g, '')))
    throw new Error(`the still's document has no sibling combinator: ${whole}`)
  const written: Complex['parts'] = []
  let before: ' ' | '>' = ' '
  for (const token of splitTop(spaced, ' ').filter((one) => one !== '')) {
    if (token === '>') {
      before = '>'
      continue
    }
    // How this part meets the one written before it, which is the one it is
    // inside: read right to left, that is how it meets the next part.
    written.push({ compound: compoundOf(token, whole), joined: before })
    before = ' '
  }
  return { parts: written.reverse() }
}

function compoundOf(text: string, whole: string): Compound {
  const made: Compound = { tag: null, id: null, classes: [], attrs: [], not: [], checked: false }
  let at = 0
  const name = () => {
    const found = /^[A-Za-z0-9_-]+/.exec(text.slice(at))?.[0] ?? ''
    at += found.length
    return found
  }
  if (text[0] === '*') at = 1
  else if (/[A-Za-z]/.test(text[0] ?? '')) made.tag = name().toLowerCase()
  while (at < text.length) {
    const ch = text[at]
    if (ch === '.') {
      at++
      made.classes.push(name())
    } else if (ch === '#') {
      at++
      made.id = name()
    } else if (ch === '[') {
      const end = text.indexOf(']', at)
      const inside = text.slice(at + 1, end)
      const eq = inside.indexOf('=')
      made.attrs.push(
        eq < 0
          ? { name: inside.trim(), value: null }
          : {
              name: inside.slice(0, eq).trim(),
              value: inside
                .slice(eq + 1)
                .trim()
                .replace(/^(['"])(.*)\1$/, '$2'),
            },
      )
      at = end + 1
    } else if (text.startsWith(':not(', at)) {
      let depth = 0
      let end = at + 4
      for (; end < text.length; end++) {
        if (text[end] === '(') depth++
        else if (text[end] === ')' && --depth === 0) break
      }
      made.not.push(...parseSelectors(text.slice(at + 5, end)))
      at = end + 1
    } else if (text.startsWith(':checked', at)) {
      made.checked = true
      at += ':checked'.length
    } else throw new Error(`the still's document cannot read \`${text.slice(at)}\` in ${whole}`)
  }
  return made
}

function matchesCompound(node: Matched, compound: Compound): boolean {
  if (compound.tag !== null && node.localName.toLowerCase() !== compound.tag) return false
  if (compound.id !== null && node.id !== compound.id) return false
  for (const name of compound.classes) if (!node.classList.contains(name)) return false
  for (const attr of compound.attrs) {
    const has = node.getAttribute(attr.name)
    if (has === null || (attr.value !== null && has !== attr.value)) return false
  }
  if (compound.checked && !node.checked) return false
  return !compound.not.some((one) => matchesComplex(node, one))
}

export function matchesComplex(node: Matched, complex: Complex, from = 0): boolean {
  const part = complex.parts[from]
  if (part === undefined) return true
  if (!matchesCompound(node, part.compound)) return false
  if (from + 1 >= complex.parts.length) return true
  let up = node.parentNode
  if (part.joined === '>') return up !== null && matchesComplex(up, complex, from + 1)
  while (up !== null) {
    if (matchesComplex(up, complex, from + 1)) return true
    up = up.parentNode
  }
  return false
}
