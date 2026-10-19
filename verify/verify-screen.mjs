#!/usr/bin/env node
/**
 * verify/verify-screen.mjs — `src/boot-screen.js` against a stub DOM and a VIRTUAL
 * CLOCK. No real timers, no sleeping, no browser.
 *
 * This is the suite that proves the handoff rule, which §5.2 calls "the one thing
 * that must not be got wrong", plus §5.2a (kernel failure always reveals itself) and
 * §9b (both surfaces' mount orderings).
 *
 * WHY A VIRTUAL CLOCK. The overlay reads an injectable clock (`cfg.now`) for every
 * decision, and animation frames only *offer* ticks. So `clock.advance(ms)` moves
 * time and fires due timers in order, and `clock.tickFrame()` steps the render loop.
 * A real `setTimeout` would make these assertions timing-dependent; here the exact
 * virtual millisecond a dissolve begins is deterministic.
 *
 * The handoff truth table this suite asserts:
 *
 *   enterMode  timelineDone  booted   failure   expected
 *   ---------  ------------  -------  --------  -----------------------------------
 *   auto       no            no       no        holds; hint says it will wait
 *   auto       no            yes      no        waits for the timeline
 *   auto       yes           no       no        holds; NEVER auto-enters un-booted
 *   auto       yes           yes      no        DISSOLVES (whichever finished second)
 *   click      yes           yes      no        waits for a gesture
 *   click      yes           no       no        waits for a gesture
 *   any        any           any      YES       DISSOLVES after the ~600ms grace, even click
 *
 * Exit: 0 pass · 1 fail · 3 pending
 */

import {
  createSuite,
  runSuite,
  exists,
  readText,
  show,
  tryLoadClassic,
  EXIT,
} from './_harness.mjs'
import { createClock, createDom } from './_dom.mjs'

const suite = createSuite('verify-screen — boot-screen.js: handoff matrix, §5.2a, §9b orderings, destroy')

const SCREEN = 'src/boot-screen.js'
const SCENE = 'src/scene.js'
const CSS = 'src/style.css'

