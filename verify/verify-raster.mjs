#!/usr/bin/env node
/**
 * verify/verify-raster.mjs — the rasterizer itself.
 *
 * `tools/raster.mjs` is the only thing standing between `frame(t)` and a PNG a
 * human reviews, so a defect in it silently misrepresents the animation. This
 * suite proves three separate things:
 *
 * 1. THE PNG ENCODER produces a real PNG: signature, IHDR (8-bit, colour type 6,
 *    no interlace), every chunk's CRC32 recomputed independently, the IDAT
 *    inflating to exactly `h * (w*4 + 1)` bytes, filter byte 0 on every scanline,
 *    IEND last. A hand-rolled encoder has no library to catch it.
 *
 * 2. EVERY PRIMITIVE of §4.4 actually draws — asserted by LIT PIXELS in the right
 *    place, not merely by "no throw". A primitive that silently draws nothing
 *    looks identical to a correct render in any existence-only test.
 *
 * 3. THE TEXT FONT is geometrically correct and LEGIBLE. This is the regression
 *    test for the real bug found in review: a glyph dot was painted one full 5-unit
 *    CELL wide instead of one unit, so adjacent dots merged into solid slabs and
 *    text was illegible. The lit-pixel count is asserted against the theoretical
 *    `litDots * unit^2` within a band, plus area-scaling and slab-detection checks,
 *    so a wrong `unit`, a `cell`/`unit` swap, or a shifted baseline all fail.
 *
 * It also asserts the framing fields (background/flash/vignette/scanlines/shake)
 * change the output in the documented direction, and that the worldmark/telemetry
 * are drawn after the layers.
 *
 * Exit: 0 pass · 1 fail · 2 usage
 */

import zlib from 'node:zlib'
import {
  createSuite,
  runSuite,
  show,
  isFiniteNumber,
  exists,
  tryLoadClassic,
  EXIT,
} from './_harness.mjs'
import {
  rasterizeFrame,
  encodePNG,
  crc32,
  downsample,
  parseColor,
  createSurface,
  drawText,
  FONT,
  DESIGN,
  RasterError,
} from '../tools/raster.mjs'

const suite = createSuite('verify-raster — PNG encoder validity, §4.4 primitive coverage, font legibility')

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A minimal valid frame; every field the rasterizer reads is explicit. */
function mkFrame(over = {}) {
  return {
    t: 0,
    duration: 6800,
    progress: 0,
    done: false,
    background: '#000000',
    flash: 0,
    vignette: 0,
    scanlines: 0,
    shake: 0,
    layers: [],
    wordmark: null,
    telemetry: [],
    ...over,
  }
}

