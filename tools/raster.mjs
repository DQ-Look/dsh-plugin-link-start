/**
 * tools/raster.mjs — the dependency-free display-list rasterizer.
 *
 * WHAT THIS IS
 * ------------
 * A faithful, offline re-implementation of `frame(t).layers` for the storyboard
 * PNGs. It exists so a human (and `verify/verify-raster.mjs`) can see exactly what
 * `src/scene.js` produced, with no browser involved.
 *
 * WHAT IT MAY CONSUME (and nothing else)
 * --------------------------------------
 * `frame.layers` (the closed primitive set of INTERFACES.md §4.4) plus the Frame
 * framing fields: `t`, `background`, `flash`, `vignette`, `scanlines`, `shake`,
 * `wordmark`, `telemetry`. It NEVER re-derives geometry: it does not know what a
 * phase is, it does not compute any coordinate, it never calls `scene.*`. The only
 * inputs are the numbers the scene put in the frame.
 *
 * COMPOSITION ORDER (the one place the contract is silent, so it is pinned here)
 * -----------------------------------------------------------------------------
 *   background fill  →  layers (back → front)  →  flash  →  vignette  →  scanlines
 *   →  wordmark  →  telemetry
 * `flash`/`vignette`/`scanlines` are documented as "over the layers", and the
 * wordmark/telemetry are documented as "drawn after layers". `src/boot-screen.js`
 * must use the same order or the storyboard is a lie.
 *
 * TEXT CONVENTION
 * ---------------
 * `text`/`wordmark` `y` is the ALPHABETIC BASELINE (canvas `fillText(text, x, y)`
 * semantics); glyphs are drawn with a 5x7 cell font whose cap height is exactly
 * `size`. `align` is 'left' (default) | 'center' | 'right'. `spacing` is
 * letter-spacing in design units. `weight: 'bold'` thickens by one design unit per
 * stem. One font dot is ONE unit square (`size / 7`), so a glyph is `size` tall and
 * advances by 6 units. `mono` is accepted and validated (§4.4 lists it) but has no
 * separate geometry: this is a fixed 5x7 CELL font, so text is monospaced by
 * construction and there is nothing extra for `mono` to change.
 *
 * FAILURE POLICY
 * --------------
 * Anything undrawable is collected in `report.problems` and, unless
 * `strict: false`, thrown as a `RasterError` whose message lists EVERY problem
 * found (not just the first). Nothing is skipped silently: an unknown `k`, a
 * malformed color, a missing required field, or a non-finite coordinate all fail
 * loudly.
 *
 * NO DEPENDENCIES. Only `node:zlib` for the PNG deflate stream; the encoder, the
 * CRC32 table and the font are all hand-rolled below.
 */

import zlib from 'node:zlib'

/** Design space (INTERFACES.md §3). Only used as the default canvas size. */
export const DESIGN = Object.freeze({ W: 1600, H: 900 })

// ---------------------------------------------------------------------------
// Errors and reporting
// ---------------------------------------------------------------------------

export class RasterError extends Error {
  constructor(problems, report) {
    super(
      `raster: ${problems.length} undrawable item(s):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    )
    this.name = 'RasterError'
    this.problems = problems
    this.report = report
  }
}

function newReport() {
  return {
    /** Every drawable primitive kind and how many times it was drawn. */
    counts: Object.create(null),
    /** Hard failures: undrawable, never silently skipped. */
    problems: [],
    /** Soft notices: drawn approximately, or an ambiguous input resolved by rule. */
    notes: [],
    /** Layers examined at the top level. */
    layers: 0,
  }
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Deterministic [0,1) hash of an integer — used only for `shake`. */
function hash01(n) {
  let h = Math.imul(n | 0, 0x9e3779b1) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * `#rrggbb` only (INTERFACES.md §4.4). Anything else is a hard problem: the
 * rasterizer deliberately carries no CSS color parser.
 */
export function parseColor(value) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) return null
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
  }
}

// ---------------------------------------------------------------------------
// Surface + compositing
// ---------------------------------------------------------------------------

/**
 * @returns {{w:number,h:number,data:Uint8ClampedArray,report:object}}
 */
export function createSurface(w, h, bg = '#000000') {
  const data = new Uint8ClampedArray(w * h * 4)
  const c = parseColor(bg) ?? { r: 0, g: 0, b: 0 }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = c.r
    data[i + 1] = c.g
    data[i + 2] = c.b
    data[i + 3] = 255
  }
  return { w, h, data, report: newReport() }
}

/** Straight-alpha source-over of one channel triple at pixel index `i`. */
function blend(surf, i, r, g, b, a) {
  if (a <= 0) return
  const d = surf.data
  const o = i << 2
  if (a >= 1) {
    d[o] = r
    d[o + 1] = g
    d[o + 2] = b
    d[o + 3] = 255
    return
  }
  const ia = 1 - a
  d[o] = r * a + d[o] * ia
  d[o + 1] = g * a + d[o + 1] * ia
  d[o + 2] = b * a + d[o + 2] * ia
  d[o + 3] = 255
}

