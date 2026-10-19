/**
 * tools/preview.mjs — local preview of the injected overlay, without DSH.
 *
 * Serves a page that loads the same three sources, in the same order, with the same
 * config row and stylesheet row that `index.js` pushes into `webserver/index-inject`.
 * That makes this a fast iteration loop for the animation: edit `src/scene.js`,
 * `src/boot-screen.js` or `src/style.css`, reload the page, and see exactly what a
 * real DSH page would show — no DSH restart, no install, no browser cache to fight.
 *
 * Deliberately dependency-free (node:http + node:fs) so it runs anywhere the rest of
 * the tooling does.
 *
 * Usage:
 *   node tools/preview.mjs [--port 0] [--config '<json>'] [--fake-boot n]
 *
 *   --port      0 (default) picks a free port and prints the exact URL.
 *   --config    a JSON object merged over the documented defaults, so a setting can
 *               be tried without touching the plugin. e.g. --config '{"title":"LINK START"}'
 *   --fake-boot ms  how long to pretend the client roster takes to activate. The
 *               real handoff needs `clientReady()`; this simulates it so the wait
 *               and the dissolve can both be exercised. 0 disables (never reports).
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Parse `--flag value` pairs. */
function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback
}

const port = Number(arg('port', '0'))
const fakeBoot = Number(arg('fake-boot', '1500'))
let overrides = {}
const rawConfig = arg('config', '')
if (rawConfig !== '') {
  try {
    overrides = JSON.parse(rawConfig)
  } catch (error) {
    console.error(`preview: --config is not valid JSON: ${String(error)}`)
    process.exit(2)
  }
}

/** Read one pre-boot source, failing loudly rather than serving a broken page. */
async function source(relative) {
  try {
    return await readFile(join(root, relative), 'utf8')
  } catch (error) {
    throw new Error(`preview: cannot read ${relative}: ${String(error)}`)
  }
}

const [scene, screen, style, manifest] = await Promise.all([
  source('src/scene.js'),
  source('src/boot-screen.js'),
  source('src/style.css'),
  source('package.json').then((t) => JSON.parse(t)),
])

/**
 * The page.
 *
 * The composition and the row order mirror `index.js` `buildRows` exactly: the
 * config global first, then the stylesheet, then one script carrying the scene
 * followed by the screen. This file's whole value depends on that mirroring, so if
 * `buildRows` changes, this must change with it.
 *
 * The client-stand-in script is assembled separately rather than inlined, because a
 * template literal that contains a nested backtick terminates early — the same trap
 * the CSS blobs have. Nothing in the markup below carries a backtick.
 */
function page(config) {
  const configRow = 'globalThis.__DSH_LINK_START_CFG__='
    + JSON.stringify(config).replaceAll('<', '\\u003c')

  // Stand in for the client half. The real handoff waits for clientReady(), which in
  // DSH arrives from the client bundle once the roster has activated; without this
  // the overlay would correctly wait forever, which is right for DSH and useless in
  // a preview.
  const standIn = fakeBoot > 0
    ? 'setTimeout(function () {\n'
      + '  var s = globalThis.__DSH_LINK_START__;\n'
      + "  if (s && typeof s.clientReady === 'function') s.clientReady();\n"
      + "  console.log('[preview] clientReady() after " + fakeBoot + "ms');\n"
      + '}, ' + fakeBoot + ');'
    : "console.log('[preview] --fake-boot 0: clientReady() is never called, so the overlay waits. Press it to enter.');"

  const probe = 'console.log("[preview] overlay installed:", !!globalThis.__DSH_LINK_START__);\n'
    + 'console.log("[preview] scene installed:", !!globalThis.__DSH_LINK_START_SCENE__);\n'
    + 'console.log("[preview] diag:", globalThis.__DSH_LINK_START_DIAG__);'

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>dsh-link-start — preview</title>',
    '<script>' + configRow + '</script>',
    '<style>' + style + '</style>',
    '</head>',
    '<body>',
    '<script>' + scene + '\n;' + screen + '</script>',
    '<script>' + standIn + '\n' + probe + '</script>',
    '</body>',
    '</html>',
  ].join('\n')
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // The resolved settings, so this page and a real DSH page agree. `normalizeConfig`
    // is not reachable from here, so the defaults are restated and then overridden.
    const config = {
      durationMs: 6800,
      fadeMs: 1000,
      enterMode: 'auto',
      accent: '#5ad7ff',
      sound: true,
      glitch: true,
      scanlines: true,
      telemetry: true,
      wordmark: true,
      title: 'DEEPSEEK HARNESS',
      respectReducedMotion: true,
      seed: 0,
      holdMs: 20000,
      ...overrides,
    }
    const body = page(config)
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
    })
    res.end(body)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  console.log('')
  console.log(`  dsh-link-start preview — ${manifest.name} v${manifest.version}`)
  console.log(`  open:  http://127.0.0.1:${actual}/`)
  console.log('')
  console.log(`  sources: src/scene.js + src/boot-screen.js + src/style.css (re-read per request)`)
  console.log(`  clientReady() simulated after ${fakeBoot > 0 ? `${fakeBoot}ms` : 'never'}`)
  if (Object.keys(overrides).length > 0) {
    console.log(`  config overrides: ${JSON.stringify(overrides)}`)
  }
  console.log('')
  console.log('  Reload the page after editing any source — no restart, no rebuild.')
  console.log('  Append ?dshlinkdiag=1 for the live readout.')
  console.log('')
})
