#!/usr/bin/env node
/**
 * verify/verify-injection-safety.mjs — the invariant that protects the HTML.
 *
 * A `script` row's `text` is interpolated into the document VERBATIM (see
 * `renderRow` in the installed `dsh-host-webserver`, `.scratch/dsh-src/...`):
 *
 *     case "script": return { placement: row.placement, markup: `<script>${row.text}<\/script>` }
 *
 * It is NOT escaped. So a literal `</script` anywhere in an injected source — in a
 * string, in a comment, in a regex — closes the element early and leaves the rest
 * of the file as markup. The `global` row IS escaped (`JSON.stringify(v).replaceAll('<','\\u003c')`),
 * which is exactly what lets a plugin-controlled string (the user's `title`) travel
 * safely. This suite asserts all three layers:
 *
 *   1. `isInjectable()` refuses the terminator, kind-specifically (`</script` for a
 *      script row, `</style` for a style row) — including in a COMMENT, which is
 *      where it is easiest to miss.
 *   2. the composed overlay is clean, and a dirty source makes `composeOverlay`
 *      return undefined rather than emitting a page-breaking row.
 *   3. the emitted `global` row value escapes `<`, so a title of
 *      `</script><script>alert(1)</script>` cannot break out.
 *   4. a missing/unreadable source file DEGRADES (log a warning, inject nothing)
 *      instead of throwing or blanking the page.
 *
 * §9b note: on desktop the script row is appended as a real element with
 * `textContent`, where `</script` is harmless. On Web it sits in the HTML text.
 * The guard protects the surface this plugin is primarily built for, so it is not
 * relaxed for desktop's convenience.
 *
 * Exit: 0 pass · 1 fail · 3 pending
 */

import { createSuite, runSuite, readText, exists, show, at, EXIT } from './_harness.mjs'

const suite = createSuite('verify-injection-safety — </script, < escaping, graceful degradation')

const INJECT_FILES = [
  ['src/scene.js', 'script'],
  ['src/boot-screen.js', 'script'],
  ['src/style.css', 'style'],
]

let m = null
try {
  m = await import('../index.js')
} catch (err) {
  suite.fatal(`import('../index.js') threw: ${err && err.message ? err.message : err}`)
}

// The Lead's verbatim extraction of the installed kernel's injection renderer
// (`.scratch/kernel-vendor/injections.mjs`). Optional: when present, the escaping
// assertions below are checked against the REAL implementation rather than only
// against my transcription of it. Absent => those extra checks are skipped, and
// the suite still proves the contract from index.js's side.
let kernelInjector = null
if (exists('.scratch/kernel-vendor/injections.mjs')) {
  try {
    kernelInjector = await import('../.scratch/kernel-vendor/injections.mjs')
  } catch (err) {
    suite.fatal(`the vendored kernel injector exists but failed to import: ${err && err.message ? err.message : err}`)
  }
}

