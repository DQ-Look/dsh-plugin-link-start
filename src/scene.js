/**
 * dsh-link-start — the animation model (src/scene.js).
 *
 * The LINK START sequence: VOID → GRID → RETICLE → LINK → SURGE → RESOLVE. A
 * wireframe instrument waking up in front of the viewer, ending on the wordmark
 * with enough rim light to dissolve into the app.
 *
 * A PURE FUNCTION OF TIME producing a display list. No DOM, no imports, no
 * assets, no network. Injected as a CLASSIC script ahead of the shell's module
 * script, and loaded in a bare Node `vm` context by verify/verify-scene.mjs.
 *
 * INTERFACES.md §4 is the frozen contract; this file implements it and nothing
 * beyond it. Two properties are load-bearing and easy to lose:
 *
 *  1. `frame(t)` is a pure function of `t` for a given scene handle. There is NO
 *    `Math.random()` and NO `Date.now()` inside `frame` — all randomness is drawn
 *    ONCE in `createScene(cfg)` from a seeded PRNG and indexed by `t` afterwards.
 *    Every storyboard render and every assertion in `verify/` depends on this.
 *  2. The primitive set in §4.4 is CLOSED. `tools/raster.mjs` and
 *    `src/boot-screen.js` each implement exactly that set, so a new `k` smuggled
 *    in here would render as nothing in the storyboard and vanish silently in the
 *    browser. Colors are `#rrggbb` (lowercase) only, and every text string is
 *    uppercase ASCII, because the rasterizer carries a 5x7 uppercase font.
 */
