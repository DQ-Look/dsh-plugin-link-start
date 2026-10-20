# INTERFACES.md — frozen contract for `dsh-link-start`

**Owner:** Lead. **Status:** FROZEN. Nothing in this file may be changed by a teammate;
if something here is wrong or insufficient, message the Lead and stop touching the
affected file until the Lead updates this document.

This is the single source of truth for every boundary between the parallel workstreams.
The whole design rests on one mechanism that has already been verified against the
installed DSH 0.2.1-rc.2 payload — see [The mechanism](#the-mechanism).

---

## 1. What the plugin is

`dsh-link-start` replaces DSH's kernel boot page with a full-window, procedurally
drawn **《刀剑神域》"LINK START"** boot sequence, then dissolves into the app.

**Zero network requests on the boot path.** The animation is drawn from a pure
function of time; there is no video, no image, no font, no fetch. This is the
deliberate differentiator from the video-clip clones in the wild (they must download
a media file and wait for `moov`/first frame, which is why they show a black screen).
First paint is therefore immediate and codec-independent.

| Half | File | Job |
|---|---|---|
| Host (Node) | `index.js` | `Config` schema, `webserver/index-inject` rows, 2 inspection routes |
| Pre-boot browser | `src/scene.js` | Pure timeline → display list. No DOM. |
| Pre-boot browser | `src/style.css` | Overlay chrome CSS (injected as a `style` row) |
| Pre-boot browser | `src/boot-screen.js` | Canvas renderer, DOM overlay, handoff, WebAudio |
| Client (browser) | `src/client.js` → `lib/client.js` | `clientReady()` + settings card |

---

## 2. The mechanism

Two facts, both verified by reading the installed payload. Do not redesign around them.

### 2.1 `webserver/index-inject` is the only moment early enough

`@deepseek-ai/dsh-host-webserver` collects an injection table on every index render
(`collectIndexInjections()` emits `webserver/index-inject`; each subscriber pushes
rows). `renderIndexInjections` splices **`head` rows immediately after the opening
`<head>` tag** — i.e. ahead of the shell's own `<script type="module">`. `src/boot-screen.js`
is pushed as a `script` row with `placement: 'head'`, so it is a parser-blocking classic
script that runs before any module executes, and therefore before the kernel constructs
its own `[data-dsh-boot]` page synchronously.

The desktop app takes the **same** table over IPC
(`dsh-desktop-host`: `process.send({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() })`),
so one host half covers Web and desktop.

**Row kinds** (`renderRow` in `dsh-host-webserver/lib/index.js`):

| kind | markup | placement |
|---|---|---|
| `global` | `<script>globalThis[NAME]=<json></script>` | head (forced) |
| `script` | `<script>TEXT</script>` | `row.placement` |
| `script-src` | `<script src="…"></script>` | `row.placement` |
| `script-preload` | `<link rel=preload as=script …>` | head (forced) |
| `style` | `<style>TEXT</style>` | head (forced) |
| `html` | raw markup | `row.placement` |

A **`script` row is NOT escaped** — `TEXT` goes into the document verbatim. Every
injected source must therefore be free of the literal sequence `</script`
(`index.js` asserts this and refuses to inject, logging a warning, rather than
breaking the page).

### 2.2 A settings namespace is the profile entry id, and only `.volatile()` fields are served

`@deepseek-ai/dsh-settings` derives the editable form from `entry.fiber.runtime.Config`;
`volatileForm()` keeps **only** fields whose schema node carries `meta.volatile`, and
`describe()` **drops every entry whose projected form is empty**. The namespace is the
`- insert: id:` in the profile patch — here **`link-start`**.

Consequences that are load-bearing:

* Every config field must be marked `.volatile()` or the namespace is never served and
  the settings card is silently absent.
* A volatile value arrives in `apply(ctx, config)` as a **stable reference** `{ get() }`,
  not as a value. Read it through `readField()`. When only volatile values change, the
  loader commits into the same reference (`updateVolatile`) and emits
  `loader/volatile-update` instead of restarting the fiber — which is why a settings edit
  needs no DSH restart, only a page reload.
* The two strings `- insert: id:` in `cordis.patch.yml` and `SETTINGS_NAMESPACE` in
  `src/client.js` must be identical. Nothing in DSH checks this. It is asserted by
  `verify/verify-namespace.mjs`.

---

## 3. Package identity — do not deviate

```
package name        dsh-link-start
row id              link-start
settings namespace  link-start
route prefix        /plugins/dsh-link-start
design space        1600 x 900 (W x H), origin top-left, +y down
```

`package.json` (Lead owns) exactly:

```json
{
  "name": "dsh-link-start",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": { "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": { "platform": "web" },
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "peerDependencies": { "@deepseek-ai/schemastery": "*" }
}
```

**`dsh.client.inject` is deliberately absent.** It declares client-module-graph
ordering, and composition *rejects* a row whose declared supplier is missing. The
client half therefore reaches every optional service with the dynamic
`ctx.inject([...], cb)` form instead of declaring `exports.inject`. `exports.inject`
must stay empty in `lib/client.js` — a required service would park the fiber `PENDING`
in a profile that lacks it, `apply` would never run, `clientReady()` would never fire,
and the animation would refuse to hand over. This was a real, measured failure mode.

`@deepseek-ai/schemastery` is a **peer**, never a dependency: `index.js` imports it
statically at module evaluation (so `Config` is a property of the module namespace
object, which is what the settings service reads), and app-boot's linked-directory rule
resolves the peer name against the runtime table — the kernel's own 3.18.5 copy.
`engines.dsh` is deliberately **omitted**: declaring it makes app-boot enforce a SemVer
range, and prerelease range matching is a trap that would refuse the very version this
was built against. A runtime version check in `index.js` warns instead.

---

## 4. `src/scene.js` — the animation model (owned by `scene-dev`)

**A classic script, not an ES module.** No `import`/`export`, no `require`, no bare
top-level statements that could collide. It is injected as script *text* and it is also
loaded in Node by `vm.runInNewContext`, so it must be completely self-contained.

```js
;(function () {
  'use strict'
  // ... implementation ...
  globalThis.__DSH_LINK_START_SCENE__ = { DESIGN, PHASES, DEFAULT_CFG, normalizeConfig, totalDuration, phaseAt, createScene }
})()
```

### 4.1 Exports

| name | signature | meaning |
|---|---|---|
| `DESIGN` | `{ W, H }` | `{ W: 1600, H: 900 }`. Every coordinate is in this space. |
| `PHASES` | `Array<{ id, label, from, to }>` | Normalized timeline, `from`/`to` in `0..1`, ascending, contiguous, first `from === 0`, last `to === 1`. `label` is ASCII uppercase. |
| `DEFAULT_CFG` | object | The documented defaults, frozen. |
| `normalizeConfig(raw)` | `raw → cfg` | **Pure.** Fills defaults, clamps ranges, coerces types, never throws, never mutates `raw`. Unknown keys dropped. |
| `totalDuration(cfg)` | `cfg → ms` | `cfg.durationMs`, normalized. |
| `phaseAt(cfg, t)` | `→ { id, label, index, local, start, end }` | `local` in `0..1` within the phase; `t` is clamped. |
| `createScene(cfg)` | `→ { cfg, duration, phases, frame(t) }` | Factory. |

### 4.2 `frame(t)` — determinism is mandatory

`frame(t)` returns the display list for time `t` (ms). **`frame(t)` must be a pure
function of `t` for a given scene handle:** calling `frame(1234)` twice must produce a
structurally equal frame. No `Math.random()` and no `Date.now()` inside `frame`.
Randomness is drawn once at `createScene(cfg)` time from a seeded PRNG:

* `cfg.seed !== 0` → that exact integer seed (`mulberry32` or equivalent).
* `cfg.seed === 0` → seed drawn once from `Math.random()` **inside `createScene`**.
* All per-artifact jitter (star positions, glitch offsets, spark phases) must be
  precomputed in `createScene` and indexed by `t`.

This is what makes the storyboard renders and every assertion in `verify/` meaningful.
A test calls `frame(t)` twice and compares `JSON.stringify`.

### 4.3 `Frame`

```js
{
  t: 0,                 // ms, = the t passed in
  duration: 6800,       // totalDuration(cfg)
  progress: 0,          // t / duration, clamped 0..1
  done: false,          // t >= duration
  phase: 'void',        // PHASES[index].id
  phaseLabel: 'VOID',   // ASCII uppercase
  index: 0,
  phaseProgress: 0,     // 0..1 within the phase
  background: '#000000',// base fill behind every layer, '#rrggbb'
  flash: 0,             // 0..1 additive white bloom, applied over the layers
  vignette: 0,          // 0..1 radial edge darkening, over the layers
  scanlines: 0,         // 0..1 scanline strength, over the layers
  shake: 0,             // design-space px of uniform jitter for the whole frame
  layers: [],           // Primitive[], draw order back → front
  wordmark: null,       // null, or { text, x, y, size, alpha, glitch, align?, spacing? } — drawn after layers
  telemetry: [],        // Array<{ x, y, text, alpha, size? }> ASCII only, drawn after wordmark
  hint: null            // reserved; the overlay draws the hint as DOM, not here
}
```

`wordmark.text` and every `telemetry[].text` and every `text` primitive must be
**uppercase ASCII** `[A-Z0-9 :._\-/%()\[\]]`, because the Node rasterizer carries a
5x7 ASCII font and renders these into the storyboard PNGs. The user-supplied title is
exempt (it may be any string; the browser draws it correctly and the rasterizer
approximates it as blocks).

`wordmark` accepts the same `align` and `spacing` fields as the `text` primitive, and the
rasterizer forwards them. A scene that wants the wordmark centred on the design space's
midline must say `align: 'center'`; without it the wordmark is drawn left-aligned from
`x`, which for `x = W/2` puts the whole string off the right edge. Both the rasterizer and
`src/boot-screen.js` must honour it.

### 4.4 Primitives — the closed set

Coordinates and sizes are in design-space units. `color` is **`#rrggbb` only** (no
named colors, no `rgb()`, no `#rgb`) so the rasterizer needs no CSS color parser.
`alpha` defaults to `1`. `width` defaults to `1` for strokes.

| `k` | fields | draws |
|---|---|---|
| `fill` | `color, alpha` | full design-space fill |
| `rect` | `x,y,w,h,color,alpha,radius?` | filled rect; `radius` rounds corners |
| `bar` | `x,y,w,h,color,alpha,radius?` | identical to `rect`; kept as a semantic alias for HUD bars |
| `line` | `x1,y1,x2,y2,color,alpha,width` | stroked segment |
| `poly` | `points:[[x,y],…],color,alpha,width?,fill?,close?` | `fill:true` → filled polygon; else stroked open/closed path |
| `circle` | `cx,cy,r,color,alpha,width?,fill?,dash?:[on,off],rot?` | `fill:true` → filled disc; else stroked circle. `dash` lengths in design units, `rot` in radians |
| `arc` | `cx,cy,r,from,to,color,alpha,width` | stroked arc. Radians. `0` = `+x` axis; **increasing angle goes clockwise on screen** (because +y is down) |
| `text` | `x,y,text,size,color,alpha,align?,spacing?,weight?,mono?` | `align` `'left'`(default)`\|'center'\|'right'`; `spacing` = letter-spacing in design units; `weight` `'normal'`(default)`\|'bold'`; `mono` boolean |

Anything a scene cannot express with these primitives is a request to the Lead to widen
the set — do not smuggle a new `k` in without updating this table, because three other
workstreams read it.

**Budget: ≤ 600 primitives per frame.** The renderer runs at 60fps inside the same
process as DSH's own boot work; keep the frame allocation-light (build arrays, do not
allocate in inner loops beyond the returned list).