/**
 * Iterate the pixel bounding box of a design-space rect, handing the callback
 * the pixel index and the pixel-center coordinates in design space.
 */
function eachPixel(surf, x0, y0, x1, y1, fn) {
  const ix0 = Math.max(0, Math.floor(x0 - 1))
  const iy0 = Math.max(0, Math.floor(y0 - 1))
  const ix1 = Math.min(surf.w - 1, Math.ceil(x1 + 1))
  const iy1 = Math.min(surf.h - 1, Math.ceil(y1 + 1))
  for (let py = iy0; py <= iy1; py++) {
    const cy = py + 0.5
    const row = py * surf.w
    for (let px = ix0; px <= ix1; px++) {
      fn(row + px, px + 0.5, cy)
    }
  }
}

// ---------------------------------------------------------------------------
// 5x7 ASCII font — hand-rolled, no assets
// ---------------------------------------------------------------------------

const G = (s) => s.split('|')

/** 5 columns x 7 rows per glyph. Uppercase-only display font. */
export const FONT = Object.freeze({
  ' ': G('.....|.....|.....|.....|.....|.....|.....'),
  A: G('.###.|#...#|#...#|#####|#...#|#...#|#...#'),
  B: G('####.|#...#|#...#|####.|#...#|#...#|####.'),
  C: G('.###.|#...#|#....|#....|#....|#...#|.###.'),
  D: G('####.|#...#|#...#|#...#|#...#|#...#|####.'),
  E: G('#####|#....|#....|####.|#....|#....|#####'),
  F: G('#####|#....|#....|####.|#....|#....|#....'),
  G: G('.###.|#...#|#....|#.###|#...#|#...#|.###.'),
  H: G('#...#|#...#|#...#|#####|#...#|#...#|#...#'),
  I: G('#####|..#..|..#..|..#..|..#..|..#..|#####'),
  J: G('..###|...#.|...#.|...#.|...#.|#..#.|.##..'),
  K: G('#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#'),
  L: G('#....|#....|#....|#....|#....|#....|#####'),
  M: G('#...#|##.##|#.#.#|#...#|#...#|#...#|#...#'),
  N: G('#...#|##..#|#.#.#|#..##|#...#|#...#|#...#'),
  O: G('.###.|#...#|#...#|#...#|#...#|#...#|.###.'),
  P: G('####.|#...#|#...#|####.|#....|#....|#....'),
  Q: G('.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#'),
  R: G('####.|#...#|#...#|####.|#.#..|#..#.|#...#'),
  S: G('.####|#....|#....|.###.|....#|....#|####.'),
  T: G('#####|..#..|..#..|..#..|..#..|..#..|..#..'),
  U: G('#...#|#...#|#...#|#...#|#...#|#...#|.###.'),
  V: G('#...#|#...#|#...#|#...#|#...#|.#.#.|..#..'),
  W: G('#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#'),
  X: G('#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#'),
  Y: G('#...#|#...#|.#.#.|..#..|..#..|..#..|..#..'),
  Z: G('#####|....#|...#.|..#..|.#...|#....|#####'),
  0: G('.###.|#...#|#..##|#.#.#|##..#|#...#|.###.'),
  1: G('..#..|.##..|..#..|..#..|..#..|..#..|.###.'),
  2: G('.###.|#...#|....#|...#.|..#..|.#...|#####'),
  3: G('####.|....#|....#|.###.|....#|....#|####.'),
  4: G('#..#.|#..#.|#..#.|#####|...#.|...#.|...#.'),
  5: G('#####|#....|####.|....#|....#|#...#|.###.'),
  6: G('.###.|#...#|#....|####.|#...#|#...#|.###.'),
  7: G('#####|....#|...#.|..#..|.#...|.#...|.#...'),
  8: G('.###.|#...#|#...#|.###.|#...#|#...#|.###.'),
  9: G('.###.|#...#|#...#|.####|....#|#...#|.###.'),
  ':': G('.....|..#..|..#..|.....|..#..|..#..|.....'),
  '.': G('.....|.....|.....|.....|.....|.##..|.##..'),
  ',': G('.....|.....|.....|.....|.##..|.##..|.#...'),
  '_': G('.....|.....|.....|.....|.....|.....|#####'),
  '-': G('.....|.....|.....|#####|.....|.....|.....'),
  '/': G('....#|....#|...#.|..#..|.#...|#....|#....'),
  '\\': G('#....|#....|.#...|..#..|...#.|....#|....#'),
  '%': G('##..#|##.#.|..#..|.#...|#.##.|..###|.....'),
  '(': G('..#..|.#...|#....|#....|#....|.#...|..#..'),
  ')': G('..#..|...#.|....#|....#|....#|...#.|..#..'),
  '[': G('.###.|.#...|.#...|.#...|.#...|.#...|.###.'),
  ']': G('.###.|...#.|...#.|...#.|...#.|...#.|.###.'),
  '+': G('.....|..#..|..#..|#####|..#..|..#..|.....'),
  '*': G('.....|#.#.#|.###.|#####|.###.|#.#.#|.....'),
  '#': G('.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.'),
  '!': G('..#..|..#..|..#..|..#..|..#..|.....|..#..'),
  '?': G('.###.|#...#|....#|...#.|..#..|.....|..#..'),
  "'": G('..#..|..#..|.....|.....|.....|.....|.....'),
  '"': G('.#.#.|.#.#.|.....|.....|.....|.....|.....'),
  '<': G('...#.|..#..|.#...|#....|.#...|..#..|...#.'),
  '>': G('.#...|..#..|...#.|....#|...#.|..#..|.#...'),
  '=': G('.....|.....|#####|.....|#####|.....|.....'),
  '&': G('.##..|#..#.|#.#..|.#...|#.#.#|#..#.|.##.#'),
  '@': G('.###.|#...#|#.###|#.#.#|#.###|#....|.###.'),
  ';': G('.....|..#..|..#..|.....|..#..|..#..|.#...'),
  '|': G('..#..|..#..|..#..|..#..|..#..|..#..|..#..'),
  '~': G('.....|.....|.##.#|#..#.|.....|.....|.....'),
  '^': G('..#..|.#.#.|#...#|.....|.....|.....|.....'),
  '$': G('..#..|.####|#.#..|.###.|..#.#|####.|..#..'),
  '`': G('.#...|..#..|.....|.....|.....|.....|.....'),
})

