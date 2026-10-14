// The page's document written out as XHTML, which is what an SVG's
// `<foreignObject>` holds — for the README's pictures of the away view
// (`still.ts`), and for the browser harness that compares them with what
// Chromium builds (`browser-stills.ts`).

/** What `xhtmlOf` reads of a node: the standard DOM, so Chromium's document is read the same way. */
export interface Markup {
  readonly nodeType: number
  readonly localName?: string
  readonly namespaceURI?: string | null
  readonly attributes?: ArrayLike<{ readonly name: string; readonly value: string }>
  readonly childNodes?: ArrayLike<Markup>
  readonly data?: string
  readonly value?: string
  readonly checked?: boolean
  readonly type?: string
}

/**
 * A node as XHTML, which is what an SVG's `<foreignObject>` holds.
 *
 * **Self-contained on purpose** — no name from outside its own body — because
 * `scripts/browser-stills.ts` hands this function's source to Chromium and
 * reads the page it built with it, so the picture and the browser are compared
 * by one serializer rather than two that agree by luck.
 *
 * What a person sees and the markup does not say is written as markup: what is
 * typed in a box is its `value`, and a ticked box is `checked`. The sprite is
 * left out (the picture draws it once, for every frame), and so is everything
 * that draws nothing: a script, a style, a comment.
 */
export function xhtmlOf(node: Markup, inherited = ''): string {
  const XHTML = 'http://www.w3.org/1999/xhtml'
  const VOIDS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta']
  const SILENT = ['script', 'style', 'link', 'meta', 'title', 'template', 'head']
  const clean = (said: string) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the ones XML forbids are the point
    said.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  const text = (said: string) =>
    clean(said).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const attr = (said: string) =>
    text(said).replaceAll('"', '&quot;').replaceAll('\n', '&#10;').replaceAll('\t', '&#9;')
  const write = (one: Markup, space: string): string => {
    if (one.nodeType === 3) return text(one.data ?? '')
    if (one.nodeType !== 1) return ''
    const name = one.localName ?? ''
    const ns = one.namespaceURI ?? XHTML
    if (ns === XHTML && SILENT.includes(name)) return ''
    const pairs: [string, string][] = []
    for (const { name: key, value } of Array.from(one.attributes ?? [])) pairs.push([key, value])
    if (name === 'svg' && pairs.some(([key, value]) => key === 'class' && /\bsprite\b/.test(value)))
      return ''
    const box = ns === XHTML && name === 'input'
    const ticks = box && (one.type === 'checkbox' || one.type === 'radio')
    let kept = pairs.filter(([key]) => !(ticks && key === 'checked'))
    if (ticks && one.checked === true) kept.push(['checked', ''])
    if (box && !ticks) {
      const shown = one.value ?? ''
      kept = kept.filter(([key]) => key !== 'value')
      if (shown !== '') kept.push(['value', shown])
    }
    const head = [
      name,
      ...(ns !== space ? [`xmlns="${attr(ns)}"`] : []),
      ...kept.map(([key, value]) => `${key}="${attr(value)}"`),
    ].join(' ')
    const inside =
      ns === XHTML && name === 'textarea'
        ? text(one.value ?? '')
        : Array.from(one.childNodes ?? [])
            .map((child) => write(child, ns))
            .join('')
    if (inside === '' && (ns !== XHTML || VOIDS.includes(name))) return `<${head}/>`
    return `<${head}>${inside}</${name}>`
  }
  return write(node, inherited)
}