### 4.5 The timeline — creative brief

`PHASES`, normalized so `durationMs` scales the whole sequence:

| id | label | from | to | what happens |
|---|---|---|---|---|
| `void` | `VOID` | 0.00 | 0.07 | Black. One breathing center dot. A thin horizontal beam inflates from the centre line. |
| `grid` | `GRID` | 0.07 | 0.30 | Perspective wireframe tunnel fades in from a centre vanishing point and rushes toward the viewer. Radial spokes + receding depth rings. Horizon scan line. |
| `reticle` | `RETICLE` | 0.30 | 0.50 | SAO reticle: concentric dashed rings rotating in opposite directions, four corner brackets, a crosshair, tick marks on the cardinal axes. Telemetry text appears. |
| `link` | `LINK` | 0.50 | 0.72 | The wordmark `LINK START` assembles at centre with a chromatic-aberration glitch and a horizontal scan pass. A thin ring snaps around it. |
| `surge` | `SURGE` | 0.72 | 0.86 | Tunnel accelerates hard, rings collapse inward, bloom rises, spokes stretch into speed lines. |
| `resolve` | `RESOLVE` | 0.86 | 1.00 | Flash peaks white, then settles; the frame simplifies to the wordmark + rim light, ready to dissolve. |

Visual language (this is the part the brief exists for):

