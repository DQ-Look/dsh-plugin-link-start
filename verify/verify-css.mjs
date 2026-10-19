#!/usr/bin/env node
/**
 * verify/verify-css.mjs — the two CSS blobs: `src/style.css` (the overlay chrome,
 * injected as a `style` row) and the card's CSS string inside `src/client.js`.
 *
 * Both are CSS-in-a-string, and both have the same three failure modes, each of
 * which is INVISIBLE in the browser:
 *
 *  1. A BACKTICK inside a template-literal blob terminates it early. The build then
 *     silently keeps the PREVIOUS artifact and the change appears to do nothing.
 *  2. An UNQUOTED numeric attribute selector — `[data-state=0]` — is invalid CSS,
 *     because an unquoted value must be an identifier and one starting with a digit
 *     is not. Chrome drops the ENTIRE rule without a word, so the switch looks wired
 *     and does nothing.
 *  3. An UNPREFIXED selector leaks overlay rules into the host application's own
 *     styling. Every overlay selector must be `.dslls-`-namespaced.
 *
 * COMMENTS ARE STRIPPED FIRST. Both artifacts are comment-preserving, so prose
 * explaining an old approach would otherwise match as if it were the approach
 * (AGENTS.md). The stripper used here is a real scanner (`stripComments` in
 * `_harness.mjs`), not a regex: a regex deletes template literals and strings, and
 * on the real `src/client.js` destroyed 29% of the file.
 *
 * Exit: 0 pass · 1 fail · 3 pending
 */

import {
  createSuite,
  runSuite,
  readText,
  exists,
  show,
  stripComments,
  EXIT,
} from './_harness.mjs'

const suite = createSuite('verify-css — no backtick, quoted numeric attribute selectors, .dslls- namespacing')

const OVERLAY_CSS = 'src/style.css'
const CLIENT_JS = 'src/client.js'

// ---------------------------------------------------------------------------
// Shared assertions, run against both blobs.
// ---------------------------------------------------------------------------

/**
 * @param {string} label - what this blob is, for the assertion names.
 * @param {string} raw - the CSS source (already isolated from any wrapper).
 * @param {{requireNamespace?:boolean, allowComments?:boolean}} opts
 */