// ---------------------------------------------------------------------------
// Primitive drawing
// ---------------------------------------------------------------------------

/** Read an optional numeric field, reporting a problem when present but bad. */
function optNum(p, key, dflt, rep, idx) {
  const v = p[key]
  if (v === undefined || v === null) return dflt
  if (!isNum(v)) {
    rep.problems.push(`layer[${idx}] k=${p.k}: field "${key}" is ${JSON.stringify(v)}, expected a finite number`)
    return dflt
  }
  return v
}

/** Read a required numeric field, reporting a problem when missing/bad. */
function reqNum(p, key, rep, idx) {
  const v = p[key]
  if (!isNum(v)) {
    rep.problems.push(`layer[${idx}] k=${p.k}: required field "${key}" is ${JSON.stringify(v)}, expected a finite number`)
    return null
  }
  return v
}

function alphaOf(p, rep, idx) {
  const a = p.alpha === undefined || p.alpha === null ? 1 : p.alpha
  if (!isNum(a)) {
    rep.problems.push(`layer[${idx}] k=${p.k}: alpha is ${JSON.stringify(a)}, expected a finite number`)
    return 0
  }
  if (a < 0 || a > 1) {
    // §4.4 documents alpha as 0..1. An out-of-range value is a scene bug that
    // otherwise passes through unnoticed — and a canvas renderer feeding it to
    // `globalAlpha` would have the assignment silently IGNORED, leaving the
    // previous alpha in place. Report it, then clamp so the render still happens.
    rep.problems.push(
      `layer[${idx}] k=${p.k}: alpha ${a} is outside the documented 0..1 range (§4.4); clamped for rendering`,
    )
  }
  return clamp(a, 0, 1)
}

function colorOf(p, rep, idx) {
  const c = parseColor(p.color)
  if (c === null) {
    rep.problems.push(
      `layer[${idx}] k=${p.k}: color ${JSON.stringify(p.color)} is not "#rrggbb" (the rasterizer has no CSS color parser)`,
    )
  }
  return c
}

/**
 * Fill an axis-aligned box [x0,x1] x [y0,y1] with EXACT analytic pixel coverage.
 *
 * `eachPixel` deliberately widens its scan window by a pixel for safety, and
 * `blend` at full alpha would then paint every pixel in that window solid — which
 * for a font dot one `unit` (≈2.9 px at size 20) across inflates each dot by ~2 px
 * in both axes. At small sizes the dots then overlap completely and the glyph
 * dissolves into a slab. Coverage must be computed from the box's real overlap with
 * each pixel, so a dot is exactly `unit` x `unit` regardless of size.
 */
function fillBox(surf, x0, y0, x1, y1, a, c) {
  if (x1 <= x0 || y1 <= y0) return
  const ix0 = Math.max(0, Math.floor(x0))
  const iy0 = Math.max(0, Math.floor(y0))
  const ix1 = Math.min(surf.w - 1, Math.ceil(x1) - 1)
  const iy1 = Math.min(surf.h - 1, Math.ceil(y1) - 1)
  for (let py = iy0; py <= iy1; py++) {
    const covY = Math.max(0, Math.min(y1, py + 1) - Math.max(y0, py))
    if (covY <= 0) continue
    const row = py * surf.w
    for (let px = ix0; px <= ix1; px++) {
      const covX = Math.max(0, Math.min(x1, px + 1) - Math.max(x0, px))
      if (covX <= 0) continue
      const cov = covX * covY
      if (cov > 0) blend(surf, row + px, c.r, c.g, c.b, a * Math.min(cov, 1))
    }
  }
}

