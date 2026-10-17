import { createRequire } from 'node:module'
import { printable } from '@tade/core'
import { QUIET } from './skin.ts'

/**
 * The part of highlight.js used here. Loaded without its own type definitions:
 * they bring the browser's DOM types into the whole program, which quietly
 * changes what `ReadableStream` means in packages that never draw anything.
 */
interface Highlighter {
  getLanguage(name: string): object | undefined
  registerLanguage(name: string, language: unknown): void
  highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string }
}

const require = createRequire(import.meta.url)

/**
 * highlight.js's core and the languages a file is ever coloured as, loaded the
 * first time a file is — never on the way to the window's first frame.
 *
 * The whole library registers all 193 languages it ships as it loads: 195
 * modules of the 1,185 an open read, 70–100 ms before anything was drawn
 * (load 5–22 on 14 cores), for a viewer that is opened later or not at all.
 * The core alone is 4 ms, and a language Tade has no name for here was never
 * coloured anyway, so registering only the named ones colours exactly what
 * the whole library did. One it does not ship is left plain, as it was.
 */
let loaded: Highlighter | null = null
function hljs(): Highlighter {
  if (loaded) return loaded
  const core = require('highlight.js/lib/core') as Highlighter
  for (const language of new Set([...Object.values(EXTENSIONS), ...Object.values(NAMES)])) {
    try {
      const module = require(`highlight.js/lib/languages/${language}`) as { default?: unknown }
      core.registerLanguage(language, module.default ?? module)
    } catch {
      // Not one highlight.js ships: plain, which is what it always was.
    }
  }
  loaded = core
  return core
}

// Colouring source code for the file viewer, in the window's 256 colours.
//
// highlight.js is already what pi colours code with, so it is a dependency we
// have rather than one we add. It answers in HTML — spans with a class per
// kind of token — and this turns that into terminal colour one line at a time,
// closing and reopening a span that runs across a line break, because the
// viewer draws lines and a colour left open would bleed into the gutter.

/** The language to colour a file as, from its name, or null to leave it plain. */
export function languageOf(path: string): string | null {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  const exact = NAMES[name]
  if (exact) return exact
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const language = EXTENSIONS[name.slice(dot + 1)]
  return language && hljs().getLanguage(language) ? language : null
}

const NAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'bash',
  '.env': 'bash',
  '.zshrc': 'bash',
  '.bashrc': 'bash',
}

const EXTENSIONS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonl: 'json',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  sql: 'sql',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  lua: 'lua',
  dart: 'dart',
  scala: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  tf: 'ini',
  zig: 'zig',
  nix: 'nix',
}

/** What each kind of token looks like: a 256-colour foreground, and bold or italic. */
const TOKENS: Record<string, string> = {
  keyword: '38;5;176',
  built_in: '38;5;173',
  type: '38;5;216',
  literal: '38;5;173',
  number: '38;5;179',
  string: '38;5;114',
  regexp: '38;5;180',
  subst: '38;5;252',
  symbol: '38;5;179',
  class: '38;5;216',
  function: '38;5;252',
  title: '38;5;80',
  params: '38;5;252',
  comment: `38;5;${QUIET};3`,
  doctag: `38;5;${QUIET};1`,
  // No `meta-keyword` or `meta-string` beside this: highlight.js 11 nests them
  // inside `meta` instead, and the stack above already ends on the inner kind,
  // so the colour is the same one this map used to name twice.
  meta: '38;5;110',
  section: '38;5;80;1',
  tag: '38;5;81',
  name: '38;5;81',
  attr: '38;5;110',
  attribute: '38;5;110',
  variable: '38;5;252',
  'template-variable': '38;5;216',
  'template-tag': '38;5;176',
  bullet: '38;5;179',
  code: '38;5;114',
  emphasis: '3',
  strong: '1',
  link: '38;5;75;4',
  quote: `38;5;${QUIET};3`,
  selector: '38;5;81',
  'selector-tag': '38;5;176',
  'selector-id': '38;5;216',
  'selector-class': '38;5;216',
  'selector-attr': '38;5;110',
  'selector-pseudo': '38;5;110',
  property: '38;5;110',
  addition: '38;5;114',
  deletion: '38;5;203',
}

const RESET = '\x1b[0m'

/**
 * A line of a file, as text: a file holds whatever whoever wrote it put there,
 * an agent among them, so it is made text (`printable`) — and its tabs kept,
 * because how wide one is drawn is the viewer's own rule (`TAB`).
 */
export function fileText(line: string): string {
  return line.includes('\t')
    ? line
        .split('\t')
        .map((part) => printable(part))
        .join('\t')
    : printable(line)
}

/**
 * A file's lines, coloured. `plain` returns them uncoloured, as the plain skin
 * draws everything; so does a language highlight.js does not know, or a file
 * it cannot make sense of — colour is decoration, never a reason to fail.
 * Made text first (`fileText`), so the only escapes in what comes out are the
 * colours put there.
 */
export function highlight(code: string, language: string | null, plain = false): string[] {
  const lines = code.replace(/\r\n/g, '\n').split('\n').map(fileText)
  if (plain || !language || !hljs().getLanguage(language)) return lines
  try {
    const html = hljs().highlight(lines.join('\n'), {
      language,
      ignoreIllegals: true,
    }).value
    return ansiLines(html)
  } catch {
    return lines
  }
}

/**
 * highlight.js HTML as terminal lines. Pure and exported, because the part
 * worth testing is that a span across a line break is closed at the end of one
 * line and opened again at the start of the next.
 */
export function ansiLines(html: string): string[] {
  const out: string[] = []
  const open: string[] = []
  let line = ''
  const style = () => {
    const codes = open.filter(Boolean)
    return codes.length > 0 ? `\x1b[${codes.join(';')}m` : ''
  }
  let at = 0
  while (at < html.length) {
    if (html.startsWith('<span', at)) {
      const end = html.indexOf('>', at)
      const tag = html.slice(at, end)
      const kind = /class="hljs-([\w-]+)/.exec(tag)?.[1] ?? ''
      // Nested spans inherit what they do not set, so the stack is the style: a
      // kind with no look of its own keeps its parent's rather than resetting it.
      open.push(TOKENS[kind] ?? '')
      line += style()
      at = end + 1
    } else if (html.startsWith('</span>', at)) {
      open.pop()
      line += RESET + style()
      at += '</span>'.length
    } else if (html[at] === '\n') {
      out.push(style() ? line + RESET : line)
      line = style()
      at++
    } else if (html[at] === '&') {
      const end = html.indexOf(';', at)
      const entity = html.slice(at, end + 1)
      line += ENTITIES[entity] ?? entity
      at = end + 1
    } else {
      const next = nextSpecial(html, at)
      line += html.slice(at, next)
      at = next
    }
  }
  out.push(style() ? line + RESET : line)
  return out
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
}

function nextSpecial(html: string, from: number): number {
  for (let i = from; i < html.length; i++) {
    const char = html[i]
    if (char === '<' || char === '&' || char === '\n') return i
  }
  return html.length
}
