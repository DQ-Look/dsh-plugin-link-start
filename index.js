// dsh-link-start — Host half.
//
// Three contributions, and the first one is the whole reason this plugin exists:
//
//   1. a `webserver/index-inject` subscriber that pushes the pre-boot overlay into
//      the document's <head> as parser-blocking rows, ahead of the shell's module
//      script and therefore ahead of the kernel's own boot page;
//   2. the Config schema a settings namespace is derived from, so the browser half
//      can offer a card;
//   3. two read-only inspection routes so a human or a test can fetch exactly what
//      the page was given.
//
// Why a head injection rather than a React component: the kernel constructs its own
// boot page synchronously in the shell module's constructor. Anything that mounts
// later than that — a slot, a plugin's `apply`, a DOM observer — mounts *over* an
// already-rendered boot page and an already-arriving app, which is a different
// product (an intro over the loaded app rather than a start sequence instead of it).
// `@deepseek-ai/dsh-host-webserver` splices `head` rows immediately after the opening
// <head> tag, and a classic (non-module, non-deferred) script there runs before any
// module executes. That ordering is the mechanism.
//
// The desktop app takes the same table over IPC, so this one half covers Web and
// desktop.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** Package name; also what the loader mounts this row as. */
export const name = 'dsh-link-start'

/**
 * This package's own manifest, read once at module evaluation.
 *
 * Synchronous and at the top deliberately: `version` is part of the identity the
 * inspection route publishes, and a lazy read would either be async (making the
 * route's shape depend on I/O) or re-read per request for a value that cannot
 * change while the process runs.
 */
const MANIFEST = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))
  } catch (error) {
    // A missing or malformed manifest must not take the injection down with it.
    process.emitWarning(`dsh-link-start: cannot read package.json: ${String(error)}`)
    return { name: 'dsh-link-start', version: '0.0.0' }
  }
})()

/** This package's version, as published by the inspection route. */
export const version = typeof MANIFEST.version === 'string' ? MANIFEST.version : '0.0.0'

/**
 * The DSH runtime this build targets.
 *
 * A constant rather than a read of the running version, because `engines.dsh` is
 * deliberately not declared (see the note in `apply`) and this value exists to make a
 * support report self-describing, not to gate anything.
 */
export const DSH_TARGET = '0.2.1-rc.2'

/** Services this half consumes. */
export const inject = ['webServer']

/** Route prefix. An exact route per URL, plus prefixes that cannot shadow client.js. */
const ROUTE = '/plugins/dsh-link-start'

/**
 * The globals the overlay reads.
 *
 * The config global is emitted as a `global` row (the webserver renders it as
 * `<script>globalThis[NAME] = <json></script>`, with `<` escaped so plugin-controlled
 * strings cannot break out of the script element). The scene and screen are emitted as
 * `script` rows, whose text goes into the document VERBATIM — which is why
 * `assertInjectable()` guards the literal `</script` sequence before anything is
 * pushed.
 */
export const CONFIG_GLOBAL = '__DSH_LINK_START_CFG__'
export const SCENE_GLOBAL = '__DSH_LINK_START_SCENE__'
export const SCREEN_GLOBAL = '__DSH_LINK_START__'

/**
 * The values the overlay runs with when the applied config does not carry one.
 *
 * With a Config schema present these are unreachable in practice: the loader validates
 * the raw profile row against the schema before `apply` runs, so every field arrives
 * already defaulted and an absent settings document and an empty one resolve
 * identically. They are kept anyway because the fallback must not depend on the schema
 * having been resolvable — a profile that cannot load the schema package still boots,
 * and this plugin then still animates under the documented defaults.
 */
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
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
})

/** The accepted `enterMode` values. */
const ENTER_MODES = ['auto', 'click']

/** `#rrggbb` only; anything else falls back to the default accent. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * The longest title the wordmark will carry (§7.1).
 *
 * Enforced here as well as in the schema and in `src/scene.js`: the value reaches both
 * the settings page and the injected global, and a 200-character title would overflow
 * the design space before anything downstream had a chance to object.
 */
const TITLE_MAX = 40