function drawRectLike(surf, p, ox, oy, rep, idx, a, c) {
  const x = reqNum(p, 'x', rep, idx)
  const y = reqNum(p, 'y', rep, idx)
  const w = reqNum(p, 'w', rep, idx)
  const h = reqNum(p, 'h', rep, idx)
  if (x === null || y === null || w === null || h === null || c === null) return
  const x0 = x - ox
  const y0 = y - oy
  const x1 = x0 + w
  const y1 = y0 + h
  if (x1 <= x0 || y1 <= y0) {
    if (w < 0 || h < 0) rep.notes.push(`layer[${idx}] k=${p.k}: negative size ${w}x${h} draws nothing`)
    return
  }
  let r = optNum(p, 'radius', 0, rep, idx)
  r = clamp(r, 0, Math.min(x1 - x0, y1 - y0) / 2)
  const ix0 = x0 + r
  const iy0 = y0 + r
  const ix1 = x1 - r
  const iy1 = y1 - r
  eachPixel(surf, x0 - 1, y0 - 1, x1 + 1, y1 + 1, (i, cx, cy) => {
    const qx = cx < ix0 ? ix0 - cx : cx > ix1 ? cx - ix1 : 0
    const qy = cy < iy0 ? iy0 - cy : cy > iy1 ? cy - iy1 : 0
    let cov
    if (qx > 0 || qy > 0) {
      const dOut = Math.sqrt(qx * qx + qy * qy)
      cov = clamp(0.5 + r - dOut, 0, 1)
    } else {
      const dIn = Math.min(cx - x0, x1 - cx, cy - y0, y1 - cy)
      cov = clamp(0.5 + dIn, 0, 1)
    }
    if (cov > 0) blend(surf, i, c.r, c.g, c.b, a * cov)
  })
}

function strokeSegment(surf, x0, y0, x1, y1, hw, fn) {
  const minX = Math.min(x0, x1) - hw
  const maxX = Math.max(x0, x1) + hw
  const minY = Math.min(y0, y1) - hw
  const maxY = Math.max(y0, y1) + hw
  const dx = x1 - x0
  const dy = y1 - y0
  const len2 = dx * dx + dy * dy
  eachPixel(surf, minX, minY, maxX, maxY, (i, cx, cy) => {
    let t = len2 > 0 ? ((cx - x0) * dx + (cy - y0) * dy) / len2 : 0
    t = clamp(t, 0, 1)
    const px = x0 + t * dx
    const py = y0 + t * dy
    const d = Math.sqrt((cx - px) * (cx - px) + (cy - py) * (cy - py))
    const cov = clamp(0.5 + hw - d, 0, 1)
    if (cov > 0) fn(i, cov)
  })
}

function drawLine(surf, p, ox, oy, rep, idx, a, c) {
  const x1 = reqNum(p, 'x1', rep, idx)
  const y1 = reqNum(p, 'y1', rep, idx)
  const x2 = reqNum(p, 'x2', rep, idx)
  const y2 = reqNum(p, 'y2', rep, idx)
  if (x1 === null || y1 === null || x2 === null || y2 === null || c === null) return
  const w = optNum(p, 'width', 1, rep, idx)
  if (!(w > 0)) return
  const hw = w / 2
  strokeSegment(surf, x1 - ox, y1 - oy, x2 - ox, y2 - oy, hw, (i, cov) =>
    blend(surf, i, c.r, c.g, c.b, a * cov),
  )
}

function drawPoly(surf, p, ox, oy, rep, idx, a, c) {
  if (!Array.isArray(p.points) || p.points.length < 2) {
    rep.problems.push(`layer[${idx}] k=poly: "points" must be an array of >= 2 [x,y] pairs`)
    return
  }
  const pts = []
  for (let n = 0; n < p.points.length; n++) {
    const pt = p.points[n]
    if (!Array.isArray(pt) || !isNum(pt[0]) || !isNum(pt[1])) {
      rep.problems.push(`layer[${idx}] k=poly: points[${n}] is ${JSON.stringify(pt)}, expected [finite x, finite y]`)
      return
    }
    pts.push([pt[0] - ox, pt[1] - oy])
  }
  const filled = p.fill === true
  const closed = p.close === true

  if (filled) {
    let minY = Infinity
    let maxY = -Infinity
    let minX = Infinity
    let maxX = -Infinity
    for (const [x, y] of pts) {
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
    }
    const n = pts.length
    const SUB = 2 // 2x2 subsamples per pixel: cheap fill antialiasing
    eachPixel(surf, minX, minY, maxX, maxY, (i, cx, cy) => {
      let hits = 0
      for (let sy = 0; sy < SUB; sy++) {
        const y = cy - 0.25 + sy * 0.5
        let inside = false
        for (let k = 0, j = n - 1; k < n; j = k++) {
          const [xk, yk] = pts[k]
          const [xj, yj] = pts[j]
          if (yk > y !== yj > y && cx < ((xj - xk) * (y - yk)) / (yj - yk) + xk) inside = !inside
        }
        if (inside) hits++
      }
      if (hits === 0) return
      blend(surf, i, c.r, c.g, c.b, a * (hits / SUB))
    })
    return
  }

  const w = optNum(p, 'width', 1, rep, idx)
  if (!(w > 0)) return
  const hw = w / 2
  const last = closed ? pts.length : pts.length - 1
  for (let n = 0; n < last; n++) {
    const [ax, ay] = pts[n]
    const [bx, by] = pts[(n + 1) % pts.length]
    strokeSegment(surf, ax, ay, bx, by, hw, (i, cov) => blend(surf, i, c.r, c.g, c.b, a * cov))
  }
}

