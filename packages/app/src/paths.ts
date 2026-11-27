// `node:path`'s three answers about a `/`-separated path, with no Node.
//
// The window's drawing runs in a browser too (`browser.ts`), and a pure file
// that imports `node:path` for a file's name cannot load there. These are
// Node's own POSIX `basename`, `dirname` and `extname`, the same loops over
// the same characters, so a name drawn on a phone is the name drawn on the
// machine — `test/paths.test.ts` holds each against `node:path` over the cases
// that differ between a guess and the real thing (`//a`, `.bashrc`, `a..`,
// trailing slashes) and a few thousand generated ones.

const SLASH = 47
const DOT = 46

/** The last part of a path, trailing slashes not counting: `node:path`'s `basename`. */
export function fileName(path: string): string {
  let start = 0
  let end = -1
  let matchedSlash = true
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) {
        start = i + 1
        break
      }
    } else if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
  }
  return end === -1 ? '' : path.slice(start, end)
}

/** Everything before the last part: `node:path`'s `dirname`. */
export function folderOf(path: string): string {
  if (path.length === 0) return '.'
  const hasRoot = path.charCodeAt(0) === SLASH
  let end = -1
  let matchedSlash = true
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) {
        end = i
        break
      }
    } else {
      matchedSlash = false
    }
  }
  if (end === -1) return hasRoot ? '/' : '.'
  if (hasRoot && end === 1) return '//'
  return path.slice(0, end)
}

/** The last part's extension, dot included, or `''`: `node:path`'s `extname`. */
export function extensionOf(path: string): string {
  let startDot = -1
  let startPart = 0
  let end = -1
  let matchedSlash = true
  // 0: no dot before the last one; 1: a dot run; -1: a character that is not a dot.
  let preDotState = 0
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i)
    if (code === SLASH) {
      if (!matchedSlash) {
        startPart = i + 1
        break
      }
      continue
    }
    if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
    if (code === DOT) {
      if (startDot === -1) startDot = i
      else if (preDotState !== 1) preDotState = 1
    } else if (startDot !== -1) {
      preDotState = -1
    }
  }
  if (
    startDot === -1 ||
    end === -1 ||
    preDotState === 0 ||
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return ''
  }
  return path.slice(startDot, end)
}