if (m !== null) {
  // -------------------------------------------------------------------------
  // 1. isInjectable — the guard itself, kind-specifically
  // -------------------------------------------------------------------------
  suite.section('isInjectable() refuses the terminator', () => {
    suite.check('a clean script source passes', m.isInjectable('t', 'var a = 1', 'script') === true, 'a clean source was refused')
    suite.check(
      'a literal </script in a string is refused',
      m.isInjectable('t', 'var a = "</script>"', 'script') === false,
      'the exact defect the guard exists for was allowed through',
    )
    suite.check(
      'a literal </script inside a COMMENT is refused (the easiest one to miss)',
      m.isInjectable('t', '// we used to write </script> here\nvar a = 1', 'script') === false,
      'a comment is still document text and still closes the element',
    )
    suite.check(
      'case-insensitivity: </SCRIPT is refused too (HTML closes case-insensitively)',
      m.isInjectable('t', 'var a = "</SCRIPT>"', 'script') === false,
      'an uppercase terminator was allowed',
    )
    suite.check(
      'a style row refuses </style',
      m.isInjectable('t', 'body::after{content:"</style>"}', 'style') === false,
      'a style terminator was allowed into a style row',
    )
    suite.check(
      'a style row does NOT refuse </script (the terminator is kind-specific)',
      m.isInjectable('t', 'body::after{content:"</script>"}', 'style') === true,
      '</script inside a style element is harmless and must not block a legit stylesheet',
    )
    suite.check(
      'a script row DOES refuse </script (the default kind)',
      m.isInjectable('t', 'var a = "</script>"') === false,
      'the default kind is not script',
    )
    suite.check(
      'the emitted diagnostic does not echo the offending payload',
      (() => {
        const seen = []
        const orig = process.emitWarning
        process.emitWarning = (w) => seen.push(String(w))
        try {
          m.isInjectable('src/test.js', 'SECRET_PAYLOAD</script>', 'script')
        } finally {
          process.emitWarning = orig
        }
        return seen.length > 0 && seen.every((w) => !w.includes('SECRET_PAYLOAD'))
      })(),
      'the warning repeated the payload into the log',
    )
  })

  // -------------------------------------------------------------------------
  // 2. composeOverlay — a dirty source produces NO row
  // -------------------------------------------------------------------------
  suite.section('composeOverlay refuses a dirty source', () => {
    const clean = { scene: 'var s=1', screen: 'var b=2' }
    const composed = m.composeOverlay(clean)
    suite.check('two clean sources compose', typeof composed === 'string' && composed.includes('var s=1') && composed.includes('var b=2'), `composeOverlay returned ${show(composed)}`)
    suite.check(
      'the composed text puts scene.js BEFORE boot-screen.js',
      typeof composed === 'string' && composed.indexOf('var s=1') < composed.indexOf('var b=2'),
      'boot-screen.js must run after scene.js defines __DSH_LINK_START_SCENE__',
    )
    suite.check(
      'a dirty scene source composes to undefined (not a broken page)',
      m.composeOverlay({ ...clean, scene: 'var s="</script>"' }) === undefined,
      'a page-breaking scene source was allowed through',
    )
    suite.check(
      'a dirty screen source composes to undefined',
      m.composeOverlay({ ...clean, screen: 'var b="</script>"' }) === undefined,
      'a page-breaking screen source was allowed through',
    )
    suite.check('a missing scene source composes to undefined', m.composeOverlay({ scene: undefined, screen: 'x' }) === undefined, 'undefined scene did not degrade')
    suite.check('a missing screen source composes to undefined', m.composeOverlay({ scene: 'x', screen: undefined }) === undefined, 'undefined screen did not degrade')

    // And the row builder must emit nothing from a dirty source.
    const settings = m.resolveSettings(undefined)
    suite.eq(
      'buildRows emits no script row when the scene source is dirty',
      m.buildRows(settings, { scene: '</script>', screen: 'var b=2' }).length,
      0,
    )
    suite.eq(
      'buildRows emits no style row when the stylesheet is dirty',
      m.buildRows(settings, { scene: 'var s=1', screen: 'var b=2', style: '</style>' }).length,
      2,
    )
  })

  // -------------------------------------------------------------------------
  // 3. the global row escapes '<'
  // -------------------------------------------------------------------------
  suite.section('the config global cannot break out of its script element', () => {
    const HOSTILE = '</script><script>globalThis.PWNED=1</script>'
    const settings = { ...m.resolveSettings(undefined), title: HOSTILE }
    const rows = m.buildRows(settings, { scene: 'var s=1', screen: 'var b=2' })
    const cfgRow = rows.find((r) => r.kind === 'global' && r.name === '__DSH_LINK_START_CFG__')
    suite.check('the config global row is emitted', cfgRow !== undefined, `rows were ${show(rows.map((r) => r.kind))}`)
    if (cfgRow !== undefined) {
      // The escaping is `renderRow`'s job in the KERNEL's webserver, not
      // index.js's: the row carries the value, and the row renderer applies
      //     JSON.stringify(row.value).replaceAll('<', '\\u003c')
      // (installed `dsh-host-webserver/lib/index.js`, the `case "global"` arm).
      // So the correct assertion is on the RENDERED markup, reproduced exactly.
      const serialized = JSON.stringify(cfgRow.value)
      suite.check(
        'the raw row value still carries the hostile title as data — index.js must NOT pre-escape it, or the value would double-escape',
        serialized.includes('globalThis.PWNED'),
        'the title was dropped from the row value; the webserver renders whatever the row holds, so the value is the only carrier',
      )

      const markup = `<script>globalThis[${JSON.stringify(cfgRow.name).replaceAll('<', '\\u003c')}] = ${JSON.stringify(cfgRow.value).replaceAll('<', '\\u003c')}</script>`
      // Every "<" in the rendered markup must belong to the two real tags.
      const strayLt = markup.replaceAll('<script>', '').replaceAll('</script>', '')
      suite.check(
        'after renderRow escaping, no "<" survives outside the real <script>/<\/script> tags',
        !strayLt.includes('<'),
        `stray markup after removing the two real tags: ${show(strayLt.slice(0, 200))}`,
      )
      const scriptOpen = (markup.match(/<script/gi) ?? []).length
      suite.eq('the rendered global row markup contains exactly one <script', scriptOpen, 1)
      const terminator = (markup.match(/<\/script/gi) ?? []).length
      suite.eq('the rendered global row markup contains exactly one </script (its own)', terminator, 1)
      suite.check(
        'the escaped form \\u003c is what actually appears in the markup',
        markup.includes('\\u003c'),
        'no \\u003c escape was produced, so the hostile title is live markup',
      )
      // And it must still parse as the intended single statement.
      suite.notThrows('the rendered global row markup is parseable JS', () => {
        const body = markup.slice('<script>'.length, markup.length - '</script>'.length)
        // eslint-disable-next-line no-new-func
        new Function(body)
      })

      // Cross-check against the KERNEL'S OWN renderer, using the Lead's verbatim
      // extraction of the installed payload. This upgrades the reproduced
      // escaping above into an assertion about the real implementation rather
      // than about my transcription of it.
      if (exists('.scratch/kernel-vendor/injections.mjs')) {
        const kernel = kernelInjector
        if (kernel !== null && typeof kernel.renderIndexInjections === 'function') {
          const shell = '<!doctype html><html><head><title>t</title></head><body><div id=root></div></body></html>'
          const hostileRows = [
            { kind: 'global', name: m.CONFIG_GLOBAL, value: cfgRow.value },
            { kind: 'script', placement: 'head', text: 'var s=1' },
          ]
          const out = kernel.renderIndexInjections(shell, hostileRows)
          const headAt = out.indexOf('<head>') + '<head>'.length
          const injected = out.slice(headAt, out.indexOf('</head>'))
          suite.check(
            'the KERNEL renderer produces no live </script> from the hostile title — the config global cannot break out',
            (injected.match(/<\/script/gi) ?? []).length === 2,
            `expected exactly 2 </script in head (the global row's own + the script row's own); the hostile title added more:\n${show(injected)}`,
          )
          suite.check(
            'the kernel renderer escaped every "<" in the config value',
            !injected.split('</script>')[0].includes('<script', injected.indexOf('<script') + 1),
            `a second "<script" appeared inside the global row:\n${show(injected.slice(0, 300))}`,
          )
          suite.check(
            'the hostile title is present as escaped data (not deleted)',
            injected.includes('globalThis.PWNED'),
            'the title vanished from the rendered head',
          )
          // The real proof: evaluate the injected global row the way a browser
          // would, and assert the page-level global holds the hostile string as
          // DATA while the escape sequence is gone from the executable text.
          suite.section('the kernel-rendered global row executes to the intended value', () => {
            const globalRow = /<script>globalThis\[[^\]]*\]\s*=\s*([\s\S]*?)<\/script>/.exec(injected)
            suite.check('the global row is extractable from the rendered head', globalRow !== null, `could not match a global row in:\n${show(injected.slice(0, 300))}`)
            if (globalRow !== null) {
              const expr = globalRow[1]
              let evaluated
              try {
                // eslint-disable-next-line no-new-func
                evaluated = new Function(`return (${expr})`)()
              } catch (err) {
                suite.check('the global row expression evaluates', false, `threw: ${err && err.message ? err.message : err}`)
                return
              }
              suite.eq(
                'evaluating the rendered global row yields the hostile title verbatim — escaping preserved the data exactly',
                evaluated.title,
                HOSTILE,
              )
              suite.eq(
                'every other config field survived the round trip unchanged',
                { ...evaluated, title: undefined },
                { ...cfgRow.value, title: undefined },
              )
            }
          })
        }
      }
    }
  })

  // -------------------------------------------------------------------------
  // 4. readSource degrades instead of throwing
  // -------------------------------------------------------------------------
  suite.section('readSource degrades on a missing/unreadable file', () => {
    const res = suite.notThrows('readSource of a missing file does not throw', () => m.readSource('src/__does_not_exist__.js'))
    if (res.ok) {
      suite.eq('readSource of a missing file returns undefined (inject nothing, show the kernel page)', res.value, undefined)
    }
    const ok = suite.notThrows('readSource of a real file returns its text', () => m.readSource('package.json'))
    if (ok.ok) {
      suite.check('readSource of package.json returns a string containing the package name', typeof ok.value === 'string' && ok.value.includes('dsh-link-start'), `got ${show(ok.value && ok.value.slice(0, 60))}`)
    }
    // A directory is the other realistic unreadable case.
    const dir = suite.notThrows('readSource of a directory does not throw', () => m.readSource('src'))
    if (dir.ok) suite.eq('readSource of a directory returns undefined', dir.value, undefined)
  })

  // -------------------------------------------------------------------------
  // 5. the real on-disk sources
  // -------------------------------------------------------------------------
  for (const [file, kind] of INJECT_FILES) {
    if (!exists(file)) {
      suite.need(file, kind === 'style' ? 'render-dev' : file.includes('screen') ? 'render-dev' : 'scene-dev')
      continue
    }
    const text = readText(file)
    const terminator = kind === 'style' ? '</style' : '</script'
    const hits = [...text.toLowerCase().matchAll(new RegExp(terminator.replace('/', '\\/'), 'g'))].length
    suite.check(
      `${file} contains no literal ${terminator} (it would terminate the injected element)`,
      hits === 0,
      `found ${hits} occurrence(s) of "${terminator}" — the first at offset ${text.toLowerCase().indexOf(terminator)}`,
    )
    suite.check(
      `${file} passes isInjectable()`,
      m.isInjectable(file, text, kind) === true,
      'isInjectable refused the real source; index.js would inject NOTHING and the kernel page would show',
    )
  }

  // The composed real overlay, if both halves are present.
  if (exists('src/scene.js') && exists('src/boot-screen.js')) {
    const overlay = m.composeOverlay({ scene: readText('src/scene.js'), screen: readText('src/boot-screen.js') })
    suite.check('the real overlay composes (both halves are present and injectable)', typeof overlay === 'string', 'composeOverlay returned undefined for the real sources')
    if (typeof overlay === 'string') {
      suite.check('the real composed overlay contains no </script', !overlay.toLowerCase().includes('</script'), `found "</script" at offset ${overlay.toLowerCase().indexOf('</script')}`)
      suite.notThrows('the real composed overlay is syntactically valid JS', () => new Function(overlay))
    }
  }
}

runSuite(suite)