function drawCircle(surf, p, ox, oy, rep, idx, a, c) {
  const cx = reqNum(p, 'cx', rep, idx)
  const cy = reqNum(p, 'cy', rep, idx)
  const r = reqNum(p, 'r', rep, idx)
  if (cx === null || cy === null || r === null || c === null) return
  if (r <= 0) return
  const X = cx - ox
  const Y = cy - oy
  const filled = p.fill === true
  const w = optNum(p, 'width', 1, rep, idx)
  const hw = w / 2
  let dash = null
  if (p.dash !== undefined && p.dash !== null) {
    if (!Array.isArray(p.dash) || !isNum(p.dash[0]) || !isNum(p.dash[1]) || p.dash[0] <= 0 || p.dash[1] <= 0) {
      rep.problems.push(`layer[${idx}] k=circle: "dash" must be [on>0, off>0], got ${JSON.stringify(p.dash)}`)
      return
    }
    dash = p.dash
  }
  const rot = optNum(p, 'rot', 0, rep, idx)
  eachPixel(surf, X - r - hw - 1, Y - r - hw - 1, X + r + hw + 1, Y + r + hw + 1, (i, px, py) => {
    const dx = px - X
    const dy = py - Y
    const d = Math.sqrt(dx * dx + dy * dy)
    let cov
    if (filled) cov = clamp(r + 0.5 - d, 0, 1)
    else cov = clamp(0.5 + hw - Math.abs(d - r), 0, 1)
    if (cov <= 0) return
    if (dash !== null) {
      let ang = Math.atan2(dy, dx) - rot
      while (ang < 0) ang += Math.PI * 2
      while (ang >= Math.PI * 2) ang -= Math.PI * 2
      const phase = (ang * r) % (dash[0] + dash[1])
      if (phase > dash[0]) return
    }
    blend(surf, i, c.r, c.g, c.b, a * cov)
  })
}

function drawArc(surf, p, ox, oy, rep, idx, a, c) {
  const cx = reqNum(p, 'cx', rep, idx)
  const cy = reqNum(p, 'cy', rep, idx)
  const r = reqNum(p, 'r', rep, idx)
  const from = reqNum(p, 'from', rep, idx)
  const to = reqNum(p, 'to', rep, idx)
  if (cx === null || cy === null || r === null || from === null || to === null || c === null) return
  if (r <= 0) return
  const w = optNum(p, 'width', 1, rep, idx)
  if (!(w > 0)) return
  const hw = w / 2
  let delta = to - from
  if (delta < 0) {
    delta += Math.PI * 2
    rep.notes.push(`layer[${idx}] k=arc: to < from, swept clockwise (+2pi) per §4.4`)
  }
  if (delta === 0) return
  const X = cx - ox
  const Y = cy - oy
  const angTol = 0.5 / Math.max(r, 1)
  eachPixel(surf, X - r - hw - 1, Y - r - hw - 1, X + r + hw + 1, Y + r + hw + 1, (i, px, py) => {
    const dx = px - X
    const dy = py - Y
    const d = Math.sqrt(dx * dx + dy * dy)
    const radial = clamp(0.5 + hw - Math.abs(d - r), 0, 1)
    if (radial <= 0) return
    let ang = Math.atan2(dy, dx) - from
    while (ang < 0) ang += Math.PI * 2
    while (ang >= Math.PI * 2) ang -= Math.PI * 2
    // Angular window [0, delta] with a soft edge at BOTH ends. Sweeping from
    // `from` to `from + delta`: a pixel inside the sweep is fully covered, and
    // coverage falls to 0 across `angTol` outside either endpoint. Because +y is
    // down, increasing angle reads as clockwise on screen — exactly §4.4.
    let angCov
    if (delta >= Math.PI * 2 - 1e-9) angCov = 1
    else {
      // Signed distance INSIDE the sweep. Positive inside, negative outside;
      // measured to the nearer end.
      const inside = ang <= delta ? Math.min(ang, delta - ang) : -Math.min(ang - delta, Math.PI * 2 - ang)
      angCov = clamp(0.5 + inside / angTol, 0, 1)
    }
    if (angCov <= 0) return
    blend(surf, i, c.r, c.g, c.b, a * radial * angCov)
  })
}

/**
 * Draw a 5x7 font string. `y` is the baseline. Unknown characters (and every
 * lowercase letter) are approximated as filled blocks and REPORTED — never
 * silently dropped. The user-supplied `title` is exempt from the ASCII rule, so
 * approximation is the documented behaviour for it.
 */