/**
 * Whether the resolved schemastery can mark a Config field live-editable.
 *
 * `.volatile()` is what makes `@deepseek-ai/dsh-settings` project a field into the form
 * the settings page renders: `volatileForm()` keeps only fields carrying
 * `meta.volatile`, and `describe()` drops every entry whose projected form is empty. A
 * Config with no volatile field therefore yields no namespace, no card, and no error
 * anywhere — the loudest possible silent failure, which is why `apply` warns.
 *
 * The kernel's copy (3.18.5, inside the app payload) has the method. A copy linked
 * beside an older workspace checkout may not, and calling it there would throw while
 * this module is being evaluated — taking the injection down with the settings card. So
 * the method is probed once, and the schema degrades to non-volatile when it is absent.
 */
const LIVE_CAPABLE = typeof z.boolean().volatile === 'function'

/** Mark one Config field live-editable, where the schema library allows it. */
function live(schema) {
  return LIVE_CAPABLE ? schema.volatile() : schema
}

/**
 * This entry's Host configuration schema.
 *
 * The namespace is not named here because it is no longer named anywhere on this side:
 * it is the entry id the profile patch mounts this row under, `- insert: id: link-start`.
 * `src/client.js` spells that same string in SETTINGS_NAMESPACE and `cordis.patch.yml`
 * spells it in the insert row; nothing in DSH checks that all three agree, so
 * `verify/verify-namespace.mjs` does.
 *
 * Every field is volatile, because that is the only class the settings service serves.
 * The price is that the applied config carries live references rather than plain values
 * — see `readField`.
 */
export const Config = z.object({
  enabled: live(z.boolean().default(DEFAULT_SETTINGS.enabled)),
  durationMs: live(z.number().min(3000).max(20000).default(DEFAULT_SETTINGS.durationMs)),
  fadeMs: live(z.number().min(200).max(4000).default(DEFAULT_SETTINGS.fadeMs)),
  enterMode: live(z.union([...ENTER_MODES]).default(DEFAULT_SETTINGS.enterMode)),
  accent: live(z.string().default(DEFAULT_SETTINGS.accent)),
  sound: live(z.boolean().default(DEFAULT_SETTINGS.sound)),
  glitch: live(z.boolean().default(DEFAULT_SETTINGS.glitch)),
  scanlines: live(z.boolean().default(DEFAULT_SETTINGS.scanlines)),
  telemetry: live(z.boolean().default(DEFAULT_SETTINGS.telemetry)),
  wordmark: live(z.boolean().default(DEFAULT_SETTINGS.wordmark)),
  title: live(z.string().default(DEFAULT_SETTINGS.title)),
  respectReducedMotion: live(z.boolean().default(DEFAULT_SETTINGS.respectReducedMotion)),
  seed: live(z.number().min(0).max(2147483647).default(DEFAULT_SETTINGS.seed)),
  holdMs: live(z.number().min(3000).max(60000).default(DEFAULT_SETTINGS.holdMs)),
})

/**
 * The well-known key cosmokit puts on a live config reference.
 *
 * `.volatile()` does not yield the value: it yields a stable reference whose `get()`
 * answers the current immutable snapshot, identified across ESM/CJS copies of the
 * library by this global-registry symbol rather than by identity. A plugin therefore
 * reads a volatile field through `get()`, exactly as the shipped Host plugins do.
 *
 * The reference is also what lets a stored edit take effect without a restart: when only
 * volatile values differ, `@deepseek-ai/cordis-plugin-loader` commits the new snapshot
 * into the SAME reference (`updateVolatile`) and emits `loader/volatile-update` instead
 * of restarting the fiber. `apply` is not run again, so a value read per index render is
 * always the stored one.
 */
const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')

/** Whether a config value is a live reference rather than a plain snapshot. */
function isLive(value) {
  return typeof value === 'object' && value !== null && VOLATILE_REF in value
}

/**
 * Read one applied-config field.
 *
 * The field is a live reference when `Config` declared it volatile — the normal case —
 * and a plain value when the config arrived without schema resolution. Reading a live
 * reference directly yields an object, every type guard below then falls through to its
 * default, and the settings page appears to do nothing while storing values correctly.
 * @param config - the applied config, possibly undefined.
 * @param key - field name.
 * @returns the current value, or undefined when the field is absent.
 */