;(function () {
  'use strict'

  /** Design space. Every coordinate in this file is expressed in these units. */
  var DESIGN = { W: 1600, H: 900 }

  /**
   * The timeline, normalized so `durationMs` scales the whole sequence.
   * Contiguous, ascending, first `from` exactly 0, last `to` exactly 1.
   */
  var PHASES = [
    { id: 'void', label: 'VOID', from: 0, to: 0.07 },
    { id: 'grid', label: 'GRID', from: 0.07, to: 0.3 },
    { id: 'reticle', label: 'RETICLE', from: 0.3, to: 0.5 },
    { id: 'link', label: 'LINK', from: 0.5, to: 0.72 },
    { id: 'surge', label: 'SURGE', from: 0.72, to: 0.86 },
    { id: 'resolve', label: 'RESOLVE', from: 0.86, to: 1 }
  ]

  /**
   * The documented defaults (§7.1), frozen.
   *
   * `motion` is the internal reduced-motion switch the overlay sets from
   * `respectReducedMotion` + `prefers-reduced-motion` (§5.4, §4.5). It is not a
   * settings field, so it has no entry in §7.1 and is never broadcast.
   */
  var DEFAULT_CFG = Object.freeze({
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
    motion: 'full'
  })

  var W = DESIGN.W
  var H = DESIGN.H
  var CX = W / 2
  var CY = H / 2

  /** Palette (§4.5): near-black base, SAO cyan accent, amber and HP green accents. */
  var BG = '#000000'
  var BG_DEEP = '#04080c'
  var PANEL = '#0b1c26'
  var WHITE = '#ffffff'
  var AMBER = '#ffb347'
  var GREEN = '#7fff8f'
  var GLITCH_R = '#ff2a2a'
  var GLITCH_B = '#2a6aff'

  /** `#rrggbb` only — anything else falls back to the default accent. */
  var HEX_COLOR = /^#[0-9a-fA-F]{6}$/

  /** §7.1: the title is truncated to 40 characters. */
  var TITLE_MAX = 40

  /** Depth rings in the GRID tunnel, and radial spokes. Fixed counts, not config. */
  var RINGS = 9
  var SPOKES = 16

  /**
   * The wordmark's own layout bounds.
   *
   * §4.5 requires everything that matters to sit inside the central 70% box (the
   * outer 15% is bleed), and the title is user-supplied and may be up to 40
   * characters. The rasterizer's cell font advances 6/7 of `size` per glyph, so a
   * fixed size does not survive a long title: the 16-character default at 96px is
   * 1317 design px wide, and 40 characters would be 3292 — twice the design space,
   * running off both edges. The size therefore shrinks to fit the text.
   */
  var WORDMARK_MAX_SIZE = 96
  var WORDMARK_MAX_WIDTH = 1080

  // ---------------------------------------------------------------------------
  // small numeric helpers
  // ---------------------------------------------------------------------------

  /**
   * Coerce to a finite number, falling back to `d`.
   *
   * A single `NaN` reaching a coordinate poisons a canvas path and can blank the
   * whole frame with no error anywhere, so every numeric input funnels through
   * this before it is allowed near the display list.
   */
  function num(v, d) {
    var n = typeof v === 'number' ? v : Number(v)
    return isFinite(n) ? n : d
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v
  }

  function lerp(a, b, u) {
    return a + (b - a) * u
  }

  function easeOut(u) {
    var c = clamp(u, 0, 1)
    return 1 - (1 - c) * (1 - c)
  }

  function easeIn(u) {
    var c = clamp(u, 0, 1)
    return c * c
  }

  function easeInOut(u) {
    var c = clamp(u, 0, 1)
    return c < 0.5 ? 2 * c * c : 1 - 2 * (1 - c) * (1 - c)
  }

  /** Normalized 0..1 ramp of `t` across `[from, to]`. */
  function ramp(t, from, to) {
    if (to <= from) return t >= to ? 1 : 0
    return clamp((t - from) / (to - from), 0, 1)
  }

  /** A single-lobed 0..1 pulse across `[from, to]` — 0 at both ends, 1 in the middle. */
  function pulse(t, from, to) {
    var u = ramp(t, from, to)
    return u <= 0 || u >= 1 ? 0 : Math.sin(u * Math.PI)
  }

  /** One byte as two lowercase hex digits. */
  function byteHex(n) {
    var s = clamp(Math.round(num(n, 0)), 0, 255).toString(16)
    return s.length < 2 ? '0' + s : s
  }

  /**
   * Lighten (`amount > 0`) or darken (`amount < 0`) a `#rrggbb` color.
   *
   * Always answers lowercase, because §4.4 admits only lowercase `#rrggbb` and
   * the accent may arrive from the settings page in either case.
   */
  function tint(hex, amount) {
    var r = parseInt(hex.slice(1, 3), 16)
    var g = parseInt(hex.slice(3, 5), 16)
    var b = parseInt(hex.slice(5, 7), 16)
    function mix(c) {
      return amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)
    }
    return '#' + byteHex(mix(r)) + byteHex(mix(g)) + byteHex(mix(b))
  }

  /** Zero-pad a non-negative integer for the telemetry counters. Digits only. */
  function pad(n, width) {
    var s = String(clamp(Math.round(num(n, 0)), 0, 999999999))
    while (s.length < width) s = '0' + s
    return s
  }

  /** A value as two uppercase hex digits — telemetry readouts, ASCII only. */
  function hexByte(n) {
    var s = clamp(Math.round(num(n, 0)), 0, 255).toString(16).toUpperCase()
    return s.length < 2 ? '0' + s : s
  }

  /** Alpha, always a finite number in 0..1 (§4.4). */
  function alpha(v) {
    return clamp(num(v, 0), 0, 1)
  }

  /** A deterministic PRNG. Seeded once per handle, never called from `frame`. */
  function mulberry32(a) {    return function () {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      var t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  // ---------------------------------------------------------------------------
  // config
  // ---------------------------------------------------------------------------

  /**
   * Fill defaults, clamp ranges and coerce types. **Pure.**
   *
   * Never throws and never mutates `raw`: the overlay hands it whatever the
   * injected global happens to hold, and the verification suite calls it with
   * `undefined`, `null`, numbers, strings, arrays, booleans, `NaN`, `Infinity`,
   * prototype-pollution payloads and deeply nested objects. Unknown keys are
   * dropped rather than carried, so a stale profile value cannot widen what the
   * scene sees.
   */
  function normalizeConfig(raw) {
    var r = raw !== null && typeof raw === 'object' ? raw : {}
    return {
      enabled: r.enabled === undefined ? DEFAULT_CFG.enabled : !!r.enabled,
      durationMs: Math.round(clamp(num(r.durationMs, DEFAULT_CFG.durationMs), 3000, 20000)),
      fadeMs: Math.round(clamp(num(r.fadeMs, DEFAULT_CFG.fadeMs), 200, 4000)),
      enterMode: r.enterMode === 'click' ? 'click' : 'auto',
      accent: typeof r.accent === 'string' && HEX_COLOR.test(r.accent) ? r.accent : DEFAULT_CFG.accent,
      sound: r.sound === undefined ? DEFAULT_CFG.sound : !!r.sound,
      glitch: r.glitch === undefined ? DEFAULT_CFG.glitch : !!r.glitch,
      scanlines: r.scanlines === undefined ? DEFAULT_CFG.scanlines : !!r.scanlines,
      telemetry: r.telemetry === undefined ? DEFAULT_CFG.telemetry : !!r.telemetry,
      wordmark: r.wordmark === undefined ? DEFAULT_CFG.wordmark : !!r.wordmark,
      title: typeof r.title === 'string' ? r.title.slice(0, TITLE_MAX) : DEFAULT_CFG.title,
      respectReducedMotion:
        r.respectReducedMotion === undefined ? DEFAULT_CFG.respectReducedMotion : !!r.respectReducedMotion,
      seed: Math.round(clamp(num(r.seed, 0), 0, 2147483647)),
      holdMs: Math.round(clamp(num(r.holdMs, DEFAULT_CFG.holdMs), 3000, 60000)),
      motion: r.motion === 'calm' ? 'calm' : 'full'
    }
  }

  /** Total timeline length in ms. */
  function totalDuration(cfg) {
    return normalizeConfig(cfg).durationMs
  }

  /**
   * The phase `t` falls in, with its local 0..1 progress. `t` is clamped, so a
   * negative time answers the first phase and a time past the end the last.
   */
  function phaseAt(cfg, t) {
    var d = totalDuration(cfg)
    var p = clamp(num(t, 0), 0, d) / d
    for (var i = 0; i < PHASES.length; i++) {
      var ph = PHASES[i]
      if (p < ph.to || i === PHASES.length - 1) {
        var span = ph.to - ph.from
        var local = span <= 0 ? 1 : (p - ph.from) / span
        return {
          id: ph.id,
          label: ph.label,
          index: i,
          local: clamp(local, 0, 1),
          start: ph.from,
          end: ph.to
        }
      }
    }
    // Unreachable: the loop's last branch always matches. Kept so a malformed
    // PHASES table can never make phaseAt answer `undefined`.
    return { id: 'void', label: 'VOID', index: 0, local: 0, start: 0, end: 1 }
  }

  // ---------------------------------------------------------------------------
  // the scene factory
  // ---------------------------------------------------------------------------

  /**
   * Build a scene handle: `{ cfg, duration, phases, frame }`.
   *
   * Everything random is drawn HERE, once, from a seeded PRNG, so that
   * `frame(t)` is a pure function of `t` for the lifetime of the handle. The
   * per-artifact jitter arrays are indexed by position, never re-drawn.
   */
  function createScene(cfg) {
    var c = normalizeConfig(cfg)
    var duration = c.durationMs
    var calm = c.motion === 'calm'

    // seed === 0 means "a fresh look per boot" — drawn once, here, and NEVER
    // inside frame(). Any jitter that needed randomness at render time would
    // make every storyboard PNG and every determinism assertion worthless.
    var seed = c.seed !== 0 ? c.seed : Math.floor(Math.random() * 2147483647) + 1
    var rnd = mulberry32(seed)

    // Lowercased for drawing only: `cfg.accent` is preserved verbatim because
    // §7.1 accepts either case, but §4.4 admits lowercase `#rrggbb` only.
    var accent = c.accent.toLowerCase()
    var accentSoft = tint(accent, -0.28)
    var accentDim = tint(accent, -0.58)

    var ringPhase = []
    var ringGain = []
    for (var i = 0; i < RINGS; i++) {
      ringPhase.push(rnd())
      ringGain.push(0.65 + rnd() * 0.45)
    }

    var spokeAngle = []
    var spokeGain = []
    for (var j = 0; j < SPOKES; j++) {
      spokeAngle.push((j / SPOKES) * Math.PI * 2 + (rnd() - 0.5) * 0.22)
      spokeGain.push(0.55 + rnd() * 0.6)
    }

    var glitchOff = rnd()

    /**
     * The display list for time `t` (ms).
     *
     * Pure in `t`. Layers are built fresh on every call — never pushed onto a
     * captured array — because the suite compares two calls at the same `t` with
     * `JSON.stringify`.
     */
    function frame(tRaw) {
      // Clamped to the timeline: `t` is echoed in the frame, and an unclamped
      // absurd input would put an implausible number into the display list.
      // `progress` is computed from this same clamped t, which agrees with
      // clamp(t/duration, 0, 1) for every t outside the range too.
      var t = clamp(num(tRaw, 0), 0, duration)
      var ph = phaseAt(c, t)
      var id = ph.id
      var u = ph.local
      var p = clamp(t / duration, 0, 1)

      var layers = []
      var background = BG
      var flash = 0
      var vignette = 0
      var scan = 0
      var shake = 0

      if (id === 'void') {
        // Black. One breathing centre dot; a thin beam inflates from the centre line.
        var ig = easeOut(u)
        background = BG
        vignette = 0
        layers.push({ k: 'fill', color: background, alpha: 1 })
        var beamW = lerp(0, 560, ig)
        if (beamW > 1) {
          layers.push({
            k: 'bar', x: CX - beamW / 2, y: CY - 1, w: beamW, h: 2,
            color: accentSoft, alpha: alpha(0.75)
          })
        }
        var breathe = 0.5 + 0.5 * Math.sin(u * Math.PI * 2)
        layers.push({
          k: 'circle', cx: CX, cy: CY, r: 3 + 4 * breathe,
          color: accent, alpha: alpha(0.95), fill: true
        })
        layers.push({
          k: 'circle', cx: CX, cy: CY, r: 16 + 46 * ig,
          color: accentDim, alpha: alpha(0.4), width: 2
        })
      } else if (id === 'grid') {
        // A perspective wireframe tunnel rushing toward the viewer.
        var gv = easeIn(u)
        background = BG_DEEP
        vignette = 0.2
        scan = 0.35
        layers.push({ k: 'fill', color: background, alpha: 1 })
        layers.push({
          k: 'poly', points: [[240, 700], [CX, 470], [1360, 700]],
          color: PANEL, alpha: alpha(0.45), fill: true, close: true
        })
        // the vanishing-point core
        layers.push({
          k: 'circle', cx: CX, cy: CY, r: 4 + 10 * gv,
          color: accent, alpha: alpha(0.95), fill: true
        })
        // horizon scan line
        layers.push({
          k: 'bar', x: 0, y: CY - 1, w: W, h: 1.5,
          color: accentSoft, alpha: alpha(0.5)
        })
        // depth rings: thin and dim far away, thick and bright up close
        for (var n = 0; n < RINGS; n++) {
          var z = (ringPhase[n] + gv * 2.4) % 1
          layers.push({
            k: 'circle', cx: CX, cy: CY, r: 16 + z * z * 980,
            color: z > 0.62 ? accentDim : accent,
            alpha: alpha((1 - z) * 0.55 * ringGain[n] + 0.05),
            width: 1 + (1 - z) * 3,
            dash: [10 + 30 * (1 - z), 14],
            rot: (ringPhase[n] + gv) * 1.8
          })
        }
        // radial spokes
        for (var s = 0; s < SPOKES; s++) {
          var ang = spokeAngle[s] + gv * 0.55
          var far = 260 + gv * 900 * spokeGain[s]
          layers.push({
            k: 'line',
            x1: CX + Math.cos(ang) * 18, y1: CY + Math.sin(ang) * 18,
            x2: CX + Math.cos(ang) * far, y2: CY + Math.sin(ang) * far,
            color: accentDim, alpha: alpha(0.12 + 0.3 * gv), width: 1.2
          })
        }
      } else if (id === 'reticle') {
        // The SAO reticle: counter-rotating dashed rings, brackets, ticks.
        background = BG_DEEP
        vignette = 0.22
        scan = 0.35
        layers.push({ k: 'fill', color: background, alpha: 1 })
        layers.push({
          k: 'circle', cx: CX, cy: CY, r: 300, color: accent,
          alpha: alpha(0.85), width: 3, dash: [26, 18], rot: u * 1.4
        })
        layers.push({
          k: 'circle', cx: CX, cy: CY, r: 244, color: AMBER,
          alpha: alpha(0.6), width: 2, dash: [14, 12], rot: -u * 1.9
        })
        layers.push({
          k: 'circle', cx: CX, cy: CY, r: 272, color: accentDim,
          alpha: alpha(0.5), width: 1
        })
        layers.push({
          k: 'line', x1: CX - 360, y1: CY, x2: CX + 360, y2: CY,
          color: accentDim, alpha: alpha(0.5), width: 1
        })
        layers.push({
          k: 'line', x1: CX, y1: CY - 260, x2: CX, y2: CY + 260,
          color: accentDim, alpha: alpha(0.5), width: 1
        })
        // four corner brackets
        for (var q = 0; q < 4; q++) {
          var bx = CX + ((q & 1) === 0 ? -1 : 1) * 372
          var by = CY + (q < 2 ? -1 : 1) * 236
          layers.push({
            k: 'bar', x: (q & 1) === 0 ? bx : bx - 78, y: by - 3, w: 78, h: 6,
            color: accent, alpha: alpha(0.8)
          })
          layers.push({
            k: 'bar', x: bx - 3, y: q < 2 ? by : by - 62, w: 6, h: 62,
            color: accent, alpha: alpha(0.8)
          })
        }
        // HP-green HUD ticks that visibly count along the lower edge
        for (var g = 0; g < 8; g++) {
          layers.push({
            k: 'bar', x: CX - 280 + g * 80, y: CY + 182, w: 46, h: 8, radius: 4,
            color: GREEN, alpha: alpha(0.2 + 0.55 * ((g / 8 + u) % 1))
          })
        }
      } else if (id === 'link') {
        // The wordmark assembles at centre; a thin ring snaps around it.
        background = BG_DEEP
        vignette = 0.16
        scan = 0.4
        layers.push({ k: 'fill', color: background, alpha: 1 })
        var snap = easeOut(clamp(u / 0.34, 0, 1))
        var ring = lerp(560, 312, snap)
        layers.push({
          k: 'circle', cx: CX, cy: CY, r: ring, color: accent,
          alpha: alpha(0.8), width: 2
        })
        layers.push({
          k: 'circle', cx: CX, cy: CY, r: ring - 16, color: accentDim,
          alpha: alpha(0.45), width: 1
        })
        layers.push({
          k: 'arc', cx: CX, cy: CY, r: 352,
          from: Math.PI * 0.15, to: Math.PI * 0.85,
          color: accentSoft, alpha: alpha(0.5), width: 2
        })
        layers.push({
          k: 'arc', cx: CX, cy: CY, r: 352,
          from: Math.PI * 1.15, to: Math.PI * 1.85,
          color: accentSoft, alpha: alpha(0.4), width: 2
        })
        // the horizontal scan pass sweeping across the assembling wordmark
        layers.push({
          k: 'bar', x: lerp(-0.25, 1.25, easeInOut(u)) * W - 200, y: CY - 84,
          w: 400, h: 168, color: accentDim, alpha: alpha(0.1)
        })
        layers.push({
          k: 'bar', x: 150, y: CY - 2, w: 190, h: 3,
          color: AMBER, alpha: alpha(0.55)
        })
        layers.push({
          k: 'bar', x: W - 340, y: CY - 2, w: 190, h: 3,
          color: AMBER, alpha: alpha(0.55)
        })
      } else if (id === 'surge') {
        // Tunnel accelerates hard; rings collapse inward; bloom rises.
        var su = easeIn(u)
        background = BG_DEEP
        vignette = 0.12
        scan = 0.45
        shake = calm ? 0 : 1 + 2.4 * su
        layers.push({ k: 'fill', color: background, alpha: 1 })
        for (var m = 0; m < 7; m++) {
          var zz = (m / 7 + su * 0.9) % 1
          layers.push({
            k: 'circle', cx: CX, cy: CY, r: lerp(980, 90, zz),
            color: zz > 0.6 ? accent : accentSoft,
            alpha: alpha(0.15 + 0.5 * zz), width: 1 + 2.5 * zz
          })
        }
        // spokes stretched into speed lines
        for (var v = 0; v < 12; v++) {
          var an = spokeAngle[v] + su * 1.4
          var r1 = lerp(120, 300, su)
          var r2 = r1 + lerp(200, 900, su) * spokeGain[v]
          layers.push({
            k: 'line',
            x1: CX + Math.cos(an) * r1, y1: CY + Math.sin(an) * r1,
            x2: CX + Math.cos(an) * r2, y2: CY + Math.sin(an) * r2,
            color: v % 3 === 0 ? WHITE : accentDim,
            alpha: alpha(0.2 + 0.45 * su), width: 1 + 1.6 * su
          })
        }
        layers.push({
          k: 'circle', cx: CX, cy: CY, r: 22 + 90 * su,
          color: WHITE, alpha: alpha(0.18 + 0.3 * su), fill: true
        })
        flash = alpha(0.1 * su)
      } else {
        // RESOLVE: the flash peaks white, then the frame simplifies to the
        // wordmark and its rim light, ready to dissolve.
        var rv = easeOut(u)
        background = rv < 0.42 ? WHITE : BG_DEEP
        vignette = 0.1
        scan = 0.2
        flash = alpha(lerp(0.85, 0, easeIn(u)))
        layers.push({ k: 'fill', color: background, alpha: 1 })
        if (rv > 0.3) {
          layers.push({
            k: 'circle', cx: CX, cy: CY, r: 330 - 20 * rv,
            color: accent, alpha: alpha(0.5 * (1 - rv)), width: 1.5
          })
        }
        layers.push({
          k: 'arc', cx: CX, cy: CY, r: 386,
          from: Math.PI * 0.08, to: Math.PI * 0.92,
          color: accentSoft, alpha: alpha(0.45), width: 2
        })
        layers.push({
          k: 'arc', cx: CX, cy: CY, r: 386,
          from: Math.PI * 1.08, to: Math.PI * 1.92,
          color: accentSoft, alpha: alpha(0.35), width: 2
        })
      }

      // Chromatic aberration (§4.5): the same shape twice, offset in red and blue
      // at low alpha. Gated by `glitch`, suppressed entirely in calm mode, and
      // deliberately a handful of primitives rather than a per-layer effect.
      if (c.glitch && !calm && (id === 'reticle' || id === 'link' || id === 'surge')) {
        var goff = 1 + glitchOff * 3
        var galpha = alpha(0.16 * (1 - easeOut(u) * 0.5))
        var gr = id === 'reticle' ? 300 : 312
        layers.push({ k: 'circle', cx: CX - goff, cy: CY, r: gr, color: GLITCH_R, alpha: galpha, width: 1.5 })
        layers.push({ k: 'circle', cx: CX + goff, cy: CY, r: gr, color: GLITCH_B, alpha: galpha, width: 1.5 })
      }

      // --- wordmark ---------------------------------------------------------
      // `align: 'center'` is not optional here: without it the string is drawn
      // left-aligned FROM x = W/2, which puts the whole wordmark off the right
      // edge of the design space.
      var wm = null
      if (c.wordmark) {
        var wmIn
        if (calm) {
          wmIn = easeOut(clamp(p / 0.18, 0, 1))
        } else if (id === 'link') {
          wmIn = easeOut(clamp(u / 0.3, 0, 1))
        } else if (id === 'surge' || id === 'resolve') {
          wmIn = 1
        } else {
          wmIn = 0
        }
        if (wmIn > 0) {
          var gl = 0
          if (c.glitch && !calm) {
            gl = id === 'surge'
              ? clamp(0.35 * (1 - u), 0, 1)
              : clamp(pulse(p, 0.5, 0.62) * 1.2, 0, 1)
          }
          // Fit the title to the wordmark box. The cell font advances one glyph
          // every `size * 6/7` design px, so a long title shrinks rather than
          // running off both edges of the design space. Floored so a degenerate
          // title can never ask for a zero or negative size.
          var chars = c.title.length
          var wmSize = chars > 0
            ? Math.max(28, Math.min(WORDMARK_MAX_SIZE, (WORDMARK_MAX_WIDTH * 7) / (6 * chars)))
            : WORDMARK_MAX_SIZE
          wm = {
            text: c.title,
            x: CX,
            y: CY + 30,
            size: Math.round(wmSize),
            alpha: alpha(wmIn),
            glitch: calm ? 0 : gl,
            align: 'center'
          }
        }
      }

      // --- telemetry --------------------------------------------------------
      // Deriving every readout from `t` (and from the phase-local progress) is
      // what makes it instrumentation rather than static decoration: it visibly
      // counts as the sequence runs.
      var tel = []
      if (c.telemetry) {
        tel.push({ x: 60, y: 830, text: 'T ' + pad(t, 6), alpha: alpha(0.8) })
        tel.push({ x: 60, y: 858, text: 'SYNC ' + hexByte(u * 255) + '%', alpha: alpha(0.7), size: 13 })
        tel.push({ x: 60, y: 60, text: 'NODE ' + ph.label, alpha: alpha(0.6), size: 18 })
        tel.push({ x: 60, y: 88, text: 'DEPTH ' + pad(p * 1000, 4), alpha: alpha(0.55), size: 13 })
      }

      return {
        t: t,
        duration: duration,
        progress: p,
        done: t >= duration,
        phase: id,
        phaseLabel: ph.label,
        index: ph.index,
        phaseProgress: u,
        background: background,
        flash: alpha(flash),
        vignette: alpha(vignette),
        // `scanlines` is a frame STRENGTH, not primitives (§4.5), and it is
        // exactly zero when the setting is off rather than merely down.
        scanlines: c.scanlines ? alpha(scan) : 0,
        shake: clamp(shake, 0, 64),
        layers: layers,
        wordmark: wm,
        telemetry: tel,
        hint: null
      }
    }

    return { cfg: c, duration: duration, phases: PHASES, seed: seed, frame: frame }
  }

  globalThis.__DSH_LINK_START_SCENE__ = {
    DESIGN: DESIGN,
    PHASES: PHASES,
    DEFAULT_CFG: DEFAULT_CFG,
    normalizeConfig: normalizeConfig,
    totalDuration: totalDuration,
    phaseAt: phaseAt,
    createScene: createScene
  }
})()