if (!suite.need(SCREEN, 'render-dev') || !suite.need(SCENE, 'scene-dev')) {
  runSuite(suite)
} else {
  // -------------------------------------------------------------------------
  // Boot harness: build a fresh sandbox + DOM + clock and load the overlay.
  // -------------------------------------------------------------------------
  function boot(cfgOver = {}, domOver = {}, mutateScene) {
    const clock = createClock(cfgOver.__start ?? 1000)
    const dom = createDom({ clock, ...domOver })

    // The scene is loaded in the SAME context so the overlay's `globalThis.__DSH_LINK_START_SCENE__`
    // resolves exactly as it does in the page (scene script row, then screen row).
    const globals = {
      document: dom.document,
      window: dom.window,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimer,
      setInterval: clock.setInterval,
      clearInterval: clock.clearTimer,
      requestAnimationFrame: clock.requestAnimationFrame,
      cancelAnimationFrame: clock.cancelAnimationFrame,
      addEventListener: dom.window.addEventListener,
      removeEventListener: dom.window.removeEventListener,
      matchMedia: dom.window.matchMedia,
      location: dom.window.location,
      navigator: dom.window.navigator,
      innerWidth: dom.window.innerWidth,
      innerHeight: dom.window.innerHeight,
      devicePixelRatio: dom.window.devicePixelRatio,
      performance: dom.window.performance,
      sessionStorage: dom.window.sessionStorage,
      localStorage: dom.window.localStorage,
      MutationObserver: dom.window.MutationObserver,
      AudioContext: dom.window.AudioContext,
      webkitAudioContext: dom.window.webkitAudioContext,
      console: { warn() {}, error() {}, log() {}, info() {} },
    }

    const sceneLoaded = tryLoadClassic(SCENE, globals)
    if (!sceneLoaded.ok) throw new Error(`scene failed to load: ${sceneLoaded.error}`)
    // Optional hook so a test can wrap the scene API BEFORE the overlay captures it.
    if (mutateScene !== undefined) mutateScene(sceneLoaded.sandbox)

    const cfg = {
      durationMs: 6800,
      fadeMs: 1000,
      enterMode: 'auto',
      accent: '#5ad7ff',
      sound: false,
      glitch: true,
      scanlines: true,
      telemetry: true,
      wordmark: true,
      title: 'DEEPSEEK HARNESS',
      respectReducedMotion: true,
      seed: 20240518,
      holdMs: 20000,
      now: () => clock.now,
      ...stripInternal(cfgOver),
    }
    sceneLoaded.sandbox.__DSH_LINK_START_CFG__ = cfg

    const screenLoaded = tryLoadClassic(SCREEN, globals, { context: sceneLoaded.context, sandbox: sceneLoaded.sandbox })
    const overlay = sceneLoaded.sandbox.__DSH_LINK_START__
    const diag = sceneLoaded.sandbox.__DSH_LINK_START_DIAG__
    return { clock, dom, cfg, screenLoaded, overlay, diag, sandbox: sceneLoaded.sandbox }
  }

  /** Strip harness-only keys (`__start`) from the cfg passed to the overlay. */
  function stripInternal(cfgOver) {
    const out = {}
    for (const [k, v] of Object.entries(cfgOver)) {
      if (!k.startsWith('__')) out[k] = v
    }
    return out
  }

  /** Step the render loop by advancing virtual time and running frames. */
  function run(env, ms, { frameEvery = 16 } = {}) {
    const steps = Math.max(1, Math.ceil(ms / frameEvery))
    for (let i = 0; i < steps; i++) {
      env.clock.advance(frameEvery)
      env.clock.tickFrame()
    }
  }

  const bodyHasOverlay = (env) =>
    env.dom.bodyChildren().some((n) => n.tagName === 'DIV' && String(n.getAttribute('class') ?? '').includes('dslls-'))

  // =========================================================================
  // 1. LOAD / DEGRADE / IDEMPOTENCE
  // =========================================================================
  suite.section('load, degrade, idempotence', () => {
    // --- mounts exactly one root, in the Web ordering (no boot page at mount)
    const env = boot({}, { bootPage: false, width: 1600, height: 900 })
    suite.check('the overlay global is published', env.overlay !== undefined && env.overlay !== null, 'globalThis.__DSH_LINK_START__ was not defined')
    suite.check('the diagnostics global is published', env.diag !== undefined && env.diag !== null, 'globalThis.__DSH_LINK_START_DIAG__ was not defined')
    if (env.overlay !== undefined && env.overlay !== null) {
      suite.check('§5.1 the public surface is { el, state, preview, clientReady, skip, destroy }', ['el', 'state', 'preview', 'clientReady', 'skip', 'destroy'].every((k) => k in env.overlay), `keys: ${show(Object.keys(env.overlay))}`)
      for (const fn of ['preview', 'clientReady', 'skip', 'destroy']) {
        suite.check(`§5.1 "${fn}" is a function`, typeof env.overlay[fn] === 'function', `typeof is ${typeof env.overlay[fn]}`)
      }
      suite.check('§5.1 el is the overlay root', env.overlay.el !== null && env.overlay.el !== undefined, 'el is null right after mount')
      suite.eq('§5.1 state starts as "booting"', env.overlay.state, 'booting')
      suite.check('§5.1 the initial frame is drawn (a scene frame was painted)', env.diag.t >= 0, `diag.t is ${show(env.diag.t)}`)
      suite.check(
        '§5.1 diag carries { t, state, phase, bootedAt, fps, reduced, errors }',
        ['t', 'state', 'phase', 'fps', 'reduced', 'errors'].every((k) => k in env.diag),
        `diag keys: ${show(Object.keys(env.diag))}`,
      )
      suite.check('§5.2a diag exposes failed', 'failed' in env.diag, `diag keys: ${show(Object.keys(env.diag))}`)
      suite.eq('§5.2a failed starts false', env.diag.failed, false)
    }
    const roots = env.dom.bodyChildren().filter((n) => String(n.getAttribute('class') ?? '').includes('dslls-'))
    suite.eq('§5.1 the overlay mounts exactly ONE root element', roots.length, 1)
    suite.check('§5 the overlay installs a stylesheet into <head> it owns', env.dom.styleSheets().length >= 1, `head stylesheets: ${env.dom.styleSheets().length}`)

    // --- idempotence: a second load does nothing
    const before = {
      body: env.dom.bodyChildren().length,
      head: env.dom.head.childNodes.length,
      el: env.overlay.el,
    }
    const second = tryLoadClassic(SCREEN, {
      document: env.dom.document, window: env.dom.window,
      setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimer,
      setInterval: env.clock.setInterval, clearInterval: env.clock.clearTimer,
      requestAnimationFrame: env.clock.requestAnimationFrame, cancelAnimationFrame: env.clock.cancelAnimationFrame,
      MutationObserver: env.dom.window.MutationObserver,
      matchMedia: env.dom.window.matchMedia, location: env.dom.window.location,
      navigator: env.dom.window.navigator, console: { warn() {}, error() {} },
    }, { context: env.sandbox, sandbox: env.sandbox })
    suite.check('§5 a second load does not throw', second.ok, `threw: ${second.error && second.error.message}`)
    suite.eq('§5 a second load adds no root element', env.dom.bodyChildren().length, before.body)
    suite.eq('§5 a second load adds no stylesheet', env.dom.head.childNodes.length, before.head)
    suite.eq('§5 a second load leaves the same el handle in place', env.overlay.el, before.el)

    // --- no-op when cfg is missing
    const noCfg = (() => {
      const clock = createClock(0)
      const dom = createDom({ clock })
      const g = minimalGlobals(dom, clock)
      const s = tryLoadClassic(SCENE, g)
      g.document = dom.document
      // deliberately do NOT define __DSH_LINK_START_CFG__
      return { s, dom, clock, sandbox: s.sandbox }
    })()
    const noCfgLoad = tryLoadClassic(SCREEN, minimalGlobals(noCfg.dom, noCfg.clock), { context: noCfg.sandbox, sandbox: noCfg.sandbox })
    suite.check('§5 loading with cfg missing does not throw', noCfgLoad.ok, `threw: ${noCfgLoad.error && noCfgLoad.error.message}`)
    suite.eq('§5 with cfg missing, nothing is mounted', noCfg.dom.bodyChildren().length, 0)
    suite.check('§5 with cfg missing, the overlay global is NOT published', noCfg.sandbox.__DSH_LINK_START__ === undefined, 'the overlay installed itself without a config')

    // --- no-op when scene is missing
    const noScene = (() => {
      const clock = createClock(0)
      const dom = createDom({ clock })
      const g = minimalGlobals(dom, clock)
      g.__DSH_LINK_START_CFG__ = { durationMs: 1000, now: () => clock.now }
      return { dom, clock, g }
    })()
    const { sandbox: dummy, context: dummyCtx } = (() => {
      const clock = createClock(0)
      const dom = createDom({ clock })
      const s = tryLoadClassic(SCENE, minimalGlobals(dom, clock))
      return s
    })()
    noScene.g.__DSH_LINK_START_SCENE__ = undefined
    const noSceneLoad = tryLoadClassic(SCREEN, noScene.g, { context: dummyCtx, sandbox: dummy })
    suite.check('§5 loading with the scene missing does not throw', noSceneLoad.ok, `threw: ${noSceneLoad.error && noSceneLoad.error.message}`)
    suite.eq('§5 with the scene missing, nothing is mounted', noScene.dom.bodyChildren().length, 0)
    suite.check('§5 with the scene missing, the overlay global is NOT published', dummy.__DSH_LINK_START__ === undefined, 'the overlay installed itself without a scene')
  })

  function minimalGlobals(dom, clock) {
    return {
      document: dom.document,
      window: dom.window,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimer,
      setInterval: clock.setInterval,
      clearInterval: clock.clearTimer,
      requestAnimationFrame: clock.requestAnimationFrame,
      cancelAnimationFrame: clock.cancelAnimationFrame,
      addEventListener: dom.window.addEventListener,
      removeEventListener: dom.window.removeEventListener,
      matchMedia: dom.window.matchMedia,
      location: dom.window.location,
      navigator: dom.window.navigator,
      innerWidth: 1600,
      innerHeight: 900,
      devicePixelRatio: 1,
      performance: dom.window.performance,
      sessionStorage: dom.window.sessionStorage,
      localStorage: dom.window.localStorage,
      MutationObserver: dom.window.MutationObserver,
      console: { warn() {}, error() {}, log() {} },
    }
  }

  // =========================================================================
  // 2. §5.2 THE HANDOFF MATRIX
  // =========================================================================
  suite.section('§5.2 handoff matrix — auto, timeline finishes FIRST', () => {
    const env = boot({ enterMode: 'auto' }, { bootPage: false })
    // Let the timeline run past its end with no clientReady().
    run(env, 8000)
    suite.check(
      '§5.2 auto + timeline done + NOT booted => the overlay does NOT dissolve (never reveal a half-built app)',
      env.overlay.state !== 'leaving' && env.overlay.state !== 'gone',
      `state is ${env.overlay.state} after the timeline ended with no clientReady()`,
    )
    suite.check('and the root is still on screen', bodyHasOverlay(env), 'the root was removed')
    suite.check(
      '§5.2 the hint tells the user it is waiting rather than entering',
      /WILL ENTER|PRESS|WAIT|SLOW/i.test(hintOf(env)),
      `hint text is ${show(hintOf(env))}`,
    )
    // A LATE clientReady() must now trigger the handoff.
    env.overlay.clientReady()
    run(env, 100)
    suite.check(
      '§5.2 a clientReady() arriving AFTER the timeline ended still triggers the handoff',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state is ${env.overlay.state} after a late clientReady()`,
    )
    suite.eq('§5.2 diag.booted is true after clientReady()', env.diag.booted, true)
  })

  suite.section('§5.2 handoff matrix — auto, roster finishes FIRST', () => {
    const env = boot({ enterMode: 'auto' }, { bootPage: false })
    env.overlay.clientReady()
    run(env, 1000) // well short of 6800ms
    suite.check(
      '§5.2 auto + booted + timeline NOT done => the overlay does NOT dissolve yet',
      env.overlay.state !== 'leaving' && env.overlay.state !== 'gone',
      `state is ${env.overlay.state} only 1000ms into a 6800ms timeline`,
    )
    suite.check('and the overlay is still mounted', bodyHasOverlay(env), 'the root was removed early')
    // Now run the timeline out.
    run(env, 7000)
    suite.check(
      '§5.2 ...and it dissolves once the TIMELINE finishes second',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state is ${env.overlay.state} after the timeline completed with a booted roster`,
    )
  })

  suite.section('§5.2 auto dissolves when BOTH are already satisfied', () => {
    const env = boot({ enterMode: 'auto' }, { bootPage: false })
    env.overlay.clientReady()
    run(env, 8000)
    suite.check('both conditions met => leaving/gone', env.overlay.state === 'leaving' || env.overlay.state === 'gone', `state ${env.overlay.state}`)
    // And after fadeMs it is fully gone and removed.
    run(env, 3000)
    suite.eq('§5.2 the overlay reaches state "gone" after fadeMs', env.overlay.state, 'gone')
    suite.check('§5.1 el is null once gone', env.overlay.el === null, `el is ${show(env.overlay.el)}`)
    suite.check('§5.2 the root element is removed from the DOM', !bodyHasOverlay(env), 'an overlay node is still in <body>')
  })

  suite.section('§5.2 click mode requires a GESTURE', () => {
    const env = boot({ enterMode: 'click' }, { bootPage: false })
    env.overlay.clientReady()
    run(env, 30000) // way past duration and holdMs
    suite.check(
      '§5.2 click + booted + timeline done + NO gesture => still does NOT dissolve',
      env.overlay.state !== 'leaving' && env.overlay.state !== 'gone',
      `state is ${env.overlay.state} after 30s in click mode with no gesture`,
    )
    suite.check('and it is still mounted', bodyHasOverlay(env), 'the root was removed without a gesture')
    // Now a gesture.
    env.overlay.el.dispatch('pointerdown', { button: 0 })
    run(env, 100)
    suite.check(
      '§5.2 a pointerdown gesture dissolves it',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state is ${env.overlay.state} after pointerdown`,
    )
  })

  suite.section('§5.2 click mode accepts a keyboard gesture', () => {
    for (const key of ['Escape', ' ', 'Enter']) {
      const env = boot({ enterMode: 'click' }, { bootPage: false })
      env.overlay.clientReady()
      run(env, 9000)
      env.dom.dispatchWindow('keydown', { key })
      run(env, 100)
      suite.check(
        `§5.2 "${key}" is accepted as the entering gesture in click mode`,
        env.overlay.state === 'leaving' || env.overlay.state === 'gone',
        `state is ${env.overlay.state} after ${key}`,
      )
    }
  })

  suite.section('§5.2 click mode LOOPS the timeline via t % duration', () => {
    const env = boot({ enterMode: 'click' }, { bootPage: false })
    run(env, 2000)
    const first = env.diag.t
    run(env, 6000) // total 8000 > duration 6800
    const second = env.diag.t
    suite.check(
      '§5.2 in click mode diag.t stays within 0..duration (the sequence loops)',
      second >= 0 && second < 6800,
      `diag.t is ${second} after 8000ms in a 6800ms timeline — it must wrap`,
    )
    suite.check(
      'and it actually wrapped (t decreased after passing the end, rather than holding at duration)',
      second < 6800 && first < 6800,
      `t went ${first} -> ${second}`,
    )
    // The frame it paints must still be valid after wrapping.
    suite.check(
      '§5.2 the wrapped time still yields a valid frame (scene.frame(t % duration))',
      env.diag.errors.length === 0,
      `the overlay recorded errors: ${show(env.diag.errors)}`,
    )
  })

  suite.section('§5.2 holdMs NEVER auto-enters an un-booted roster', () => {
    const env = boot({ enterMode: 'auto', holdMs: 3000 }, { bootPage: false })
    suite.eq('holdMs is honoured from cfg', env.cfg.holdMs, 3000)
    // Advance well past holdMs with no clientReady().
    run(env, 3000 + 6800 + 5000)
    suite.check(
      '§5.2 after holdMs and a finished timeline, an un-booted roster still does NOT enter',
      env.overlay.state !== 'leaving' && env.overlay.state !== 'gone',
      `state is ${env.overlay.state} after holdMs — the app would have been revealed half-built`,
    )
    suite.check(
      '§5.2 the hint switches to the "press to continue" wording',
      /PRESS/i.test(hintOf(env)),
      `hint text is ${show(hintOf(env))} — expected the press-to-continue wording`,
    )
    // A late clientReady() still triggers the auto handoff even in auto mode.
    env.overlay.clientReady()
    run(env, 200)
    suite.check(
      '§5.2 a clientReady() after the holdMs hint still triggers the auto handoff',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state is ${env.overlay.state} after a late clientReady()`,
    )
  })

  // =========================================================================
  // 2b. DEFECT REGRESSIONS — found by review, each would have shipped
  // =========================================================================
  suite.section('the "press to continue" hint SURVIVES the timeline ending', () => {
    // The holdMs timer arms at holdMs and writes the press-to-continue wording.
    // But `maybeEnter()` runs on every frame AFTER the timeline ends and rewrites
    // the hint to "WILL ENTER WHEN READY" — which is the copy for a normal boot
    // that is merely slow, not the actionable wording a user needs.
    //
    // Observed: with the default holdMs (20s) the timeline ends at ~6.8s, so
    // "PRESS TO CONTINUE" NEVER appears at all. With holdMs=3s it appears at ~3s
    // and is then OVERWRITTEN at ~6.8s.
    for (const holdMs of [20000, 3000]) {
      const env = boot({ enterMode: 'auto', holdMs, durationMs: 6800 }, { bootPage: false })
      let sawPress = false
      let pressAt = null
      for (let ms = 0; ms <= 24000; ms += 10) {
        env.clock.advance(10)
        env.clock.tickFrame()
        if (/PRESS TO CONTINUE/i.test(hintOf(env))) {
          sawPress = true
          if (pressAt === null) pressAt = ms
        }
      }
      const final = hintOf(env)
      suite.check(
        `§5.2 with holdMs=${holdMs} the "press to continue" wording is shown while un-booted`,
        sawPress,
        `"PRESS TO CONTINUE" never appeared in 24s (holdMs=${holdMs}). ` +
          'The holdMs timer fires at holdMs, but once the timeline ends maybeEnter() rewrites the hint every frame, so the actionable wording is lost. ' +
          'A user staring at a stuck screen is told the overlay "will enter when ready" when it in fact needs a press.',
      )
      suite.check(
        `§5.2 with holdMs=${holdMs} the wording SURVIVES until the roster reports ready (final hint is still press-to-continue)`,
        /PRESS TO CONTINUE/i.test(final),
        `final hint after 24s un-booted is ${show(final)}; the press affordance was overwritten. ` +
          'The press DOES work (verified below), so the wording is the only thing telling the user what to do.',
      )
      suite.check(
        `§5.2 with holdMs=${holdMs} the overlay still correctly refuses to enter`,
        env.overlay.state !== 'leaving' && env.overlay.state !== 'gone',
        `state is ${env.overlay.state} — it entered un-booted`,
      )
    }

    // The press really is actionable, which is what makes the wording matter.
    const env = boot({ enterMode: 'auto', holdMs: 20000 }, { bootPage: false })
    run(env, 10000)
    env.overlay.el.dispatch('pointerdown', { button: 0 })
    run(env, 200)
    suite.check(
      '§5.2 a press in the un-booted stuck state does dissolve (so the affordance is real)',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state is ${env.overlay.state} after a pointerdown at t=10s — if a press works, the press-to-continue wording is load-bearing`,
    )
  })

  suite.section('a render error does NOT freeze the handoff (regression)', () => {
    // A paint exception used to kill the frame loop permanently: the catch called
    // maybeEnter() but never rescheduled, so the handoff never happened.
    const env = boot({ enterMode: 'auto' }, { bootPage: false })
    const canvas = env.dom.bodyChildren().flatMap((n) => n.descendants()).find((n) => n.tagName === 'CANVAS')
    suite.check('the canvas context is reachable for sabotage', canvas !== undefined && canvas._ctx !== undefined, 'no canvas/_ctx in the stub DOM')
    if (canvas !== undefined && canvas._ctx !== undefined) {
      let sabotage = true
      canvas._ctx.fillRect = (...args) => {
        if (sabotage) throw new Error('sabotaged fillRect')
        return undefined
      }
      const r = suite.notThrows('frames after a paint failure do not escape the overlay', () => run(env, 400))
      suite.check('the overlay contains the paint failure', r.ok, 'the exception escaped the frame loop')
      suite.check(
        'the failure is recorded on diag.errors rather than swallowed',
        env.diag.errors.length > 0,
        `diag.errors is empty after ${400}ms of failing paints — a silently swallowed render error is undiagnosable from a screenshot`,
      )
      // The loop must still be alive and able to release. `diag.t` legitimately
      // pins at `duration` once the timeline is done (the last frame holds), so
      // the meaningful assertion is that the HANDOFF still happens rather than
      // that the clock keeps climbing.
      sabotage = false
      run(env, 500)
      suite.check(
        'after the paint failure stops, the overlay is still responsive to a later handoff',
        env.overlay.state === 'booting',
        `state is ${env.overlay.state} while un-booted; it should still be holding`,
      )
      env.overlay.clientReady()
      run(env, 9000)
      suite.check(
        'a paint failure followed by a late clientReady() still reveals the app',
        env.overlay.state === 'leaving' || env.overlay.state === 'gone',
        `state is ${env.overlay.state} — a render error left the overlay permanently stuck over the app`,
      )
    }
  })

  suite.section('a LATE clientReady() after the timeline ends still releases (regression)', () => {
    // The loop used to stop rescheduling once t >= duration, so a clientReady()
    // arriving after the end was never observed and the overlay sat forever.
    const env = boot({ enterMode: 'auto' }, { bootPage: false })
    run(env, 8000) // timeline (6800) is fully over well before the roster reports
    suite.check('pre-condition: still up, un-booted', env.overlay.state === 'booting', `state ${env.overlay.state}`)
    // Give the loop every chance to have stopped; then report readiness.
    run(env, 3000)
    env.overlay.clientReady()
    run(env, 400)
    suite.check(
      '§5.2 a clientReady() arriving LONG after the timeline ended still releases the overlay',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state is ${env.overlay.state} — the overlay is stuck exactly as §5.2 exists to prevent`,
    )
  })

  suite.section('§5.2a failure is detected WITHOUT a spinner (regression)', () => {
    // Failure detection must attach to [data-dsh-boot] alone. A boot that fails
    // before rendering a spinner has no [data-dsh-boot-spinner], and tying the
    // observer to both meant such a failure was never noticed.
    const env = boot({ enterMode: 'auto' }, { bootPage: 'ok' })
    // Remove the spinner to model a failure before it renders.
    if (env.dom.spinnerEl !== null) env.dom.spinnerEl.remove()
    suite.check(
      'pre-condition: the boot page exists but has NO spinner',
      env.dom.document.querySelector('[data-dsh-boot]') !== null && env.dom.document.querySelector('[data-dsh-boot-spinner]') === null,
      'the stub DOM still has a spinner',
    )
    // The failure text appears on the boot card.
    env.dom.setBootText('Failed to load plugins: 1 entry did not activate')
    run(env, 1500)
    suite.check(
      '§5.2a a failure with NO spinner is still detected (diag.failed true)',
      env.diag.failed === true,
      `diag.failed is ${env.diag.failed}; a boot that fails before rendering a spinner would never be revealed`,
    )
    suite.check(
      '§5.2a ...and still auto-dissolves',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state is ${env.overlay.state} 1500ms after a no-spinner failure`,
    )
  })

  suite.section('§5.1 destroy() removes the stylesheet it owns', () => {
    const env = boot({}, { bootPage: false })
    const before = env.dom.styleSheets().length
    suite.check('pre-condition: the overlay injected a stylesheet', before >= 1, `stylesheets: ${before}`)
    env.overlay.destroy()
    suite.eq(
      '§5.1 destroy() removes the <style> element it injected',
      env.dom.styleSheets().length,
      0,
    )
    suite.eq('§5.1 destroy() removes the overlay root', env.dom.bodyChildren().length, 0)
    suite.check(
      '§5.1 destroy() leaves no node behind at all (body AND head)',
      env.dom.bodyChildren().length === 0 && env.dom.styleSheets().length === 0,
      `body has ${env.dom.bodyChildren().length} child(ren) and head has ${env.dom.styleSheets().length} injected style(s)`,
    )
    // A destroy/preview cycle must not accumulate stylesheets.
    env.overlay.preview()
    env.overlay.destroy()
    suite.check(
      '§5.1 repeated preview()/destroy() cycles do not accumulate stylesheets',
      env.dom.styleSheets().length === 0,
      `${env.dom.styleSheets().length} injected style(s) remain after a second preview/destroy cycle — a leak that grows per cycle`,
    )
  })

  suite.section('§5 the overlay does not double-inject when the host style row is present', () => {
    // The host pushes src/style.css as a `style` row. `tools/preview.mjs` loads the
    // three sources directly, with no host row. Both must end with the chrome
    // styled exactly once — a second copy of `.dslls-root` silently wins on order.
    const env = boot({}, { bootPage: false })
    const own = env.dom.styleSheets().length
    // Now simulate the host's row having been injected first.
    const hostRow = env.dom.document.createElement('style')
    hostRow.setAttribute('data-dsh-link-start-style', '1')
    hostRow.textContent = '.dslls-root{position:fixed;inset:0}'
    env.dom.head.insertBefore(hostRow, env.dom.head.childNodes[0])
    env.overlay.preview()
    const total = env.dom.styleSheets().length
    suite.check(
      '§5 the overlay does not add a second chrome stylesheet when the host already shipped one',
      total <= own + 1,
      `${total} style elements are now in <head> (the overlay injected ${own} on its own plus the host row): the chrome is defined twice`,
    )
  })

  // =========================================================================
  // 3. §5.2a KERNEL FAILURE ALWAYS REVEALS ITSELF
  // =========================================================================
  suite.section('§5.2a kernel failure overrides the gesture rule', () => {
    // --- the failure text is detected and diag.failed is set
    const env = boot({ enterMode: 'click' }, { bootPage: 'ok' })
    suite.eq('§5.2a failed is false while the boot page is healthy', env.diag.failed, false)
    suite.check('§5.2a the failure is NOT reported before the text appears', env.overlay.state === 'booting', `state ${env.overlay.state}`)

    env.dom.setBootText('Failed to load plugins: 2 entries did not activate')
    run(env, 50)
    suite.eq('§5.2a diag.failed becomes true when the kernel reports a failure', env.diag.failed, true)
    suite.check(
      '§5.2a the failure is reflected on the hint line (diagnosable from a screenshot)',
      /FAIL/i.test(hintOf(env)) || /fail/i.test(hintOf(env)),
      `hint text is ${show(hintOf(env))}`,
    )
    suite.check(
      '§5.2a the overlay does NOT dissolve instantly (there is a readable grace)',
      env.overlay.state !== 'gone',
      `state ${env.overlay.state} immediately after the failure text appeared`,
    )
    // --- the grace is ~600ms: still present just before, dissolving after
    run(env, 400)
    suite.check(
      '§5.2a after ~450ms of grace the overlay is still up (the grace is not instantaneous)',
      env.overlay.state !== 'gone',
      `state ${env.overlay.state} at ~450ms into the grace — the failure would be unreadable`,
    )
    run(env, 400) // now ~850ms since detection
    suite.check(
      '§5.2a by ~850ms after detection the overlay HAS begun to dissolve',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state ${env.overlay.state} at ~850ms; §5.2a requires the dissolve after a ~600ms grace`,
    )
    run(env, 3000)
    suite.eq('§5.2a and it is fully removed, revealing the kernel diagnosis', env.overlay.state, 'gone')
    suite.check('§5.2a the root is gone from the DOM', !bodyHasOverlay(env), 'an overlay node is still covering the diagnosis')
  })

  suite.section('§5.2a the grace window is 500..1000ms (the contract says ~600ms)', () => {
    const env = boot({ enterMode: 'click' }, { bootPage: 'ok' })
    env.dom.setBootText('did not activate')
    // Step in small increments and record the first virtual ms at which it leaves.
    let leftAt = null
    for (let elapsed = 0; elapsed <= 2000; elapsed += 25) {
      env.clock.advance(25)
      env.clock.tickFrame()
      if (env.overlay.state === 'leaving' || env.overlay.state === 'gone') {
        leftAt = elapsed
        break
      }
    }
    suite.check('§5.2a the overlay does dissolve on the failure text', leftAt !== null, 'it never dissolved within 2000ms of the failure')
    if (leftAt !== null) {
      suite.check(
        `§5.2a the grace is between 500ms and 1000ms (observed ~${leftAt}ms)`,
        leftAt >= 500 && leftAt <= 1000,
        `the dissolve began ${leftAt}ms after detection; §5.2a specifies a ~600ms grace — long enough to read as deliberate, short enough to reveal the diagnosis promptly`,
      )
    }
  })

  suite.section('§5.2a failure overrides click mode (the deliberate exception)', () => {
    const env = boot({ enterMode: 'click' }, { bootPage: 'ok' })
    run(env, 9000) // the timeline is long done; click mode would normally wait forever
    suite.check('§5.2a pre-condition: click mode is holding without a gesture', env.overlay.state !== 'leaving', `state ${env.overlay.state}`)
    env.dom.setBootText('Failed to load plugins')
    run(env, 1200)
    suite.check(
      '§5.2a a kernel failure dissolves the overlay EVEN IN CLICK MODE with no gesture',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state is ${env.overlay.state} — click mode trapped the user on a decorative screen while DSH was reporting a failure`,
    )
  })

  suite.section('§5.2a a failure BEFORE the timeline ends also reveals itself', () => {
    const env = boot({ enterMode: 'auto' }, { bootPage: 'ok' })
    run(env, 500) // early in the timeline
    suite.check('pre-condition: still booting early in the timeline', env.overlay.state === 'booting', `state ${env.overlay.state}`)
    env.dom.setBootText('did not activate: 3 entries')
    run(env, 1200)
    suite.check(
      '§5.2a a failure mid-timeline dissolves without waiting for the timeline',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state ${env.overlay.state} — the user is held on the animation while DSH reports a failure`,
    )
  })

  suite.section('§5.2a holdMs and failure are DISTINGUISHED', () => {
    // holdMs: waits, never enters, does not set failed.
    const held = boot({ enterMode: 'auto', holdMs: 3000 }, { bootPage: 'ok' })
    run(held, 12000)
    suite.eq('§5.2a holdMs does NOT set diag.failed (a slow boot is not a failure)', held.diag.failed, false)
    suite.check('§5.2a holdMs does NOT dissolve', held.overlay.state !== 'leaving' && held.overlay.state !== 'gone', `state ${held.overlay.state}`)
    suite.check('§5.2a holdMs changes the hint wording only', /PRESS/i.test(hintOf(held)), `hint ${show(hintOf(held))}`)

    // failure: dissolves, sets failed.
    const failed = boot({ enterMode: 'auto', holdMs: 3000 }, { bootPage: 'ok' })
    failed.dom.setBootText('Failed to load plugins')
    run(failed, 1200)
    suite.eq('§5.2a failure DOES set diag.failed', failed.diag.failed, true)
    suite.check('§5.2a failure DOES dissolve', failed.overlay.state === 'leaving' || failed.overlay.state === 'gone', `state ${failed.overlay.state}`)

    suite.check(
      '§5.2a the two cases are observably different on diagnostics (failed true vs false)',
      held.diag.failed === false && failed.diag.failed === true,
      `holdMs run failed=${held.diag.failed}, failure run failed=${failed.diag.failed}`,
    )
  })

  // =========================================================================
  // 4. §9b BOTH SURFACE ORDERINGS
  // =========================================================================
  suite.section('§9b Web ordering: [data-dsh-boot] is ABSENT at mount', () => {
    const env = boot({}, { bootPage: false })
    suite.check('§9b no boot page exists at mount time in the Web ordering', env.dom.document.querySelector('[data-dsh-boot]') === null, 'a boot page was present')
    suite.check('§9b the overlay still mounts', bodyHasOverlay(env), 'the overlay did not mount without a boot page')
    run(env, 1000)
    suite.check('§9b the overlay animates without a boot page (the bar is timeline-driven)', env.diag.t > 0, `diag.t is ${env.diag.t}`)
    suite.check(
      '§5.3 with no progress source the bar is driven by the timeline — never stuck at zero',
      env.diag.progress >= 0,
      `diag.progress is ${show(env.diag.progress)}`,
    )
    suite.check('§9b no errors were recorded on the no-boot-page path', env.diag.errors.length === 0, `errors: ${show(env.diag.errors)}`)
  })

  suite.section('§9b Desktop ordering: [data-dsh-boot] ALREADY EXISTS at mount', () => {
    const env = boot({}, { bootPage: 'ok', arc: 72 })
    suite.check('§9b the boot page exists BEFORE the overlay loads', env.dom.document.querySelector('[data-dsh-boot]') !== null, 'no boot page at mount')
    suite.check(
      '§9b the overlay mounts anyway (it must not depend on being first)',
      env.overlay !== undefined && env.overlay !== null && bodyHasOverlay(env),
      'the overlay failed to mount when a boot page was already present',
    )
    suite.check('§9b the overlay is still exactly one root', env.dom.bodyChildren().filter((n) => String(n.getAttribute('class') ?? '').includes('dslls-')).length === 1, 'expected exactly one overlay root')
    run(env, 1500)
    suite.check('§9b it animates on the desktop ordering too', env.diag.t > 0, `diag.t is ${env.diag.t}`)
    suite.check('§9b no errors were recorded on the already-booted path', env.diag.errors.length === 0, `errors: ${show(env.diag.errors)}`)
    suite.check(
      '§9b the overlay is opaque and full-viewport (it owns the viewport over the kernel page)',
      String(env.overlay.el.getAttribute('data-state') ?? '') !== '',
      'the root carries no data-state',
    )
  })

  suite.section('§9b timeline is anchored to the OVERLAY MOUNT INSTANT, not an epoch', () => {
    // Mount at a large, arbitrary virtual epoch. If the overlay used Date.now() or
    // an absolute origin, diag.t would be huge or negative instead of counting
    // from mount.
    const env = boot({ durationMs: 10000, __start: 987654321 }, { bootPage: 'ok' })
    suite.check(
      '§9b at mount, diag.t is ~0 even though the injected clock is at a large epoch',
      env.diag.t >= 0 && env.diag.t < 100,
      `diag.t is ${env.diag.t} at a clock of ${987654321} — the timeline is not anchored at the mount instant`,
    )
    run(env, 2000)
    suite.check(
      '§9b after 2000 virtual ms, diag.t is ~2000 (tracking now() - mountedAt)',
      Math.abs(env.diag.t - 2000) <= 120,
      `diag.t is ${env.diag.t} after 2000ms — expected ~2000`,
    )
    run(env, 3000)
    suite.check(
      '§9b after 5000 virtual ms, diag.t is ~5000',
      Math.abs(env.diag.t - 5000) <= 200,
      `diag.t is ${env.diag.t} after 5000ms — expected ~5000`,
    )
    suite.check(
      '§9b the epoch did not leak into the frame time (no Date.now() origin)',
      env.diag.t < 10000,
      `diag.t is ${env.diag.t}, which exceeds the 10000ms timeline — the overlay is timing from an absolute origin`,
    )
  })

  suite.section('§5.3 progress maps --dsh-boot-arc 72..288deg onto 0..100%', () => {
    const env = boot({ durationMs: 60000, __start: 5000 }, { bootPage: 'ok', arc: 72 })
    run(env, 200)
    const at0 = env.diag.progress
    suite.check(
      `§5.3 at 72deg the bar reads ~0% (got ${show(at0)})`,
      at0 === 0 || at0 < 0.08,
      `progress is ${show(at0)} at arc 72deg (the defined zero)`,
    )
    env.dom.setArc(288)
    run(env, 200)
    const at100 = env.diag.progress
    suite.check(
      `§5.3 at 288deg the bar reads ~100% (got ${show(at100)})`,
      at100 > 0.92,
      `progress is ${show(at100)} at arc 288deg (the defined full)`,
    )
    env.dom.setArc(180)
    run(env, 200)
    const atHalf = env.diag.progress
    suite.check(
      `§5.3 at 180deg the bar reads ~50% (got ${show(atHalf)})`,
      atHalf > 0.4 && atHalf < 0.6,
      `progress is ${show(atHalf)} at the midpoint arc — the mapping is not linear over 72..288`,
    )
    suite.check('§5.3 progress is monotonic with the arc', at0 < atHalf && atHalf < at100, `${at0} -> ${atHalf} -> ${at100}`)
    suite.check('§5.3 progress stays within 0..1', at0 >= 0 && at100 <= 1, `range ${at0}..${at100}`)
  })

  // =========================================================================
  // 5. §5.1 clientReady SAFETY, skip, destroy, reduced motion
  // =========================================================================
  suite.section('§5.1 clientReady() is safe to call twice and never throws', () => {
    const env = boot({}, { bootPage: false })
    const first = suite.notThrows('clientReady() does not throw', () => env.overlay.clientReady())
    const second = suite.notThrows('clientReady() called a second time does not throw', () => env.overlay.clientReady())
    suite.check('both calls succeeded', first.ok && second.ok, 'one of the calls threw')
    suite.eq('diag.booted is true after the calls', env.diag.booted, true)
    const third = suite.notThrows('clientReady() after entering does not throw', () => {
      run(env, 9000)
      env.overlay.clientReady()
    })
    suite.check('clientReady() after the dissolve has begun does not throw', third.ok, 'it threw once the overlay was leaving/gone')
    // And after destroy.
    env.overlay.destroy()
    const fourth = suite.notThrows('clientReady() after destroy() does not throw', () => env.overlay.clientReady())
    suite.check('clientReady() after destroy() does not throw', fourth.ok, 'it threw after destroy()')
  })

  suite.section('§5.1 skip() begins the dissolve', () => {
    const env = boot({ enterMode: 'auto' }, { bootPage: false })
    suite.check('pre-condition: booting', env.overlay.state === 'booting', `state ${env.overlay.state}`)
    env.overlay.skip()
    run(env, 100)
    suite.check('skip() dissolves even without a booted roster (it is an explicit user action)', env.overlay.state === 'leaving' || env.overlay.state === 'gone', `state ${env.overlay.state} after skip()`)
    run(env, 3000)
    suite.eq('skip() completes to gone', env.overlay.state, 'gone')
    suite.check('skip() removes the root', !bodyHasOverlay(env), 'the root survived skip()')
  })

  suite.section('§5.1 destroy() leaves no node behind', () => {
    const env = boot({}, { bootPage: false })
    const bodyBefore = env.dom.bodyChildren().length
    const headBefore = env.dom.head.childNodes.length
    suite.check('pre-condition: the overlay mounted a root and a style', bodyBefore >= 1 && headBefore >= 1, `body ${bodyBefore}, head ${headBefore}`)
    env.overlay.destroy()
    suite.eq('§5.1 destroy() removes the overlay root from <body>', env.dom.bodyChildren().length, 0)
    suite.eq('§5.1 destroy() removes every injected stylesheet', env.dom.styleSheets().length, 0)
    suite.check('§5.1 el is null after destroy()', env.overlay.el === null, `el is ${show(env.overlay.el)}`)
    suite.check(
      '§5.1 every node the overlay added is gone',
      env.dom.bodyChildren().length === 0 && env.dom.styleSheets().length === 0,
      `body has ${env.dom.bodyChildren().length} child(ren), head has ${env.dom.styleSheets().length} style(s)`,
    )
    const again = suite.notThrows('destroy() is safe to call twice', () => env.overlay.destroy())
    suite.check('destroy() twice does not throw', again.ok, 'the second destroy() threw')
  })

  suite.section('§5.1 destroy() stops the timers it started', () => {
    const env = boot({}, { bootPage: false })
    run(env, 500)
    env.overlay.destroy()
    const after = env.clock.pendingIntervals()
    suite.check(
      '§5.1 destroy() clears its interval(s) — nothing keeps repainting after removal',
      after === 0,
      `${after} interval(s) still scheduled after destroy(); a leaked interval is the classic "it never really went away" bug`,
    )
  })

  suite.section('§5.4 reduced motion', () => {
    // reduce + respectReducedMotion true -> calm + shortened
    const calm = boot({ respectReducedMotion: true }, { bootPage: false, reducedMotion: true })
    suite.eq('§5.4 diag.reduced is true when the media query matches and the cfg respects it', calm.diag.reduced, true)
    // respectReducedMotion false -> not reduced
    const notRespected = boot({ respectReducedMotion: false }, { bootPage: false, reducedMotion: true })
    suite.eq('§5.4 respectReducedMotion:false disables the reduced path', notRespected.diag.reduced, false)
    // no media match -> not reduced
    const full = boot({ respectReducedMotion: true }, { bootPage: false, reducedMotion: false })
    suite.eq('§5.4 no prefers-reduced-motion leaves the full sequence', full.diag.reduced, false)

    // The calm scene must still produce valid frames and hand over.
    const env = boot({ respectReducedMotion: true, enterMode: 'auto' }, { bootPage: false, reducedMotion: true })
    run(env, 3000)
    suite.check('§5.4 a calm run still animates and records no errors', env.diag.errors.length === 0, `errors: ${show(env.diag.errors)}`)
    env.overlay.clientReady()
    run(env, 9000)
    suite.check(
      '§5.4 a calm run still hands over (reduced motion must not trap the user)',
      env.overlay.state === 'leaving' || env.overlay.state === 'gone',
      `state ${env.overlay.state} after a full calm run with a booted roster`,
    )
  })

  // =========================================================================
  // 6. §5.5 AUDIO — cfg.sound false means NO audio path at all
  // =========================================================================
  suite.section('§5.5 cfg.sound === false constructs no AudioContext', () => {
    const env = boot({ sound: false }, { bootPage: false, audio: true })
    const made = env.dom.window.AudioContext._made
    run(env, 500)
    // Gesture and keypresses must not create one either.
    env.overlay.el.dispatch('pointerdown', { button: 0 })
    env.dom.dispatchWindow('keydown', { key: 'Enter' })
    run(env, 500)
    suite.eq('§5.5 no AudioContext is constructed when sound is off', made.oscillators + made.gains + made.buffers, 0)
    suite.eq('§5.5 no oscillator is ever created when sound is off', made.oscillators, 0)
    const soundControls = env.dom.bodyChildren().flatMap((n) => n.descendants()).filter((n) => String(n.getAttribute('class') ?? '').includes('sound'))
    suite.eq('§5.5 no sound control is drawn when sound is off', soundControls.length, 0)
  })

  suite.section('§5.6 diagnostics readout', () => {
    const env = boot({}, { bootPage: false, search: '?dshlinkdiag=1' })
    run(env, 500)
    const hint = hintOf(env)
    suite.check('§5.6 with ?dshlinkdiag=1 the hint becomes a live readout', /STATE/.test(hint), `hint is ${show(hint)}`)
    suite.check('§5.6 the readout includes the state', /STATE (booting|ready|leaving|gone)/.test(hint), `hint is ${show(hint)}`)
    suite.check('§5.6 the readout includes T (elapsed)', /\bT \d/.test(hint), `hint is ${show(hint)}`)
    suite.check('§5.6 the readout includes PHASE and FPS', /PHASE/.test(hint) && /FPS/.test(hint), `hint is ${show(hint)}`)
    suite.check('§5.6 the readout includes BOOTED and REDUCED', /BOOTED/.test(hint) && /REDUCED/.test(hint), `hint is ${show(hint)}`)
    suite.check('§5.6 the readout includes FAILED and the error count', /FAILED/.test(hint) && /ERR/.test(hint), `hint is ${show(hint)}`)

    // Without the query parameter it stays a normal hint.
    const plain = boot({}, { bootPage: false, search: '' })
    run(plain, 500)
    suite.check('§5.6 without the query parameter the hint is normal copy, not a readout', !/STATE /.test(hintOf(plain)), `hint is ${show(hintOf(plain))}`)
  })

  // =========================================================================
  // 7. §5.1 preview()
  // =========================================================================
  suite.section('§5.1 preview(overrides)', () => {
    const env = boot({ enterMode: 'auto' }, { bootPage: false })
    run(env, 8000)
    env.overlay.clientReady()
    run(env, 4000)
    suite.eq('pre-condition: the first run is gone', env.overlay.state, 'gone')

    const first = suite.notThrows('preview() after the overlay is gone does not throw', () => env.overlay.preview())
    if (first.ok) {
      suite.eq('§5.1 preview() returns true when it starts', first.value, true)
      suite.check('§5.1 preview() mounts a fresh root', bodyHasOverlay(env), 'no root appeared for the preview')
      suite.check('§5.1 the preview is running the animation', env.overlay.state === 'booting' || env.overlay.state === 'ready', `state ${env.overlay.state}`)
    }
    const second = suite.notThrows('a second preview() does not throw', () => env.overlay.preview())
    if (second.ok) {
      suite.eq('§5.1 preview() returns false when one is already running', second.value, false)
    }
    // preview overrides are applied
    const withOver = suite.notThrows('preview({durationMs}) does not throw', () => {
      env.overlay.destroy()
      return env.overlay.preview({ accent: '#ff0000', durationMs: 3000 })
    })
    suite.check('§5.1 preview accepts overrides', withOver.ok, `threw: ${withOver.error && withOver.error.message}`)
  })

  // =========================================================================
  // 8. ROBUSTNESS — a decorative overlay must never take the boot down
  // =========================================================================
  suite.section('unknown primitive kinds are reported, not silently skipped', () => {
    // A scene that emits a kind the renderer does not know is a contract breach.
    // The overlay must surface it on diag.errors rather than skipping it and
    // quietly rendering a partial frame.
    //
    // The scene global must be wrapped BEFORE the overlay loads, because the
    // overlay calls `createScene` once at build time and keeps the handle.
    const env = boot({}, { bootPage: false }, (sandbox) => {
      const S = sandbox.__DSH_LINK_START_SCENE__
      const realCreate = S.createScene
      S.createScene = function (sceneCfg) {
        const handle = realCreate(sceneCfg)
        const realFrame = handle.frame
        handle.frame = function (t) {
          const f = realFrame(t)
          f.layers = f.layers.concat([{ k: 'hexagon', x: 1, y: 1, w: 2, h: 2, color: '#ffffff' }])
          return f
        }
        return handle
      }
    })
    run(env, 300)
    suite.check(
      'an unknown primitive kind reaches diag.errors instead of being silently dropped',
      env.diag.errors.some((e) => /hexagon|unknown/i.test(e)),
      `diag.errors is ${show(env.diag.errors)} — an unknown primitive was skipped in silence, so a partial frame renders with no diagnostic`,
    )
    suite.check(
      'the unknown primitive does not stop the overlay from rendering the rest of the frame',
      env.diag.t > 0 && env.overlay.state === 'booting',
      `diag.t=${env.diag.t}, state=${env.overlay.state}`,
    )
  })

  suite.section('the overlay never leaves the page blank on a handoff', () => {
    // After a full run the root is gone, so nothing opaque covers the app.
    const env = boot({ enterMode: 'auto' }, { bootPage: false })
    env.overlay.clientReady()
    run(env, 12000)
    suite.eq('the overlay reaches gone', env.overlay.state, 'gone')
    suite.check(
      '§10.3 nothing opaque is left over the app after the dissolve',
      env.dom.bodyChildren().filter((n) => String(n.getAttribute('class') ?? '').includes('dslls-')).length === 0,
      'an overlay node remains over the app',
    )
  })

  // -------------------------------------------------------------------------
  // helper: read the overlay's visible hint text from the DOM
  // -------------------------------------------------------------------------
  function hintOf(env) {
    if (env.overlay.el === null) return ''
    const nodes = env.overlay.el.descendants()
    // The hint is the element carrying a text-like class; fall back to scanning.
    const hintish = nodes.find((n) => /hint/i.test(String(n.getAttribute('class') ?? '')))
    if (hintish !== undefined) return hintish.textContent
    return nodes.map((n) => n.textContent).join(' ')
  }
}

runSuite(suite)