function readField(config, key) {
  const value = config?.[key]
  return isLive(value) && typeof value.get === 'function' ? value.get() : value
}

/** Clamp a number, falling back to the default when it is not a usable finite number. */
function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/** Shed anything that could break out of the injected script element or the frame. */
function cleanTitle(value) {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.title
  // Control characters would corrupt the wordmark; the wordmark itself is the only
  // text on screen the user controls.
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (stripped === '') return DEFAULT_SETTINGS.title
  return stripped.slice(0, TITLE_MAX)
}

/**
 * The settings the overlay should run with right now.
 *
 * Read per index render rather than cached, because the overlay is rebuilt from this on
 * the next page load — which is exactly when a new value can take effect, and the loader
 * has by then already committed a stored edit into the references this reads.
 *
 * Every field falls back individually. With `Config` resolved the fallback is
 * unreachable, but it must stay so that a profile which could not load the schema, and
 * therefore receives an unresolved config, still boots a working animation under the
 * documented defaults.
 * @param config - the applied config, possibly undefined.
 * @returns the resolved settings, with every field defaulted and clamped.
 */
export function resolveSettings(config) {
  const d = DEFAULT_SETTINGS
  const enabled = readField(config, 'enabled')
  const enterMode = readField(config, 'enterMode')
  const accent = readField(config, 'accent')
  const sound = readField(config, 'sound')
  const glitch = readField(config, 'glitch')
  const scanlines = readField(config, 'scanlines')
  const telemetry = readField(config, 'telemetry')
  const wordmark = readField(config, 'wordmark')
  const respectReducedMotion = readField(config, 'respectReducedMotion')
  return {
    enabled: typeof enabled === 'boolean' ? enabled : d.enabled,
    durationMs: Math.round(clampNumber(readField(config, 'durationMs'), 3000, 20000, d.durationMs)),
    fadeMs: Math.round(clampNumber(readField(config, 'fadeMs'), 200, 4000, d.fadeMs)),
    enterMode: ENTER_MODES.includes(enterMode) ? enterMode : d.enterMode,
    accent: typeof accent === 'string' && HEX_COLOR.test(accent) ? accent : d.accent,
    sound: typeof sound === 'boolean' ? sound : d.sound,
    glitch: typeof glitch === 'boolean' ? glitch : d.glitch,
    scanlines: typeof scanlines === 'boolean' ? scanlines : d.scanlines,
    telemetry: typeof telemetry === 'boolean' ? telemetry : d.telemetry,
    wordmark: typeof wordmark === 'boolean' ? wordmark : d.wordmark,
    // Read through `readField` like every other field: a volatile `title` is a reference
    // object, and cleaning the reference instead of its value would replace the user's
    // title with the default on every render.
    title: cleanTitle(readField(config, 'title')),
    respectReducedMotion: typeof respectReducedMotion === 'boolean' ? respectReducedMotion : d.respectReducedMotion,
    seed: Math.round(clampNumber(readField(config, 'seed'), 0, 2147483647, d.seed)),
    holdMs: Math.round(clampNumber(readField(config, 'holdMs'), 3000, 60000, d.holdMs)),
  }
}

/**
 * Whether a source file may be injected as script or style text.
 *
 * `writeHead`-level escaping does not apply to a `script` or `style` row: `row.text` is
 * interpolated into the document verbatim, so a literal `</script` (in a script row) or
 * `</style` (in a style row) — in a string, in a comment, in a CSS content value — would
 * terminate the element early and leave the rest of the source as markup. This is a
 * refusal rather than an escape because escaping would change the source's meaning; the
 * fix belongs in the source file.
 *
 * The terminator is kind-specific on purpose: checking only `</script` would let a
 * `</style` through in the stylesheet, which is the same defect one element over.
 * @param label - file label for the diagnostic.
 * @param text - the source text.
 * @param kind - `'script'` (default) or `'style'`.
 * @returns true when the text is safe to inject.
 */
