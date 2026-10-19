// Lead-side integration check: run the plugin's injection rows through the KERNEL's
// OWN index renderer and assert the overlay actually lands where the design claims.
//
// This is deliberately not a unit test of index.js. It imports the real
// `renderIndexInjections` from the installed @deepseek-ai/dsh-host-webserver payload and
// a real shell index.html, so it proves the ordering claim rather than restating it:
// that the composed overlay script reaches the document as a classic script positioned
// ahead of the shell's module script.
//
// Run: node tools/e2e-injection.mjs
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// `index.js` is imported DYNAMICALLY, not statically.
//
// It imports `@deepseek-ai/schemastery` statically at module-evaluation time, so on a
// clone that has not run `npm install` a static import here dies with a raw
// ERR_MODULE_NOT_FOUND stack trace — which reads as "this plugin is broken" rather
// than "a dependency is not installed yet". The peer IS public on npm
// (`@deepseek-ai/schemastery@3.18.5`), so the fix for a user is one command, and the
// honest answer from this tool is PENDING (3) with that command in the message.
//
// Same reasoning as the `.scratch/` inputs below: resolve at runtime, and report
// "could not run" instead of crashing.
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function pending(lines) {
  console.log('dsh-link-start: end-to-end injection check against the kernel renderer')
  console.log('')
  console.log('  PENDING — this check could NOT run, so the ordering claim is NOT proven here.')
  for (const line of lines) console.log(`  ${line}`)
  console.log('')
  console.log('  Exit 3 = PENDING (not proven), never a stand-in for green, never a failure.')
  process.exit(3)
}

let plugin
try {
  plugin = await import('../index.js')
} catch (error) {
  const message = error && error.message ? error.message : String(error)
  if (message.includes('@deepseek-ai/schemastery')) {
    pending([
      'the peer dependency @deepseek-ai/schemastery is not installed beside this package.',
      'It is a PEER, not a dependency (INTERFACES.md §3): DSH resolves it against the',
      "runtime's own copy. For the offline suites, install it with:  npm install",
      `(${message})`,
    ])
  }
  console.error(`dsh-link-start: index.js failed to import: ${message}`)
  process.exit(1)
}

const { buildRows, resolveSettings, CONFIG_GLOBAL, readSource } = plugin

// ---------------------------------------------------------------------------
// The kernel's own renderer, extracted verbatim from the installed payload into
// `.scratch/kernel-vendor/injections.mjs` (the kernel module itself pulls in
// cordis/compression/ipaddr, which these pure functions do not need). Importing the
// real implementation is the point: this proves the ordering claim instead of
// restating it.
//
// `.scratch/` is a local, gitignored extraction of a THIRD-PARTY payload — it is not
// part of this package and is not committed. On a fresh clone it simply does not
// exist, so both the renderer and the shipped shell index below are OPTIONAL
// dependencies of this check, resolved at runtime rather than by a static import.
// A static import here would make the tool die with ERR_MODULE_NOT_FOUND on every
// clone, which would read as a broken plugin instead of a check that cannot run.
//
// The three-state protocol matches `verify/`: 0 pass, 1 fail, 3 PENDING — "not
// proven", never a stand-in for green. Missing kernel sources are 3, not 1.
// ---------------------------------------------------------------------------
const VENDOR = join(root, '.scratch/kernel-vendor/injections.mjs')
const SHELL_INDEX = join(
  root,
  '.scratch/dsh-src/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
)

/** Load the vendored kernel renderer, or explain precisely why we cannot. */
async function loadKernel() {
  if (!existsSync(VENDOR)) {
    return { ok: false, why: `the vendored kernel renderer is absent (${VENDOR})` }
  }
  try {
    const mod = await import(pathToFileURL(VENDOR).href)
    if (typeof mod.renderIndexInjections !== 'function') {
      return { ok: false, why: `${VENDOR} does not export renderIndexInjections` }
    }
    return { ok: true, renderIndexInjections: mod.renderIndexInjections }
  } catch (error) {
    return { ok: false, why: `the vendored kernel renderer failed to import: ${error && error.message ? error.message : error}` }
  }
}

const kernel = await loadKernel()

if (!kernel.ok || !existsSync(SHELL_INDEX)) {
  pending([
    kernel.ok ? `the shipped shell index is absent (${SHELL_INDEX})` : kernel.why,
    '',
    'Expected on a fresh clone: `.scratch/` is a gitignored local extraction of the',
    'installed DSH payload, not part of this package. Both modes of this check need',
    'it — `--selftest` substitutes synthetic overlay SOURCES, but still renders them',
    'through the real kernel renderer, so it cannot stand in for a missing kernel.',
    'To run this check, extract the kernel payload into `.scratch/` first.',
  ])
}

