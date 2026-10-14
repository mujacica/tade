import { matchesComplex, parseSelectors } from './still-selectors.ts'

// A document for the page to build itself in, with no browser.
//
// The README's pictures of the away view are the page's own modules — `boot.js`
// and every screen it routes to — run here over the projection of a made-up
// world, and what they build is written out as XHTML (`still.ts`). This is the
// document they build it in: enough of the DOM for the page to run end to end,
// and nothing that pretends to be more.
//
// **It has no layout, and says so by answering every measurement with 0** —
// the answer a page gets from an element nothing has laid out yet, and one
// every place that measures already handles: a plan's map is drawn at its own
// default spread rather than spread to its card, and a screen that picks a
// layout by its width (one plan, a workflow, settings) picks the one it falls
// back to. Each is a real drawing of the page, never an invented one. Where a
// picture needs the room a browser would have given, its visit says so by
// selector (`measured`), and `scripts/browser-stills.ts` holds that number to
// what Chromium measures.
//
// **The selectors are the ones the page asks, and an unknown one throws**
// (`still-selectors.ts`). It is written out by `still-xhtml.ts`.
//
// Not in `src/`: nothing here ships, and nothing the window loads imports it.

export const HTML = 'http://www.w3.org/1999/xhtml'
export const SVG = 'http://www.w3.org/2000/svg'

type Listener = (event: StillEvent) => void

/** What a handler is handed, for the few events the stage itself sends. */
export class StillEvent {
  readonly type: string
  target: StillNode | null = null
  defaultPrevented = false
  readonly button = 0
  readonly metaKey = false
  readonly ctrlKey = false
  readonly shiftKey = false
  readonly altKey = false
  readonly data: string

  constructor(type: string, data = '') {
    this.type = type
    this.data = data
  }

  preventDefault(): void {
    this.defaultPrevented = true
  }

  stopPropagation(): void {}
}

/** Listeners by type, for an element, the document and the window alike. */
export class Listening {
  private readonly held = new Map<string, Listener[]>()

  addEventListener(type: string, listener: Listener | null): void {
    if (listener === null) return
    const list = this.held.get(type) ?? []
    list.push(listener)
    this.held.set(type, list)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.held.set(
      type,
      (this.held.get(type) ?? []).filter((one) => one !== listener),
    )
  }

  dispatchEvent(event: StillEvent): boolean {
    for (const listener of [...(this.held.get(event.type) ?? [])]) listener(event)
    return !event.defaultPrevented
  }
}

export class StillNode extends Listening {
  declare readonly nodeType: number
  parentNode: StillElement | null = null
  readonly ownerDocument: StillDocument

  constructor(doc: StillDocument) {
    super()
    this.ownerDocument = doc
  }

  get parentElement(): StillElement | null {
    return this.parentNode
  }

  get nextSibling(): StillNode | null {
    const siblings = this.parentNode?.childNodes ?? []
    return siblings[siblings.indexOf(this) + 1] ?? null
  }

  get previousSibling(): StillNode | null {
    const siblings = this.parentNode?.childNodes ?? []
    const at = siblings.indexOf(this)
    return at > 0 ? (siblings[at - 1] ?? null) : null
  }

  get nextElementSibling(): StillElement | null {
    let next = this.nextSibling
    while (next !== null && !(next instanceof StillElement)) next = next.nextSibling
    return next
  }

  get previousElementSibling(): StillElement | null {
    let before = this.previousSibling
    while (before !== null && !(before instanceof StillElement)) before = before.previousSibling
    return before
  }

  get isConnected(): boolean {
    let at: StillNode | null = this
    while (at !== null) {
      if (at === this.ownerDocument.documentElement) return true
      at = at.parentNode
    }
    return false
  }

  get textContent(): string {
    return ''
  }

  set textContent(_said: string) {}

  remove(): void {
    const parent = this.parentNode
    if (parent === null) return
    const at = parent.childNodes.indexOf(this)
    if (at >= 0) parent.childNodes.splice(at, 1)
    this.parentNode = null
  }

  after(...nodes: (StillNode | string)[]): void {
    const parent = this.parentNode
    if (parent === null) return
    const next = this.nextSibling
    for (const node of nodes) parent.insertBefore(parent.made(node), next)
  }

  before(...nodes: (StillNode | string)[]): void {
    const parent = this.parentNode
    if (parent === null) return
    for (const node of nodes) parent.insertBefore(parent.made(node), this)
  }

  replaceWith(...nodes: (StillNode | string)[]): void {
    const parent = this.parentNode
    if (parent === null) return
    const next = this.nextSibling
    this.remove()
    for (const node of nodes) parent.insertBefore(parent.made(node), next)
  }
}

export class StillText extends StillNode {
  override readonly nodeType = 3
  data: string

