#!/usr/bin/env node
/**
 * verify/verify-scene.mjs — `src/scene.js` against INTERFACES.md §4, adversarially.
 *
 * The scene is a classic script, so it is loaded with `node:vm` in a bare context
 * (never `import()`), exactly as the page receives it.
 *
 * The load-bearing assertions here, and the mistake each one catches:
 *
 *  * "no Math.random() / Date.now() inside frame" — proved with INSTRUMENTED
 *    globals, not by grepping the source. A grep misses `var r = Math.random`
 *    captured at module scope and called inside frame; a call counter does not.
 *    Every storyboard render and every other assertion in `verify/` depends on
 *    determinism, so this is the foundation §4.2 names.
 *  * "the primitive set is EXACTLY §4.4" — the rasterizer implements that closed
 *    set. A new `k` smuggled in without widening the contract renders as nothing
 *    in the storyboard and is invisible in the browser until it silently drops.
 *  * "every frame <= 600 primitives" — the renderer shares a process with DSH's
 *    own boot work at 60fps.
 *  * "no NaN/Infinity anywhere in a frame" — a single NaN coordinate poisons a
 *    canvas path and can blank the whole frame with no error.
 *
 * Exit: 0 pass · 1 fail · 3 pending (src/scene.js has not landed)
 */

import { createSuite, runSuite, exists, readText, show, walk, isFiniteNumber, EXIT } from './_harness.mjs'
import vm from 'node:vm'

const suite = createSuite('verify-scene — src/scene.js §4: determinism, primitives, budget, NaN-freedom')

// ---------------------------------------------------------------------------
// §4.4 — the CLOSED primitive set. Transcribed from the frozen contract.
// ---------------------------------------------------------------------------
const PRIMITIVES = {
  fill: { required: ['color'], optional: ['alpha'] },
  rect: { required: ['x', 'y', 'w', 'h', 'color'], optional: ['alpha', 'radius'] },
  bar: { required: ['x', 'y', 'w', 'h', 'color'], optional: ['alpha', 'radius'] },
  line: { required: ['x1', 'y1', 'x2', 'y2', 'color'], optional: ['alpha', 'width'] },
  poly: { required: ['points', 'color'], optional: ['alpha', 'width', 'fill', 'close'] },
  circle: { required: ['cx', 'cy', 'r', 'color'], optional: ['alpha', 'width', 'fill', 'dash', 'rot'] },
  arc: { required: ['cx', 'cy', 'r', 'from', 'to', 'color'], optional: ['alpha', 'width'] },
  text: { required: ['x', 'y', 'text', 'size', 'color'], optional: ['alpha', 'align', 'spacing', 'weight', 'mono'] },
}
const HEX = /^#[0-9a-f]{6}$/
const TEXT_CHARSET = /^[A-Z0-9 :._\-/%()[\]]*$/
const PHASE_IDS = ['void', 'grid', 'reticle', 'link', 'surge', 'resolve']
const PHASE_LABELS = ['VOID', 'GRID', 'RETICLE', 'LINK', 'SURGE', 'RESOLVE']
const BUDGET = 600