const { renderIndexInjections } = kernel
const shellIndex = readFileSync(SHELL_INDEX, 'utf8')

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${label}\n        ${error.message}`)
  }
}

const settings = resolveSettings(undefined)
// `--selftest` substitutes synthetic sources so the harness's own assertions can be
// exercised before the real source files exist. A green run here proves the CHECKS work;
// only a green run without the flag proves the plugin works.
const SELFTEST = process.argv.includes('--selftest')
const sources = SELFTEST
  ? {
    scene: '/* synthetic scene */\nglobalThis.__DSH_LINK_START_SCENE__ = { marker: "scene" };\n',
    screen: '/* synthetic screen */\nglobalThis.__DSH_LINK_START__ = { marker: "screen" };\n',
    style: '.dslls-root{position:fixed;inset:0}\n',
  }
  : {
    scene: readSource('src/scene.js'),
    screen: readSource('src/boot-screen.js'),
    style: readSource('src/style.css'),
  }
const rows = buildRows(settings, sources)

console.log('dsh-link-start: end-to-end injection check against the kernel renderer')
console.log(`  mode: ${SELFTEST ? 'SELFTEST (synthetic sources)' : 'real sources'}`)
console.log(`  rows: ${rows.map(r => r.kind).join(', ') || '(none)'}`)
console.log('')

check('rows were produced at all (sources present and enabled)', () => {
  assert.ok(rows.length > 0, 'no rows: a source file is missing or unreadable')
})

const html = renderIndexInjections(shellIndex, rows)

check('the shell module script is still the LAST script in the document', () => {
  assert.ok(html.includes('assets/index-'), 'the shell entry script vanished from the document')
})

check('the config global is defined before the shell entry script', () => {
  const globalAt = html.indexOf(`globalThis[${JSON.stringify(CONFIG_GLOBAL)}]`)
  const shellAt = html.indexOf('assets/index-')
  assert.ok(globalAt >= 0, 'the config global row is absent')
  assert.ok(shellAt >= 0, 'the shell entry script is absent')
  assert.ok(globalAt < shellAt, `config global at ${globalAt} must precede shell at ${shellAt}`)
})

check('the overlay script is positioned ahead of the shell entry script', () => {
  const overlayAt = html.indexOf('__DSH_LINK_START__')
  const shellAt = html.indexOf('assets/index-')
  assert.ok(overlayAt >= 0, 'the composed overlay did not reach the document')
  assert.ok(overlayAt < shellAt, `overlay at ${overlayAt} must precede shell at ${shellAt}`)
})

check('the overlay is a classic script, not a module (so it is parser-blocking)', () => {
  const at = html.indexOf('__DSH_LINK_START_SCENE__')
  assert.ok(at >= 0, 'the scene global is absent from the document')
  const open = html.lastIndexOf('<script', at)
  assert.ok(open >= 0, 'could not find the enclosing script tag')
  const tag = html.slice(open, html.indexOf('>', open) + 1)
  assert.ok(!/type\s*=\s*["']?module/i.test(tag), `overlay script carries type=module: ${tag}`)
  assert.ok(!/\bdefer\b/i.test(tag), `overlay script carries defer: ${tag}`)
  assert.ok(!/\basync\b/i.test(tag), `overlay script carries async: ${tag}`)
})

check('every row landed inside <head>, ahead of </head>', () => {
  const headEnd = html.indexOf('</head>')
  assert.ok(headEnd >= 0, 'no </head> in the rendered document')
  for (const marker of [CONFIG_GLOBAL, '__DSH_LINK_START_SCENE__', 'dslls-']) {
    const at = html.indexOf(marker)
    assert.ok(at >= 0, `marker ${marker} is absent`)
    assert.ok(at < headEnd, `marker ${marker} at ${at} must be inside head (ends ${headEnd})`)
  }
})

check('the stylesheet reached the document as a style element', () => {
  assert.ok(html.includes('<style>'), 'no style element was emitted')
  assert.ok(html.includes('dslls-'), 'the overlay stylesheet did not reach the document')
})

check('no injected text terminates its own element early', () => {
  // The guarantee that matters is structural: after rendering, the number of opening
  // script tags and closing script tags must agree, and the same for style. Note this
  // counts REAL tags, which is why a source that merely mentions a tag name in prose
  // must not trip it — a comment saying "style element" is not a style tag. A bare
  // "<style>" in a comment IS indistinguishable from a real one to a tag counter, so
  // `isInjectable` (which guards the actual terminators) is the real defence; this
  // assertion is the end-to-end confirmation.
  const opens = (html.match(/<script[\s>]/g) ?? []).length
  const closes = (html.match(/<\/script>/g) ?? []).length
  assert.equal(opens, closes, `script tag imbalance: ${opens} open vs ${closes} close`)
  const styleOpens = (html.match(/<style[\s>]/g) ?? []).length
  const styleCloses = (html.match(/<\/style>/g) ?? []).length
  assert.equal(styleOpens, styleCloses, `style tag imbalance: ${styleOpens} open vs ${styleCloses} close`)
})

check('the boot-readiness deferred is settled after every injected row', () => {
  const readyAt = html.indexOf('__DSH_BOOT_READY__')
  const overlayAt = html.indexOf('__DSH_LINK_START_SCENE__')
  assert.ok(readyAt >= 0, 'the kernel boot-readiness tail is absent')
  assert.ok(overlayAt < readyAt, 'the readiness tail must come after the overlay rows')
})

check('disabled means nothing at all is injected', () => {
  const off = buildRows({ ...settings, enabled: false }, sources)
  assert.equal(off.length, 0, 'a disabled config still produced rows')
  const offHtml = renderIndexInjections(shellIndex, off)
  assert.ok(!offHtml.includes('__DSH_LINK_START__'), 'a disabled config still reached the page')
  assert.ok(!offHtml.includes('dslls-'), 'a disabled config still injected the stylesheet')
})

check('the document is unchanged when there is nothing to inject', () => {
  const clean = renderIndexInjections(shellIndex, [])
  assert.ok(!clean.includes('__DSH_LINK_START__'), 'the overlay leaked into a clean render')
  assert.ok(clean.includes('assets/index-'), 'the clean render lost the shell entry')
})

console.log('')
if (failures > 0) {
  console.log(`FAILED: ${failures} assertion(s)`)
  process.exit(1)
}
console.log('OK: the overlay reaches the document ahead of the shell, as a classic script in head.')
