// Rebuild lib/client.js from src/client.js.
//
// The browser bundle is the source wrapped in the shell's module-loader call.
// Keeping the build here — rather than a bundler — is deliberate: this half
// imports nothing (React arrives through the factory's `require`), so there is
// nothing to resolve and nothing to tree-shake. The wrapper is the whole build.
//
//   window.__ModuleLoader__.load({ id: "dsh-link-start", factory: (require) => {
//   var module = { exports: {} }; var exports = module.exports;
//   <src/client.js verbatim>
//   return module.exports; } });
//
// `lib/client.js` is a build artifact and IS committed. Never hand-edit it:
// edit `src/client.js` and run this. `verify/verify-client.mjs` re-runs the
// build into memory and fails if the committed artifact differs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

/** The bundle id must be the package name: `dsh.client` resolves it by that name. */
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const id = manifest.name
if (typeof id !== 'string' || id.length === 0) {
  throw new Error('build-client: package.json has no "name"; the bundle id is derived from it')
}

// The wrapper. The tail is also the marker that detects a source file which is
// already a bundle: wrapping a wrapped file would nest the loader call and
// produce a bundle that registers nothing (the inner call registers, the outer
// one throws on a duplicate id) — a failure that only shows up in the browser.
const TAIL = '\nreturn module.exports; } });\n'
const HEAD = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: (require) => {\n'
  + 'var module = { exports: {} }; var exports = module.exports;\n'

const sourcePath = join(root, 'src', 'client.js')
const outPath = join(root, 'lib', 'client.js')

const source = readFileSync(sourcePath, 'utf8')

if (source.includes(TAIL.trim())) {
  throw new Error(
    'build-client: src/client.js already carries the loader tail; it is source, not a bundle',
  )
}

// The bundle must contain the loader literal EXACTLY ONCE, and the wrapper adds
// one occurrence. So the source may not spell it at all — not in code, not in a
// comment, not in a string. This is asserted against the source here (where the
// message can say what to do) and again against the finished bundle below,
// which is the authority `verify/verify-client.mjs` also applies.
if (source.includes('__ModuleLoader__')) {
  throw new Error(
    'build-client: src/client.js mentions __ModuleLoader__; the source must not spell the '
    + 'loader literal, because the wrapper already supplies the one occurrence a bundle may have',
  )
}

// `exports.inject` must stay empty: a static inject the host cannot satisfy
// leaves the fiber PENDING, and web boot refuses to mount the entire GUI.
// Checked here so a bad build fails at the build step rather than in the field.
for (const line of source.split('\n')) {
  const text = line.trim()
  if (text.startsWith('//')) continue
  if (/^exports\.inject\s*=/.test(text) && !/^exports\.inject\s*=\s*(\[\]|undefined|null)\s*;?$/.test(text)) {
    throw new Error(
      'build-client: src/client.js assigns a non-empty exports.inject; '
      + 'that leaves the fiber PENDING and web boot refuses to mount the whole GUI',
    )
  }
}

const bundle = HEAD + source + TAIL
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, bundle)

const sourceBytes = Buffer.byteLength(source, 'utf8')
const bundleBytes = Buffer.byteLength(bundle, 'utf8')

// The authority: the artifact itself. One occurrence means one registration.
const loads = bundle.split('__ModuleLoader__.load').length - 1
if (loads !== 1) {
  throw new Error(
    'build-client: the bundle contains ' + String(loads) + ' __ModuleLoader__.load occurrence(s); '
    + 'exactly one is required',
  )
}

console.log(
  'build-client: ' + outPath + ' written (id ' + id + ', ' + String(bundleBytes)
  + ' bytes from ' + String(sourceBytes) + ' source bytes, +' + String(bundleBytes - sourceBytes) + ' wrapper)',
)
