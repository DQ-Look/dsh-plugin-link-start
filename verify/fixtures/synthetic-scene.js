/**
 * verify/fixtures/synthetic-scene.js — a TEST FIXTURE, not the product scene.
 *
 * `src/scene.js` is owned by `scene-dev`. This file exists so that
 * `tools/raster.mjs` / `tools/storyboard.mjs` and `verify/verify-raster.mjs` can be
 * proven end-to-end BEFORE and INDEPENDENTLY OF the real scene, and so the
 * rasterizer's coverage of every §4.4 primitive is not hostage to whatever the
 * real scene happens to draw.
 *
 * It is deliberately ugly-but-total: it draws every primitive kind, sets every
 * Frame framing field, emits a wordmark with glitch and telemetry with and
 * without `size`, and stays deterministic. It implements the §4.1 surface just
 * well enough to be a valid stand-in for the storyboard harness.
 *
 * Loaded with `vm.runInNewContext` like the real one. Classic script.
 */
;(function () {
  'use strict'
  var DESIGN = { W: 1600, H: 900 }
  var PHASES = [
    { id: 'void', label: 'VOID', from: 0, to: 0.07 },
    { id: 'grid', label: 'GRID', from: 0.07, to: 0.3 },
    { id: 'reticle', label: 'RETICLE', from: 0.3, to: 0.5 },
    { id: 'link', label: 'LINK', from: 0.5, to: 0.72 },
    { id: 'surge', label: 'SURGE', from: 0.72, to: 0.86 },
    { id: 'resolve', label: 'RESOLVE', from: 0.86, to: 1 }
  ]
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
    title: 'SYNTHETIC',
    respectReducedMotion: true,
    seed: 0,
    holdMs: 20000,
    motion: 'full'
  })

  function num(v, d) {
    var n = typeof v === 'number' ? v : Number(v)
    return isFinite(n) ? n : d
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v
  }
  function normalizeConfig(raw) {
    var r = raw && typeof raw === 'object' ? raw : {}
    var out = {
      enabled: r.enabled === undefined ? DEFAULT_CFG.enabled : !!r.enabled,
      durationMs: clamp(num(r.durationMs, DEFAULT_CFG.durationMs), 3000, 20000),
      fadeMs: clamp(num(r.fadeMs, DEFAULT_CFG.fadeMs), 200, 4000),
      enterMode: r.enterMode === 'click' ? 'click' : 'auto',
      accent: /^#[0-9a-fA-F]{6}$/.test(r.accent) ? r.accent : DEFAULT_CFG.accent,
      sound: r.sound === undefined ? true : !!r.sound,
      glitch: r.glitch === undefined ? true : !!r.glitch,
      scanlines: r.scanlines === undefined ? true : !!r.scanlines,
      telemetry: r.telemetry === undefined ? true : !!r.telemetry,
      wordmark: r.wordmark === undefined ? true : !!r.wordmark,
      title: typeof r.title === 'string' ? r.title.slice(0, 40) : DEFAULT_CFG.title,
      respectReducedMotion: r.respectReducedMotion === undefined ? true : !!r.respectReducedMotion,
      seed: clamp(Math.round(num(r.seed, 0)), 0, 2147483647),
      holdMs: clamp(num(r.holdMs, DEFAULT_CFG.holdMs), 3000, 60000),
      motion: r.motion === 'calm' ? 'calm' : 'full'
    }
    return out
  }
  function totalDuration(cfg) {
    return normalizeConfig(cfg).durationMs
  }
  function phaseAt(cfg, t) {
    var d = totalDuration(cfg)
    var p = clamp(num(t, 0), 0, d) / d
    for (var i = 0; i < PHASES.length; i++) {
      var ph = PHASES[i]
      if (p < ph.to || i === PHASES.length - 1) {
        var local = (p - ph.from) / (ph.to - ph.from)
        return { id: ph.id, label: ph.label, index: i, local: clamp(local, 0, 1), start: ph.from, end: ph.to }
      }
    }
    return { id: 'void', label: 'VOID', index: 0, local: 0, start: 0, end: 1 }
  }
  function mulberry32(a) {
    return function () {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      var t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  function hex(n) {
    var s = clamp(Math.round(n), 0, 255).toString(16)
    return s.length < 2 ? '0' + s : s
  }

  function createScene(cfg) {
    var c = normalizeConfig(cfg)
    var duration = c.durationMs
    var rnd = mulberry32(c.seed !== 0 ? c.seed : Math.floor(Math.random() * 2147483647) + 1)
    var jitter = []
    for (var i = 0; i < 64; i++) jitter.push([(rnd() - 0.5) * 40, (rnd() - 0.5) * 40, rnd()])

    function frame(tRaw) {
      var t = clamp(num(tRaw, 0), 0, duration * 1e6)
      var ph = phaseAt(c, t)
      var p = clamp(t / duration, 0, 1)
      var layers = []
      var calm = c.motion === 'calm'
      var glow = calm ? 0 : Math.sin(ph.local * Math.PI)

      // void → grid: a perspective tunnel built from lines + a poly horizon
      layers.push({ k: 'fill', color: p < 0.5 ? '#000000' : '#04080c', alpha: 1 })
      var core = 1 - p * 0.6
      layers.push({ k: 'circle', cx: 800, cy: 450, r: 6 + 46 * glow, color: c.accent, alpha: 0.9, fill: true })
      var rings = 10
      for (var n = 0; n < rings; n++) {
        var depth = ((n + ((calm ? 0 : t / 900) % 1)) / rings) % 1
        var rr = 40 + depth * 780
        layers.push({
          k: 'circle', cx: 800, cy: 450, r: rr, color: c.accent, alpha: 0.55 * (1 - depth) + 0.06,
          width: 1 + (1 - depth) * 5, dash: [10 + 40 * (1 - depth), 14], rot: t / 4000
        })
      }
      for (var a = 0; a < 12; a++) {
        var ang = (a / 12) * Math.PI * 2 + (calm ? 0 : t / 6000)
        layers.push({
          k: 'line', x1: 800, y1: 450,
          x2: 800 + Math.cos(ang) * 1100, y2: 450 + Math.sin(ang) * 700,
          color: c.accent, alpha: 0.28, width: 1
        })
      }
      layers.push({
        k: 'poly', points: [[200, 700], [800, 420], [1400, 700]], color: '#0b1c26', alpha: 0.5,
        fill: true, close: true
      })
      layers.push({
        k: 'poly', points: [[120, 760], [340, 690], [560, 760], [780, 690]], color: '#ffb347',
        alpha: 0.7, width: 3, close: false
      })

      // reticle: arcs + corner brackets + tick bars
      layers.push({ k: 'arc', cx: 800, cy: 450, r: 300, from: 0, to: 1.6, color: c.accent, alpha: 0.85, width: 4 })
      layers.push({ k: 'arc', cx: 800, cy: 450, r: 240, from: 2.2, to: 4.4, color: '#ffb347', alpha: 0.6, width: 2 })
      var corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]]
      for (var q = 0; q < 4; q++) {
        var cxx = 800 + corners[q][0] * 360
        var cyy = 450 + corners[q][1] * 240
        layers.push({ k: 'bar', x: cxx - 40, y: cyy - 6, w: 80, h: 12, color: c.accent, alpha: 0.8, radius: 2 })
      }
      for (var g = 0; g < 8; g++) {
        layers.push({
          k: 'bar', x: 800 - 280 + g * 80, y: 640, w: 46, h: 10, radius: 5,
          color: '#7fff8f', alpha: 0.25 + 0.5 * ((g / 8 + p) % 1)
        })
      }
      // rect + text
      layers.push({ k: 'rect', x: 60, y: 60, w: 300, h: 90, color: '#020609', alpha: 0.72, radius: 10 })
      layers.push({
        k: 'text', x: 80, y: 120, text: 'SYNTH ' + hex(p * 255), size: 26, color: c.accent,
        alpha: 0.95, align: 'left', spacing: 2, weight: 'bold', mono: true
      })
      layers.push({
        k: 'text', x: 1540, y: 830, text: 'RIGHT EDGE', size: 20, color: '#ffb347', alpha: 0.7, align: 'right'
      })
      layers.push({
        k: 'text', x: 800, y: 862, text: 'CENTER ' + Math.round(t), size: 22, color: '#7fff8f', alpha: 0.6, align: 'center'
      })
      // the exempt-title path: unknown glyphs must be approximated, not dropped
      layers.push({ k: 'text', x: 800, y: 300, text: c.title, size: 34, color: '#ffffff', alpha: 0.9, align: 'center' })

      var telemetry = []
      if (c.telemetry) {
        telemetry.push({ x: 60, y: 810, text: 'T ' + String(Math.round(t)).padStart(5, '0'), alpha: 0.8 })
        telemetry.push({ x: 60, y: 840, text: 'SYNC ' + hex(ph.local * 255) + '%', alpha: 0.8, size: 12 })
        telemetry.push({ x: 1540, y: 60, text: 'NODE ' + ph.label, alpha: 0.6, size: 18 })
      }
      return {
        t: t,
        duration: duration,
        progress: p,
        done: t >= duration,
        phase: ph.id,
        phaseLabel: ph.label,
        index: ph.index,
        phaseProgress: ph.local,
        background: p < 0.5 ? '#000000' : '#04080c',
        flash: p > 0.86 ? clamp((p - 0.86) / 0.14, 0, 1) * 0.7 : 0.1 * glow,
        vignette: 0.35,
        scanlines: c.scanlines ? 0.5 : 0,
        shake: p > 0.72 && p < 0.9 ? 3 : 0,
        layers: layers,
        wordmark: c.wordmark
          ? {
              text: 'LINK START',
              x: 800,
              y: 490,
              size: 96,
              alpha: clamp((p - 0.42) * 4, 0, 1),
              glitch: c.glitch ? clamp(1 - Math.abs(p - 0.62) * 8, 0, 1) : 0
            }
          : null,
        telemetry: telemetry,
        hint: null
      }
    }
    return { cfg: c, duration: duration, phases: PHASES, frame: frame }
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