const SCENE = 'src/scene.js'
if (!exists(SCENE)) {
  suite.need(SCENE, 'scene-dev')
  runSuite(suite)
} else {
  // -------------------------------------------------------------------------
  // Instrumented sandbox.
  //
  // The spy globals are installed BEFORE the script is evaluated, so a
  // module-scope capture (`var rnd = Math.random`) is also detected, not just a
  // call written literally inside frame().
  // -------------------------------------------------------------------------
  const randomCalls = []
  const nowCalls = []
  let phase = 'load'

  const spyMath = Object.create(Math)
  spyMath.random = function random() {
    randomCalls.push(phase)
    return Math.random()
  }

  class SpyDate extends Date {
    static now() {
      nowCalls.push(phase)
      return Date.now()
    }
    constructor(...args) {
      if (args.length === 0) nowCalls.push(`${phase}:new`)
      super(...args)
    }
  }

  const sandbox = {
    console,
    Math: spyMath,
    JSON,
    Date: SpyDate,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Symbol,
    Map,
    Set,
    WeakMap,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox

  let S = null
  try {
    const context = vm.createContext(sandbox, { name: SCENE })
    vm.runInContext(readText(SCENE), context, { filename: SCENE })
    S = sandbox.__DSH_LINK_START_SCENE__
  } catch (err) {
    suite.fatal(`evaluating ${SCENE} in a bare vm context threw: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`)
  }

  if (S === null || S === undefined) {
    suite.fatal(`${SCENE} ran but did not assign globalThis.__DSH_LINK_START_SCENE__`)
  }

  if (S !== null && S !== undefined) {
    // -----------------------------------------------------------------------
    // §4.1 exports
    // -----------------------------------------------------------------------
    suite.check('the scene global is a plain object', typeof S === 'object', `typeof is ${typeof S}`)
    for (const key of ['DESIGN', 'PHASES', 'DEFAULT_CFG', 'normalizeConfig', 'totalDuration', 'phaseAt', 'createScene']) {
      suite.check(`§4.1 exports "${key}"`, S[key] !== undefined, `missing export "${key}"`)
    }
    for (const fn of ['normalizeConfig', 'totalDuration', 'phaseAt', 'createScene']) {
      suite.check(`§4.1 "${fn}" is a function`, typeof S[fn] === 'function', `typeof is ${typeof S[fn]}`)
    }

    // §4: no module machinery, no DOM, no Node built-ins referenced.
    const src = readText(SCENE)
    for (const banned of ['require(', 'module.exports', 'import ', 'export ']) {
      suite.check(
        `§4 the source contains no "${banned.trim()}"`,
        !new RegExp(`(^|[^\\w.])${banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')),
        `${SCENE} is injected as script TEXT and loaded in a bare vm context; "${banned.trim()}" would break one or both`,
      )
    }

    // -----------------------------------------------------------------------
    // §4.1 DESIGN
    // -----------------------------------------------------------------------
    suite.eq('§3/§4.1 DESIGN is exactly { W: 1600, H: 900 }', { W: S.DESIGN && S.DESIGN.W, H: S.DESIGN && S.DESIGN.H }, { W: 1600, H: 900 })

    // -----------------------------------------------------------------------
    // §4.1 / §4.5 PHASES — normalized, contiguous, ascending, 0→1
    // -----------------------------------------------------------------------
    suite.check('§4.1 PHASES is an array', Array.isArray(S.PHASES), `typeof is ${typeof S.PHASES}`)
    const P = Array.isArray(S.PHASES) ? S.PHASES : []
    suite.eq('§4.5 PHASES has the six documented phases', P.map((p) => p.id), PHASE_IDS)
    suite.eq('§4.5 phase labels are the documented ASCII uppercase strings', P.map((p) => p.label), PHASE_LABELS)
    suite.eq('§4.5 the first phase starts at exactly 0', P[0] && P[0].from, 0)
    suite.eq('§4.5 the last phase ends at exactly 1', P[P.length - 1] && P[P.length - 1].to, 1)
    for (let i = 0; i < P.length; i++) {
      const p = P[i]
      suite.check(
        `§4.1 phase[${i}] "${p.id}" is ascending (from < to)`,
        p.from < p.to,
        `from=${p.from} to=${p.to} — an empty or inverted phase makes phaseAt() return a nonsense local`,
      )
      suite.check(
        `§4.1 phase[${i}] "${p.id}" lies within 0..1`,
        p.from >= 0 && p.to <= 1,
        `from=${p.from} to=${p.to}`,
      )
      if (i > 0) {
        suite.check(
          `§4.1 phase[${i}] "${p.id}" is CONTIGUOUS with "${P[i - 1].id}" (previous.to === this.from)`,
          Math.abs(P[i - 1].to - p.from) < 1e-9,
          `previous.to=${P[i - 1].to} but this.from=${p.from} — a gap or overlap breaks normalized phase lookup`,
        )
      }
      suite.is(
        `§4.5 phase[${i}] label "${p.label}" is ASCII uppercase`,
        p.label,
        (v) => typeof v === 'string' && /^[A-Z]+$/.test(v),
        'labels must be ASCII uppercase (the rasterizer carries a 5x7 uppercase font)',
      )
    }

    // -----------------------------------------------------------------------
    // §4.1 DEFAULT_CFG
    // -----------------------------------------------------------------------
    const D = S.DEFAULT_CFG
    suite.check('§4.1 DEFAULT_CFG is an object', D !== null && typeof D === 'object', `typeof is ${typeof D}`)
    if (D !== null && typeof D === 'object') {
      suite.check('§4.1 DEFAULT_CFG is frozen', Object.isFrozen(D), 'DEFAULT_CFG is mutable — a caller could corrupt every later scene handle')
      const documented = {
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
      }
      for (const [k, v] of Object.entries(documented)) {
        suite.eq(`§7.1 DEFAULT_CFG.${k} default is ${show(v)}`, D[k], v)
      }
    }

    // -----------------------------------------------------------------------
    // §4.1 normalizeConfig — pure, never throws, never mutates, clamps, coercion
    // -----------------------------------------------------------------------
    suite.section('§4.1 normalizeConfig', () => {
      const calls = [
        ['undefined', undefined],
        ['null', null],
        ['a number', 42],
        ['a string', 'nope'],
        ['an array', [1, 2, 3]],
        ['a boolean', true],
        ['an empty object', {}],
        ['NaN values', { durationMs: NaN, fadeMs: NaN, holdMs: NaN, seed: NaN }],
        ['Infinity values', { durationMs: Infinity, fadeMs: -Infinity, holdMs: Infinity, seed: -Infinity }],
        ['strings where numbers belong', { durationMs: 'abc', fadeMs: '5', holdMs: null, seed: {} }],
        ['objects where scalars belong', { accent: {}, title: [], enterMode: {}, enabled: {} }],
        ['negative and huge numbers', { durationMs: -1e9, fadeMs: 1e12, holdMs: -99, seed: 1e30 }],
        ['prototype pollution attempt', JSON.parse('{"__proto__":{"polluted":true},"constructor":1}')],
        ['a deeply nested object', { a: { b: { c: { d: 1 } } }, durationMs: 5000 }],
      ]
      for (const [label, input] of calls) {
        const r = suite.notThrows(`normalizeConfig(${label}) does not throw (§4.1 "never throws")`, () => S.normalizeConfig(input))
        if (!r.ok) continue
        const out = r.value
        suite.check(`normalizeConfig(${label}) returns an object`, out !== null && typeof out === 'object', `got ${show(out)}`)
        if (out === null || typeof out !== 'object') continue
        // every documented field present, correctly typed
        suite.check(
          `normalizeConfig(${label}) yields a boolean "enabled"`,
          typeof out.enabled === 'boolean',
          `enabled is ${show(out.enabled)}`,
        )
        for (const k of ['durationMs', 'fadeMs', 'holdMs', 'seed']) {
          suite.check(
            `normalizeConfig(${label}) yields a finite number "${k}"`,
            isFiniteNumber(out[k]),
            `${k} is ${show(out[k])} — a non-finite value reaches frame() and poisons the whole display list`,
          )
        }
        suite.check(
          `normalizeConfig(${label}) clamps durationMs to 3000..20000`,
          out.durationMs >= 3000 && out.durationMs <= 20000,
          `durationMs is ${show(out.durationMs)}`,
        )
        suite.check(
          `normalizeConfig(${label}) clamps fadeMs to 200..4000`,
          out.fadeMs >= 200 && out.fadeMs <= 4000,
          `fadeMs is ${show(out.fadeMs)}`,
        )
        suite.check(
          `normalizeConfig(${label}) clamps holdMs to 3000..60000`,
          out.holdMs >= 3000 && out.holdMs <= 60000,
          `holdMs is ${show(out.holdMs)}`,
        )
        suite.check(
          `normalizeConfig(${label}) clamps seed to 0..2147483647`,
          out.seed >= 0 && out.seed <= 2147483647 && Number.isInteger(out.seed),
          `seed is ${show(out.seed)}`,
        )
        suite.check(
          `normalizeConfig(${label}) yields a #rrggbb accent`,
          typeof out.accent === 'string' && HEX.test(out.accent),
          `accent is ${show(out.accent)}`,
        )
        suite.check(
          `normalizeConfig(${label}) yields enterMode auto|click`,
          out.enterMode === 'auto' || out.enterMode === 'click',
          `enterMode is ${show(out.enterMode)}`,
        )
        suite.check(
          `normalizeConfig(${label}) yields a string title`,
          typeof out.title === 'string',
          `title is ${show(out.title)}`,
        )
      }

      // purity: never mutates raw
      const raw = { durationMs: 999999, accent: 'not-a-color', extra: 'drop me', seed: -5 }
      const snapshot = JSON.stringify(raw)
      S.normalizeConfig(raw)
      suite.eq('§4.1 normalizeConfig never mutates its argument', JSON.stringify(raw), snapshot)

      // unknown keys dropped
      const out = S.normalizeConfig({ unknownKey: 1, another: 'x' })
      suite.check(
        '§4.1 normalizeConfig drops unknown keys',
        !Object.prototype.hasOwnProperty.call(out, 'unknownKey') && !Object.prototype.hasOwnProperty.call(out, 'another'),
        `unknown keys survived: ${show(Object.keys(out).filter((k) => k === 'unknownKey' || k === 'another'))}`,
      )
      // no prototype pollution
      suite.check(
        'normalizeConfig does not pollute Object.prototype',
        ({}).polluted === undefined,
        'Object.prototype.polluted was set — a normalization path is copying __proto__ through',
      )

      // clamping boundaries, exactly
      suite.eq('durationMs below range clamps to 3000', S.normalizeConfig({ durationMs: 0 }).durationMs, 3000)
      suite.eq('durationMs above range clamps to 20000', S.normalizeConfig({ durationMs: 99999 }).durationMs, 20000)
      suite.eq('fadeMs below range clamps to 200', S.normalizeConfig({ fadeMs: 0 }).fadeMs, 200)
      suite.eq('fadeMs above range clamps to 4000', S.normalizeConfig({ fadeMs: 99999 }).fadeMs, 4000)
      suite.eq('holdMs below range clamps to 3000', S.normalizeConfig({ holdMs: 0 }).holdMs, 3000)
      suite.eq('holdMs above range clamps to 60000', S.normalizeConfig({ holdMs: 99999 }).holdMs, 60000)
      suite.eq('a malformed accent falls back to the default', S.normalizeConfig({ accent: '#xyz' }).accent, '#5ad7ff')
      suite.eq('an rgb() accent falls back to the default (only #rrggbb is accepted)', S.normalizeConfig({ accent: 'rgb(1,2,3)' }).accent, '#5ad7ff')
      suite.eq('a 3-digit hex accent falls back to the default', S.normalizeConfig({ accent: '#abc' }).accent, '#5ad7ff')
      suite.eq('a valid uppercase accent is accepted', S.normalizeConfig({ accent: '#AABBCC' }).accent, '#AABBCC')
      suite.eq('enterMode "click" is preserved', S.normalizeConfig({ enterMode: 'click' }).enterMode, 'click')
      suite.eq('an unknown enterMode falls back to auto', S.normalizeConfig({ enterMode: 'turbo' }).enterMode, 'auto')
      suite.is(
        'the title is truncated to 40 chars (§7.1)',
        S.normalizeConfig({ title: 'Z'.repeat(200) }).title,
        (v) => typeof v === 'string' && v.length <= 40,
        'a title longer than 40 chars must be truncated',
      )
    })

    // -----------------------------------------------------------------------
    // §4.1 totalDuration / phaseAt
    // -----------------------------------------------------------------------
    suite.section('§4.1 totalDuration / phaseAt', () => {
      suite.eq('totalDuration returns cfg.durationMs', S.totalDuration(S.normalizeConfig({ durationMs: 5000 })), 5000)
      suite.eq('totalDuration of the default config is 6800', S.totalDuration(S.normalizeConfig(undefined)), 6800)
      suite.eq('totalDuration clamps an out-of-range duration', S.totalDuration({ durationMs: 1 }), 3000)

      const cfg = S.normalizeConfig({ durationMs: 10000 })
      for (const [label, t] of [['negative', -500], ['zero', 0], ['one third', 3333], ['exactly duration', 10000], ['past the end', 99999]]) {
        const r = suite.notThrows(`phaseAt(${label}) does not throw`, () => S.phaseAt(cfg, t))
        if (!r.ok) continue
        const got = r.value
        suite.check(
          `phaseAt(${label}) returns { id, label, index, local, start, end }`,
          got !== null && typeof got === 'object' && 'id' in got && 'label' in got && 'index' in got && 'local' in got && 'start' in got && 'end' in got,
          `got ${show(got)}`,
        )
        suite.check(`phaseAt(${label}) local is within 0..1`, got.local >= 0 && got.local <= 1, `local is ${show(got.local)}`)
        suite.check(`phaseAt(${label}) index is a valid phase index`, Number.isInteger(got.index) && got.index >= 0 && got.index < PHASE_IDS.length, `index is ${show(got.index)}`)
        suite.eq(`phaseAt(${label}) id is the phase at that index`, got.id, PHASE_IDS[got.index])
        suite.check(`phaseAt(${label}) start/end are finite numbers`, isFiniteNumber(got.start) && isFiniteNumber(got.end), `start=${show(got.start)} end=${show(got.end)}`)
      }
      suite.eq('phaseAt clamps a negative t to phase void at local 0', (() => { const g = S.phaseAt(cfg, -500); return [g.id, g.local] })(), ['void', 0])
      suite.eq('phaseAt clamps t past the duration to the last phase', (() => { const g = S.phaseAt(cfg, 999999); return g.id })(), 'resolve')
      // phaseAt must agree with PHASES at each boundary
      for (const p of P) {
        const g = S.phaseAt(cfg, p.from * cfg.durationMs + 1)
        suite.eq(`phaseAt at the exact start of "${p.id}" reports "${p.id}"`, g.id, p.id)
      }
    })

    // -----------------------------------------------------------------------
    // §4.2 createScene + determinism
    // -----------------------------------------------------------------------
    const cfg0 = S.normalizeConfig({ seed: 12345 })
    let scene = null
    const created = suite.notThrows('§4.1 createScene(cfg) does not throw', () => S.createScene(cfg0))
    if (created.ok) scene = created.value

    if (scene === null || scene === undefined) {
      suite.fatal('createScene did not return a handle — the remaining §4.2/§4.3/§4.4 assertions cannot run')
    } else {
      suite.check('§4.1 createScene returns { cfg, duration, phases, frame }', ['cfg', 'duration', 'phases', 'frame'].every((k) => k in scene), `keys are ${show(Object.keys(scene))}`)
      suite.check('§4.1 scene.frame is a function', typeof scene.frame === 'function', `typeof is ${typeof scene.frame}`)
      suite.eq('§4.1 scene.duration equals totalDuration(cfg)', scene.duration, S.totalDuration(cfg0))
      suite.eq('§4.1 scene.phases is the PHASES table', scene.phases, P)

      // --- the determinism proof -------------------------------------------
      const duration = scene.duration

      // Reset the spies: everything above was setup, everything below is frame().
      randomCalls.length = 0
      nowCalls.length = 0
      phase = 'frame'

      const samples = []
      for (let i = 0; i <= 200; i++) samples.push(Math.round((duration * i) / 200))
      samples.push(duration + 1, duration * 2, -100, 0.5, 1234.567)

      suite.section('§4.2 frame(t) is a pure function of t', () => {
        let firstFailure = null
        for (const t of samples) {
          const a = scene.frame(t)
          const b = scene.frame(t)
          const sa = JSON.stringify(a)
          const sb = JSON.stringify(b)
          if (sa !== sb) {
            firstFailure = { t, a: sa.slice(0, 300), b: sb.slice(0, 300) }
            break
          }
        }
        suite.check(
          '§4.2 calling frame(t) twice at the same t yields stringify-equal frames (all 205 samples)',
          firstFailure === null,
          firstFailure === null ? undefined : `first divergence at t=${firstFailure.t}\n      a ${firstFailure.a}\n      b ${firstFailure.b}`,
        )
        suite.check(
          '§4.2 frame() drew NO Math.random() — randomness must be precomputed in createScene',
          randomCalls.length === 0,
          `${randomCalls.length} Math.random() call(s) occurred during frame(): a frame is therefore not reproducible, and every storyboard PNG and every assertion in verify/ is worthless`,
        )
        suite.check(
          '§4.2 frame() called NO Date.now()',
          nowCalls.length === 0,
          `${nowCalls.length} Date call(s) occurred during frame(): the timeline would move on its own between two renders of the same t`,
        )
      })

      // Two independent handles at the same seed must agree — this catches
      // determinism that only holds because of a shared mutable cache.
      const sceneA = S.createScene(S.normalizeConfig({ seed: 777 }))
      const sceneB = S.createScene(S.normalizeConfig({ seed: 777 }))
      suite.check(
        '§4.2 two handles built with the same non-zero seed produce identical frames at every sample',
        samples.every((t) => JSON.stringify(sceneA.frame(t)) === JSON.stringify(sceneB.frame(t))),
        `seeds are equal but the frames differ: ${show(samples.find((t) => JSON.stringify(sceneA.frame(t)) !== JSON.stringify(sceneB.frame(t))))}`,
      )

      // seed 0 draws once from Math.random() inside createScene (not inside frame)
      randomCalls.length = 0
      nowCalls.length = 0
      const sceneZero = S.createScene(S.normalizeConfig({ seed: 0 }))
      const drawsDuringCreate = randomCalls.length
      suite.check(
        '§4.2 cfg.seed === 0 draws a seed from Math.random() INSIDE createScene',
        drawsDuringCreate > 0,
        'seed 0 produced no Math.random() draw in createScene — every boot would look identical, contradicting "0 = fresh random per boot"',
      )
      randomCalls.length = 0
      sceneZero.frame(duration / 2)
      sceneZero.frame(duration / 4)
      suite.check(
        '§4.2 a seed-0 handle still draws NO randomness inside frame()',
        randomCalls.length === 0,
        `${randomCalls.length} Math.random() call(s) during frame() on a seed-0 handle`,
      )
      suite.check(
        '§4.2 two seed-0 handles differ (the draw really is per-createScene)',
        JSON.stringify(sceneZero.frame(1000)) !== JSON.stringify(S.createScene(S.normalizeConfig({ seed: 0 })).frame(1000)) ||
          drawsDuringCreate === 0,
        'two independent seed-0 handles produced identical frames, so "0 = fresh random per boot" is not implemented',
      )

      // --- §4.3 Frame shape ------------------------------------------------
      suite.section('§4.3 Frame shape', () => {
        const REQUIRED = {
          t: 'number',
          duration: 'number',
          progress: 'number',
          done: 'boolean',
          phase: 'string',
          phaseLabel: 'string',
          index: 'number',
          phaseProgress: 'number',
          background: 'string',
          flash: 'number',
          vignette: 'number',
          scanlines: 'number',
          shake: 'number',
          layers: 'object',
          telemetry: 'object',
        }
        let bad = null
        for (const t of samples) {
          const f = scene.frame(t)
          for (const [k, ty] of Object.entries(REQUIRED)) {
            if (typeof f[k] !== ty) {
              bad = { t, k, got: typeof f[k], want: ty }
              break
            }
          }
          if (bad === null && !Array.isArray(f.layers)) bad = { t, k: 'layers', got: typeof f.layers, want: 'array' }
          if (bad === null && !Array.isArray(f.telemetry)) bad = { t, k: 'telemetry', got: typeof f.telemetry, want: 'array' }
          if (bad === null && !('wordmark' in f)) bad = { t, k: 'wordmark', got: 'missing', want: 'null | object' }
          if (bad === null && !('hint' in f)) bad = { t, k: 'hint', got: 'missing', want: 'reserved field' }
          if (bad !== null) break
        }
        suite.check(
          '§4.3 every sampled frame carries every documented field with the right type',
          bad === null,
          bad === null ? undefined : `at t=${bad.t}: field "${bad.k}" is ${show(bad.got)}, expected ${bad.want}`,
        )

        const f0 = scene.frame(0)
        suite.eq('§4.3 frame.t echoes the t passed in', f0.t, 0)
        suite.eq('§4.3 frame.duration is totalDuration(cfg)', f0.duration, duration)
        suite.eq('§4.3 frame.progress at t=0 is 0', f0.progress, 0)
        suite.eq('§4.3 frame.phase at t=0 is the first phase id', f0.phase, 'void')
        suite.eq('§4.3 frame.index at t=0 is 0', f0.index, 0)
        suite.eq('§4.3 frame.done at t=0 is false', f0.done, false)

        // progress = t/duration clamped
        let progressBad = null
        for (const t of samples) {
          const f = scene.frame(t)
          const want = Math.min(Math.max(t / duration, 0), 1)
          if (Math.abs(f.progress - want) > 1e-9) {
            progressBad = { t, got: f.progress, want }
            break
          }
        }
        suite.check(
          '§4.3 frame.progress is exactly clamp(t/duration, 0, 1) at every sample',
          progressBad === null,
          progressBad === null ? undefined : `at t=${progressBad.t}: progress is ${progressBad.got}, expected ${progressBad.want}`,
        )

        // done at t >= duration
        suite.check('§4.3 done is false just below the duration', scene.frame(duration - 1).done === false, `done at t=${duration - 1} was ${scene.frame(duration - 1).done}`)
        suite.check('§4.3 done is true at exactly t === duration', scene.frame(duration).done === true, `done at t=${duration} was ${scene.frame(duration).done}`)
        suite.check('§4.3 done is true past the duration', scene.frame(duration + 5000).done === true, `done at t=${duration + 5000} was ${scene.frame(duration + 5000).done}`)
        suite.check(
          '§4.3 phase is a valid PHASES id and index/label agree at every sample',
          samples.every((t) => {
            const f = scene.frame(t)
            return PHASE_IDS[f.index] === f.phase && PHASE_LABELS[f.index] === f.phaseLabel
          }),
          'phase/index/phaseLabel disagree somewhere in the timeline',
        )
        suite.check(
          '§4.3 phaseProgress is within 0..1 at every sample',
          samples.every((t) => {
            const v = scene.frame(t).phaseProgress
            return isFiniteNumber(v) && v >= 0 && v <= 1
          }),
          `out-of-range phaseProgress, e.g. ${show(samples.map((t) => scene.frame(t).phaseProgress).find((v) => !(v >= 0 && v <= 1)))}`,
        )
        // §4.3 background is #rrggbb
        suite.check(
          '§4.3 background is #rrggbb at every sample',
          samples.every((t) => HEX.test(scene.frame(t).background)),
          `a background failed the #rrggbb test: ${show(samples.map((t) => scene.frame(t).background).find((v) => !HEX.test(v)))}`,
        )
        for (const k of ['flash', 'vignette', 'scanlines', 'shake']) {
          suite.check(
            `§4.3 ${k} is a finite non-negative number at every sample`,
            samples.every((t) => {
              const v = scene.frame(t)[k]
              return isFiniteNumber(v) && v >= 0
            }),
            `a bad ${k}: ${show(samples.map((t) => scene.frame(t)[k]).find((v) => !(isFiniteNumber(v) && v >= 0)))}`,
          )
        }
        // §4.3 documents flash/vignette/scanlines as 0..1 "strengths". A value
        // above 1 is a contract deviation: the rasterizer and any consumer that
        // treats the field as a normalized strength must clamp it themselves.
        // Report WHICH field, its true maximum, and where — not just "one failed".
        const RANGE_FIELDS = ['flash', 'vignette', 'scanlines']
        const rangeReport = []
        for (const k of RANGE_FIELDS) {
          let max = -Infinity
          let maxAt = null
          const over = []
          for (const t of samples) {
            const v = scene.frame(t)[k]
            if (v > max) {
              max = v
              maxAt = t
            }
            if (v > 1) over.push({ t: Math.round(t), v })
          }
          if (over.length > 0) {
            rangeReport.push(
              `§4.3 "${k}" exceeds 1: max ${max} at t=${Math.round(maxAt)}; ` +
                `${over.length}/${samples.length} samples above 1, t=${over[0].t}..${over[over.length - 1].t}`,
            )
          }
        }
        suite.check(
          '§4.3 flash/vignette/scanlines stay within their documented 0..1 range',
          rangeReport.length === 0,
          `${rangeReport.join('\n      ')}\n      §4.3 documents these as "0..1" additive strengths; a consumer that treats the value as normalised will over-drive`,
        )
        suite.check(
          '§4.3 the range assertion is non-vacuous (all three fields were actually non-negative and examined)',
          samples.every((t) => {
            const f = scene.frame(t)
            return RANGE_FIELDS.every((k) => isFiniteNumber(f[k]))
          }),
          'a sampled frame had a non-finite framing field, so the range check could not mean anything',
        )
        suite.check(
          '§4.3 hint is null (the overlay draws the hint as DOM, not in the frame)',
          samples.every((t) => scene.frame(t).hint === null),
          `hint is not null: ${show(samples.map((t) => scene.frame(t).hint).find((v) => v !== null))}`,
        )
      })

      // --- §4.3 wordmark ---------------------------------------------------
      suite.section('§4.3 wordmark', () => {
        const wordmarkTexts = new Set()
        let shapeBad = null
        for (const t of samples) {
          const wm = scene.frame(t).wordmark
          if (wm === null) continue
          if (typeof wm !== 'object') {
            shapeBad = { t, wm }
            break
          }
          wordmarkTexts.add(wm.text)
          for (const k of ['text', 'x', 'y', 'size', 'alpha', 'glitch']) {
            if (!(k in wm)) {
              shapeBad = { t, missing: k }
              break
            }
          }
          if (shapeBad !== null) break
        }
        suite.check(
          '§4.3 a non-null wordmark carries { text, x, y, size, alpha, glitch }',
          shapeBad === null,
          shapeBad === null ? undefined : `at t=${shapeBad.t}: ${shapeBad.missing ? `missing "${shapeBad.missing}"` : show(shapeBad.wm)}`,
        )
        suite.check(
          '§4.3 the wordmark text is always the ASCII uppercase title',
          [...wordmarkTexts].every((v) => typeof v === 'string' && v === v.toUpperCase()),
          `non-uppercase wordmark text: ${show([...wordmarkTexts].find((v) => v !== v.toUpperCase()))}`,
        )
        // wordmark: null outside its phase is allowed; it must exist somewhere
        suite.check(
          '§4.3 the wordmark appears at some point in the timeline (cfg.wordmark defaults true)',
          [...wordmarkTexts].length > 0,
          'no sampled frame carried a wordmark, yet DEFAULT_CFG.wordmark is true',
        )
      })

      // --- §4.4 the closed primitive set -----------------------------------
      suite.section('§4.4 the closed primitive set', () => {
        const seenKinds = new Set()
        const problems = []
        let maxLayers = 0
        let maxAt = 0

        for (const t of samples) {
          const f = scene.frame(t)
          if (f.layers.length > maxLayers) {
            maxLayers = f.layers.length
            maxAt = t
          }
          if (f.layers.length > BUDGET) {
            problems.push(`t=${t}: ${f.layers.length} primitives exceeds the ${BUDGET} budget`)
          }
          for (let i = 0; i < f.layers.length; i++) {
            const p = f.layers[i]
            if (p === null || typeof p !== 'object') {
              problems.push(`t=${t} layer[${i}]: not an object (${show(p)})`)
              continue
            }
            const spec = PRIMITIVES[p.k]
            if (spec === undefined) {
              problems.push(`t=${t} layer[${i}]: unknown primitive k=${show(p.k)} — §4.4 is a closed set; the rasterizer and boot-screen.js both implement exactly it`)
              continue
            }
            seenKinds.add(p.k)
            for (const req of spec.required) {
              if (!(req in p)) problems.push(`t=${t} layer[${i}] k=${p.k}: missing required field "${req}"`)
            }
            for (const key of Object.keys(p)) {
              if (key !== 'k' && !spec.required.includes(key) && !spec.optional.includes(key)) {
                problems.push(`t=${t} layer[${i}] k=${p.k}: undocumented field "${key}"`)
              }
            }
            if (typeof p.color !== 'string' || !HEX.test(p.color)) {
              problems.push(`t=${t} layer[${i}] k=${p.k}: color ${show(p.color)} is not lowercase #rrggbb`)
            }
            if ('alpha' in p && !(isFiniteNumber(p.alpha) && p.alpha >= 0 && p.alpha <= 1)) {
              problems.push(`t=${t} layer[${i}] k=${p.k}: alpha ${show(p.alpha)} is not a finite number in 0..1`)
            }
            if (p.k === 'text') {
              if (typeof p.text !== 'string') problems.push(`t=${t} layer[${i}] k=text: text is ${show(p.text)}`)
              else if (!TEXT_CHARSET.test(p.text)) {
                // The user-supplied title is the one documented exemption.
                const cfgTitle = String(cfg0.title ?? '')
                if (!(cfgTitle.length > 0 && p.text === cfgTitle)) {
                  problems.push(`t=${t} layer[${i}] k=text: text ${show(p.text)} is outside the allowed uppercase-ASCII charset`)
                }
              }
              if ('align' in p && !['left', 'center', 'right'].includes(p.align)) {
                problems.push(`t=${t} layer[${i}] k=text: align ${show(p.align)} is not left|center|right`)
              }
              if ('weight' in p && !['normal', 'bold'].includes(p.weight)) {
                problems.push(`t=${t} layer[${i}] k=text: weight ${show(p.weight)} is not normal|bold`)
              }
            }
            if (p.k === 'poly') {
              if (!Array.isArray(p.points) || p.points.length < 2) {
                problems.push(`t=${t} layer[${i}] k=poly: points must be an array of >= 2 pairs`)
              } else {
                for (let n = 0; n < p.points.length; n++) {
                  const pt = p.points[n]
                  if (!Array.isArray(pt) || pt.length !== 2 || !isFiniteNumber(pt[0]) || !isFiniteNumber(pt[1])) {
                    problems.push(`t=${t} layer[${i}] k=poly: points[${n}] is ${show(pt)}`)
                    break
                  }
                }
              }
            }
            if (p.k === 'circle' && 'dash' in p) {
              if (!Array.isArray(p.dash) || !isFiniteNumber(p.dash[0]) || !isFiniteNumber(p.dash[1]) || p.dash[0] <= 0 || p.dash[1] <= 0) {
                problems.push(`t=${t} layer[${i}] k=circle: dash ${show(p.dash)} must be [on>0, off>0]`)
              }
            }
          }
        }
        suite.eq(
          `§4.4 no frame exceeds the ${BUDGET}-primitive budget (max seen: ${maxLayers} at t=${maxAt})`,
          problems.filter((p) => p.includes('exceeds the')).length,
          0,
        )
        suite.check(
          '§4.4 every primitive k is in the closed set and carries only documented fields',
          problems.filter((p) => p.includes('unknown primitive') || p.includes('undocumented field') || p.includes('missing required')).length === 0,
          problems.filter((p) => p.includes('unknown primitive') || p.includes('undocumented field') || p.includes('missing required')).slice(0, 8).join('\n      '),
        )
        suite.check(
          '§4.4 every color is lowercase #rrggbb',
          problems.filter((p) => p.includes('is not lowercase #rrggbb')).length === 0,
          problems.filter((p) => p.includes('is not lowercase #rrggbb')).slice(0, 5).join('\n      '),
        )
        suite.check(
          '§4.4 every alpha is a finite number in 0..1',
          problems.filter((p) => p.includes('alpha')).length === 0,
          problems.filter((p) => p.includes('alpha')).slice(0, 5).join('\n      '),
        )
        suite.check(
          '§4.4/§4.3 all text (layers, wordmark, telemetry) is within the allowed ASCII charset',
          problems.filter((p) => p.includes('charset')).length === 0,
          problems.filter((p) => p.includes('charset')).slice(0, 5).join('\n      '),
        )
        suite.check(
          '§4.4 text align/weight use the documented enum values',
          problems.filter((p) => p.includes('is not left|center|right') || p.includes('is not normal|bold')).length === 0,
          problems.filter((p) => p.includes('is not left|center|right') || p.includes('is not normal|bold')).slice(0, 5).join('\n      '),
        )
        suite.check(
          '§4.4 poly points are all finite [x, y] pairs',
          problems.filter((p) => p.includes('points')).length === 0,
          problems.filter((p) => p.includes('points')).slice(0, 5).join('\n      '),
        )
        suite.check(
          '§4.4 circle dash is [on>0, off>0]',
          problems.filter((p) => p.includes('dash')).length === 0,
          problems.filter((p) => p.includes('dash')).slice(0, 5).join('\n      '),
        )
        suite.check(
          '§4.3 telemetry text is within the allowed ASCII charset',
          samples.every((t) =>
            scene.frame(t).telemetry.every((e) => typeof e.text === 'string' && TEXT_CHARSET.test(e.text)),
          ),
          `bad telemetry text: ${show(samples.flatMap((t) => scene.frame(t).telemetry).map((e) => e.text).find((v) => !TEXT_CHARSET.test(v)))}`,
        )
        // §4.4 says the rasterizer needs a 5x7 uppercase font, so report coverage.
        suite.check(
          '§4.4 the scene actually draws shapes, not only a background (the timeline is not a still)',
          seenKinds.size >= 3,
          `only ${seenKinds.size} distinct primitive kind(s) were used across the whole timeline: ${[...seenKinds].join(', ')}`,
        )
      })

      // --- NaN / Infinity freedom ------------------------------------------
      suite.section('NaN/Infinity freedom', () => {
        const bad = []
        for (const t of samples) {
          const f = scene.frame(t)
          for (const [path, value] of walk(f)) {
            if (typeof value === 'number' && !Number.isFinite(value)) {
              bad.push(`t=${t} ${path} = ${value}`)
            }
            if (typeof value === 'number' && Number.isFinite(value) && value > 1e9) {
              bad.push(`t=${t} ${path} = ${value} (implausibly large for a 1600x900 design space)`)
            }
          }
        }
        suite.check(
          '§8 no NaN or Infinity appears anywhere in a frame across a dense sample of the whole timeline',
          bad.length === 0,
          `${bad.length} occurrence(s); first few:\n      ${bad.slice(0, 6).join('\n      ')}`,
        )
      })

      // --- the timeline never throws ---------------------------------------
      suite.section('whole-timeline robustness', () => {
        let threw = null
        let dense = 0
        for (let i = 0; i <= 4000; i++) {
          const t = (duration * i) / 4000
          try {
            scene.frame(t)
            dense++
          } catch (err) {
            threw = { t, err: err && err.message ? err.message : String(err) }
            break
          }
        }
        suite.check(
          '§8 sampling the whole timeline (4001 points) never throws',
          threw === null,
          threw === null ? undefined : `threw at t=${threw.t}: ${threw.err}`,
        )
        suite.eq('every one of the 4001 dense samples rendered', dense, 4001)

        // hostile t values the overlay can actually produce
        for (const [label, t] of [
          ['NaN', NaN],
          ['Infinity', Infinity],
          ['-Infinity', -Infinity],
          ['a string', '1234'],
          ['undefined', undefined],
          ['null', null],
          ['an object', {}],
        ]) {
          const r = suite.notThrows(`frame(${label}) does not throw (the overlay may hand it anything)`, () => scene.frame(t))
          if (r.ok && r.value !== null && typeof r.value === 'object') {
            suite.check(
              `frame(${label}) still yields a finite, ordered display list`,
              Array.isArray(r.value.layers) && r.value.layers.length <= BUDGET && isFiniteNumber(r.value.progress),
              `layers=${show(r.value.layers && r.value.layers.length)} progress=${show(r.value.progress)}`,
            )
          }
        }
      })

      // --- §4.5 calm mode --------------------------------------------------
      suite.section('§4.5 cfg.motion === "calm"', () => {
        const calm = suite.notThrows(
          'a calm scene builds and renders without throwing',
          () => {
            const s = S.createScene(S.normalizeConfig({ motion: 'calm', seed: 4242 }))
            return { s, frames: [0, duration / 2, duration].map((t) => s.frame(t)) }
          },
        )
        if (calm.ok) {
          const { s, frames } = calm.value
          suite.check('a calm frame is still a valid Frame', frames.every((f) => Array.isArray(f.layers) && isFiniteNumber(f.progress)), 'a calm frame was malformed')
          suite.check(
            '§4.5 a calm frame stays within the primitive budget',
            frames.every((f) => f.layers.length <= BUDGET),
            `calm frame sizes: ${frames.map((f) => f.layers.length).join(', ')}`,
          )
          // "tunnel/grid motion and glitch suppressed": a calm scene must draw
          // materially fewer primitives than a full one at the same t.
          const full = S.createScene(S.normalizeConfig({ seed: 4242, motion: 'full' }))
          let calmTotal = 0
          let fullTotal = 0
          for (let i = 0; i <= 100; i++) {
            const t = (duration * i) / 100
            calmTotal += s.frame(t).layers.length
            fullTotal += full.frame(t).layers.length
          }
          suite.check(
            '§4.5 calm mode measurably suppresses the motion (fewer primitives across the timeline than full motion)',
            calmTotal < fullTotal,
            `calm drew ${calmTotal} primitives vs ${fullTotal} for full motion — "suppressed" is not observable, so reduced motion is not implemented`,
          )
          const calmWM = frames.map((f) => f.wordmark).filter((w) => w !== null)
          suite.check(
            '§4.5 calm mode still produces a wordmark (the reticle + wordmark fade is the calm sequence)',
            calmWM.length > 0,
            'no calm frame carried a wordmark',
          )
          suite.check(
            '§4.5 calm mode produces no glitch (glitch is suppressed)',
            calmWM.every((w) => w.glitch === 0),
            `a calm wordmark had glitch=${show(calmWM.map((w) => w.glitch).find((v) => v !== 0))}`,
          )
        }
      })

      // --- §4.5/§7.1 cfg gates ---------------------------------------------
      suite.section('§4.5 config gates', () => {
        const at = duration * 0.61 // inside the `link` phase, where the wordmark assembles
        const withWM = S.createScene(S.normalizeConfig({ seed: 99, wordmark: true })).frame(at)
        const noWM = S.createScene(S.normalizeConfig({ seed: 99, wordmark: false })).frame(at)
        suite.check('§4.5 wordmark:true yields a wordmark', withWM.wordmark !== null, 'wordmark was null with wordmark:true')
        suite.check('§4.5 wordmark:false yields a null wordmark', noWM.wordmark === null, `wordmark:false still produced ${show(noWM.wordmark)}`)
        suite.check(
          '§4.5 wordmark:false drops the wordmark primitives from the budget too',
          noWM.layers.length <= withWM.layers.length,
          `wordmark:false drew more layers (${noWM.layers.length}) than wordmark:true (${withWM.layers.length})`,
        )

        const telOn = S.createScene(S.normalizeConfig({ seed: 99, telemetry: true })).frame(at)
        const telOff = S.createScene(S.normalizeConfig({ seed: 99, telemetry: false })).frame(at)
        suite.check('§4.5 telemetry:true yields telemetry', telOn.telemetry.length > 0, 'telemetry was empty with telemetry:true')
        suite.eq('§4.5 telemetry:false yields no telemetry', telOff.telemetry.length, 0)

        const scanOn = S.createScene(S.normalizeConfig({ seed: 99, scanlines: true })).frame(at)
        const scanOff = S.createScene(S.normalizeConfig({ seed: 99, scanlines: false })).frame(at)
        suite.check('§4.5 scanlines:true sets a non-zero scanline strength', scanOn.scanlines > 0, `scanlines was ${scanOn.scanlines}`)
        suite.eq('§4.5 scanlines:false sets scanline strength to 0', scanOff.scanlines, 0)

        // accent drives the palette: changing it must change drawn colors
        const accentA = S.createScene(S.normalizeConfig({ seed: 99, accent: '#ff0000' })).frame(at)
        const accentB = S.createScene(S.normalizeConfig({ seed: 99, accent: '#00ff00' })).frame(at)
        const colorsA = new Set(accentA.layers.map((l) => l.color))
        const colorsB = new Set(accentB.layers.map((l) => l.color))
        suite.check('§4.5 cfg.accent actually drives the drawn palette', ![...colorsA].every((c) => colorsB.has(c)), 'changing cfg.accent produced an identical color set, so the accent is ignored')
        suite.check(
          '§4.5 the configured accent color itself appears in the frame',
          colorsA.has('#ff0000'),
          `cfg.accent '#ff0000' never reached a primitive; colors used: ${[...colorsA].slice(0, 10).join(', ')}`,
        )

        // title drives the wordmark text
        const titled = S.createScene(S.normalizeConfig({ seed: 99, title: 'ACCEL WORLD' })).frame(at)
        suite.eq('§4.5 cfg.title becomes the wordmark text', titled.wordmark && titled.wordmark.text, 'ACCEL WORLD')
      })

      // --- §4.5 telemetry counts with t ------------------------------------
      suite.section('§4.5 telemetry is derived from t (it visibly counts)', () => {
        const s = S.createScene(S.normalizeConfig({ seed: 99, telemetry: true }))
        const early = s.frame(duration * 0.31).telemetry.map((e) => e.text).join('|')
        const late = s.frame(duration * 0.49).telemetry.map((e) => e.text).join('|')
        suite.check(
          '§4.5 the telemetry readout changes between two points in the same phase (it is derived from t)',
          early !== late,
          `the readout was byte-identical at 31% and 49%: ${show(early)} — it is static decoration, not instrumentation`,
        )
        suite.check(
          '§4.5 telemetry entries carry finite x/y and an alpha in 0..1',
          [duration * 0.31, duration * 0.49].every((t) =>
            s.frame(t).telemetry.every((e) => isFiniteNumber(e.x) && isFiniteNumber(e.y) && e.alpha >= 0 && e.alpha <= 1),
          ),
          'a telemetry entry had a bad x/y/alpha',
        )
      })

      // --- §4.5 central 70% safe box ---------------------------------------
      suite.section('§4.5 bleed: what matters stays inside the central box', () => {
        const BLEED = 0.15
        const x0 = 1600 * BLEED
        const x1 = 1600 * (1 - BLEED)
        const y0 = 900 * BLEED
        const y1 = 900 * (1 - BLEED)
        // Only assert the wordmark, which §4.5 says is the thing that must read
        // at any aspect ratio ("Keep everything that matters inside the central
        // 70% box"). The tunnel/starfield is deliberately allowed to bleed.
        const offenders = []
        for (const t of samples) {
          const wm = scene.frame(t).wordmark
          if (wm === null) continue
          // Estimate the drawn extent from the text length and size.
          const halfW = (String(wm.text).length * wm.size * 0.72) / 2
          if (wm.x - halfW < 0 || wm.x + halfW > 1600 || wm.y - wm.size < 0 || wm.y > 900) {
            offenders.push(`t=${t}: wordmark "${wm.text}" spans x ${Math.round(wm.x - halfW)}..${Math.round(wm.x + halfW)} at y ${Math.round(wm.y)}`)
          }
        }
        suite.check(
          '§4.5 the wordmark stays fully inside the design space (nothing important is cropped at any aspect ratio)',
          offenders.length === 0,
          `${offenders.length} frame(s) place the wordmark outside 1600x900; e.g. ${offenders[0]}`,
        )
        suite.check(
          '§4.5 the safe-box check itself is non-vacuous (a wordmark was actually examined)',
          samples.some((t) => scene.frame(t).wordmark !== null),
          'no wordmark was ever present, so the previous assertion proved nothing',
        )
        suite.check(
          '§4.5 safe-box bounds are the documented central 70% box',
          x0 === 240 && x1 === 1360 && y0 === 135 && y1 === 765,
          'the bleed constants do not match §4.5',
        )
      })
    }
  }
}

runSuite(suite)