export function isInjectable(label, text, kind = 'script') {
  const terminator = kind === 'style' ? '</style' : '</script'
  if (text.toLowerCase().includes(terminator)) {
    // The offending text itself is not echoed: it is the payload, and a diagnostic that
    // repeats it into a log is its own small problem.
    process.emitWarning(
      `dsh-link-start: refusing to inject ${label}: it contains the sequence "${terminator}", `
      + `which would terminate the injected ${kind} element early. Remove it from the source.`,
    )
    return false
  }
  return true
}

/** Absolute path of one pre-boot asset, resolved from this module rather than cwd. */
function assetPath(relative) {
  return fileURLToPath(new URL(relative, import.meta.url))
}

/**
 * Read one pre-boot source file.
 *
 * Read per index render rather than once at module load, so editing the scene, the
 * screen or the stylesheet takes effect on a plain page reload. Reading at load time
 * would pin the page to whatever the file held when the process started, forcing a DSH
 * restart to change an animation — the one operation this whole design avoids asking
 * for.
 *
 * A missing or unreadable file must not blank the boot page: the caller then injects
 * nothing for that piece and the kernel's own page shows, which is the documented
 * fallback.
 * @param relative - package-relative path.
 * @returns the text, or undefined when it cannot be read.
 */
export function readSource(relative) {
  try {
    return readFileSync(assetPath(relative), 'utf8')
  } catch (error) {
    process.emitWarning(`dsh-link-start: cannot read ${relative}: ${String(error)}`)
    return undefined
  }
}

/**
 * Compose the overlay source that will be injected.
 *
 * `src/scene.js` then `src/boot-screen.js`, in that order, in ONE script row: the screen
 * reads the scene global the moment it runs, so a separate row would work too but would
 * cost an extra element for nothing. Both are classic scripts written as IIFEs, so
 * concatenating them introduces no binding collision.
 * @param pair - `{ scene, screen }`, either possibly undefined.
 * @returns the composed source, or undefined when either piece is missing or unsafe.
 */
export function composeOverlay(pair) {
  const { scene, screen } = pair
  if (typeof scene !== 'string' || typeof screen !== 'string') return undefined
  if (!isInjectable('src/scene.js', scene)) return undefined
  if (!isInjectable('src/boot-screen.js', screen)) return undefined
  return `${scene}\n;${screen}\n`
}

/**
 * Build the injection rows for one index render.
 *
 * Exported so the verification suite can assert the exact row set without a live
 * webserver. `enabled: false` means switched off means switched off: no configuration
 * row, no stylesheet, no screen, and not one request. Injecting a disabled overlay and
 * making it bail out at runtime would look identical and leave the whole thing running,
 * which is the version of "off" this avoids.
 * @param settings - the resolved settings.
 * @param sources - the loaded source texts.
 * @returns the rows to push, in order.
 */
export function buildRows(settings, sources) {
  if (!settings.enabled) return []
  const overlay = composeOverlay(sources)
  const style = typeof sources.style === 'string' && isInjectable('src/style.css', sources.style, 'style')
    ? sources.style
    : undefined
  if (overlay === undefined) return []
  const rows = [
    { kind: 'global', name: CONFIG_GLOBAL, value: broadcastConfig(settings) },
  ]
  if (style !== undefined) rows.push({ kind: 'style', text: style })
  rows.push({ kind: 'script', placement: 'head', text: overlay })
  return rows
}

/**
 * The subset of the settings the overlay needs.
 *
 * Deliberately not the full settings object: the injected global is page-visible, and
 * carrying fields the overlay never reads only widens what can drift. `enabled` is
 * omitted because a disabled config produces no rows at all.
 * @param settings - the resolved settings.
 * @returns the broadcast config.
 */
export function broadcastConfig(settings) {
  return {
    durationMs: settings.durationMs,
    fadeMs: settings.fadeMs,
    enterMode: settings.enterMode,
    accent: settings.accent,
    sound: settings.sound,
    glitch: settings.glitch,
    scanlines: settings.scanlines,
    telemetry: settings.telemetry,
    wordmark: settings.wordmark,
    title: settings.title,
    respectReducedMotion: settings.respectReducedMotion,
    seed: settings.seed,
    holdMs: settings.holdMs,
  }
}