* Palette: near-black base `#000000`–`#04080c`; primary accent SAO cyan (`cfg.accent`,
  default `#5ad7ff`); secondary amber `#ffb347`; tertiary HP green `#7fff8f`. Use the
  accent for the tunnel and reticle, amber sparingly for warning/tick accents in
  `reticle`, green only for thin HUD bars.
* Movement is **fast and mechanical**, not soft: hard edges, high contrast, no bouncy
  easing. Use linear or ease-out with short durations. SAO's look is a wireframe
  instrument waking up.
* The tunnel must read as *depth*: fade line alpha with distance, thin far lines, thick
  near lines, and keep a bright vanishing-point core.
* `glitch` (cfg) gates chromatic aberration: draw the same shape 2–3 times offset by
  1–4 design px in red/green/blue-ish tints with low alpha. Keep it under 15% of the
  primitive budget or drop it on the last 20% of a phase.
* `scanlines` (cfg) is a `Scanlines` strength, not primitives — fill the frame field.
* `telemetry` (cfg) gates the ASCII readout text: hex-ish counters, `LINK`, `SYNC`,
  `NODE`, depth meters. It must look like live instrumentation and must be *derived
  from `t`*, so it visibly counts.
* Reduced motion: when the effective setting says so, the scene must still produce a
  valid frame, but with the tunnel/grid motion and glitch suppressed — a calm fade of
  the reticle and wordmark. Implement this inside `scene.js` as `cfg.motion === 'calm'`
  (the overlay decides the value; see §5).

