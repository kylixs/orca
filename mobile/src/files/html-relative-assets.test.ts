import { describe, expect, it } from 'vitest'
import { findRelativeHtmlAssetRefs, relativeHtmlAssetWarning } from './html-relative-assets'

describe('findRelativeHtmlAssetRefs', () => {
  it('returns nothing for a self-contained document', () => {
    expect(
      findRelativeHtmlAssetRefs(
        '<style>body{background:#fff}</style><h1>Hello</h1><script>1</script>'
      )
    ).toEqual([])
    expect(findRelativeHtmlAssetRefs('')).toEqual([])
  })

  it('finds relative styles, images, scripts and CSS url() references', () => {
    const html = [
      '<link rel="stylesheet" href="./styles/app.css">',
      '<script src="../js/app.js"></script>',
      '<img src="assets/hero.png">',
      '<div style="background:url(../images/bg.png)"></div>'
    ].join('')
    expect(findRelativeHtmlAssetRefs(html)).toEqual([
      './styles/app.css',
      '../js/app.js',
      'assets/hero.png',
      'url(../images/bg.png)'
    ])
  })

  it('keeps root-absolute paths, which cannot resolve in about:blank either', () => {
    expect(findRelativeHtmlAssetRefs('<link href="/assets/x.css">')).toEqual(['/assets/x.css'])
  })

  it.each([
    'https://example.com/a.png',
    'http://example.com/a.png',
    'data:image/png;base64,AAAA',
    'mailto:a@example.com',
    'tel:+15551234',
    'javascript:void(0)',
    'about:blank',
    'blob:https://example.com/id',
    '//cdn.example.com/a.js',
    '#section',
    ''
  ])('ignores %p', (value) => {
    expect(findRelativeHtmlAssetRefs(`<a href="${value}">x</a>`)).toEqual([])
    expect(findRelativeHtmlAssetRefs(`<img src="${value}">`)).toEqual([])
  })

  it('ignores attribute-shaped text in comments, scripts, styles and pre examples', () => {
    const html = [
      '<!-- <img src="./commented.png"> -->',
      '<script>const example = \'<img src="./script.png">\'</script>',
      '<style>.bg{background:url(./style.png)}</style>',
      '<pre><code>&lt;img src="./example.png"&gt;</code></pre>',
      '<img src="./real.png">'
    ].join('')

    expect(findRelativeHtmlAssetRefs(html)).toEqual(['./real.png'])
  })

  it('does not report escaped refs inside an iframe srcdoc attribute', () => {
    // Regression: the escaped srcdoc markup was scanned as top-level attributes, so
    // href=&quot;javascript:... looked like a relative path and showed a garbled warning.
    const html = [
      "<iframe srcdoc=\"&lt;a id='x' href=&quot;javascript:void(parent.document.getElementById('status'))&quot;&gt;x&lt;/a&gt;\"></iframe>",
      '<iframe srcdoc=\'<img src="./inner.png">\'></iframe>',
      '<img src="./outer.png">'
    ].join('')
    expect(findRelativeHtmlAssetRefs(html)).toEqual(['./outer.png'])
    expect(relativeHtmlAssetWarning(findRelativeHtmlAssetRefs(html))).toBe(
      'Relative assets may not load: ./outer.png. Detected from src / href / url() in this file.'
    )
  })

  it('keeps the live src on an inert script or style tag', () => {
    const html =
      '<script src="./app.js">const x = "<img src=\\"./fake.png\\">"</script>' +
      '<link rel="stylesheet" href="./app.css">'
    expect(findRelativeHtmlAssetRefs(html)).toEqual(['./app.js', './app.css'])
  })

  it('returns src, href and url() refs in document order, not one kind first', () => {
    const html =
      '<div style="background:url(./bg.png)"></div>' +
      '<img src="./hero.png">' +
      '<a href="./page.html">x</a>'

    expect(findRelativeHtmlAssetRefs(html)).toEqual(['url(./bg.png)', './hero.png', './page.html'])
  })

  it('ignores srcset and poster, which are out of scope', () => {
    expect(
      findRelativeHtmlAssetRefs(
        '<img srcset="./a.png 1x, ./b.png 2x"><video poster="./poster.png"></video>'
      )
    ).toEqual([])
  })

  it('deduplicates repeated references in document order', () => {
    expect(
      findRelativeHtmlAssetRefs('<img src="./a.png"><img src="./a.png"><img src="./b.png">')
    ).toEqual(['./a.png', './b.png'])
  })
})

describe('relativeHtmlAssetWarning', () => {
  it('is omitted when nothing is relative', () => {
    expect(relativeHtmlAssetWarning([])).toBeNull()
  })

  it('uses the normative copy and lists at most three refs', () => {
    expect(relativeHtmlAssetWarning(['./a.css', './b.js', 'url(../c.png)', './d.png'])).toBe(
      'Relative assets may not load: ./a.css, ./b.js, url(../c.png). Detected from src / href / url() in this file.'
    )
  })
})