  constructor(doc: StillDocument, data: string) {
    super(doc)
    this.data = data
  }

  override get textContent(): string {
    return this.data
  }

  override set textContent(said: string) {
    this.data = String(said)
  }

  get nodeValue(): string {
    return this.data
  }
}

/** `classList`, over the element's own `class` attribute, so the two never disagree. */
class Classes {
  private readonly of: StillElement

  constructor(of: StillElement) {
    this.of = of
  }

  private get names(): string[] {
    return (this.of.getAttribute('class') ?? '').split(/\s+/).filter((one) => one !== '')
  }

  private write(names: string[]): void {
    this.of.setAttribute('class', names.join(' '))
  }

  get length(): number {
    return this.names.length
  }

  get value(): string {
    return this.names.join(' ')
  }

  contains(name: string): boolean {
    return this.names.includes(name)
  }

  add(...names: string[]): void {
    const now = this.names
    for (const name of names) if (!now.includes(name)) now.push(name)
    this.write(now)
  }

  remove(...names: string[]): void {
    if (this.of.getAttribute('class') === null) return
    this.write(this.names.filter((one) => !names.includes(one)))
  }

  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.contains(name)
    if (on) this.add(name)
    else this.remove(name)
    return on
  }

  replace(was: string, is: string): boolean {
    if (!this.contains(was)) return false
    this.write(this.names.map((one) => (one === was ? is : one)))
    return true
  }

  [Symbol.iterator](): Iterator<string> {
    return this.names[Symbol.iterator]()
  }
}

/** `style`, as declarations written back into the `style` attribute in the order set. */
class Style {
  private readonly of: StillElement
  private readonly held = new Map<string, { value: string; important: boolean }>()

  constructor(of: StillElement) {
    this.of = of
  }

  setProperty(name: string, value: string | null, priority = ''): void {
    if (value === null || value === '') {
      this.removeProperty(name)
      return
    }
    this.held.set(name, { value: String(value), important: priority === 'important' })
    this.of.writeStyle(this.cssText)
  }

  getPropertyValue(name: string): string {
    return this.held.get(name)?.value ?? ''
  }

  removeProperty(name: string): string {
    const was = this.getPropertyValue(name)
    if (this.held.delete(name)) this.of.writeStyle(this.cssText)
    return was
  }

  get cssText(): string {
    return [...this.held]
      .map(([name, one]) => `${name}: ${one.value}${one.important ? ' !important' : ''};`)
      .join(' ')
  }

  /** The attribute, read back in: how `setAttribute('style', …)` reaches `getPropertyValue`. */
  readFrom(text: string): void {
    this.held.clear()
    for (const part of text.split(';')) {
      const cut = part.indexOf(':')
      if (cut < 0) continue
      const name = part.slice(0, cut).trim()
      let value = part.slice(cut + 1).trim()
      const important = /!important$/.test(value)
      if (important) value = value.replace(/\s*!important$/, '')
      if (name !== '' && value !== '') this.held.set(name, { value, important })
    }
  }
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])

/** `data-some-thing` for `dataset.someThing`. */
const dataName = (key: string) => `data-${key.replace(/[A-Z]/g, (up) => `-${up.toLowerCase()}`)}`

export class StillElement extends StillNode {
  override readonly nodeType = 1
  readonly localName: string
  readonly namespaceURI: string
  readonly childNodes: StillNode[] = []
  readonly classList: Classes
  readonly style: Style
  readonly dataset: Record<string, string | undefined>
  /** What a person typed, which in a browser is a property and not the attribute. */
  private typed: string | null = null
  private ticked: boolean | null = null
  private readonly attrs = new Map<string, string>()
  scrollTop = 0
  scrollLeft = 0
  /** No layout, so every measurement is the one an element nothing laid out answers. */
  readonly offsetWidth = 0
  readonly offsetHeight = 0
  readonly offsetTop = 0
  readonly offsetLeft = 0
  readonly offsetParent = null
  readonly clientHeight = 0
  readonly scrollWidth = 0
  readonly scrollHeight = 0

  /**
   * The room this element has: what a browser measured for it, where somebody
   * wrote that down (`StillDocument.measured`), and otherwise 0.
   */
  get clientWidth(): number {
    for (const [selector, width] of Object.entries(this.ownerDocument.measured))
      if (this.matches(selector)) return width
    return 0
  }