Amber note: the scene must look good at *any* window aspect ratio, since the renderer
scales `DESIGN` to cover. Keep everything that matters inside the central 70% box, and
treat the outer 15% as bleed.

---

## 5. `src/boot-screen.js` — the overlay (owned by `render-dev`)

Also a **classic script**, self-contained, injected as text. It may use
`globalThis.__DSH_LINK_START_SCENE__` (injected immediately before it) and
`globalThis.__DSH_LINK_START_CFG__` (a `global` row injected before both).

`src/style.css` is injected as a separate `style` row; all overlay selectors are
prefixed `.dslls-`.

```js
;(function () {
  'use strict'
  var scene = globalThis.__DSH_LINK_START_SCENE__
  var cfg = globalThis.__DSH_LINK_START_CFG__
  // ... implementation ...
  globalThis.__DSH_LINK_START__ = { el, state, preview, clientReady, skip, destroy }
})()
```

If `scene` or `cfg` is missing, or `globalThis.__DSH_LINK_START__` already exists, the
script must **return immediately and do nothing** (idempotence + graceful degradation).

### 5.1 Public surface

| member | type | meaning |
|---|---|---|
| `el` | `HTMLElement \| null` | overlay root, `null` after removal |
| `state` | `'booting' \| 'ready' \| 'leaving' \| 'gone'` | current state |
| `clientReady()` | `() → void` | called by the client half once the client roster activates. Records `bootedAt` and re-evaluates the handoff. Must be safe to call twice, and must not throw. |
| `skip()` | `() → void` | begin the dissolve now |
| `preview(overrides)` | `(object?) → boolean` | replay the real overlay on a live page for the settings card. `false` if one is already running. |
| `destroy()` | `() → void` | remove everything, including the stylesheet it owns |

Also publish `globalThis.__DSH_LINK_START_DIAG__` (a plain object) with at least
`{ t, state, phase, bootedAt, fps, reduced, errors: [] }` for the `?dshlinkdiag=1`
readout.

### 5.2 The handoff rule — the one thing that must not be got wrong

The dissolve begins when **both** the timeline is done **and** the client roster has
reported ready:

```
timelineDone  =  scene.frame(t).done
clientBooted  =  bootedAt !== null
```

* `enterMode === 'auto'`: whichever of the two finishes **second** triggers the
  dissolve. A timeline that finishes during a slow boot simply holds its last frame; a
  roster that becomes ready before the timeline ends waits for the timeline.
* `enterMode === 'click'`: only a user gesture (pointerdown, or `Esc`/`Space`/`Enter`)
  dissolves. The timeline **loops** in this mode — it must therefore be rendered by
  asking `scene.frame(t % duration)` so the display list stays valid, and the loop must
  not fight the handoff.
* Bound: `holdMs` after which, if `clientBooted` is still false, the hint switches to
  the "press to continue" wording. It **never auto-enters without a booted roster** —
  that would reveal a half-built app. A `clientReady()` that arrives later still
  triggers the auto handoff.
* In `click` mode there is no looping requirement on the *scene* API beyond
  `t % duration`; do not add loop semantics to `scene.js`.

During the dissolve: the **whole overlay fades as one unit** (background gradient, art
and chrome together) over `fadeMs`, then the root is removed. Never leave anything
opaque over the app.

