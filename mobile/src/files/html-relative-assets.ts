/**
 * The relative asset references a rendered HTML artifact would try to resolve.
 *
 * Only `src`, `href` and `url(...)` are read. `srcset`, `poster` and CSS `@import` strings are out
 * of scope (design 8.6). Comments, script/style bodies and `<pre>` examples are not markup the
 * renderer acts on, so attribute-shaped prose there must not raise the warning. `url(...)` values
 * keep their wrapper so the warning lists what the document actually wrote, as the prototype does.
 */
const COMMENT = /<!--[\s\S]*?-->/g
const SCRIPT_BODY = /(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi
const STYLE_BODY = /(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi
const PRE_BODY = /(<pre\b[^>]*>)[\s\S]*?(<\/pre\s*>)/gi
/** `srcdoc` holds a second, HTML-escaped document; its refs are not top-level assets. */
const SRCDOC_ATTR = /(?<![\w-])srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi

/** One pass so the returned refs keep document order across attributes and CSS `url()`. */
const ASSET_REF =
  /(?<![\w-])(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi

export function findRelativeHtmlAssetRefs(html: string): string[] {
  if (!html) {
    return []
  }
  const refs: string[] = []
  const seen = new Set<string>()
  for (const match of stripInertMarkup(html).matchAll(ASSET_REF)) {
    const cssUrl = match[4] !== undefined || match[5] !== undefined || match[6] !== undefined
    addRef(refs, seen, match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6], cssUrl)
  }
  return refs
}

export function relativeHtmlAssetWarning(refs: readonly string[]): string | null {
  if (refs.length === 0) {
    return null
  }
  const listed = refs.slice(0, 3).join(', ')
  return `Relative assets may not load: ${listed}. Detected from src / href / url() in this file.`
}

function stripInertMarkup(html: string): string {
  return html
    .replace(COMMENT, '')
    .replace(SRCDOC_ATTR, 'srcdoc=""')
    .replace(SCRIPT_BODY, '$1$2')
    .replace(STYLE_BODY, '$1$2')
    .replace(PRE_BODY, '$1$2')
}

function addRef(refs: string[], seen: Set<string>, raw: string | undefined, cssUrl: boolean): void {
  const value = raw?.trim()
  if (!value || !isRelativeAssetRef(value)) {
    return
  }
  const ref = cssUrl ? `url(${value})` : value
  if (seen.has(ref)) {
    return
  }
  seen.add(ref)
  refs.push(ref)
}

function isRelativeAssetRef(value: string): boolean {
  if (value.startsWith('#')) {
    return false
  }
  // Protocol-relative URLs carry their own host and resolve without the worktree.
  if (value.startsWith('//')) {
    return false
  }
  // Any explicit scheme (http, https, data, mailto, tel, javascript, about, blob, file, custom)
  // is not a worktree-relative path. Root-absolute paths have no scheme and are kept below.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    return false
  }
  return true
}