/** Answer one JSON response, never cached. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Answer one JavaScript response, never cached. */
function sendJavaScript(res, status, text) {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/javascript; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Mount the injection subscriber and the inspection routes.
 * @param ctx - Host plugin context.
 * @param config - the applied config, already validated against `Config`. Each field
 *   arrives as a live reference carrying its defaulted value, so a profile with no
 *   settings document reads the same values as one holding an empty document.
 */
export function apply(ctx, config) {
  if (!LIVE_CAPABLE) {
    ctx.logger?.warn?.(
      'dsh-link-start: the resolved @deepseek-ai/schemastery has no .volatile(), so DSH will '
      + 'not serve this entry as a settings namespace and the settings card stays hidden. The '
      + 'animation itself is unaffected. To fix the card, make @deepseek-ai/schemastery resolve '
      + 'from this package to a copy with .volatile() (>= 3.18.4), normally the one the kernel '
      + 'loads.',
    )
  }

  // `engines.dsh` is deliberately NOT declared in package.json. Declaring it makes
  // app-boot enforce the range against the running version, and a mismatch there skips
  // the whole bundle SILENTLY on some profiles: installed, restarted, nothing happens,
  // and no error anywhere. A runtime refusal the user cannot see is worse than no check,
  // so the contract is documented and verified instead.

  // Two inspection routes, both EXACT.
  //
  // Never a prefix on ROUTE: the webserver resolves prefixes longest-first, so a prefix
  // on ROUTE also claims `ROUTE/client.js` — the URL dsh-client-modules serves this
  // package's own browser bundle at. That request would answer this plugin's 404, the
  // bundle would never materialize, and the settings card would never register, with
  // nothing in any log to say why. An exact route per URL leaves every other path under
  // ROUTE to its owner.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/state.json`,
    handler: (req, res) => {
      try {
        const settings = resolveSettings(config)
        sendJson(res, 200, {
          name,
          version,
          dsh: DSH_TARGET,
          phase: 'host',
          enabled: settings.enabled,
          config: settings,
          contract: {
            configGlobal: CONFIG_GLOBAL,
            sceneGlobal: SCENE_GLOBAL,
            screenGlobal: SCREEN_GLOBAL,
            routePrefix: ROUTE,
            rowKinds: ['global', 'style', 'script'],
          },
        })
      } catch (error) {
        ctx.logger?.error?.('dsh-link-start: state route failed', error)
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
        else res.end()
      }
    },
  }), 'dsh-link-start: state route')

  // Exactly what the page was given, byte for byte. This exists so a test — and a human
  // debugging a page that does not animate — can fetch the composed overlay instead of
  // reconstructing it from three files by hand.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/boot.js`,
    handler: (req, res) => {
      try {
        const settings = resolveSettings(config)
        const overlay = composeOverlay({
          scene: readSource('src/scene.js'),
          screen: readSource('src/boot-screen.js'),
        })
        if (overlay === undefined) {
          sendJavaScript(res, 404, '/* dsh-link-start: overlay sources are not injectable */\n')
          return
        }
        if (!settings.enabled) {
          sendJavaScript(res, 200, '/* dsh-link-start: disabled by configuration */\n')
          return
        }
        sendJavaScript(res, 200, overlay)
      } catch (error) {
        ctx.logger?.error?.('dsh-link-start: boot route failed', error)
        if (!res.headersSent) sendJavaScript(res, 500, '/* internal */\n')
        else res.end()
      }
    },
  }), 'dsh-link-start: boot route')

  // `ctx.on` already returns a disposer the fiber tracks, so it is registered directly
  // rather than wrapped in an effect — matching the other subscribers of this event
  // (client-modules, client-connection, ui-theme).
  ctx.on('webserver/index-inject', (table) => {
    const settings = resolveSettings(config)
    const rows = buildRows(settings, {
      scene: readSource('src/scene.js'),
      screen: readSource('src/boot-screen.js'),
      style: readSource('src/style.css'),
    })
    if (rows.length === 0) return
    for (const row of rows) table.push(row)
  })
}