### 5.2a Kernel failure is always revealed — it is the one case that overrides 5.2

§5.2 says never to auto-enter without a booted roster, and §5.3 says to hand over
promptly on a kernel failure. Those pull in opposite directions for an un-booted roster,
and the resolution is that they are about **different objects**:

* §5.2 guards against revealing a **half-built application** — a screen that is
  technically mounted but missing the parts the user is about to interact with.
* A kernel failure produces no application at all. It produces the kernel's own failure
  card, holding `Failed to load plugins` and the list of entries that did not activate.
  That card **is** the complete diagnosis.

So on a detected kernel failure the overlay must **get out of the way**: dissolve after a
short grace (`~600ms`, long enough to read as deliberate rather than as a glitch) and
then remove itself, **regardless of `enterMode`** — including `click` mode, where a user
asked to control the timing. This is the one case where the gesture rule is overridden,
and it is overridden because an opaque full-viewport animation that hides a startup
diagnosis is strictly worse than any amount of unwanted motion. The user is never held on
a decorative screen while DSH is telling them it is broken.

`holdMs` remains the *other* case and keeps §5.2's treatment exactly: a slow boot is not a
failure and normally resolves, so it only switches the hint to "press to continue" and
waits. It must never auto-enter.

Publish the distinction on diagnostics as `failed: true` (and keep the failure text on the
hint line), so a stuck screen is diagnosable from a screenshot.

## 5.3 Progress

Read the kernel's own boot progress from the boot page it renders:
`document.querySelector('[data-dsh-boot]')` then `[data-dsh-boot-spinner]`, and parse
the CSS custom property `--dsh-boot-arc` (72deg at zero active entries, 288deg at all).
Map onto the bottom HUD bar. Observe with a `MutationObserver` on that element's `style`
attribute. If the element is absent, the bar is driven by the timeline instead — never
stuck at zero.

Also detect the kernel's failure report (the boot card's text gaining
`Failed to load plugins` / `did not activate`) and, if it appears, hand over promptly
rather than trapping the user on a decorative screen. Failing loudly is better than
hiding a diagnosis.

### 5.4 Reduced motion

`prefers-reduced-motion: reduce` **and** `cfg.respectReducedMotion === true` →
`cfg.motion = 'calm'` before `createScene(cfg)`, and the overlay shortens to a
`min(1200, durationMs)` dissolve of the reticle + wordmark only. Expose `reduced` on
the diagnostics object. Any explicit user gesture always works.

### 5.5 Audio — procedural, zero assets (owned by `render-dev`)

A short synthesized "system online" chime via `WebAudio`: two or three oscillators
(sine/triangle) with a fast gain envelope, ~900ms, plus a filtered noise swell. No
audio file, no fetch. Rules:

* Start **silent**. Chromium grants audio only to a user gesture, and the entering
  gesture cannot also be the unlock. Provide the same two-meaning press model as the
  reference: while silent, a press unlocks audio and stays; once unlocked (or if audio
  was never blocked), a press skips ahead.
* `cfg.sound === false` → **no audio path at all**: no `AudioContext` is constructed,
  no control is drawn, no attempt is made.
* The `AudioContext` must be created lazily on the first gesture and closed on
  `destroy()`. Never let an audio error break the animation.
* On the desktop Electron app autoplay-with-sound may be permitted; attempt it and
  degrade silently if refused.

### 5.6 Diagnostics

`location.search` containing `dshlinkdiag=1` turns the hint line into a live readout
(`state`, `t`, `phase`, `fps`, `booted`, `reduced`, `errors`). Reported from the page so
a stuck screen can be diagnosed from a screenshot.

---

## 6. `src/client.js` → `lib/client.js` (owned by `client-dev`)

Two jobs, in this priority order:

1. **`globalThis.__DSH_LINK_START__?.clientReady()`** — first, unconditionally, inside
   its own `try/catch`. This is part of the handoff condition; nothing may delay or
   prevent it. A missing overlay is a no-op, not an error.
2. The settings card.

Hard constraints:

* **`exports.inject` must remain empty** (no declared inject).
* Reach services only through `ctx.inject(['slots','locale','configForms'], cb)` and read
  them with `owner.get(name)` (fallback to `owner[name]`). Never `ctx.get(name)` —
  it is a one-shot read that races activation and silently answers `undefined`.
* The card registers into slot **`plugins.item`** and dispatches on `props.view`:
  `'summary'` → a one-line **string/light element**, otherwise the page. These must be
  **two components**, because they use a different number of hooks and one component
  branching between them is a conditional hook call, which React rejects — the visible
  symptom is a card that renders but every control is dead.