export function drawText(surf, spec, ox, oy, rep, idx, label) {
  const text = spec.text
  if (typeof text !== 'string') {
    rep.problems.push(`${label}: "text" is ${JSON.stringify(text)}, expected a string`)
    return
  }
  const x = spec.x
  const y = spec.y
  const size = spec.size
  if (!isNum(x) || !isNum(y) || !isNum(size)) {
    rep.problems.push(`${label}: x/y/size must be finite numbers, got ${JSON.stringify({ x, y, size })}`)
    return
  }
  if (size <= 0) return
  const c = parseColor(spec.color)
  if (c === null) {
    rep.problems.push(`${label}: color ${JSON.stringify(spec.color)} is not "#rrggbb"`)
    return
  }
  const rawAlpha = spec.alpha === undefined || spec.alpha === null ? 1 : spec.alpha
  if (!isNum(rawAlpha)) {
    rep.problems.push(`${label}: alpha is ${JSON.stringify(spec.alpha)}, expected a finite number`)
    return
  }
  const a = clamp(rawAlpha, 0, 1)
  if (a <= 0) return
  const weight = spec.weight === 'bold' ? 'bold' : 'normal'
  if (spec.weight !== undefined && spec.weight !== null && spec.weight !== 'bold' && spec.weight !== 'normal') {
    rep.problems.push(`${label}: weight ${JSON.stringify(spec.weight)} is not 'normal' | 'bold'`)
    return
  }
  const spacing = isNum(spec.spacing) ? spec.spacing : 0
  if (spec.spacing !== undefined && spec.spacing !== null && !isNum(spec.spacing)) {
    rep.problems.push(`${label}: spacing is not a finite number`)
    return
  }
  const align = spec.align === undefined || spec.align === null ? 'left' : spec.align
  if (align !== 'left' && align !== 'center' && align !== 'right') {
    rep.problems.push(`${label}: align ${JSON.stringify(align)} is not 'left' | 'center' | 'right'`)
    return
  }

  const unit = size / 7 // one font pixel — the fixed 5x7 cell grid
  const cell = unit * 5
  // This is a fixed 5x7 CELL font: every glyph occupies exactly 5 columns, so the
  // advance is monospaced by construction and `mono` needs no separate geometry.
  // (`mono` is accepted and validated because §4.4 lists it; see the note below.)
  const gap = unit
  const advance = cell + gap + spacing
  const width = text.length > 0 ? text.length * advance - (gap + spacing) : 0
  let originX = x - ox
  if (align === 'center') originX -= width / 2
  else if (align === 'right') originX -= width
  const baseline = y - oy
  const top = baseline - size

  let approximated = 0
  for (let n = 0; n < text.length; n++) {
    const ch = text[n]
    let glyph = FONT[ch]
    if (glyph === undefined) {
      const up = ch.toUpperCase()
      glyph = FONT[up]
      if (glyph !== undefined) {
        // case-folded into the display font: acceptable, but say so once.
        approximated++
      } else {
        glyph = null
        approximated++
      }
    }
    const gx = originX + n * advance
    if (glyph === null) {
      // Unknown glyph: draw a solid block so the text still reads as text.
      const bx0 = Math.round(gx)
      const by0 = Math.round(top)
      const bx1 = Math.round(gx + cell)
      const by1 = Math.round(baseline)
      for (let py = by0; py < by1; py++) {
        if (py < 0 || py >= surf.h) continue
        for (let px = bx0; px < bx1; px++) {
          if (px < 0 || px >= surf.w) continue
          blend(surf, py * surf.w + px, c.r, c.g, c.b, a * 0.75)
        }
      }
      continue
    }
    for (let row = 0; row < 7; row++) {
      const line = glyph[row]
      for (let col = 0; col < 5; col++) {
        if (line[col] !== '#') continue
        const px0 = gx + col * unit
        const py0 = top + row * unit
        // ONE font dot is ONE unit square. Using `cell` here painted every dot a
        // full cell wide, so adjacent dots merged into solid slabs and the text was
        // illegible (and ~5x too wide, running off the frame).
        const px1 = px0 + unit
        const py1 = py0 + unit
        const wExtra = weight === 'bold' ? unit * 0.34 : 0
        fillBox(surf, px0, py0, px1 + wExtra, py1, a, c)
      }
    }
  }
  if (approximated > 0) {
    rep.notes.push(
      `${label}: ${approximated}/${text.length} char(s) approximated (no glyph in the 5x7 font; blocks/case-fold)`,
    )
  }
}

// ---------------------------------------------------------------------------
// Rasterize a whole frame
// ---------------------------------------------------------------------------

/**
 * @param {object} frame - the object returned by `scene.frame(t)`.
 * @param {{w?:number,h?:number,bg?:string,strict?:boolean}} [opts]
 * @returns {{w:number,h:number,data:Uint8ClampedArray,report:object}}
 */
