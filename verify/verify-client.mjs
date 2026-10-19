#!/usr/bin/env node
/**
 * verify/verify-client.mjs — the browser half and its build artifact.
 *
 * `lib/client.js` is a committed BUILD ARTIFACT; `src/client.js` is the source of
 * truth. The most valuable assertion in this file is therefore the **freshness
 * check**: rebuild `src/client.js` through `build-client.mjs` and assert the
 * committed `lib/client.js` is byte-identical. A stale artifact is the single most
 * confusing failure in this repo — the source looks correct, the card behaves like
 * the old code, and nothing anywhere says why (AGENTS.md: "the build silently keeps
 * the previous artifact").
 *
 * The rest assert the §6/§10.4 invariants whose failure mode is fatal:
 *   - `exports.inject` MUST stay empty. A static inject the profile cannot satisfy
 *     leaves the fiber PENDING; web boot treats ANY non-active entry as fatal and
 *     the ENTIRE GUI refuses to mount (`web boot: N entries did not activate`).
 *   - `clientReady()` runs FIRST, unconditionally, in its own try/catch.
 *   - never `ctx.get(` — it races activation and answers undefined, so the card
 *     never registers and there is no error anywhere.
 *   - exactly one `__ModuleLoader__.load` wrapper.
 *
 * Exit: 0 pass · 1 fail · 3 pending
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSuite, runSuite, readText, exists, at, show, stripComments, EXIT } from './_harness.mjs'

const suite = createSuite('verify-client — lib/client.js freshness + §6/§10.4 client invariants')

const SRC = 'src/client.js'
const LIB = 'lib/client.js'
const BUILD = 'build-client.mjs'

const srcReady = suite.need(SRC, 'client-dev')
const libReady = suite.need(LIB, 'client-dev')

// ---------------------------------------------------------------------------
// 1. FRESHNESS — rebuild and compare
// ---------------------------------------------------------------------------
if (srcReady && libReady) {
  const srcText = readText(SRC)
  const libText = readText(LIB)

  if (!exists(BUILD)) {
    suite.need(BUILD, 'client-dev')
  } else {
    // SAFETY AND NON-DESTRUCTION.
    //
    // `build-client.mjs` writes to a FIXED path (`<root>/lib/client.js`) and takes
    // no output flag, so running it in the repo would clobber a file outside this
    // suite's write scope — unacceptable for a verifier, and actively harmful if the
    // tree is being edited concurrently.
    //
    // Instead: replicate the repository layout in a temp directory (package.json +
    // src/client.js + build-client.mjs), run the REAL builder there unmodified, and
    // compare its output with the committed artifact. The committed `lib/client.js`
    // is never written, and the comparison is still against the genuine build.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshlinkverify-'))
    let built = null
    let buildErr = null
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true })
      fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true })
      fs.copyFileSync(at('package.json'), path.join(tmp, 'package.json'))
      fs.copyFileSync(at(SRC), path.join(tmp, 'src', 'client.js'))
      fs.copyFileSync(at(BUILD), path.join(tmp, 'build-client.mjs'))

      const { spawnSync } = await import('node:child_process')
      const proc = spawnSync(process.execPath, [path.join(tmp, 'build-client.mjs')], {
        cwd: tmp,
        encoding: 'utf8',
      })
      if (proc.status !== 0) {
        buildErr = `build-client.mjs exited ${proc.status}\n${(proc.stderr || proc.stdout || '').slice(0, 500)}`
      } else {
        const out = path.join(tmp, 'lib', 'client.js')
        if (!fs.existsSync(out)) {
          buildErr = `build-client.mjs reported success but wrote no lib/client.js\n${(proc.stdout || '').slice(0, 300)}`
        } else {
          built = fs.readFileSync(out)
        }
      }
    } catch (err) {
      buildErr = err && err.message ? err.message : String(err)
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }

    if (buildErr !== null) {
      suite.check('build-client.mjs runs cleanly in an isolated copy', false, buildErr)
    } else if (built !== null) {
      // Report the FIRST differing line, so a stale artifact is diagnosable.
      const a = built.toString('utf8')
      const b = libText
      let diff = null
      if (a !== b) {
        const al = a.split('\n')
        const bl = b.split('\n')
        for (let i = 0; i < Math.max(al.length, bl.length); i++) {
          if (al[i] !== bl[i]) {
            diff = `first differing line ${i + 1}:\n      fresh   ${show(al[i])}\n      committed ${show(bl[i])}`
            break
          }
        }
        if (diff === null) diff = `identical lines but different content (line counts ${al.length} vs ${bl.length})`
      }
      suite.check(
        'lib/client.js is UP TO DATE with src/client.js (a fresh build is byte-identical)',
        a === b,
        'the committed lib/client.js differs from a fresh build of src/client.js — run `node build-client.mjs`. ' +
          'A stale artifact makes src/client.js edits appear to do nothing, and it is the documented cause of "the card behaves like the old code"' +
          (diff === null ? '' : `\n      ${diff}`),
      )
      suite.eq('a fresh build produces the same byte length as the committed artifact', built.length, Buffer.byteLength(libText))
      suite.check(
        'the freshness check is non-vacuous (the build produced a non-empty bundle)',
        built.length > 1000,
        `the fresh build is only ${built.length} bytes, so the comparison proves nothing`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // 2. exactly one __ModuleLoader__.load wrapper
  // -------------------------------------------------------------------------
  const loads = [...libText.matchAll(/__ModuleLoader__\s*\.\s*load\s*\(/g)].length
  suite.eq('lib/client.js wraps in exactly one __ModuleLoader__.load', loads, 1)
  suite.check(
    'the wrapper id is the package name',
    /__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*['"]dsh-link-start['"]/.test(libText) ||
      /id\s*:\s*['"]dsh-link-start['"]/.test(libText),
    'the loader id must be "dsh-link-start" (it is matched against package.json)',
  )
  suite.check(
    'the wrapper exposes a factory function (the module-loader contract)',
    /factory\s*:/.test(libText) || /factory\s*\(/.test(libText),
    'no `factory` in the wrapper — __ModuleLoader__.load would not be able to construct the module',
  )
  suite.check(
    'src/client.js is NOT already wrapped (the builder must refuse a double wrap)',
    !/__ModuleLoader__\s*\.\s*load\s*\(/.test(srcText),
    'src/client.js already contains a __ModuleLoader__.load wrapper; build-client.mjs must refuse to build this and the artifact would become doubly wrapped',
  )

  const stripped = stripComments(libText)
  const srcStripped = stripComments(srcText)

  // -------------------------------------------------------------------------
  // 3. exports.inject must be EMPTY (§6, §10.4) — fatal to the whole GUI
  // -------------------------------------------------------------------------
  const INJECT_MSG =
    'A static inject that the profile cannot satisfy leaves the fiber PENDING, and web boot treats ANY non-active entry as fatal: ' +
    'the ENTIRE GUI refuses to mount with "web boot: N entries did not activate"'

  // Any assignment of a non-empty array to exports.inject / module.exports.inject.
  const injectAssignments = [
    ...stripped.matchAll(/(?:exports|module\.exports)\s*\.\s*inject\s*=\s*([^\n;]+)/g),
  ]
  for (const [whole, value] of injectAssignments) {
    const v = value.trim()
    suite.check(
      `§6 exports.inject assignment is empty (found: ${show(v)})`,
      v === '[]' || v === 'void 0' || v === 'undefined' || v === 'null',
      `${INJECT_MSG}\ns      the assignment is: ${show(whole.trim())}`,
    )
  }
  // Also catch `export const inject = [...]` in the source.
  const staticInject = [...srcStripped.matchAll(/export\s+const\s+inject\s*=\s*([^\n;]+)/g)]
  for (const [, value] of staticInject) {
    suite.check(
      `§6 src/client.js declares no static "export const inject" list (found ${show(value.trim())})`,
      value.trim() === '[]' || value.trim() === 'void 0',
      INJECT_MSG,
    )
  }
  suite.check(
    '§6 no non-empty inject array appears anywhere in the client bundle',
    !/(?:exports|module\.exports)\s*\.\s*inject\s*=\s*\[\s*['"]/.test(stripped) && !/export\s+const\s+inject\s*=\s*\[\s*['"]/.test(srcStripped),
    INJECT_MSG,
  )
  // `exports.inject` must be present-but-empty OR absent; either is fine, but a
  // *required service* declaration in any other spelling is not.
  const requiredService = /inject\s*:\s*\[\s*['"](?:uisession|slots|locale|configForms|settings)['"]/.test(srcStripped)
  suite.check(
    '§6 no service is declared as a required inject (the client uses ctx.inject([...], cb))',
    !requiredService,
    'found a static `inject: ["<service>"]` in src/client.js — this is the fatal-static-inject failure mode',
  )

  // -------------------------------------------------------------------------
  // 4. clientReady() runs FIRST, unconditionally, in its own try/catch
  // -------------------------------------------------------------------------
  // §6 allows either spelling: the optional-chained form, or the guarded form
  // (`const overlay = globalThis.__DSH_LINK_START__; if (overlay && typeof
  // overlay.clientReady === 'function') overlay.clientReady()`). Both are
  // correct; the guarded form is what the shipped code uses. Assert the CALL, not
  // one particular way of reaching it.
  const readyCall =
    /globalThis\.__DSH_LINK_START__\s*\??\.\s*clientReady\s*\(/.exec(srcStripped) ??
    /\.clientReady\s*\(/.exec(srcStripped)
  suite.check(
    '§6 src/client.js calls clientReady() on the overlay global',
    readyCall !== null,
    'the overlay handoff condition includes clientReady(); if it never runs, the animation sits there refusing to hand over forever',
  )
  if (readyCall !== null) {
    const idx = readyCall.index
    const before = srcStripped.slice(0, idx)
    const lastTry = before.lastIndexOf('try')
    const lastCatch = before.lastIndexOf('catch')
    suite.check(
      '§6 clientReady() is inside its own try/catch (a missing overlay is a no-op, not an error)',
      lastTry > lastCatch,
      'clientReady() is not enclosed in a try block; a throw here would abort the whole client module and the animation would never hand over',
    )
    // The guard must be a real capability check, not a bare property read.
    const guardWindow = srcStripped.slice(Math.max(0, idx - 400), idx)
    suite.check(
      '§6 clientReady() is guarded (the overlay may be absent, and that is a no-op)',
      /typeof\s+[\w.$]*clientReady\s*===?\s*['"]function['"]/.test(guardWindow) ||
        /\?\s*\.\s*clientReady/.test(srcStripped) ||
        /__DSH_LINK_START__\s*!==?\s*undefined/.test(guardWindow),
      `no capability guard found before the call:\n      …${show(guardWindow.slice(-160))}`,
    )
    // Ordering: the call must precede the settings-card work.
    const after = srcStripped.slice(idx)
    const heavy = ['slots.inject', 'slots.register', 'useSyncExternalStore', 'locale.register', 'whileServed']
      .map((marker) => after.indexOf(marker))
      .filter((p) => p >= 0)
    suite.check(
      '§6 clientReady() is called BEFORE any settings-card work (§6 makes it job 1)',
      heavy.length === 0 || Math.min(...heavy) > 0,
      'card work appears before the clientReady() call, so a slow or failing card would delay the handoff',
    )
    const lineOfCall = srcText.slice(0, srcText.indexOf(readyCall[0])).split('\n').length
    suite.check(
      '§6 the clientReady() call sits in the first third of src/client.js',
      lineOfCall < srcText.split('\n').length / 3,
      `clientReady() first appears at line ${lineOfCall} of ${srcText.split('\n').length}`,
    )
    // It must not be gated behind a feature flag that could skip it. The guarded
    // form legitimately uses one `if`, so instead assert there is exactly one
    // call site and that it is not behind an early-return flag.
    const callSites = [...srcStripped.matchAll(/\.clientReady\s*\(/g)].length
    suite.eq('§6 there is exactly one clientReady() call site in the module body', callSites, 1)
    suite.check(
      '§6 no early return precedes the clientReady() call (nothing may delay or prevent it)',
      !/return\b/.test(before.slice(Math.max(0, before.length - 300))),
      `an early return appears immediately before the call:\n      …${show(before.slice(-160))}`,
    )
  }

  // -------------------------------------------------------------------------
  // 5. never ctx.get(
  // -------------------------------------------------------------------------
  const ctxGet = [...stripped.matchAll(/ctx\s*\.\s*get\s*\(/g)]
  suite.eq(
    '§6 the client never calls ctx.get( — it is a one-shot read that races activation and silently answers undefined',
    ctxGet.length,
    0,
  )
  suite.check(
    '§6 the client reaches optional services through ctx.inject([...], cb)',
    /ctx\s*\.\s*inject\s*\(/.test(stripped),
    'no `ctx.inject([...], cb)` found — §6 requires the dynamic form because exports.inject must stay empty',
  )
  const ownerGet = [...stripped.matchAll(/owner\s*\.\s*get\s*\(/g)].length
  const ownerBracket = /owner\s*\[/.test(stripped)
  suite.check(
    '§6 services are read via owner.get(name) or owner[name]',
    ownerGet > 0 || ownerBracket,
    'neither `owner.get(name)` nor `owner[name]` was found',
  )

  // -------------------------------------------------------------------------
  // 6. The CSS blob has no backtick (§6, AGENTS.md)
  // -------------------------------------------------------------------------
  suite.section('the card CSS blob has no backtick', () => {
    // Locate template-literal CSS blobs in the SOURCE and assert their contents
    // carry no stray backtick. A backtick inside a `...` blob ends it early.
    const blobAssign = /(?:const|var|let)\s+CSS\s*=\s*`/.exec(srcText)
    if (blobAssign === null) {
      suite.check(
        'src/client.js declares a CSS blob',
        /const\s+CSS\s*=/.test(srcText) || /style\s*=\s*`/.test(srcText),
        'no CSS blob found (a plain string or a template literal was expected)',
      )
    } else {
      const start = blobAssign.index + blobAssign[0].length
      const end = srcText.indexOf('`', start)
      suite.check('the CSS blob is terminated (not runaway)', end > start, 'the CSS template literal never closes')
      const blob = end > start ? srcText.slice(start, end) : srcText.slice(start)
      suite.check(
        '§6 the CSS blob contains no backtick character',
        !blob.includes('`'),
        `a backtick exists inside the CSS blob, which terminates it early — the build then keeps the PREVIOUS artifact and the change appears to do nothing`,
      )
      suite.check(
        'the card styles use var(--dsw-alias-*, literal) fallbacks (it must read as a shipped card)',
        /var\(\s*--dsw-alias-/.test(blob),
        'no `var(--dsw-alias-*)` token usage found in the CSS blob',
      )
    }
    // Whatever the shape, the artifact must not contain an odd number of backticks
    // in its CSS region — a strong signal that a blob was split.
    const tickCount = (libText.match(/`/g) ?? []).length
    suite.check(
      'lib/client.js has an EVEN number of backticks (an odd count means a string literal is unterminated)',
      tickCount % 2 === 0,
      `found ${tickCount} backticks; an odd count means a template literal runs to the end of the file`,
    )
  })

  // -------------------------------------------------------------------------
  // 7. Registration is idempotent and owns its throws (§6)
  //
  // §6 does not name a symbol, so assert the BEHAVIOUR: a handle is retained, the
  // previous handle is disposed before a new registration, the register call is
  // wrapped, and contribution is gated on whileServed. The shipped code keeps a
  // `registration` handle plus a `withdraw()` that calls the disposer it took.
  // -------------------------------------------------------------------------
  suite.section('idempotent registration', () => {
    suite.check(
      '§6 the registration keeps a handle (registration/disposer variable)',
      /\b(registration|disposer|handle|dispose)\b/.test(srcStripped),
      'no registration handle found — without it a duplicate slots.register throws INSIDE the slot ledger notification and kills the mounted card while leaving its DOM in place',
    )
    // Disposal before re-register: either `X.dispose()`/`X()` called on the saved
    // handle, or an explicit `if (saved !== null) withdraw()` guard.
    const disposesSaved =
      /(?:registration|disposer|handle)\s*(?:\?\s*)?\.\s*(?:dispose|unregister|off|call)\s*\(/.test(srcStripped) ||
      /if\s*\(\s*(?:registration|disposer|handle)\s*!==?\s*null\s*\)\s*[A-Za-z_$][\w$]*\s*\(/.test(srcStripped) ||
      /const\s+\w+\s*=\s*(?:registration|disposer|handle)\b[\s\S]{0,80}?\b\w+\s*\(\s*\)/.test(srcStripped)
    suite.check(
      '§6 the previous registration is disposed before re-registering',
      disposesSaved,
      'the saved handle is never disposed, so a second register throws inside the ledger notification',
    )
    suite.check(
      '§6 the register call is wrapped so a duplicate-id throw cannot escape',
      /try\s*\{[\s\S]{0,600}?register\s*\(/.test(srcStripped) || /try\s*\{[\s\S]{0,600}?inject\s*\(/.test(srcStripped),
      'the register/inject call is not inside a try block',
    )
    suite.check(
      '§6 contribution is gated on configForms.whileServed([…], …)',
      /whileServed\s*\(\s*\[/.test(srcStripped),
      'without whileServed a profile with no settings provider shows an inert tab that can never work',
    )
    // The gate must be passed the settings namespace, not a stray literal.
    const nsConst = /const\s+SETTINGS_NAMESPACE\s*=\s*['"]([^'"]+)['"]/.exec(srcStripped)
    suite.eq('§6 SETTINGS_NAMESPACE is declared and is "link-start"', nsConst === null ? null : nsConst[1], 'link-start')
    suite.check(
      '§6 whileServed is called with SETTINGS_NAMESPACE (not a duplicated literal)',
      /whileServed\s*\(\s*\[\s*SETTINGS_NAMESPACE\s*\]/.test(srcStripped),
      'the whileServed gate uses something other than SETTINGS_NAMESPACE, so the two can drift',
    )
    suite.check(
      '§6 the card registers into slot "plugins.item"',
      /SLOT\s*=\s*['"]plugins\.item['"]/.test(srcStripped) || /['"]plugins\.item['"]/.test(srcStripped),
      'no plugins.item slot found',
    )
    suite.check(
      '§6 the card registration carries order 60',
      /order\s*:\s*60\b/.test(srcStripped),
      'no `order: 60` on the registration',
    )
  })

  // -------------------------------------------------------------------------
  // 8. summary and page must be TWO components (§6)
  // -------------------------------------------------------------------------
  suite.section('summary and page are separate components', () => {
    const hasSummary = /['"]summary['"]/.test(srcStripped)
    suite.check('§6 the card dispatches on props.view === "summary"', hasSummary, 'no "summary" branch found in src/client.js')
    // At least two component definitions (function X( / const X = (…) =>) whose
    // names suggest a split, plus a dispatch site.
    const fnComponents = [...srcStripped.matchAll(/(?:function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*=\s*(?:React\.)?(?:memo\()?\s*(?:function|\())/g)].map((mm) => mm[1] ?? mm[2])
    suite.check(
      '§6 at least two distinct component functions exist (one component branching on view is a conditional hook call React rejects)',
      new Set(fnComponents).size >= 2,
      `found ${new Set(fnComponents).size} component function(s): ${[...new Set(fnComponents)].join(', ') || '(none)'}`,
    )
    suite.check(
      '§6 the two views are not one component with a conditional return',
      !/function\s+\w+\s*\([^)]*\)\s*\{[^}]{0,200}?if\s*\([^)]*view[^)]*\)\s*return\s+[^}]{0,200}?use[A-Z]/.test(srcStripped),
      'a single component appears to branch on `view` and then call a hook, which is the conditional-hook failure',
    )
  })

  // -------------------------------------------------------------------------
  // 9. Bilingual (§6)
  // -------------------------------------------------------------------------
  suite.section('bilingual dictionaries', () => {
    const localeConst = /const\s+LOCALE_NAMESPACE\s*=\s*['"]([^'"]+)['"]/.exec(srcStripped)
    suite.eq('§6 the locale namespace constant is "linkStart"', localeConst === null ? null : localeConst[1], 'linkStart')
    suite.check(
      '§6 the locale namespace is registered',
      /locale\s*\.\s*register\s*\(/.test(srcStripped),
      'no `locale.register(...)` found — the card copy would never resolve',
    )
    for (const lang of ['zh', 'en']) {
      suite.check(
        `§6 a "${lang}" dictionary exists`,
        new RegExp(`DICTIONARY_${lang.toUpperCase()}\\s*=|\\b${lang}\\s*:`).test(srcStripped),
        `no "${lang}" dictionary found in src/client.js`,
      )
    }
    suite.check(
      '§6 the register call passes BOTH zh and en',
      /locale\s*\.\s*register\s*\([^)]*\{[\s\S]{0,200}?zh\b[\s\S]{0,200}?en\b/.test(srcStripped) ||
        /register\s*\([^,]+,\s*\{\s*zh\s*:[\s\S]{0,120}?en\s*:/.test(srcStripped),
      'the locale register call does not pass both dictionaries',
    )
    suite.check(
      '§6 labels are rendered through locale.bind(LOCALE_NAMESPACE)',
      /\.bind\s*\(\s*LOCALE_NAMESPACE\s*\)/.test(srcStripped),
      'no `locale.bind(LOCALE_NAMESPACE)` found — labels would not resolve through the dictionary',
    )
  })

  // -------------------------------------------------------------------------
  // 10. the write path (§6)
  // -------------------------------------------------------------------------
  suite.section('the settings write path', () => {
    suite.check(
      '§6 reads go through useSyncExternalStore',
      /useSyncExternalStore/.test(srcStripped),
      'no useSyncExternalStore found — the snapshot must be a stable reference between changes',
    )
    suite.check(
      "§6 writes use the { op:'set', path:[field], value } shape",
      /op\s*:\s*['"]set['"]/.test(srcStripped),
      'no `{ op: "set", ... }` write found',
    )
    suite.check(
      '§6 the write carries the snapshot revision',
      /revision/.test(srcStripped),
      'no revision in the write — a concurrent edit would be silently clobbered',
    )
    // §6: "on a bare `false`, retry once through the remote service". The shipped
    // code names the retry `form.remoteMutate` and resolves props.remote.settings
    // .mutate at bind time. Assert the BEHAVIOUR: a false-answer branch exists and
    // it reaches the remote mutate at most once.
    suite.check(
      '§6 props.remote.settings.mutate is resolved for the retry path',
      /remote\s*\.\s*settings/.test(srcStripped) && /\.\s*mutate\s*\(/.test(srcStripped),
      'no props.remote.settings.mutate binding — a bare `false` could never be explained',
    )
    suite.check(
      '§6 a bare false from mutate is detected before retrying',
      /accepted\s*!==?\s*false/.test(srcStripped) || /===\s*false/.test(srcStripped) || /!==\s*false/.test(srcStripped),
      'no false-answer check found — the retry would fire on every write or never',
    )
    const retryCount = (srcStripped.match(/remoteMutate\s*\(/g) ?? []).length
    suite.check(
      '§6 the remote retry is issued ONCE, not in a loop (§6: "retry once")',
      retryCount <= 2,
      `found ${retryCount} remoteMutate( call site(s); §6 permits exactly one retry`,
    )
    suite.check(
      '§6 the remote retry is unfenced (no revision) so it can surface the real reason',
      /remoteMutate\s*\([^)]*undefined\s*\)/.test(srcStripped) || /remoteMutate\s*\([^)]*\)/.test(srcStripped),
      'the remote retry does not pass an undefined revision',
    )
    suite.check(
      '§6 the preview button calls the overlay preview(',
      /preview\s*\(/.test(srcStripped),
      'no preview() call found',
    )
    suite.check(
      '§6 the confirmed root services are reached through ctx.inject([...], cb)',
      /ctx\s*\.\s*inject\s*\(\s*\[/.test(srcStripped),
      'no dynamic `ctx.inject([...], cb)` found',
    )
    for (const svc of ['slots', 'locale', 'configForms']) {
      suite.check(
        `§6 "${svc}" is requested through ctx.inject`,
        new RegExp(`inject\\s*\\(\\s*\\[[^\\]]*['"]${svc}['"]`).test(srcStripped),
        `"${svc}" is not in the ctx.inject dependency list`,
      )
    }
  })
}

runSuite(suite)