* Reads go through `useSyncExternalStore` over `props.form` (preferred) else
  `props.scope` else the static `props.form.state`; the snapshot reference must be
  stable between changes. Writes go through `props.form.mutate` / `scope.mutate` with
  `{ op:'set', path:[field], value }` and the snapshot `revision`; on a bare `false`,
  retry once through the remote service
  (`props.remote.settings.mutate(ns, ops, undefined)`) to surface **why**, instead of a
  control that silently does nothing.
* Registration must be **idempotent**: guard with a `registration` handle, dispose the
  previous one before re-registering, own every throw. A duplicate `slots.register`
  throw lands inside the slot ledger's store notification and kills the mounted card's
  updates while its DOM stays in place — a visible, completely dead card.
* Gate contribution on `configForms.whileServed(['link-start'], register)` so a profile
  with no settings provider shows no inert tab.
* Buffer the card's layout with the host's own tokens (`--dsw-alias-*`) with literal
  fallbacks, so it reads as a shipped card. **No backticks anywhere inside the CSS
  string** — a stray backtick terminates the blob and the build silently keeps the
  previous artifact.
* Bilingual: register a `locale` dictionary namespace `linkStart` with `zh` + `en` and
  render labels through `locale.bind('linkStart')`. The card's own copy must exist in
  both languages.

`build-client.mjs` wraps `src/client.js` verbatim into
`window.__ModuleLoader__.load({ id: 'dsh-link-start', factory: (require) => { … } })`.
It must refuse to build if the source already carries the wrapper tail. `lib/client.js`
is a **build artifact and is committed**; `src/client.js` is the source of truth.

---

## 7. `index.js` — the host half (owned by the Lead)

```js
export const name = 'dsh-link-start'
export const inject = ['webServer']
export const Config = z.object({ /* every field .volatile() */ })
export function apply(ctx, config) { … }
```

`apply` registers, each under `ctx.effect(...)`:

* exact `GET /plugins/dsh-link-start/state.json` → `{ name, version, dsh, config, phase }`
  where `config` is the resolved config read through `readField`. `no-store`.
* exact `GET /plugins/dsh-link-start/boot.js` → the exact composed injected script text
  as `application/javascript`. This exists so a test and a human can fetch precisely
  what the page received. `no-store`.
* a `ctx.on('webserver/index-inject', table => …)` subscriber (registered directly, not
  wrapped in an effect — `ctx.on` already returns a tracked disposer), pushing, **when
  and only when `enabled`**:
  1. a `global` row `__DSH_LINK_START_CFG__` with `<` escaped by `JSON.stringify(v).replaceAll('<','\\u003c')`,
  2. a `style` row carrying `src/style.css`,
  3. a `script` row, `placement: 'head'`, carrying `src/scene.js` + `src/boot-screen.js`
     composed in that order.