export function rasterizeFrame(frame, opts = {}) {
  if (frame === null || typeof frame !== 'object') {
    throw new RasterError(['rasterizeFrame: frame is not an object'], newReport())
  }
  const W = opts.w ?? DESIGN.W
  const H = opts.h ?? DESIGN.H
  const rep = newReport()
  const surf = createSurface(W, H, opts.bg ?? frame.background ?? '#000000')

  // `shake` is "design-space px of uniform jitter for the whole frame": a still
  // render has to pick one offset deterministically from t.
  let ox = 0
  let oy = 0
  const shake = frame.shake
  if (shake !== undefined && shake !== null) {
    if (!isNum(shake)) {
      rep.problems.push(`frame.shake is ${JSON.stringify(shake)}, expected a finite number`)
    } else if (shake > 0) {
      const t = isNum(frame.t) ? frame.t : 0
      ox = (hash01(t * 2 + 1) - 0.5) * 2 * shake
      oy = (hash01(t * 2 + 2) - 0.5) * 2 * shake
    }
  }

  const layers = frame.layers
  if (!Array.isArray(layers)) {
    rep.problems.push(`frame.layers is ${JSON.stringify(layers)}, expected an array`)
  } else {
    rep.layers = layers.length
    for (let idx = 0; idx < layers.length; idx++) {
      const p = layers[idx]
      if (p === null || typeof p !== 'object') {
        rep.problems.push(`layer[${idx}] is ${JSON.stringify(p)}, expected a primitive object`)
        continue
      }
      const k = p.k
      const a = alphaOf(p, rep, idx)
      const c = colorOf(p, rep, idx)
      if (k === 'fill') {
        if (c !== null)
          for (let i = 0; i < surf.w * surf.h; i++) blend(surf, i, c.r, c.g, c.b, a)
      } else if (k === 'rect' || k === 'bar') {
        drawRectLike(surf, p, ox, oy, rep, idx, a, c)
      } else if (k === 'line') {
        drawLine(surf, p, ox, oy, rep, idx, a, c)
      } else if (k === 'poly') {
        drawPoly(surf, p, ox, oy, rep, idx, a, c)
      } else if (k === 'circle') {
        drawCircle(surf, p, ox, oy, rep, idx, a, c)
      } else if (k === 'arc') {
        drawArc(surf, p, ox, oy, rep, idx, a, c)
      } else if (k === 'text') {
        drawText(surf, p, ox, oy, rep, idx, `layer[${idx}] k=text`)
      } else {
        rep.problems.push(
          `layer[${idx}]: unknown primitive k=${JSON.stringify(k)} — §4.4 is a closed set; widen the contract before adding a kind`,
        )
        continue
      }
      rep.counts[k] = (rep.counts[k] ?? 0) + 1
    }
  }

  // --- framing effects, in the pinned order --------------------------------
  const flash = frame.flash
  if (flash !== undefined && flash !== null && flash !== 0) {
    if (!isNum(flash)) rep.problems.push(`frame.flash is ${JSON.stringify(flash)}, expected a finite number`)
    else {
      const f = clamp(flash, 0, 1) * 255
      const d = surf.data
      for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i] + f
        d[i + 1] = d[i + 1] + f
        d[i + 2] = d[i + 2] + f
      }
    }
  }
  const vig = frame.vignette
  if (vig !== undefined && vig !== null && vig !== 0) {
    if (!isNum(vig)) rep.problems.push(`frame.vignette is ${JSON.stringify(vig)}, expected a finite number`)
    else {
      const v = clamp(vig, 0, 1)
      const cxp = surf.w / 2
      const cyp = surf.h / 2
      const d = surf.data
      for (let py = 0; py < surf.h; py++) {
        const ny = (py + 0.5 - cyp) / cyp
        for (let px = 0; px < surf.w; px++) {
          const nx = (px + 0.5 - cxp) / cxp
          const dist = Math.sqrt(nx * nx + ny * ny)
          const f = 1 - v * clamp((dist - 0.45) / 0.55, 0, 1)
          const o = (py * surf.w + px) << 2
          d[o] *= f
          d[o + 1] *= f
          d[o + 2] *= f
        }
      }
    }
  }
  const scan = frame.scanlines
  if (scan !== undefined && scan !== null && scan !== 0) {
    if (!isNum(scan)) rep.problems.push(`frame.scanlines is ${JSON.stringify(scan)}, expected a finite number`)
    else {
      const s = clamp(scan, 0, 1) * 0.6
      const f = 1 - s
      const d = surf.data
      for (let py = 1; py < surf.h; py += 2) {
        const base = py * surf.w * 4
        for (let px = 0; px < surf.w * 4; px += 4) {
          d[base + px] *= f
          d[base + px + 1] *= f
          d[base + px + 2] *= f
        }
      }
    }
  }

  // --- wordmark, then telemetry -------------------------------------------
  const wm = frame.wordmark
  if (wm !== undefined && wm !== null) {
    if (typeof wm !== 'object') {
      rep.problems.push(`frame.wordmark is ${JSON.stringify(wm)}, expected null or an object`)
    } else {
      // §4.3 gives `wordmark` no `color` field (only text/x/y/size/alpha/glitch),
      // so the rasterizer owns the default: pure white, as the resolved frame
      // settles to a white wordmark. An explicit `color` still wins if a scene
      // supplies one. Built as a local spec: `frame` is never mutated.
      let wmColor = '#ffffff'
      if (wm.color !== undefined && wm.color !== null) {
        if (parseColor(wm.color) === null) {
          rep.problems.push(`frame.wordmark.color is ${JSON.stringify(wm.color)}, expected "#rrggbb"`)
        } else {
          wmColor = wm.color
        }
      }
      const wmSpec = { ...wm, color: wmColor }
      const glitch = isNum(wm.glitch) ? clamp(wm.glitch, 0, 1) : 0
      if (wm.glitch !== undefined && wm.glitch !== null && !isNum(wm.glitch)) {
        rep.problems.push(`frame.wordmark.glitch is ${JSON.stringify(wm.glitch)}, expected a finite number`)
      }
      const off = glitch > 0 ? 1 + glitch * 3 : 0
      if (off > 0) {
        const tints = [
          ['#ff2a2a', -off],
          ['#2aff6a', off * 0.5],
          ['#2a6aff', off],
        ]
        for (const [tint, dx] of tints) {
          drawText(
            surf,
            { ...wm, x: wm.x + dx, y: wm.y + dx * 0.35, color: tint, alpha: (isNum(wm.alpha) ? wm.alpha : 1) * 0.42 },
            ox,
            oy,
            rep,
            -1,
            'frame.wordmark(glitch tint)',
          )
        }
      }
      drawText(surf, wmSpec, ox, oy, rep, -1, 'frame.wordmark')
      rep.counts.wordmark = (rep.counts.wordmark ?? 0) + 1
    }
  }
  const tel = frame.telemetry
  if (tel !== undefined && tel !== null) {
    if (!Array.isArray(tel)) {
      rep.problems.push(`frame.telemetry is ${JSON.stringify(tel)}, expected an array`)
    } else {
      for (let n = 0; n < tel.length; n++) {
        const e = tel[n]
        if (e === null || typeof e !== 'object') {
          rep.problems.push(`frame.telemetry[${n}] is ${JSON.stringify(e)}, expected an object`)
          continue
        }
        drawText(
          surf,
          { ...e, size: e.size ?? 14, color: e.color ?? '#5ad7ff', align: e.align ?? 'left' },
          ox,
          oy,
          rep,
          n,
          `frame.telemetry[${n}]`,
        )
        rep.counts.telemetry = (rep.counts.telemetry ?? 0) + 1
      }
    }
  }

  surf.report = rep
  if (opts.strict !== false && rep.problems.length > 0) throw new RasterError(rep.problems, rep)
  return surf
}