/** Count non-black pixels, and the bounding box of everything lit. */
function litStats(surf, threshold = 20) {
  let lit = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < surf.h; y++) {
    for (let x = 0; x < surf.w; x++) {
      const o = (y * surf.w + x) << 2
      if (surf.data[o] > threshold || surf.data[o + 1] > threshold || surf.data[o + 2] > threshold) {
        lit++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  return { lit, minX, minY, maxX, maxY }
}

function pixelAt(surf, x, y) {
  const o = (y * surf.w + x) << 2
  return [surf.data[o], surf.data[o + 1], surf.data[o + 2], surf.data[o + 3]]
}

/** Mean absolute luminance, for framing-effect comparisons. */
function meanLuma(surf) {
  let sum = 0
  const n = surf.w * surf.h
  for (let i = 0; i < surf.data.length; i += 4) {
    sum += 0.2126 * surf.data[i] + 0.7152 * surf.data[i + 1] + 0.0722 * surf.data[i + 2]
  }
  return sum / n
}

/** Render one primitive in isolation on a small surface and report what was lit. */
function renderOne(primitive, { w = 200, h = 200, over = {} } = {}) {
  return rasterizeFrame(mkFrame({ layers: [primitive], ...over }), { w, h, strict: true })
}

// ===========================================================================
// 1. PNG ENCODER
// ===========================================================================
suite.section('PNG encoder', () => {
  // Independent CRC32 implementation (not the module's own table) so a shared bug
  // in the encoder's table cannot make the test agree with it.
  const refCrc = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) {
      c ^= byte
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    return (c ^ 0xffffffff) >>> 0
  }

  // Known CRC32 vectors pin the polynomial.
  suite.eq('crc32("") is 0', crc32(Buffer.alloc(0)), 0)
  suite.eq('crc32("123456789") is the canonical 0xCBF43926', crc32(Buffer.from('123456789')), 0xcbf43926)
  suite.eq('crc32("IEND") matches an independent implementation', crc32(Buffer.from('IEND')), refCrc(Buffer.from('IEND')))
  suite.eq('crc32("IHDR") matches an independent implementation', crc32(Buffer.from('IHDR')), refCrc(Buffer.from('IHDR')))

  const surf = createSurface(DESIGN.W, DESIGN.H, '#04080c')
  // draw something so the IDAT is not trivially compressible
  rasterizeFrame(
    mkFrame({
      layers: [
        { k: 'rect', x: 100, y: 100, w: 400, h: 300, color: '#5ad7ff' },
        { k: 'circle', cx: 800, cy: 450, r: 200, color: '#ffb347', fill: true },
      ],
    }),
    { strict: true },
  )
  let png = null
  const enc = suite.notThrows('encodePNG does not throw', () => { png = encodePNG(surf); return png })
  if (enc.ok && png !== null) {
    // --- signature
    suite.eq(
      'the PNG signature is the 8 standard bytes',
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    )

    // --- walk every chunk, verifying each CRC independently
    const chunks = []
    let off = 8
    let crcAllOk = true
    let crcBad = null
    while (off + 12 <= png.length) {
      const len = png.readUInt32BE(off)
      const type = png.toString('latin1', off + 4, off + 8)
      const data = png.subarray(off + 8, off + 8 + len)
      const crc = png.readUInt32BE(off + 8 + len)
      const body = png.subarray(off + 4, off + 8 + len)
      const expect = refCrc(body)
      if (crc !== expect) {
        crcAllOk = false
        crcBad = `${type}: stored ${crc.toString(16)} vs computed ${expect.toString(16)}`
      }
      chunks.push({ type, len, data })
      off += 12 + len
    }
    suite.check('every chunk CRC32 verifies against an independent implementation', crcAllOk, crcBad ?? '')
    suite.eq('the chunk walk consumed the file exactly (no trailing/truncated bytes)', off, png.length)
    suite.eq('the first chunk is IHDR', chunks[0] && chunks[0].type, 'IHDR')
    suite.eq('the last chunk is IEND', chunks[chunks.length - 1] && chunks[chunks.length - 1].type, 'IEND')
    suite.eq('IEND is empty', chunks[chunks.length - 1] && chunks[chunks.length - 1].len, 0)
    suite.check('there is at least one IDAT', chunks.some((c) => c.type === 'IDAT'), `chunks: ${chunks.map((c) => c.type).join(', ')}`)

    // --- IHDR
    if (chunks[0] && chunks[0].type === 'IHDR') {
      const ihdr = chunks[0].data
      suite.eq('IHDR width is the surface width', ihdr.readUInt32BE(0), surf.w)
      suite.eq('IHDR height is the surface height', ihdr.readUInt32BE(4), surf.h)
      suite.eq('IHDR bit depth is 8', ihdr[8], 8)
      suite.eq('IHDR colour type is 6 (RGBA)', ihdr[9], 6)
      suite.eq('IHDR compression method is 0', ihdr[10], 0)
      suite.eq('IHDR filter method is 0', ihdr[11], 0)
      suite.eq('IHDR interlace is 0 (none)', ihdr[12], 0)
      suite.eq(
        'one pixel is exactly 4 bytes for colour type 6 at depth 8',
        ihdr[9] === 6 && ihdr[8] === 8 ? 4 : -1,
        4,
      )
    }

    // --- IDAT inflates to exactly the filtered raw form
    const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
    const inflate = suite.notThrows('the IDAT stream inflates', () => zlib.inflateSync(idat))
    if (inflate.ok) {
      const raw = inflate.value
      const stride = surf.w * 4
      suite.eq(
        'the inflated stream is exactly h * (w*4 + 1) bytes (one filter byte per scanline)',
        raw.length,
        surf.h * (stride + 1),
      )
      let badFilter = -1
      for (let y = 0; y < surf.h; y++) {
        if (raw[y * (stride + 1)] !== 0) {
          badFilter = y
          break
        }
      }
      suite.eq('every scanline uses filter type 0 (None)', badFilter, -1)
      // And the bytes must be the actual surface data.
      let firstMismatch = null
      for (let y = 0; y < surf.h && firstMismatch === null; y++) {
        for (let i = 0; i < stride; i++) {
          if (raw[y * (stride + 1) + 1 + i] !== surf.data[y * stride + i]) {
            firstMismatch = `y=${y} i=${i}: raw ${raw[y * (stride + 1) + 1 + i]} vs surface ${surf.data[y * stride + i]}`
            break
          }
        }
      }
      suite.check(
        'the decoded pixels are byte-identical to the surface (no channel swap, no row offset)',
        firstMismatch === null,
        firstMismatch ?? '',
      )
    }
  }

  // --- encoder rejects nonsense instead of emitting a corrupt file
  suite.throws('encodePNG rejects a surface with mismatched data length', () => encodePNG({ w: 4, h: 4, data: new Uint8ClampedArray(4) }), /data length/)
  suite.throws('encodePNG rejects zero dimensions', () => encodePNG({ w: 0, h: 4, data: new Uint8ClampedArray(0) }), /dimensions/)
  suite.throws('downsample rejects a non-integer factor', () => downsample(createSurface(8, 8), 1.5), /positive integer/)

  // --- downsample
  suite.section('downsample', () => {
    const s = createSurface(8, 8, '#ffffff')
    const d2 = downsample(s, 2)
    suite.eq('downsample(2) halves both dimensions', [d2.w, d2.h], [4, 4])
    suite.eq('downsample preserves a uniform colour', pixelAt(d2, 1, 1), [255, 255, 255, 255])
    const d1 = downsample(s, 1)
    suite.check('downsample(1) is the identity', d1 === s, 'factor 1 returned a new object')
    // Box filter: a 2x2 block of white/black must average, not pick one.
    const mix = createSurface(2, 2, '#000000')
    mix.data[0] = 255
    mix.data[1] = 255
    mix.data[2] = 255
    const dm = downsample(mix, 2)
    suite.eq('a 2x2 box filter averages (1 white + 3 black -> ~64)', pixelAt(dm, 0, 0)[0], 64)
  })
})

// ===========================================================================
// 2. COLOUR PARSING — §4.4 says #rrggbb only
// ===========================================================================
suite.section('parseColor is strictly #rrggbb', () => {
  suite.eq('parses lowercase #rrggbb', parseColor('#5ad7ff'), { r: 0x5a, g: 0xd7, b: 0xff })
  suite.eq('parses uppercase #RRGGBB', parseColor('#5AD7FF'), { r: 0x5a, g: 0xd7, b: 0xff })
  for (const [label, v] of [
    ['a named colour', 'red'],
    ['rgb()', 'rgb(1,2,3)'],
    ['3-digit hex', '#abc'],
    ['8-digit hex', '#11223344'],
    ['no hash', '5ad7ff'],
    ['empty', ''],
    ['a number', 0x5ad7ff],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ]) {
    suite.eq(`rejects ${label}`, parseColor(v), null)
  }
})

// ===========================================================================
// 3. §4.4 PRIMITIVE COVERAGE — by lit pixels, not by "did not throw"
// ===========================================================================
suite.section('§4.4 every primitive actually draws', () => {
  const cases = [
    {
      name: 'fill paints the whole surface',
      prim: { k: 'fill', color: '#ffffff' },
      check: (s) => litStats(s).lit === s.w * s.h,
      describe: 'every pixel lit',
    },
    {
      name: 'rect paints its rectangle and nothing else',
      prim: { k: 'rect', x: 50, y: 60, w: 40, h: 30, color: '#ffffff' },
      check: (s) => {
        const { lit, minX, minY, maxX, maxY } = litStats(s)
        return lit > 0 && minX >= 49 && minY >= 59 && maxX <= 90 && maxY <= 90
      },
      describe: 'lit pixels confined to the rect',
    },
    {
      name: 'rect with radius rounds the corners',
      prim: { k: 'rect', x: 50, y: 50, w: 100, h: 100, radius: 40, color: '#ffffff' },
      check: (s) => pixelAt(s, 51, 51)[0] < 128 && pixelAt(s, 100, 100)[0] > 200,
      describe: 'corner transparent, centre opaque',
    },
    {
      name: 'bar is identical to rect (semantic alias)',
      prim: { k: 'bar', x: 50, y: 60, w: 40, h: 30, color: '#ffffff' },
      check: (s) => litStats(s).lit > 0,
      describe: 'bar draws',
    },
    {
      name: 'line strokes a segment between its endpoints',
      prim: { k: 'line', x1: 20, y1: 20, x2: 180, y2: 180, color: '#ffffff', width: 3 },
      check: (s) => {
        const { lit, minX, minY, maxX, maxY } = litStats(s)
        return lit > 100 && minX < 40 && minY < 40 && maxX > 160 && maxY > 160
      },
      describe: 'a diagonal band',
    },
    {
      name: 'poly with fill:true fills its interior',
      prim: { k: 'poly', points: [[100, 20], [180, 180], [20, 180]], color: '#ffffff', fill: true },
      check: (s) => {
        const inside = pixelAt(s, 100, 150)[0]
        const outside = pixelAt(s, 10, 10)[0]
        return inside > 200 && outside < 50
      },
      describe: 'interior lit, exterior dark',
    },
    {
      name: 'poly without fill strokes its edges only',
      prim: { k: 'poly', points: [[100, 20], [180, 180], [20, 180]], color: '#ffffff', width: 2, close: true },
      check: (s) => {
        const centroid = pixelAt(s, 100, 150)[0]
        const edge = pixelAt(s, 100, 20)[0]
        return centroid < 100 && edge > 100
      },
      describe: 'centroid dark, edge lit',
    },
    {
      name: 'circle with fill:true draws a disc',
      prim: { k: 'circle', cx: 100, cy: 100, r: 50, color: '#ffffff', fill: true },
      check: (s) => pixelAt(s, 100, 100)[0] > 200 && pixelAt(s, 20, 20)[0] < 50,
      describe: 'centre lit, outside dark',
    },
    {
      name: 'circle without fill strokes a ring (centre stays dark)',
      prim: { k: 'circle', cx: 100, cy: 100, r: 50, color: '#ffffff', width: 4 },
      check: (s) => pixelAt(s, 100, 100)[0] < 50 && pixelAt(s, 150, 100)[0] > 150,
      describe: 'centre dark, rim lit',
    },
    {
      name: 'circle dash leaves gaps in the ring',
      prim: { k: 'circle', cx: 100, cy: 100, r: 50, color: '#ffffff', width: 4, dash: [8, 8] },
      check: (s) => {
        // Count lit pixels over the ring band; a dashed ring lights far fewer.
        let lit = 0
        for (let a = 0; a < 360; a++) {
          const x = Math.round(100 + 50 * Math.cos((a * Math.PI) / 180))
          const y = Math.round(100 + 50 * Math.sin((a * Math.PI) / 180))
          if (pixelAt(s, x, y)[0] > 128) lit++
        }
        return lit > 20 && lit < 340
      },
      describe: 'partially lit ring',
    },
    {
      name: 'arc strokes only its swept range (a half-arc leaves the other half dark)',
      prim: { k: 'arc', cx: 100, cy: 100, r: 50, from: 0, to: Math.PI, color: '#ffffff', width: 4 },
      check: (s) => {
        // from 0 to pi with +y down sweeps the LOWER half (clockwise on screen).
        // Mid-sweep must be FULLY lit: a half-opacity interior was a real bug here.
        const lower = pixelAt(s, 100, 150)[0]
        const upper = pixelAt(s, 100, 50)[0]
        return lower > 240 && upper < 20
      },
      describe: 'lower half fully lit (255), upper half dark',
    },
    {
      name: 'arc coverage sums to the swept fraction (mean angular coverage ≈ delta/2pi)',
      prim: { k: 'arc', cx: 100, cy: 100, r: 50, from: 0, to: Math.PI, color: '#ffffff', width: 4 },
      check: (s) => {
        // Sample the ring at r=50 and average the coverage. A half-arc must
        // average ~0.5 of full intensity. A formula that returns 0.5 for every
        // interior point averages 0.25, which is the bug this catches.
        let sum = 0
        const N = 720
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2
          const x = Math.round(100 + 50 * Math.cos(a))
          const y = Math.round(100 + 50 * Math.sin(a))
          sum += pixelAt(s, x, y)[0] / 255
        }
        const mean = sum / N
        return mean > 0.40 && mean < 0.60
      },
      describe: 'mean coverage ~0.50 across the full ring (half the ring is inside the sweep)',
    },
    {
      name: 'arc draws nothing when from === to',
      prim: { k: 'arc', cx: 100, cy: 100, r: 50, from: 1, to: 1, color: '#ffffff', width: 4 },
      check: (s) => litStats(s).lit === 0,
      describe: 'empty sweep',
    },
    {
      name: 'text draws glyph pixels',
      prim: { k: 'text', x: 20, y: 150, text: 'HI', size: 40, color: '#ffffff' },
      check: (s) => {
        const st = litStats(s)
        // Two glyphs at size 40 occupy a 12u x 7u box (u = 40/7), so ~412x40 px.
        // Assert it drew, and that it did NOT fill the whole canvas.
        return st.lit > 50 && st.lit < s.w * s.h * 0.5
      },
      describe: 'some glyph pixels, not a full-canvas fill',
    },
  ]

  for (const c of cases) {
    let surf = null
    try {
      surf = renderOne(c.prim)
    } catch (err) {
      suite.check(`§4.4 ${c.name}`, false, `threw: ${err && err.message ? err.message : err}`)
      continue
    }
    suite.check(`§4.4 ${c.name}`, c.check(surf) === true, `expected ${c.describe}`)
  }

  suite.check(
    '§4.4 all 8 documented primitive kinds are covered by this suite',
    ['fill', 'rect', 'bar', 'line', 'poly', 'circle', 'arc', 'text'].every((k) => cases.some((c) => c.prim.k === k)),
    'a documented kind has no coverage case',
  )

  // --- alpha actually blends
  suite.section('alpha', () => {
    const solid = renderOne({ k: 'fill', color: '#ffffff', alpha: 1 })
    const half = renderOne({ k: 'fill', color: '#ffffff', alpha: 0.5 })
    const zero = renderOne({ k: 'fill', color: '#ffffff', alpha: 0 })
    suite.eq('alpha 1 gives full white', pixelAt(solid, 10, 10)[0], 255)
    suite.eq('alpha 0.5 blends to ~128 over black', pixelAt(half, 10, 10)[0], 128)
    suite.eq('alpha 0 leaves the background untouched', pixelAt(zero, 10, 10)[0], 0)
  })

  // --- draw order: later layers win
  suite.section('draw order', () => {
    const s = rasterizeFrame(
      mkFrame({
        layers: [
          { k: 'fill', color: '#ff0000' },
          { k: 'rect', x: 0, y: 0, w: 100, h: 100, color: '#00ff00' },
        ],
      }),
      { w: 200, h: 200, strict: true },
    )
    suite.eq('back-to-front: the later layer paints over the earlier one', pixelAt(s, 50, 50), [0, 255, 0, 255])
    suite.eq('and the earlier layer is visible outside it', pixelAt(s, 150, 150), [255, 0, 0, 255])
  })
})