  constructor(doc: StillDocument, localName: string, namespaceURI: string) {
    super(doc)
    this.localName = localName
    this.namespaceURI = namespaceURI
    this.classList = new Classes(this)
    this.style = new Style(this)
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_, key) =>
        typeof key === 'string' ? (this.getAttribute(dataName(key)) ?? undefined) : undefined,
      set: (_, key, value) => {
        if (typeof key === 'string') this.setAttribute(dataName(key), String(value))
        return true
      },
      deleteProperty: (_, key) => {
        if (typeof key === 'string') this.removeAttribute(dataName(key))
        return true
      },
    })
  }

  /** Only `Style` calls this: the attribute it owns, written without reading it back. */
  writeStyle(text: string): void {
    if (text === '') this.attrs.delete('style')
    else this.attrs.set('style', text)
  }

  /** A node, or a string made into one, as `append` and its siblings take them. */
  made(node: StillNode | string): StillNode {
    return typeof node === 'string' ? new StillText(this.ownerDocument, node) : node
  }

  get tagName(): string {
    return this.namespaceURI === HTML ? this.localName.toUpperCase() : this.localName
  }

  get nodeName(): string {
    return this.tagName
  }

  /* ── attributes, and the properties that are them ─────────────────────── */

  private named(name: string): string {
    return this.namespaceURI === HTML ? name.toLowerCase() : name
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(this.named(name)) ?? null
  }

  setAttribute(name: string, value: string): void {
    const key = this.named(name)
    this.attrs.set(key, String(value))
    if (key === 'style') this.style.readFrom(String(value))
  }

  removeAttribute(name: string): void {
    const key = this.named(name)
    this.attrs.delete(key)
    if (key === 'style') this.style.readFrom('')
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(this.named(name))
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(name)
    if (on) {
      if (!this.hasAttribute(name)) this.setAttribute(name, '')
    } else this.removeAttribute(name)
    return on
  }

  getAttributeNames(): string[] {
    return [...this.attrs.keys()]
  }

  /** In the order they were set, which is the order a serializer writes them. */
  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }))
  }

  private flag(name: string, on: boolean): void {
    if (on) this.setAttribute(name, '')
    else this.removeAttribute(name)
  }

  get id(): string {
    return this.getAttribute('id') ?? ''
  }

  set id(said: string) {
    this.setAttribute('id', said)
  }

  get className(): string {
    return this.getAttribute('class') ?? ''
  }

  set className(said: string) {
    this.setAttribute('class', said)
  }

  get hidden(): boolean {
    return this.hasAttribute('hidden')
  }

  set hidden(on: boolean) {
    this.flag('hidden', on)
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled')
  }

  set disabled(on: boolean) {
    this.flag('disabled', on)
  }

  get open(): boolean {
    return this.hasAttribute('open')
  }

  set open(on: boolean) {
    this.flag('open', on)
  }

  get title(): string {
    return this.getAttribute('title') ?? ''
  }

  set title(said: string) {
    this.setAttribute('title', said)
  }

  get tabIndex(): number {
    return Number(this.getAttribute('tabindex') ?? -1)
  }

  set tabIndex(at: number) {
    this.setAttribute('tabindex', String(at))
  }

  get href(): string {
    return this.getAttribute('href') ?? ''
  }

  get target(): string {
    return this.getAttribute('target') ?? ''
  }

  get type(): string {
    return this.getAttribute('type') ?? (this.localName === 'input' ? 'text' : '')
  }

  get name(): string {
    return this.getAttribute('name') ?? ''
  }

  /** What is in the box: typed, or the attribute it started as. */
  get value(): string {
    if (this.typed !== null) return this.typed
    if (this.localName === 'textarea') return this.textContent
    return this.getAttribute('value') ?? (this.type === 'checkbox' ? 'on' : '')
  }

  set value(said: string) {
    this.typed = String(said)
  }

  get checked(): boolean {
    return this.ticked ?? this.hasAttribute('checked')
  }

  set checked(on: boolean) {
    this.ticked = on
  }

  /** Whether `value` was set as a property, which a serializer writes as what is shown. */
  get typedValue(): string | null {
    return this.typed
  }

  /* ── the tree ─────────────────────────────────────────────────────────── */

  get children(): StillElement[] {
    return this.childNodes.filter((node): node is StillElement => node instanceof StillElement)
  }

  get childElementCount(): number {
    return this.children.length
  }

  get firstChild(): StillNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): StillNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get firstElementChild(): StillElement | null {
    return this.children[0] ?? null
  }

  get lastElementChild(): StillElement | null {
    const all = this.children
    return all[all.length - 1] ?? null
  }

  override get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('')
  }

  override set textContent(said: string) {
    for (const node of this.childNodes) node.parentNode = null
    this.childNodes.length = 0
    const text = said === null || said === undefined ? '' : String(said)
    if (text !== '') this.appendChild(new StillText(this.ownerDocument, text))
  }

  appendChild<T extends StillNode>(node: T): T {
    return this.insertBefore(node, null)
  }

  insertBefore<T extends StillNode>(node: T, before: StillNode | null): T {
    if (node === before) return node
    let up: StillNode | null = this
    while (up !== null) {
      if (up === node) throw new Error('a node cannot be put inside itself')
      up = up.parentNode
    }
    node.remove()
    const at = before === null ? -1 : this.childNodes.indexOf(before)
    if (at < 0) this.childNodes.push(node)
    else this.childNodes.splice(at, 0, node)
    node.parentNode = this
    return node
  }

  removeChild<T extends StillNode>(node: T): T {
    if (node.parentNode === this) node.remove()
    return node
  }

  append(...nodes: (StillNode | string)[]): void {
    for (const node of nodes) this.appendChild(this.made(node))
  }

  prepend(...nodes: (StillNode | string)[]): void {
    const first = this.firstChild
    for (const node of nodes) this.insertBefore(this.made(node), first)
  }

  replaceChildren(...nodes: (StillNode | string)[]): void {
    const keep = nodes.map((node) => this.made(node))
    for (const node of keep) node.remove()
    for (const node of this.childNodes) node.parentNode = null
    this.childNodes.length = 0
    for (const node of keep) this.appendChild(node)
  }

  contains(node: StillNode | null): boolean {
    let at: StillNode | null = node
    while (at !== null) {
      if (at === this) return true
      at = at.parentNode
    }
    return false
  }

  cloneNode(deep = false): StillElement {
    const copy = new StillElement(this.ownerDocument, this.localName, this.namespaceURI)
    for (const { name, value } of this.attributes) copy.setAttribute(name, value)
    if (deep)
      for (const node of this.childNodes)
        copy.appendChild(
          node instanceof StillElement
            ? node.cloneNode(true)
            : new StillText(this.ownerDocument, node.textContent),
        )
    return copy
  }

  /* ── asking ───────────────────────────────────────────────────────────── */

  querySelectorAll(selector: string): StillElement[] {
    const asked = parseSelectors(selector)
    const found: StillElement[] = []
    const walk = (node: StillElement) => {
      for (const child of node.children) {
        if (asked.some((one) => matchesComplex(child, one))) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  querySelector(selector: string): StillElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  matches(selector: string): boolean {
    return parseSelectors(selector).some((one) => matchesComplex(this, one))
  }

  closest(selector: string): StillElement | null {
    const asked = parseSelectors(selector)
    let at: StillElement | null = this
    while (at !== null) {
      const here: StillElement = at
      if (asked.some((one) => matchesComplex(here, one))) return here
      at = here.parentNode
    }
    return null
  }

  /* ── what a browser would do, and this cannot ─────────────────────────── */

  focus(): void {
    this.ownerDocument.activeElement = this
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null
  }

  click(): void {
    const event = new StillEvent('click')
    event.target = this
    this.dispatchEvent(event)
  }

  scrollIntoView(): void {}
  scrollTo(): void {}
  scrollBy(): void {}

  showModal(): void {
    this.open = true
  }

  show(): void {
    this.open = true
  }

  close(): void {
    this.open = false
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  getAnimations(): never[] {
    return []
  }

  /** Whether the element has no end tag in HTML, which XML writes as `<x/>`. */
  get isVoid(): boolean {
    return this.namespaceURI === HTML && VOID.has(this.localName)
  }
}

export class StillDocument extends Listening {
  readonly documentElement: StillElement
  readonly head: StillElement
  readonly body: StillElement
  activeElement: StillElement | null = null
  /**
   * Widths a browser measured, by selector, for the places in the page that ask
   * how much room they have: the one thing a document with no layout cannot
   * work out, written down where it is needed and held to Chromium's own
   * measure by `browser-stills.ts`.
   */
  measured: Readonly<Record<string, number>> = {}
  title = ''
  readonly visibilityState = 'visible'
  readonly hidden = false
  readonly readyState = 'complete'
  readonly compatMode = 'BackCompat'

  constructor() {
    super()
    this.documentElement = this.createElement('html')
    this.head = this.createElement('head')
    this.body = this.createElement('body')
    this.documentElement.append(this.head, this.body)
    this.activeElement = this.body
  }

  get scrollingElement(): StillElement {
    return this.body
  }

  createElement(tag: string): StillElement {
    return new StillElement(this, tag.toLowerCase(), HTML)
  }

  createElementNS(namespace: string, tag: string): StillElement {
    return new StillElement(this, tag, namespace)
  }

  createTextNode(said: string): StillText {
    return new StillText(this, String(said))
  }

  querySelectorAll(selector: string): StillElement[] {
    const asked = parseSelectors(selector)
    const top = asked.some((one) => matchesComplex(this.documentElement, one))
    return [
      ...(top ? [this.documentElement] : []),
      ...this.documentElement.querySelectorAll(selector),
    ]
  }

  querySelector(selector: string): StillElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  getElementById(id: string): StillElement | null {
    return this.querySelectorAll(`#${id}`)[0] ?? null
  }
}