Sources are re-read **per index render**, so editing `src/style.css` / `src/scene.js` /
`src/boot-screen.js` takes effect on a plain page reload with no DSH restart. A missing
or unreadable source file must **not** blank the boot page: log a warning and inject
nothing (the kernel's own boot page then shows).

`enabled === false` means *nothing is injected at all* — no config row, no style, no
script, zero requests. Injecting a disabled overlay that bails out at runtime would look
the same and leave the whole thing running.

### 7.1 The config schema — final field list (all `.volatile()`)

| field | type | default | notes |
|---|---|---|---|
| `enabled` | boolean | `true` | master switch |
| `durationMs` | number | `6800` | 3000..20000, the animation timeline |
| `fadeMs` | number | `1000` | 200..4000, the dissolve |
| `enterMode` | `'auto' \| 'click'` | `'auto'` | |
| `accent` | string | `'#5ad7ff'` | must match `/^#[0-9a-fA-F]{6}$/` or fall back to the default |
| `sound` | boolean | `true` | |
| `glitch` | boolean | `true` | chromatic aberration |
| `scanlines` | boolean | `true` | |
| `telemetry` | boolean | `true` | |
| `wordmark` | boolean | `true` | |
| `title` | string | `'DEEPSEEK HARNESS'` | max 40 chars |
| `respectReducedMotion` | boolean | `true` | |
| `seed` | number | `0` | 0 = fresh random per boot; else int 1..2^31-1 |
| `holdMs` | number | `20000` | 3000..60000, the "boot never settled" bound |

If `schemastery`'s resolved copy lacks `.volatile()`, `index.js` must not throw during
module evaluation: probe once (`LIVE_CAPABLE`), degrade the schema, and `apply` warns
with the fix. A `Config` with no volatile field yields no namespace and a missing card —
that is the documented cost, and it must be a warning, not a crash.

---

## 8. Verification contract (owned by `verify-dev`)

Node-only, no DSH process, no ports, no prompts, no network. All suites must be runnable
together and must exit non-zero on failure. `verify-dev` owns `tools/raster.mjs`,
`tools/storyboard.mjs` and `verify/*.mjs`.

| suite | proves |
|---|---|
| `verify/verify-scene.mjs` | `scene.js` loads in a bare `vm` context; `normalizeConfig` clamps/never throws; `PHASES` is contiguous 0→1; `frame(t)` is deterministic (two calls stringify-equal); the primitive set is exactly §4.4; `color` is `#rrggbb`; text is ASCII; every frame ≤ 600 primitives; `done` at `t >= duration`; sampling the whole timeline never throws and never yields `NaN`/`Infinity` coordinates |
| `verify/verify-screen.mjs` | `boot-screen.js` runs against a **stub DOM**: mounts one root, is idempotent on a second load, returns immediately when `cfg` is missing, `clientReady()` is safe twice, the handoff matrix (`auto` both orders, `click` needs a gesture, `holdMs` never auto-enters un-booted) holds, `destroy()` leaves no node behind |
| `verify/verify-css.mjs` | no backtick inside the CSS blob; every attribute selector with a numeric value is quoted (`[data-x="0"]`); every `.dslls-` selector is namespaced; comments stripped before any regex assertion |
| `verify/verify-client.mjs` | `lib/client.js` matches a fresh build of `src/client.js`; it wraps in exactly one `__ModuleLoader__.load`; it declares **no** `exports.inject`; it calls `clientReady` before any other work; it never contains `ctx.get(`; the CSS blob has no backtick |
| `verify/verify-entry.mjs` | `index.js` imports; `Config` is present on the namespace; `Config.toJSON()` projects **a non-empty form for every §7.1 field** (this is the settings-visibility proof); `apply` pushes exactly 3 rows when enabled and **0** when disabled, via a stub `ctx`; every field is volatile |
| `verify/verify-namespace.mjs` | `- insert: id:` in `cordis.patch.yml` === `SETTINGS_NAMESPACE` in `src/client.js` === the `name` export === `package.json` name/route prefix invariants of §3 |
| `verify/verify-injection-safety.mjs` | no injected source contains the literal `</script`; the config row escapes `<`; a missing source file degrades instead of throwing |
| `verify/verify-routes.mjs` | the two routes answer with the right content type and `cache-control: no-store`, using stub req/res objects |
| `tools/storyboard.mjs` | renders the identical display list the browser draws into PNGs, one per phase, with **no dependencies** (hand-rolled PNG encoder over `node:zlib`), and prints a contact-sheet index |

The rasterizer must implement exactly §4.4 and must **not** re-derive any geometry — it
consumes `frame(t).layers` and nothing else. Anything it cannot draw, it must report
loudly rather than skip silently.

---

## 9. Docs and tooling (owned by `docs-dev`)

`README.md` (中文-first + full English section, a language switcher at the top of each),
`MANUAL.md` (user-facing, Chinese), `AGENTS.md`
(maintainer briefing), `tools/install.ps1`, `tools/uninstall.ps1`.

Install does exactly two things and nothing else: a directory junction at
`<profile>/node_modules/dsh-link-start`, and one `- insert:` row appended to
`<profile>/cordis.patch.yml`. It must **not** touch `package.json` and must **not** run
pnpm. Uninstall reverses exactly those two and must leave `cordis.patch.yml`
**byte-identical except for the row it owns** — UTF-8, no BOM, CJK intact, original line
terminators preserved. Use `[System.IO.File]::ReadAllText/WriteAllText` with
`New-Object System.Text.UTF8Encoding($false)`; **never** `Get-Content`/`Set-Content` and
never `ReadAllLines`/`WriteAllLines` (the latter rewrites every line terminator). Count
*insert* rows specifically: once the settings card has saved a value, the settings
service writes its own `- id: link-start` row with a `config:` block and no `insert:`,
and a naive name search then reports "already installed" while the plugin is off the
loader graph. Scripts are **pure ASCII**.

`docs-dev` must not touch any file under `src/`, `index.js`, `lib/`, `verify/` or
`tools/raster.mjs` / `tools/storyboard.mjs`.

---

## 9a. Operational facts confirmed by recon — all four bite us

1. **The desktop profile cannot be installed into with `dsh plugin`.** It is refused with
   `profile "desktop" is managed exclusively by the Electron application`. The
   link + patch-row method (`tools/install.ps1 -ProfileName desktop`) is therefore the
   *only* route, not a fallback.
2. **Client bundles are served `cache-control: max-age=31536000, immutable`, and the
   `rev` in the bundle URL is a per-process nonce that does not track content.** After
   changing `src/client.js` and rebuilding, a plain F5 can keep serving the old bundle.
   `install.ps1` must tell the user this, and **Ctrl+Shift+R** is the documented step.
   This is also why the settings card is the *only* thing that lives in the client
   bundle: the animation itself is re-read per index render and needs only an F5.
3. **`--dsh-boot-arc` is the live progress signal** on `[data-dsh-boot] [data-dsh-boot-spinner]`
   (72deg = 0 active entries, 288deg = all). §5.3 is correct as written.
4. **A static `inject` in the client half is fatal to the entire GUI**, not just to the
   plugin: web boot throws `web boot: N entries did not activate` and refuses to mount.
   Observed in the field as `pending (waiting for service: uisession)`. Never add one.

## 9b. The two surfaces inject at DIFFERENT times — verified, and it matters

The injection table is the same object on both surfaces, but it reaches the page at
different moments, and the difference is not cosmetic.

**Web (the HTTP-served GUI, e.g. `http://127.0.0.1:<port>/`).** `dsh-host-frontend-static`
claims the webserver fallback seat and calls `ctx.webServer.renderIndex(html)` on every
index response, which splices the collected rows into the document text. The rows are
therefore **in the HTML**, so the `script` row is a genuine parser-blocking classic
script: it executes before the shell's module script, before `new AppWebEntry(...)`
constructs the kernel boot page, and before the first paint. This is the full intended
behaviour — the overlay owns the viewport from the very first frame.

**Desktop (Electron, `dsh-app://app/`).** `serveWebDocument` injects only
`globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()` into the index text. The rows
are NOT in the HTML; the renderer fetches them over IPC and applies them with
`applyInjections()` **after `Ms.ready()` resolves**, which is after the whole host
process has booted (`dsh-desktop-host` sends `{type:'ready', injections}` only once
`application` has resolved). The shell module also constructs the kernel boot page
**synchronously** before awaiting that promise:

```js
const t = new TZ(e)            // constructs the boot page (CZ) into #root, right now
if (Ms !== void 0) {
  Ms.ready().then(async ({ injections }) => {
    await PZ(injections, …)    // our rows apply HERE — after the host booted
    r.resolve()                // …and only then does t.run() proceed to mount the app
  })
}
t.run(…)                       // t.run awaits __DSH_BOOT_READY__.promise first
```

Consequences, both of which are honest limitations rather than defects:

1. On desktop the kernel's "HARNESS / Loading plugins…" page is visible during the host
   boot, and our overlay then covers it and plays. The sequence the user sees is
   *boot page → animation → app*, not *animation instead of the boot page*. Our overlay
   is opaque, full-viewport and `z-index: 2147483647`, and it mounts strictly before any
   module loads or the app mounts, so it still fully owns the viewport for the length of
   the animation and still dissolves into the app correctly.
2. The overlay must therefore **not** assume it mounted before the boot page exists. It
   must find `[data-dsh-boot]` already present, must not depend on having been first, and
   must time its own timeline from its own mount instant.

Also note: on desktop the `script` row is appended as a real `<script>` element with
`textContent`, so `</script` inside it is harmless there — but on Web the same text sits
in the HTML text, where it would terminate the element. `index.js`'s `isInjectable()`
guard is therefore not a style preference: it protects the surface this plugin is
primarily built for. `verify/verify-injection-safety.mjs` asserts it.

Because of (1) the desktop surface cannot show a true pre-boot overlay without a change
inside the Electron host, which is not a plugin's to make. `MANUAL.md` states this.

## 10. Invariants that must never regress

1. `frame(t)` is deterministic for a given scene handle.
2. The animation needs **no network request** to draw its first frame.
3. Nothing opaque is left over the app after the dissolve.
4. `exports.inject` in the client half stays empty; `clientReady()` runs first and
   inside its own `try/catch`.
5. Every config field the card edits is `.volatile()`, and is read on the host through
   `.get()`.
6. `enabled: false` injects nothing at all.
7. Injected text never contains `</script`.
8. `verify/` suites pass together, offline, with no prompts and no fixed ports.