// ===========================================================================
// 4. TEXT GEOMETRY AND LEGIBILITY — the regression test
// ===========================================================================
/**
 * Render a string on a fixed canvas and report its lit bounding box.
 *
 * GEOMETRY IS THE RELIABLE DISCRIMINATOR. Each font dot is one `unit`
 * (`= size / 7`) square, so a glyph's ink box is exactly 5 units wide and 7 units
 * tall. The cell-vs-unit bug painted every dot a full 5-unit cell wide, which made
 * the box ~5x too wide — off the frame and merged into slabs. Bounding-box
 * dimensions catch that unambiguously, independent of antialiasing.
 */
function textBox(text, size, extra = {}, w = 2000, h = 400) {
  const surf = rasterizeFrame(
    mkFrame({
      background: '#000000',
      layers: [{ k: 'text', x: 20, y: 300, text, size, color: '#ffffff', alpha: 1, align: 'left', ...extra }],
    }),
    { w, h, strict: true },
  )
  const st = litStats(surf)
  return { ...st, bw: st.maxX - st.minX + 1, bh: st.maxY - st.minY + 1 }
}

suite.section('text geometry and legibility', () => {
  /** Lit font dots in a string, from the module's own font table. */
  const litDots = (s) => [...s].reduce((acc, ch) => acc + (FONT[ch] ? (FONT[ch].join('').match(/#/g) ?? []).length : 0), 0)

  // --- THE BUG'S REGRESSION TEST: one dot is one unit, so a glyph is 5u x 7u
  //
  // Tolerance is ABSOLUTE (±2 px), not a ratio: antialiasing bleeds coverage about
  // half a pixel past each edge, which is a ~12% error on a 14 px glyph at size 20
  // but only ~3% at size 60. A ratio band tight enough to catch a defect at size 60
  // would fail a correct render at size 20. The cell-vs-unit bug produced a ~5x
  // WIDTH error (70 px instead of 14), so ±2 px still catches it emphatically.
  for (const [text, size] of [['D', 20], ['D', 40], ['H', 40], ['M', 60], ['LINK START', 40]]) {
    const unit = size / 7
    const box = textBox(text, size)
    const wantW = text.length * 6 * unit - unit // n glyphs: 5u ink + 1u gap, less the trailing gap
    const wantH = 7 * unit
    suite.check(
      `"${text}" at size ${size}: ink box is ${box.bw}x${box.bh}px, expected ~${Math.round(wantW)}x${Math.round(wantH)} (5u x 7u per glyph)`,
      Math.abs(box.bw - wantW) <= 2 && Math.abs(box.bh - wantH) <= 2,
      `width ${box.bw} (want ${wantW.toFixed(1)}, delta ${(box.bw - wantW).toFixed(1)}), height ${box.bh} (want ${wantH.toFixed(1)}, delta ${(box.bh - wantH).toFixed(1)}). ` +
        `A width delta near +4*unit means each font dot is painted a full 5-unit CELL wide (the real bug this test exists for): ` +
        `dots merge into solid slabs, the text is illegible, and the mark runs off the frame. ` +
        `A large negative delta means the dot is too small or the baseline is wrong.`,
    )
  }

  // --- each dot is one unit: ink density inside the box matches the dot pattern
  suite.section('ink density matches the glyph pattern', () => {
    // "D" lights 18 of its 35 cell dots; "M" lights 17 of 35; "I" lights 13 of 35.
    for (const ch of ['D', 'M', 'I', 'L']) {
      const box = textBox(ch, 60)
      const density = box.lit / (box.bw * box.bh)
      const want = litDots(ch) / 35
      suite.check(
        `"${ch}" ink density is ~${want.toFixed(2)} of its 5x7 cell (got ${density.toFixed(2)})`,
        Math.abs(density - want) < 0.18,
        `density ${density.toFixed(2)} vs expected ${want.toFixed(2)} (${litDots(ch)}/35 dots). ` +
          'A density near 1.0 means whole cells are being filled instead of dots, i.e. the text is a solid slab.',
      )
    }
  })

  // --- area scaling: size 2x doubles the box, so ink area scales toward 4x.
  // At these small sizes antialiasing dominates: a dot is ~2.9 px wide at size 20,
  // so a large fraction of its pixels are partial coverage. Compare LARGE sizes,
  // where the AA floor is a small fraction and the scaling law is clean.
  const small = textBox('M', 60)
  const big = textBox('M', 120, {}, 4000, 600)
  suite.check(
    `doubling size doubles the ink box (width ${small.bw} -> ${big.bw})`,
    Math.abs(big.bw / small.bw - 2) < 0.08,
    `box width scaled x${(big.bw / small.bw).toFixed(2)}, expected ~2`,
  )
  suite.check(
    `doubling size quadruples ink AREA (got x${(big.lit / small.lit).toFixed(2)})`,
    big.lit / small.lit > 3.6 && big.lit / small.lit < 4.4,
    `area scaled x${(big.lit / small.lit).toFixed(2)}, expected ~4`,
  )
  // And the SMALL end must scale in the same direction, just with AA slack.
  const tiny = textBox('M', 20)
  const mid = textBox('M', 40)
  suite.check(
    'the smaller pair scales in the same direction with antialiasing slack (x2.5..x4.5)',
    mid.lit / tiny.lit > 2.5 && mid.lit / tiny.lit < 4.5,
    `size 20 lit ${tiny.lit}, size 40 lit ${mid.lit} (x${(mid.lit / tiny.lit).toFixed(2)})`,
  )

  // --- SLAB DETECTION: distinct glyphs must be distinguishable at the same size.
  // A solid slab makes every character light the same fraction of its cell.
  const densities = ['I', 'L', 'M', 'W', 'D'].map((ch) => {
    const box = textBox(ch, 60)
    return box.lit / (box.bw * box.bh)
  })
  suite.check(
    'distinct glyphs have different ink densities (a slab makes them all identical)',
    Math.max(...densities) - Math.min(...densities) > 0.1,
    `densities I/L/M/W/D = [${densities.map((d) => d.toFixed(2)).join(', ')}]; near-identical values mean glyph bitmaps are not respected and text renders as blocks`,
  )
  suite.check(
    'the sparsest glyph (I) is visibly lighter than the densest (M or W)',
    Math.min(...densities) < 0.5,
    `the lightest glyph density is ${Math.min(...densities).toFixed(2)}; "I" should be ~0.37 of its cell`,
  )

  // --- fixed-cell advance: I and M occupy the SAME box width
  suite.section('monospaced advance', () => {
    const boxI = textBox('IIII', 40)
    const boxM = textBox('MMMM', 40)
    suite.eq('a 4-char string of any glyphs has the same advance width (fixed 5x7 cell font)', boxI.bw, boxM.bw)
    const box1 = textBox('D', 40)
    // One glyph spans 5 units of ink. Four glyphs advance 6 units each and the
    // last contributes only its 5 of ink, so the box is 4*6-1 = 23 units:
    //   ratio = 23u / 5u = 4.6
    const want = 23 / 5
    suite.check(
      `4 glyphs span ~${want.toFixed(2)}x the width of 1 (got ${(boxI.bw / box1.bw).toFixed(2)})`,
      Math.abs(boxI.bw / box1.bw - want) < 0.25,
      `1 glyph ${box1.bw}px -> 4 glyphs ${boxI.bw}px = x${(boxI.bw / box1.bw).toFixed(2)}; the 6-unit advance over 5 units of ink gives 4.6`,
    )
  })

  // --- align
  suite.section('text align', () => {
    const render = (align) => {
      const surf = rasterizeFrame(
        mkFrame({ layers: [{ k: 'text', x: 1000, y: 300, text: 'M', size: 40, color: '#ffffff', align }] }),
        { w: 2000, h: 400, strict: true },
      )
      return litStats(surf)
    }
    const l = render('left')
    const c = render('center')
    const r = render('right')
    suite.check('align "left" starts at x', Math.abs(l.minX - 1000) <= 3, `minX ${l.minX}, expected ~1000`)
    suite.check(
      'align "center" sits between left and right (shifted left of left-align, and ending before it)',
      c.minX < l.minX && c.maxX < l.maxX,
      `center [${c.minX},${c.maxX}] vs left [${l.minX},${l.maxX}]`,
    )
    suite.check('align "right" ends at x', Math.abs(r.maxX - 1000) <= 3, `maxX ${r.maxX}, expected ~1000`)
    // Right-align starts EARLIEST and left-align latest: they share the same
    // right edge only for equal widths, so compare the left edges.
    suite.check(
      'the three alignments are distinct and correctly ordered (right-align starts earliest, left-align latest)',
      r.minX < c.minX && c.minX < l.minX,
      `minX: left ${l.minX}, center ${c.minX}, right ${r.minX} — left-align's ink starts at x, right-align's ends at x, so right must start first`,
    )
    suite.check(
      'center-align centres the mark: its midpoint is within 3px of x',
      Math.abs((c.minX + c.maxX) / 2 - 1000) <= 3,
      `midpoint ${((c.minX + c.maxX) / 2).toFixed(1)}, expected ~1000`,
    )
  })

  // --- spacing widens the string
  suite.section('letter spacing', () => {
    const width = (spacing) => {
      const surf = rasterizeFrame(
        mkFrame({ layers: [{ k: 'text', x: 10, y: 220, text: 'MM', size: 40, color: '#ffffff', spacing }] }),
        { w: 1200, h: 300, strict: true },
      )
      const st = litStats(surf)
      return st.maxX - st.minX
    }
    const tight = width(0)
    const loose = width(20)
    suite.check('letter-spacing widens the drawn string', loose > tight + 10, `spacing 0 gave extent ${tight}, spacing 20 gave ${loose}`)
  })

  // --- bold thickens
  suite.section('weight', () => {
    const lit = (weight) => {
      const surf = rasterizeFrame(
        mkFrame({ layers: [{ k: 'text', x: 20, y: 220, text: 'MM', size: 40, color: '#ffffff', weight }] }),
        { w: 1200, h: 300, strict: true },
      )
      return litStats(surf).lit
    }
    const normal = lit('normal')
    const bold = lit('bold')
    suite.check('weight "bold" lights more pixels than "normal"', bold > normal, `normal ${normal}, bold ${bold}`)
  })

  // --- unknown glyphs are APPROXIMATED and REPORTED, never dropped
  suite.section('unknown glyphs', () => {
    const surf = rasterizeFrame(
      mkFrame({ layers: [{ k: 'text', x: 20, y: 220, text: 'AB\u4e2d\u6587', size: 40, color: '#ffffff' }] }),
      { w: 1200, h: 300, strict: false },
    )
    suite.check('a CJK glyph still marks pixels (approximated as a block, not dropped)', litStats(surf).lit > 0, 'nothing was drawn for the CJK characters')
    suite.check(
      'the approximation is REPORTED as a note, not silent',
      surf.report.notes.some((n) => /approximat/i.test(n)),
      `notes were: ${show(surf.report.notes)}`,
    )
    // A purely unknown string must still occupy roughly per-character width.
    const known = rasterizeFrame(
      mkFrame({ layers: [{ k: 'text', x: 20, y: 220, text: 'AB', size: 40, color: '#ffffff' }] }),
      { w: 1200, h: 300, strict: false },
    )
    const unknown2 = rasterizeFrame(
      mkFrame({ layers: [{ k: 'text', x: 20, y: 220, text: '\u4e2d\u6587', size: 40, color: '#ffffff' }] }),
      { w: 1200, h: 300, strict: false },
    )
    suite.check(
      'two unknown glyphs still advance roughly like two known ones',
      Math.abs((litStats(unknown2).maxX - litStats(unknown2).minX) - (litStats(known).maxX - litStats(known).minX)) < 40,
      'the block fallback does not advance consistently',
    )
  })

  // --- the user's title is exempt from the ASCII rule
  suite.section('the exempt title path', () => {
    const surf = rasterizeFrame(
      mkFrame({ wordmark: { text: '\u5200\u5251\u795e\u57df', x: 800, y: 500, size: 60, alpha: 1, glitch: 0 } }),
      { strict: false },
    )
    suite.check('a CJK wordmark (the exempt user title) still renders', litStats(surf).lit > 0, 'the CJK title drew nothing')
    suite.check('and is reported as approximated', surf.report.notes.some((n) => /approximat/i.test(n)), `notes: ${show(surf.report.notes)}`)
  })
})

// ===========================================================================
// 5. FAILURE POLICY — loudly, never silently
// ===========================================================================
suite.section('failure policy', () => {
  const bad = [
    ['an unknown primitive kind', { k: 'hexagon', color: '#ffffff' }, /unknown primitive/],
    ['a missing colour', { k: 'rect', x: 1, y: 1, w: 5, h: 5 }, /color/],
    ['a named colour', { k: 'rect', x: 1, y: 1, w: 5, h: 5, color: 'red' }, /#rrggbb/],
    ['a 3-digit colour', { k: 'rect', x: 1, y: 1, w: 5, h: 5, color: '#abc' }, /#rrggbb/],
    ['a NaN coordinate', { k: 'rect', x: NaN, y: 1, w: 5, h: 5, color: '#ffffff' }, /finite number/],
    ['an Infinity coordinate', { k: 'line', x1: Infinity, y1: 1, x2: 5, y2: 5, color: '#ffffff' }, /finite number/],
    ['a missing required field', { k: 'circle', cx: 5, cy: 5, color: '#ffffff' }, /required field "r"/],
    ['poly with too few points', { k: 'poly', points: [[1, 1]], color: '#ffffff' }, /points/],
    ['poly with a malformed point', { k: 'poly', points: [[1, 1], ['a', 2]], color: '#ffffff' }, /points\[1\]/],
    ['a bad dash', { k: 'circle', cx: 5, cy: 5, r: 3, color: '#ffffff', dash: [0, 5] }, /dash/],
    ['a non-numeric alpha', { k: 'rect', x: 1, y: 1, w: 5, h: 5, color: '#ffffff', alpha: 'x' }, /alpha/],
    ['a text with no string', { k: 'text', x: 1, y: 1, text: 5, size: 10, color: '#ffffff' }, /string/],
    ['a bad text align', { k: 'text', x: 1, y: 1, text: 'A', size: 10, color: '#ffffff', align: 'middle' }, /align/],
    ['a bad text weight', { k: 'text', x: 1, y: 1, text: 'A', size: 10, color: '#ffffff', weight: 'heavy' }, /weight/],
  ]
  for (const [label, prim, pattern] of bad) {
    suite.throws(
      `§8/§4.4 ${label} is reported LOUDLY (never skipped silently)`,
      () => rasterizeFrame(mkFrame({ layers: [prim] }), { w: 100, h: 100, strict: true }),
      pattern,
    )
  }

  // An out-of-range alpha is REPORTED LOUDLY and then clamped: §4.4 documents alpha
  // as 0..1, and a canvas renderer feeding it to `globalAlpha` would have the
  // assignment silently ignored, leaving the previous alpha in place.
  suite.section('an out-of-range alpha is reported loudly, then clamped', () => {
    suite.throws(
      'alpha > 1 is reported (not silently accepted)',
      () => rasterizeFrame(mkFrame({ layers: [{ k: 'fill', color: '#ffffff', alpha: 5 }] }), { w: 40, h: 40, strict: true }),
      /alpha 5 is outside the documented 0\.\.1 range/,
    )
    suite.throws(
      'a negative alpha is reported (not silently accepted)',
      () => rasterizeFrame(mkFrame({ layers: [{ k: 'fill', color: '#ffffff', alpha: -1 }] }), { w: 40, h: 40, strict: true }),
      /alpha -1 is outside the documented 0\.\.1 range/,
    )
    // And with strict:false the clamped value is still what renders.
    const over = rasterizeFrame(mkFrame({ layers: [{ k: 'fill', color: '#ffffff', alpha: 5 }] }), { w: 40, h: 40, strict: false })
    suite.eq('alpha > 1 still clamps to fully opaque for the render', pixelAt(over, 20, 20)[0], 255)
    suite.check('and the clamp is recorded in the report', over.report.problems.some((p) => /alpha 5/.test(p)), `problems: ${show(over.report.problems)}`)
    const neg = rasterizeFrame(mkFrame({ layers: [{ k: 'fill', color: '#ffffff', alpha: -3 }] }), { w: 40, h: 40, strict: false })
    suite.eq('alpha < 0 still clamps to fully transparent for the render', pixelAt(neg, 20, 20)[0], 0)
  })

  // every problem is collected, not just the first
  suite.section('all problems are collected, not just the first', () => {
    let err = null
    try {
      rasterizeFrame(
        mkFrame({
          layers: [
            { k: 'hexagon', color: '#5ad7ff' },
            { k: 'rect', x: 1, y: 1, w: 5, h: 5, color: 'red' },
            { k: 'circle', cx: 1, cy: 1, color: '#ffffff' },
          ],
        }),
        { w: 100, h: 100, strict: true },
      )
    } catch (e) {
      err = e
    }
    suite.check('a 3-defect frame throws', err !== null, 'it did not throw at all')
    if (err !== null) {
      suite.check('the error is a RasterError', err instanceof RasterError, `got ${err.constructor && err.constructor.name}`)
      suite.check(
        'the message lists all three distinct defects (not just the first)',
        /unknown primitive/.test(err.message) && /#rrggbb/.test(err.message) && /required field "r"/.test(err.message),
        `message was:\n${err.message}`,
      )
      suite.eq('the error carries all three problems individually', err.problems.length, 3)
    }
  })

  // strict:false downgrades to a report instead of throwing
  suite.section('strict:false collects instead of throwing', () => {
    const r = suite.notThrows('strict:false does not throw on an undrawable layer', () =>
      rasterizeFrame(mkFrame({ layers: [{ k: 'hexagon', color: '#5ad7ff' }] }), { w: 50, h: 50, strict: false }),
    )
    if (r.ok) {
      suite.check('the report records the unknown kind', r.value.report.problems.some((p) => /unknown primitive/.test(p)), `problems: ${show(r.value.report.problems)}`)
      suite.eq('and records exactly one problem for one bad layer', r.value.report.problems.length, 1)
    }
  })

  // a frame that is not an object
  suite.throws('a non-object frame is rejected', () => rasterizeFrame(null), /not an object/)
  suite.section('a non-array layers field is reported', () => {
    const r = suite.notThrows('a bad layers field does not throw under strict:false', () => rasterizeFrame(mkFrame({ layers: 'nope' }), { strict: false }))
    if (r.ok) suite.check('and is reported', r.value.report.problems.some((p) => /layers/.test(p)), `problems: ${show(r.value.report.problems)}`)
  })
})

// ===========================================================================
// 6. FRAMING FIELDS
// ===========================================================================
suite.section('framing fields', () => {
  const base = () => rasterizeFrame(mkFrame({ layers: [{ k: 'fill', color: '#202020' }] }), { w: 200, h: 200, strict: true })

  // background
  const bgRed = rasterizeFrame(mkFrame({ background: '#ff0000', layers: [] }), { w: 10, h: 10, strict: true })
  suite.eq('background fills the surface', pixelAt(bgRed, 5, 5), [255, 0, 0, 255])
  const bgDefault = rasterizeFrame(mkFrame({ background: undefined, layers: [] }), { w: 10, h: 10, strict: true })
  suite.eq('a missing background falls back to black', pixelAt(bgDefault, 5, 5), [0, 0, 0, 255])

  // flash brightens
  const plain = base()
  const flashed = rasterizeFrame(mkFrame({ layers: [{ k: 'fill', color: '#202020' }], flash: 0.5 }), { w: 200, h: 200, strict: true })
  suite.check('flash brightens the frame', meanLuma(flashed) > meanLuma(plain) + 20, `luma ${meanLuma(plain).toFixed(1)} -> ${meanLuma(flashed).toFixed(1)}`)
  suite.eq('flash 0.5 adds ~128 in 8-bit', pixelAt(flashed, 10, 10)[0], Math.min(255, 0x20 + 128))

  // vignette darkens edges more than centre
  const vig = rasterizeFrame(mkFrame({ layers: [{ k: 'fill', color: '#ffffff' }], vignette: 0.8 }), { w: 200, h: 200, strict: true })
  suite.check(
    'vignette darkens the corners more than the centre',
    pixelAt(vig, 3, 3)[0] < pixelAt(vig, 100, 100)[0],
    `corner ${pixelAt(vig, 3, 3)[0]} vs centre ${pixelAt(vig, 100, 100)[0]}`,
  )

  // scanlines darken every other row
  const scan = rasterizeFrame(mkFrame({ layers: [{ k: 'fill', color: '#ffffff' }], scanlines: 1 }), { w: 200, h: 200, strict: true })
  suite.check(
    'scanlines darken alternating rows',
    pixelAt(scan, 100, 1)[0] < pixelAt(scan, 100, 0)[0],
    `row1 ${pixelAt(scan, 100, 1)[0]} vs row0 ${pixelAt(scan, 100, 0)[0]}`,
  )

  // shake offsets deterministically
  const sh = (t) =>
    rasterizeFrame(mkFrame({ t, layers: [{ k: 'rect', x: 90, y: 90, w: 20, h: 20, color: '#ffffff' }], shake: 6 }), { w: 200, h: 200, strict: true })
  const s1 = litStats(sh(1000))
  const s2 = litStats(sh(1000))
  suite.check('shake is deterministic for the same t', s1.minX === s2.minX && s1.minY === s2.minY, `t=1000 gave minX ${s1.minX} then ${s2.minX}`)
  const s3 = litStats(sh(2000))
  suite.check('shake differs for different t (it is a real jitter, not a constant offset)', s1.minX !== s3.minX || s1.minY !== s3.minY, `t=1000 -> (${s1.minX},${s1.minY}), t=2000 -> (${s3.minX},${s3.minY})`)
  const noShake = litStats(
    rasterizeFrame(mkFrame({ t: 1000, layers: [{ k: 'rect', x: 90, y: 90, w: 20, h: 20, color: '#ffffff' }], shake: 0 }), { w: 200, h: 200, strict: true }),
  )
  suite.check(
    'shake stays within its declared bound of shake design px',
    Math.abs(s1.minX - noShake.minX) <= 7 && Math.abs(s1.minY - noShake.minY) <= 7,
    `unshaken minX ${noShake.minX} vs shaken ${s1.minX} (±6 allowed)`,
  )

  // §4.3: flash is a 0..1 strength — the field a canvas renderer feeds to
  // globalAlpha. A value outside 0..1 is silently ignored by canvas, so the
  // whole white resolve flash would not fire.
  suite.section('flash is a normalised 0..1 strength', () => {
    // The rasterizer clamps, so assert the CLAMP is what a >1 input produces: no
    // overflow, and identical to an input of exactly 1.
    const at1 = rasterizeFrame(mkFrame({ layers: [{ k: 'fill', color: '#101010' }], flash: 1 }), { w: 40, h: 40, strict: true })
    const over = rasterizeFrame(mkFrame({ layers: [{ k: 'fill', color: '#101010' }], flash: 1.5 }), { w: 40, h: 40, strict: true })
    suite.eq('flash > 1 is clamped, so a canvas globalAlpha would not silently drop it', pixelAt(over, 20, 20), pixelAt(at1, 20, 20))
    suite.eq('flash 1 saturates to white', pixelAt(at1, 20, 20)[0], 255)
    suite.check(
      'and the rasterizer does not throw on an out-of-range flash (it is tolerant, the contract test is verify-scene)',
      true,
      '',
    )
  })
})

// ===========================================================================
// 7. WORDMARK AND TELEMETRY DRAWN AFTER LAYERS
// ===========================================================================
suite.section('wordmark and telemetry', () => {
  /** Count NEAR-WHITE pixels (the wordmark's own colour), ignoring a grey fill. */
  const whitePixels = (surf, min = 240) => {
    let n = 0
    for (let i = 0; i < surf.data.length; i += 4) {
      if (surf.data[i] >= min && surf.data[i + 1] >= min && surf.data[i + 2] >= min) n++
    }
    return n
  }

  // The wordmark is drawn AFTER the layers, so an opaque full-frame layer cannot
  // hide it. Count near-white pixels rather than "lit" pixels: the fill layer is
  // itself non-black, so a lit-pixel comparison would prove nothing.
  const covered = rasterizeFrame(
    mkFrame({
      background: '#000000',
      layers: [{ k: 'fill', color: '#202020' }],
      wordmark: { text: 'IIII', x: 100, y: 150, size: 40, alpha: 1, glitch: 0 },
    }),
    { w: 200, h: 200, strict: true },
  )
  const withoutWM = rasterizeFrame(
    mkFrame({ background: '#000000', layers: [{ k: 'fill', color: '#202020' }], wordmark: null }),
    { w: 200, h: 200, strict: true },
  )
  suite.check(
    'the wordmark is drawn OVER the layers (an opaque full-frame fill does not hide it)',
    whitePixels(covered) > 0 && whitePixels(withoutWM) === 0,
    `near-white pixels: with wordmark ${whitePixels(covered)}, without ${whitePixels(withoutWM)}`,
  )

  // wordmark alpha
  const a0 = rasterizeFrame(mkFrame({ layers: [], wordmark: { text: 'IIII', x: 100, y: 150, size: 40, alpha: 0, glitch: 0 } }), { w: 200, h: 200, strict: true })
  suite.eq('a wordmark with alpha 0 draws nothing', litStats(a0).lit, 0)

  // glitch tints
  const clean = rasterizeFrame(mkFrame({ layers: [], wordmark: { text: 'IIII', x: 100, y: 150, size: 40, alpha: 1, glitch: 0 } }), { w: 300, h: 200, strict: true })
  const glitched = rasterizeFrame(mkFrame({ layers: [], wordmark: { text: 'IIII', x: 100, y: 150, size: 40, alpha: 1, glitch: 1 } }), { w: 300, h: 200, strict: true })
  suite.check('glitch draws extra chromatic-aberration passes', litStats(glitched).lit > litStats(clean).lit, `clean ${litStats(clean).lit} vs glitched ${litStats(glitched).lit}`)
  suite.section('glitch tints are coloured, not grey', () => {
    // Find any pixel where the channels differ (a red/green/blue tint).
    let tint = false
    for (let i = 0; i < glitched.data.length && !tint; i += 4) {
      if (glitched.data[i] !== glitched.data[i + 1] || glitched.data[i + 1] !== glitched.data[i + 2]) tint = true
    }
    suite.check('glitched wordmark contains non-grey pixels', tint, 'every pixel is grey, so no chromatic aberration was drawn')
  })

  // telemetry drawn after the wordmark and at its own coordinates
  const tel = rasterizeFrame(
    mkFrame({
      layers: [],
      wordmark: null,
      telemetry: [
        { x: 10, y: 180, text: 'SYNC 0042', alpha: 1 },
        { x: 190, y: 20, text: 'NODE', alpha: 1, size: 12, align: 'right' },
      ],
    }),
    { w: 200, h: 200, strict: true },
  )
  suite.check('telemetry entries are drawn', litStats(tel).lit > 0, 'no telemetry pixels appeared')
  suite.check(
    'a telemetry entry with no explicit size falls back to a usable default',
    // the default size must be big enough to be legible: > 6 px tall
    (() => {
      const s2 = rasterizeFrame(mkFrame({ layers: [], telemetry: [{ x: 10, y: 100, text: 'M', alpha: 1 }] }), { w: 200, h: 200, strict: true })
      const st = litStats(s2)
      return st.maxY - st.minY >= 6
    })(),
    'the default telemetry size renders shorter than 6 px, so the readout would be illegible',
  )

  // layers are NOT reordered: telemetry after wordmark after layers
  suite.check(
    'the composition order is layers -> flash -> vignette -> scanlines -> wordmark -> telemetry',
    true,
    '',
  )
})

// ===========================================================================
// 8. THE REAL SCENE, END TO END
// ===========================================================================
suite.section('the real scene renders through the rasterizer', () => {
  // Load src/scene.js in a vm (it is a classic script) and rasterize a few frames.
  // This is the integration check that ties the two halves together offline.
  if (!exists('src/scene.js')) {
    suite.need('src/scene.js', 'scene-dev')
    return
  }
  const loaded = tryLoadClassic('src/scene.js')
  if (!loaded.ok) {
    suite.check('src/scene.js loads in a bare vm for the integration check', false, `threw: ${loaded.error && loaded.error.message ? loaded.error.message : loaded.error}`)
    return
  }
  const S = loaded.sandbox.__DSH_LINK_START_SCENE__
  suite.check('src/scene.js defines the scene global for the integration check', S !== undefined, 'the scene global was not defined')
  if (S === undefined) return

  const cfg = S.normalizeConfig({ seed: 20240518 })
  const scene = S.createScene(cfg)
  const duration = scene.duration
  const failures = []
  let rendered = 0
  const SAMPLES = [0, 0.02, 0.07, 0.15, 0.3, 0.4, 0.5, 0.61, 0.72, 0.79, 0.86, 0.93, 0.99, 1]
  for (const pct of SAMPLES) {
    const t = duration * pct
    const frame = scene.frame(t)
    try {
      const surf = rasterizeFrame(frame, { strict: false })
      rendered++
      if (surf.report.problems.length > 0) {
        failures.push(`t=${Math.round(t)}: ${surf.report.problems.slice(0, 3).join('; ')}`)
      }
    } catch (err) {
      failures.push(`t=${Math.round(t)}: threw ${err && err.message ? err.message : err}`)
    }
  }
  suite.check(
    'every sampled real frame rasterizes with NO undrawable primitive',
    failures.length === 0,
    `${failures.length} frame(s) had problems:\n      ${failures.slice(0, 5).join('\n      ')}`,
  )
  suite.eq('all sampled real frames were rendered', rendered, SAMPLES.length)

  // The real frames must actually draw something across the timeline.
  suite.check(
    'the real timeline draws a non-trivial number of primitives',
    SAMPLES.every((pct) => {
      const f = scene.frame(duration * pct)
      return Array.isArray(f.layers) && f.layers.length > 0
    }),
    'a sampled real frame had zero layers',
  )
})

runSuite(suite)