function auditCss(label, raw, opts = {}) {
  suite.check(`${label}: the blob is non-empty`, typeof raw === 'string' && raw.trim().length > 0, `length ${raw && raw.length}`)
  if (typeof raw !== 'string' || raw.trim().length === 0) return

  // Strip comments FIRST (AGENTS.md: strip before ANY regex assertion), then judge
  // the CODE. A backtick in a comment is prose; a backtick in the stylesheet body is
  // only fatal when the blob lives inside a JS template literal (`opts.inString`).
  const css = stripComments(raw, { mode: 'css' })
  suite.check(
    `${label}: stripping comments does not swallow the whole blob`,
    css.trim().length > raw.trim().length * 0.3,
    `raw ${raw.length} bytes, stripped ${css.length} bytes — the stripper ate the content, so every assertion below would be vacuous`,
  )

  // --- (1) no backtick in the CSS BODY -------------------------------------
  // `src/style.css` is a standalone file injected as a `style` row, so a backtick
  // in it is harmless. The card's CSS, by contrast, lives inside a JS string, where
  // a stray backtick terminates the literal. Assert accordingly.
  const bodyTicks = [...css.matchAll(/`/g)].length
  if (opts.inString === true) {
    suite.eq(
      `${label}: the CSS body contains NO backtick (a stray one ends the JS string and the build silently keeps the old artifact)`,
      bodyTicks,
      0,
    )
  } else {
    suite.check(
      `${label}: the CSS body contains no backtick`,
      bodyTicks === 0,
      `${bodyTicks} backtick(s) outside comments. Harmless in a standalone .css file but a signal worth knowing about`,
    )
  }
  // The terminator that IS fatal for a `style` row, in both shapes.
  suite.check(
    `${label}: contains no literal "</style" (it would close the injected element early)`,
    !raw.toLowerCase().includes('</style'),
    'a `style` row is interpolated verbatim; "</style" ends the element and the rest becomes markup',
  )

  // --- (2) numeric attribute selectors must be quoted ----------------------
  // Find every `[attr=value]` and assert the value is quoted when it is numeric
  // (or when it is not a valid identifier).
  const attrSel = [...css.matchAll(/\[\s*([\w-]+)\s*([~^$*|]?=)\s*("[^"]*"|'[^']*'|[^\]\s]+)\s*(\w)?\s*\]/g)]
  suite.check(`${label}: attribute selectors were found to check`, attrSel.length > 0, 'no attribute selectors found; the check below would be vacuous')
  let unquotedNumeric = []
  for (const m of attrSel) {
    const [, attr, , value] = m
    const quoted = value.startsWith('"') || value.startsWith("'")
    if (quoted) continue
    // An unquoted value must be a CSS identifier: no leading digit, no '.'.
    const isIdentifier = /^-?[A-Za-z_][\w-]*$/.test(value)
    if (!isIdentifier) unquotedNumeric.push(`[${attr}${m[2]}${value}]`)
  }
  suite.eq(
    `${label}: every attribute selector with a numeric/non-identifier value is QUOTED (unquoted numeric values make Chrome drop the whole rule silently)`,
    unquotedNumeric,
    [],
  )

  // The specific case the contract names.
  const badNumeric = [...css.matchAll(/\[data-[\w-]+\s*=\s*(-?\d[\w.%]*)\s*\]/g)].map((m) => m[0])
  suite.eq(
    `${label}: no unquoted numeric data-attribute selector such as [data-x=0]`,
    badNumeric,
    [],
  )

  // --- (3) namespacing -----------------------------------------------------
  if (opts.requireNamespace !== false) {
    // Collect every selector in the stylesheet, rule by rule, and check the leftmost
    // compound of each comma-separated selector.
    const selectors = extractSelectors(css)
    suite.check(`${label}: selectors were extracted to check namespacing`, selectors.length > 0, 'no selectors extracted')
    const unprefixed = selectors.filter((sel) => !isNamespaced(sel))
    suite.eq(
      `${label}: every selector is .dslls--namespaced (an unprefixed rule leaks into the host app)`,
      unprefixed,
      [],
    )
  }

  // A blob that is only comments/whitespace would make all of the above vacuous.
  const ruleCount = (css.match(/\{/g) ?? []).length
  suite.check(`${label}: the blob declares at least one rule`, ruleCount > 0, `found ${ruleCount} rule blocks`)
}

/** Extract selector lists from CSS, skipping at-rule preludes. */
function extractSelectors(css) {
  const out = []
  // Walk the text, tracking brace depth; at depth 0 anything before `{` is a
  // selector (or an at-rule prelude).
  let depth = 0
  let buf = ''
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '{') {
      const prelude = buf.trim()
      buf = ''
      depth++
      if (depth === 1 && prelude !== '' && !prelude.startsWith('@')) {
        for (const s of prelude.split(',')) out.push(s.trim())
      }
      if (depth === 1 && prelude.startsWith('@')) {
        // at-rule with a block (e.g. @media) — its inner rules are at depth 2, and
        // are handled by the same loop below.
      }
      continue
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      buf = ''
      continue
    }
    if (depth <= 1) buf += ch
  }
  return out.filter((s) => s !== '')
}

/** Is a selector's leftmost compound namespaced under `.dslls-`? */
function isNamespaced(selector) {
  const sel = selector.trim()
  if (sel === '') return true
  // Keyframe steps (`from`, `to`, `0%`) are not element selectors.
  if (/^(from|to|-?\d+(\.\d+)?%)$/.test(sel)) return true
  // Split on combinators, take the leftmost part.
  const leftmost = sel.split(/\s*[>+~]\s*|\s+/)[0]
  // Pseudo-elements/elements keyed off the overlay root are fine.
  if (leftmost.startsWith('.dslls-')) return true
  // `:root`, `*`, `html`, `body` are only acceptable if the rule is scoped by an
  // ancestor `.dslls-` later in the selector.
  if (/^(html|body|:root|\*)$/.test(leftmost)) {
    return /\.dslls-/.test(sel)
  }
  // A bare element selector is allowed only when scoped under .dslls-.
  return /\.dslls-/.test(sel)
}

// ---------------------------------------------------------------------------
// 1. src/style.css — the overlay chrome
// ---------------------------------------------------------------------------
if (suite.need(OVERLAY_CSS, 'render-dev')) {
  const raw = readText(OVERLAY_CSS)
  auditCss('style.css', raw, { inString: false })

  const css = stripComments(raw, { mode: 'css' })

  // §5: the full-viewport opaque root.
  suite.check(
    '§5 .dslls-root is defined',
    /\.dslls-root\b/.test(css),
    'no `.dslls-root` rule found',
  )
  suite.check(
    '§5 the root is position:fixed with an inset of 0',
    /\.dslls-root\s*\{[^}]*position\s*:\s*fixed/.test(css) && /\.dslls-root\s*\{[^}]*inset\s*:\s*0/.test(css),
    'the root must be position:fixed;inset:0 to cover the viewport',
  )
  suite.check(
    '§5 the root is at the maximum z-index (2147483647)',
    /\.dslls-root\s*\{[^}]*z-index\s*:\s*2147483647/.test(css),
    `the root's z-index does not pin it above everything: ${show(/z-index\s*:\s*([^;]+)/.exec(css)?.[1])}`,
  )
  suite.check(
    '§5 the root starts opaque (opacity 1) so the first frame is not the app showing through',
    /\.dslls-root\s*\{[^}]*opacity\s*:\s*1/.test(css),
    'the root does not declare opacity:1',
  )
  suite.check(
    '§5 the leaving state fades the WHOLE overlay as one unit (opacity transition on the root)',
    /\.dslls-root\[data-state="leaving"\]\s*\{[^}]*opacity\s*:\s*0/.test(css),
    'no `.dslls-root[data-state="leaving"] { opacity: 0 }` rule — the dissolve must fade the root, not its children',
  )
  suite.check(
    '§5 the leaving state also drops pointer-events so it cannot eat clicks on the app',
    /\[data-state="leaving"\][^}]*pointer-events\s*:\s*none/.test(css),
    'the leaving state does not set pointer-events:none',
  )
  suite.check(
    'the root covers with overflow hidden (no scrollbar from the overlay)',
    /\.dslls-root\s*\{[^}]*overflow\s*:\s*hidden/.test(css),
    'the root does not hide overflow',
  )

  // The attribute selectors actually used must all be quoted.
  for (const attr of ['data-state', 'data-attention', 'data-diag', 'data-hint']) {
    const uses = [...css.matchAll(new RegExp(`\\[${attr}\\s*=\\s*([^\\]]+)\\]`, 'g'))]
    for (const m of uses) {
      const v = m[1].trim()
      suite.check(
        `style.css [${attr}=${v}] is quoted`,
        v.startsWith('"') || v.startsWith("'"),
        `[${attr}=${v}] is unquoted; a numeric value here would make Chrome drop the entire rule silently`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 2. the card's CSS blob inside src/client.js
// ---------------------------------------------------------------------------
if (suite.need(CLIENT_JS, 'client-dev')) {
  const src = readText(CLIENT_JS)

  /**
   * Extract the card CSS blob from src/client.js.
   *
   * Two shapes are legitimate and both must be handled, because the failure this
   * guards against is the same in each:
   *   `const CSS = \`…\``              a template literal — a stray backtick truncates it
   *   `const CSS = ['a', 'b', …]`      an array of strings, joined at use
   * The shipped client uses the ARRAY form, which is why a naive
   * `const CSS = \`` regex reported "not found" and proved nothing.
   */
  function extractCardCss(source) {
    const tmpl = /(?:const|var|let)\s+CSS\s*=\s*`/.exec(source)
    if (tmpl !== null) {
      const start = tmpl.index + tmpl[0].length
      let i = start
      let end = -1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === '`') {
          end = i
          break
        }
        i++
      }
      return { kind: 'template', body: end > start ? source.slice(start, end) : source.slice(start), terminated: end > start, start }
    }
    const arr = /(?:const|var|let)\s+CSS\s*=\s*\[/.exec(source)
    if (arr !== null) {
      const start = source.indexOf('[', arr.index)
      // Find the matching close bracket, honouring string literals.
      let i = start
      let depth = 0
      let quote = null
      let end = -1
      while (i < source.length) {
        const ch = source[i]
        if (quote !== null) {
          if (ch === '\\') {
            i += 2
            continue
          }
          if (ch === quote) quote = null
          i++
          continue
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch
          i++
          continue
        }
        if (ch === '[') depth++
        else if (ch === ']') {
          depth--
          if (depth === 0) {
            end = i
            break
          }
        }
        i++
      }
      const inner = end > start ? source.slice(start + 1, end) : source.slice(start)
      // Concatenate the string literal contents, exactly as `.join('')` would.
      const pieces = [...inner.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, '$1'))
      return { kind: 'array', body: pieces.join(''), terminated: end > start, start, pieceCount: pieces.length }
    }
    return null
  }

  const found = extractCardCss(src)
  suite.check(
    '§6 src/client.js declares the card CSS as a string literal or an array of them',
    found !== null,
    'neither `const CSS = `…`` nor `const CSS = [...]` was found — this suite then cannot prove the card blob is backtick-free',
  )
  if (found !== null) {
    suite.check(
      `§6 the card CSS (${found.kind} form) is terminated`,
      found.terminated,
      'the CSS literal never closes',
    )
    // A stray backtick inside a template literal would have truncated `body`, so
    // assert the extracted blob looks like a complete stylesheet, then audit it.
    suite.check(
      '§6 the card CSS blob looks like a complete stylesheet (it was not truncated by a stray backtick)',
      /\{/.test(found.body) && /\}/.test(found.body) && found.body.length > 200,
      `blob is ${found.body.length} bytes: ${show(found.body.slice(0, 120))}`,
    )
    if (found.kind === 'array') {
      suite.check(
        '§6 the card CSS array has no piece containing a backtick (a backtick would end a template literal elsewhere)',
        !found.body.includes('`'),
        'a backtick is present in the joined CSS',
      )
      suite.check('§6 the card CSS array has several pieces', found.pieceCount > 5, `pieceCount=${found.pieceCount}`)
    }
    auditCss('card CSS', found.body, { inString: true, requireNamespace: false })

    const cardCss = stripComments(found.body, { mode: 'css' })
    suite.check(
      '§6 the card CSS uses the host tokens with literal fallbacks (var(--dsw-alias-*, …))',
      /var\(\s*--dsw-alias-/.test(cardCss),
      'no `var(--dsw-alias-...)` token usage found',
    )
    const tokenUses = [...cardCss.matchAll(/var\(\s*(--[\w-]+)\s*,\s*([^)]*)\)/g)]
    suite.check(
      '§6 the card declares at least one token with a literal fallback',
      tokenUses.length > 0,
      'every var() has no fallback, so an unthemed host renders unstyled controls',
    )
    const emptyFallback = tokenUses.filter((t) => t[2].trim() === '').map((t) => t[1])
    suite.eq(
      '§6 every var(…) has a non-empty literal fallback',
      emptyFallback,
      [],
    )
    // Class names that could collide with the host application. Judge the LEFTMOST
    // compound of each selector, not every `.class` token: `.dslls-msg.err` is
    // correctly scoped (it only ever matches inside the card), whereas a bare
    // `.err` rule would leak into the host's own error styling.
    const cardSelectors = extractSelectors(cardCss)
    // For each selector take its LEFTMOST COMPOUND (before any combinator) and then
    // the FIRST class in that compound. The first class is what determines whether
    // the rule is scoped: `.dslls-msg.err` is namespaced (it can only match inside
    // the card), whereas a rule beginning `.err` would leak into the host app.
    // Collecting every class token in the compound would wrongly flag the `err`.
    const leftmostClasses = [
      ...new Set(
        cardSelectors
          .map((sel) => sel.split(/\s*[>+~]\s*|\s+/)[0])
          .map((compound) => {
            const first = /\.([a-zA-Z][\w-]*)/.exec(compound)
            return first === null ? null : first[1]
          })
          .filter((c) => c !== null),
      ),
    ]
    const suspicious = leftmostClasses.filter((c) => !/^(dslls|dsh|dsw|link|ls)[-_A-Za-z0-9]*/.test(c))
    suite.eq(
      '§6 no card rule starts with an unprefixed class (an unprefixed selector leaks into the host app)',
      suspicious,
      [],
    )
    suite.check(
      '§6 the card CSS actually declares namespaced rules (the previous assertion is not vacuous)',
      leftmostClasses.some((c) => c.startsWith('dslls-')),
      `leftmost classes were: ${show(leftmostClasses)}`,
    )
  } else {
    const ticks = (src.match(/`/g) ?? []).length
    suite.check(
      '§6 src/client.js has an even backtick count (an odd count means a literal is unterminated)',
      ticks % 2 === 0,
      `found ${ticks} backticks`,
    )
  }
}

// ---------------------------------------------------------------------------
// 3. defensive: the overlay's style row and the .dslls- prefix agree
// ---------------------------------------------------------------------------
suite.section('the .dslls- prefix is used consistently', () => {
  if (exists(OVERLAY_CSS)) {
    const css = stripComments(readText(OVERLAY_CSS), { mode: 'css' })
    const classes = [...new Set([...css.matchAll(/\.(dslls-[\w-]+)/g)].map((m) => m[1]))]
    suite.check('style.css defines at least one .dslls- class', classes.length > 0, 'no .dslls- classes found')
  }
  if (exists('src/boot-screen.js')) {
    const js = readText('src/boot-screen.js')
    const used = [...new Set([...js.matchAll(/['"](dslls-[\w-]+)/g)].map((m) => m[1]))]
    suite.check(
      'boot-screen.js applies .dslls- class names (the same prefix the stylesheet defines)',
      used.length > 0,
      'no `dslls-` class name appears in boot-screen.js, so the chrome would be unstyled',
    )
    if (exists(OVERLAY_CSS)) {
      const css = stripComments(readText(OVERLAY_CSS), { mode: 'css' })
      const defined = new Set([...css.matchAll(/\.(dslls-[\w-]+)/g)].map((m) => m[1]))
      const missing = used.filter((c) => !defined.has(c))
      suite.check(
        'every .dslls- class boot-screen.js applies is defined in style.css (or is set via a data- attribute selector)',
        missing.length === 0 || missing.every((c) => new RegExp(`\\.${c}\\b`).test(js) === false),
        `classes applied but never defined: ${show(missing)}`,
      )
    }
  }
})

runSuite(suite)