// ---------------------------------------------------------------------------
// Downsampling + PNG encoding
// ---------------------------------------------------------------------------

/** Integer box-filter downsample. `factor` 2 => 1600x900 becomes 800x450. */
export function downsample(surf, factor) {
  if (!Number.isInteger(factor) || factor < 1) throw new Error(`downsample: factor must be a positive integer, got ${factor}`)
  if (factor === 1) return surf
  const w = Math.floor(surf.w / factor)
  const h = Math.floor(surf.h / factor)
  const out = new Uint8ClampedArray(w * h * 4)
  const n = factor * factor
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < factor; sy++) {
        const row = (y * factor + sy) * surf.w
        for (let sx = 0; sx < factor; sx++) {
          const o = (row + x * factor + sx) << 2
          r += surf.data[o]
          g += surf.data[o + 1]
          b += surf.data[o + 2]
          a += surf.data[o + 3]
        }
      }
      const o = (y * w + x) << 2
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = a / n
    }
  }
  return { w, h, data: out, report: surf.report }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.allocUnsafe(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'latin1')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.allocUnsafe(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Hand-rolled PNG encoder: 8-bit RGBA (colour type 6), filter byte 0 per
 * scanline, one IDAT from `node:zlib` deflate, correct CRC32 on every chunk.
 * @param {{w:number,h:number,data:Uint8ClampedArray}} surf
 * @returns {Buffer}
 */
export function encodePNG(surf) {
  const { w, h, data } = surf
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`encodePNG: bad dimensions ${w}x${h}`)
  }
  if (data.length !== w * h * 4) {
    throw new Error(`encodePNG: data length ${data.length} !== ${w * h * 4}`)
  }
  const stride = w * 4
  const raw = Buffer.allocUnsafe(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    const at = y * (stride + 1)
    raw[at] = 0 // filter type 0 (None)
    const src = y * stride
    for (let i = 0; i < stride; i++) raw[at + 1 + i] = data[src + i]
  }
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * One-call convenience: rasterize at design resolution, box-downsample, encode.
 * @returns {{png:Buffer,report:object,outW:number,outH:number}}
 */
export function renderFramePNG(frame, opts = {}) {
  const surf = rasterizeFrame(frame, opts)
  const outW = opts.outW ?? DESIGN.W
  const factor = Math.max(1, Math.round(surf.w / outW))
  const small = downsample(surf, factor)
  return { png: encodePNG(small), report: surf.report, outW: small.w, outH: small.h }
}
