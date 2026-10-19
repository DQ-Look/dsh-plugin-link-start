/**
 * dsh-link-start — the pre-boot overlay.
 *
 * Injected as script *text* into <head> by `index.js`, immediately after
 * `src/scene.js` and after the `__DSH_LINK_START_CFG__` global row. On the Web
 * surface this runs as a parser-blocking classic script, so it owns the viewport
 * before the shell module builds the kernel's own boot page. On the desktop
 * surface the injection table is applied later (see INTERFACES.md §9b), so this
 * script mounts *over* an already-created boot page instead. Both orderings are
 * supported and neither is assumed: this file never requires that it was first.
 *
 * It is deliberately framework-free. It needs no React, touches no shell module
 * table, and must keep working even if the UI renderer never mounts — that is what
 * makes it able to cover a boot that is still in progress.
 *
 * THE HANDOFF RULE (§5.2), which is the one thing here that must not be got wrong:
 * the dissolve begins when the timeline is done AND `clientReady()` has been
 * called. Whichever of the two finishes second is what releases it. `holdMs` may
 * change the wording but must NEVER auto-enter, because that would reveal a
 * half-built application. A kernel FAILURE is the one deliberate override (§5.2a):
 * there is no application to protect, and an opaque overlay hiding a startup
 * diagnosis is worse than unwanted motion, so the overlay gets out of the way.
 */
;(function () {
  'use strict'

  var OVERLAY = '__DSH_LINK_START__'
  var DIAG = '__DSH_LINK_START_DIAG__'

  var scene = globalThis.__DSH_LINK_START_SCENE__
  var cfg = globalThis.__DSH_LINK_START_CFG__

  // Grace before a detected kernel failure hands over. Not configurable: a user
  // should not be tuning how fast a failure is revealed.
  var FAILURE_GRACE_MS = 600

  // A timeline whose length is unknown would never fire `ended`; this bounds the
  // `done` check for a degenerate duration and nothing else.
  var MIN_DURATION_MS = 300

  // Kernel boot progress: the spinner's arc custom property runs 72deg (no active
  // entries) to 288deg (all active).
  var ARC_MIN = 72
  var ARC_SPAN = 216

  // Bail out unless the scene and config both arrived, and never install twice.
  // A missing piece means the host half contributed nothing for it, in which case
  // the kernel's own boot page is the only screen and there is nothing to cover.
  if (scene === undefined || scene === null || typeof scene.createScene !== 'function') return
  if (cfg === undefined || cfg === null || typeof cfg !== 'object') return
  if (globalThis[OVERLAY] !== undefined) return

  // --- time -----------------------------------------------------------------
  // The clock is injectable (`cfg.now`) so the verification suite can step time
  // deterministically without sleeping. Correctness never depends on a timer
  // firing: animation frames only *offer* ticks, and every decision reads `now()`.
  var injectedNow = typeof cfg.now === 'function' ? cfg.now : null
  function now() {
    if (injectedNow !== null) {
      var v = injectedNow()
      return typeof v === 'number' && isFinite(v) ? v : 0
    }
    return Date.now()
  }

  // --- diagnostics ----------------------------------------------------------
  var diag = {
    state: 'booting',
    t: 0,
    phase: '-',
    fps: 0,
    booted: false,
    reduced: false,
    failed: false,
    progress: 0,
    errors: []
  }
  globalThis[DIAG] = diag

  function noteError(label, error) {
    try {
      diag.errors.push(label + ': ' + String(error && error.message ? error.message : error))
      // A decorative overlay must never take the boot down.
      console.warn('dsh-link-start: ' + label, error)
    } catch (ignored) { /* nothing left to report with */ }
  }

  // --- runtime state --------------------------------------------------------
  var root = null
  var canvas = null
  var ctx2d = null
  var fillBar = null
  var hintEl = null
  var titleEl = null
  var soundBtn = null
  var progressSource = null
  var progressObserver = null
  var failureObserver = null
  var rafId = 0
  var holdTimer = 0
  var failureTimer = 0
  var entered = false
  var failureDetected = false
  var timer = null
  var watchTimers = []
  var handle = null
  var startedAt = 0
  var bootedAt = null
  var lastFrameAt = 0
  var fpsAccum = 0
  var fpsCount = 0
  var hintText = ''
  var audio = null
  var audioUnlocked = false
  var previewActive = false
  var previewDone = null

  // --- viewport -------------------------------------------------------------
  var viewW = 1
  var viewH = 1
  var scale = 1
  var offX = 0
  var offY = 0
  var dpr = 1

  /** Whether the user asked for reduced motion and the config honours it. */
  function wantsReducedMotion() {
    if (settings.respectReducedMotion !== true) return false
    try {
      return typeof globalThis.matchMedia === 'function'
        && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches === true
    } catch (ignored) {
      return false
    }
  }

  /** The effective settings for this run: config, plus the motion decision. */
  var settings = normalize(cfg)
  var reduced = wantsReducedMotion()
  settings.motion = reduced ? 'calm' : 'full'
  diag.reduced = reduced

  /** Normalize the broadcast config through the scene's own normalizer. */
  function normalize(raw) {
    try {
      return scene.normalizeConfig(raw)
    } catch (error) {
      noteError('normalizeConfig', error)
      return scene.normalizeConfig(undefined)
    }
  }

  // --- scene handle ---------------------------------------------------------
  var sceneHandle = null
  function rebuildScene(overrides) {
    var merged = {}
    var base = overrides !== undefined && overrides !== null ? overrides : settings
    for (var k in settings) if (Object.prototype.hasOwnProperty.call(settings, k)) merged[k] = settings[k]
    for (var j in base) if (Object.prototype.hasOwnProperty.call(base, j)) merged[j] = base[j]
    merged.motion = reduced ? 'calm' : 'full'
    settings = normalize(merged)
    sceneHandle = scene.createScene(settings)
    duration = sceneHandle.duration
  }
  var duration = 0
  rebuildScene()

  // --- audio ----------------------------------------------------------------
  // A short synthesized chime. No asset, no fetch, and no AudioContext at all
  // when sound is off — "off" is the absence of every audio path, not a muted
  // playback that still constructs one.
  var AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext || null

  function ensureAudio() {
    if (settings.sound !== true) return null
    if (audio !== null) return audio
    if (AudioCtor === null) return null
    try {
      audio = new AudioCtor()
      return audio
    } catch (error) {
      noteError('audio context', error)
      return null
    }
  }

  /** Play the start-up chime: two oscillators over a filtered noise swell. */
  function chime() {
    var ac = ensureAudio()
    if (ac === null) return false
    try {
      if (ac.state === 'suspended' && typeof ac.resume === 'function') ac.resume()
      var t0 = ac.currentTime
      var out = ac.createGain()
      out.gain.setValueAtTime(0.0001, t0)
      out.gain.exponentialRampToValueAtTime(0.22, t0 + 0.04)
      out.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9)
      out.connect(ac.destination)

      var tones = [[523.25, 0], [783.99, 0.07], [1046.5, 0.15]]
      for (var i = 0; i < tones.length; i++) {
        var osc = ac.createOscillator()
        var g = ac.createGain()
        osc.type = i === 0 ? 'sine' : 'triangle'
        osc.frequency.setValueAtTime(tones[i][0], t0 + tones[i][1])
        g.gain.setValueAtTime(0.0001, t0 + tones[i][1])
        g.gain.exponentialRampToValueAtTime(0.5, t0 + tones[i][1] + 0.03)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + tones[i][1] + 0.55)
        osc.connect(g)
        g.connect(out)
        osc.start(t0 + tones[i][1])
        osc.stop(t0 + tones[i][1] + 0.7)
      }

      // A filtered noise swell underneath, for the "system powering up" texture.
      var frames = Math.max(1, Math.floor(ac.sampleRate * 0.5))
      var buffer = ac.createBuffer(1, frames, ac.sampleRate)
      var data = buffer.getChannelData(0)
      for (var n = 0; n < frames; n++) {
        data[n] = (Math.random() * 2 - 1) * (1 - n / frames)
      }
      var noise = ac.createBufferSource()
      noise.buffer = buffer
      var filter = ac.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.setValueAtTime(320, t0)
      filter.frequency.exponentialRampToValueAtTime(2600, t0 + 0.5)
      var ng = ac.createGain()
      ng.gain.setValueAtTime(0.0001, t0)
      ng.gain.exponentialRampToValueAtTime(0.08, t0 + 0.08)
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5)
      noise.connect(filter)
      filter.connect(ng)
      ng.connect(out)
      noise.start(t0)
      return true
    } catch (error) {
      noteError('chime', error)
      return false
    }
  }

  function closeAudio() {
    if (audio === null) return
    var ac = audio
    audio = null
    try {
      if (typeof ac.close === 'function') ac.close()
    } catch (ignored) { /* already closed */ }
  }

  // --- handoff --------------------------------------------------------------
  /**
   * Dissolve and hand over.
   *
   * The whole overlay fades as one unit — art, chrome and background together —
   * and is then removed. Nothing here outlives the fade, so the app is never left
   * covered by anything.
   */
  function enter(reason) {
    if (entered) return
    entered = true
    setState('leaving')
    diag.state = 'leaving'
    stopLoop()
    stopTimers()
    stopWatching()
    if (failureTimer !== 0) { clearTimeout(failureTimer); failureTimer = 0 }

    var span = Math.max(120, Math.min(settings.fadeMs, 4000))
    if (reduced) span = Math.min(span, 500)
    if (root !== null) root.style.transitionDuration = (span / 1000) + 's'

    // Give the browser one frame to see the transition, then let it run. A
    // transition started in the same frame as the class change can be skipped.
    setTimeout(function () {
      if (root !== null && root.parentNode !== null) root.parentNode.removeChild(root)
      root = null
      handle.el = null
      removeStyle()
      diag.state = 'gone'
      if (previewActive) {
        previewActive = false
        var done = previewDone
        previewDone = null
        if (typeof done === 'function') {
          try { done() } catch (error) { noteError('preview onDone', error) }
        }
      }
    }, span + 80)
  }

  /**
   * The hint for a run that is still waiting, honouring `holdMs`.
   *
   * `holdMs` is an escalation, not a deadline: before it elapses the hint is the
   * ordinary press affordance, after it the wording admits the start is slow. It is
   * recomputed rather than latched so that `clientReady()` can put the ordinary
   * wording back when the roster finally catches up — a screen that keeps saying
   * "slow start" after it entered would be wrong, and a screen that overwrote the
   * press affordance with a status line would stop telling the user what to do.
   */
  function waitingHint() {
    var slow = now() - startedAt >= settings.holdMs
    if (slow) return 'SLOW START - PRESS TO CONTINUE'
    return defaultHint()
  }

  /**
   * Apply the waiting wording and the amber attention state together, so the two can
   * never disagree.
   */
  function refreshWaiting() {
    if (entered || failureDetected) return
    var slow = now() - startedAt >= settings.holdMs && bootedAt === null
    setAttention(slow)
    setHint(slow ? 'SLOW START - PRESS TO CONTINUE' : defaultHint())
  }

  /**
   * Evaluate the handoff condition.
   *
   * Called from the frame loop, from `clientReady()`, and from the kernel-failure
   * watcher — because either side of the condition can be the last one to arrive.
   * @returns true when the overlay has begun (or already begun) leaving, so a caller
   *   can stop drawing. False means "still waiting; keep the loop alive".
   */
  function maybeEnter(t) {
    if (entered) return true
    // §5.2a: a kernel failure overrides everything, including click mode.
    if (failureDetected) {
      if (failureTimer === 0) {
        failureTimer = setTimeout(function () { enter('kernel-failure') }, FAILURE_GRACE_MS)
      }
      return true
    }
    var timelineDone = t >= duration
    if (settings.enterMode === 'click') {
      refreshWaiting()
      return false            // a gesture is the only way out
    }
    if (!timelineDone) return false
    if (bootedAt === null) {
      // Not an error yet: a slow boot usually resolves, and flashing a warning for
      // it would cry wolf. `refreshWaiting` owns the wording and the amber state.
      refreshWaiting()
      return false
    }
    enter('timeline-and-boot')
    return true
  }

  // --- DOM ------------------------------------------------------------------
  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className !== undefined && className !== null) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function setState(value) {
    diag.state = value
    if (root !== null) root.setAttribute('data-state', value)
  }

  function setHint(text) {
    hintText = text
    if (hintEl !== null) hintEl.textContent = text
  }

  function setAttention(on) {
    if (root !== null) root.setAttribute('data-attention', on ? '1' : '0')
  }

  /** Repaint the sound button from the audio state rather than from the click. */
  function renderSound(hint) {
    if (soundBtn === null) return
    var audible = audioUnlocked
    soundBtn.textContent = audible ? '\uD83D\uDD0A' : '\uD83D\uDD07'
    soundBtn.title = hint || (audible ? 'MUTE' : 'UNMUTE')
    soundBtn.setAttribute('aria-pressed', audible ? 'true' : 'false')
  }

  function build() {
    var node = el('div', 'dslls-root')
    node.setAttribute('role', 'dialog')
    node.setAttribute('aria-label', 'LINK START')
    node.setAttribute('data-state', 'booting')
    node.setAttribute('data-hint', settings.showHint === false ? '0' : '1')
    node.setAttribute('data-attention', '0')
    node.setAttribute('data-diag', diagnosticsOn() ? '1' : '0')
    node.setAttribute('data-reduced', reduced ? '1' : '0')

    var cv = el('canvas', 'dslls-canvas')

    var hud = el('div', 'dslls-hud')
    var ttl = el('div', 'dslls-title', 'DEEPSEEK HARNESS')
    var bar = el('div', 'dslls-bar')
    var fill = el('div', 'dslls-fill')
    bar.appendChild(fill)
    var hint = el('div', 'dslls-hint', '')
    hud.appendChild(ttl)
    hud.appendChild(bar)
    hud.appendChild(hint)
    node.appendChild(cv)
    node.appendChild(hud)

    var sound = null
    if (settings.sound === true) {
      sound = el('button', 'dslls-sound')
      sound.type = 'button'
      sound.setAttribute('aria-label', 'Sound')
      sound.textContent = '\uD83D\uDD07'
      sound.addEventListener('pointerdown', function (event) { event.stopPropagation() }, true)
      sound.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        toggleSound()
      })
      node.appendChild(sound)
    }

    return { root: node, canvas: cv, fill: fill, hint: hint, title: ttl, sound: sound }
  }

  /** The stylesheet element this overlay installed, if it owns one. */
  var styleEl = null

  /**
   * Whether the overlay's chrome is already dressed on this page.
   *
   * The host half injects the real stylesheet as a `style` row, and that row is
   * ordinary CSS with no identifying attribute, so it cannot be found by id. The
   * check is therefore on CONTENT: any style element already carrying a `.dslls-`
   * rule means the chrome is present, whoever put it there.
   *
   * Content-based rather than id-based on purpose. Testing only for this file's own
   * id meant that with the host's row present the page carried TWO definitions of
   * every `.dslls-` rule — the host's and this fallback — which is harmless today
   * only because the later one wins on order. Two sources of one stylesheet that can
   * drift apart is not a thing to leave in place because it currently happens to
   * work.
   * @returns true when a `.dslls-` stylesheet is already in the document.
   */
  function chromeAlreadyStyled() {
    var doc = globalThis.document
    if (doc === null || doc === undefined || !doc.getElementById) return false
    if (doc.getElementById('dslls-style') !== null) return true
    var head = doc.head
    if (head === null || head === undefined || !head.childNodes) return false
    var kids = head.childNodes
    for (var i = 0; i < kids.length; i++) {
      var node = kids[i]
      if (node === null || node === undefined) continue
      if (String(node.tagName || '').toUpperCase() !== 'STYLE') continue
      var text = node.textContent
      if (typeof text === 'string' && text.indexOf('.dslls-') >= 0) return true
    }
    return false
  }

  /**
   * Install the overlay's chrome CSS, unless the page already has it.
   *
   * The host half normally supplies this as a `style` row, so on a real DSH page this
   * is a no-op. It exists for the two paths where that row is genuinely absent: a
   * page whose injection table was assembled before this file existed, and a
   * hand-authored page that loads the three sources directly. The element is
   * remembered so `destroy()` hands the document back exactly as it found it — an
   * overlay that leaves a stylesheet behind on every preview cycle is a leak that
   * grows for the life of the page.
   */
  function ensureStyle() {
    if (chromeAlreadyStyled()) return
    var doc = globalThis.document
    if (doc === null || doc === undefined) return
    if (!doc.head) return
    var style = doc.createElement('style')
    style.id = 'dslls-style'
    style.setAttribute('data-dslls', '1')
    style.textContent = styleSheet()
    doc.head.appendChild(style)
    styleEl = style
  }

  /** Remove the stylesheet this overlay installed, if it installed one. */
  function removeStyle() {
    if (styleEl === null) return
    var node = styleEl
    styleEl = null
    try {
      if (node.parentNode !== null && node.parentNode !== undefined) node.parentNode.removeChild(node)
    } catch (ignored) { /* already detached by the host */ }
  }

  /** Overlay chrome CSS, inlined so the screen is self-sufficient. */
  function styleSheet() {
    return [
      '.dslls-root{position:fixed;inset:0;z-index:2147483647;overflow:hidden;margin:0;',
      'background:#000;color:#dbeaf7;cursor:pointer;opacity:1;',
      'font-family:system-ui,-apple-system,Segoe UI,Microsoft YaHei,sans-serif;',
      '-webkit-user-select:none;user-select:none;transition:opacity 900ms ease}',
      '.dslls-root[data-state="leaving"]{opacity:0;pointer-events:none}',
      '.dslls-canvas{position:absolute;inset:0;display:block;width:100%;height:100%}',
      '.dslls-hud{position:absolute;left:0;right:0;bottom:0;padding:26px 30px 24px;',
      'display:flex;flex-direction:column;gap:9px;align-items:center;pointer-events:none;',
      'text-shadow:0 1px 10px rgba(0,0,0,.7)}',
      '.dslls-title{font-size:12px;letter-spacing:.34em;font-weight:600;',
      'text-transform:uppercase;color:#9fc4e6;opacity:.92}',
      '.dslls-bar{position:relative;width:min(340px,54vw);height:2px;border-radius:2px;',
      'background:rgba(159,196,230,.22);overflow:hidden}',
      '.dslls-fill{position:absolute;inset:0 auto 0 0;width:0%;border-radius:2px;',
      'background:linear-gradient(90deg,#4f9dd9,#8fd8ff);',
      'box-shadow:0 0 12px rgba(143,216,255,.75);transition:width .45s ease}',
      '.dslls-hint{font-size:12px;letter-spacing:.12em;color:#8fb3d4;opacity:0;',
      'transition:opacity .5s ease;text-align:center}',
      '.dslls-root[data-state="ready"] .dslls-hint{opacity:.95}',
      '.dslls-root[data-attention="1"] .dslls-hint{opacity:1;color:#ffd79a;letter-spacing:.04em}',
      '.dslls-root[data-attention="1"] .dslls-fill{background:linear-gradient(90deg,#d99a4f,#ffd79a)}',
      '.dslls-root[data-hint="0"] .dslls-hint{display:none}',
      '.dslls-root[data-diag="1"] .dslls-hint{display:block;opacity:1;color:#9fe8b0;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;',
      'letter-spacing:0;line-height:1.6;word-break:break-word;max-width:min(900px,92vw)}',
      '.dslls-sound{position:absolute;right:22px;bottom:22px;z-index:2;cursor:pointer;',
      'width:38px;height:38px;padding:0;display:flex;align-items:center;justify-content:center;',
      'font-size:16px;line-height:1;border-radius:999px;color:#cfe4f6;',
      'background:rgba(12,26,42,.62);border:1px solid rgba(159,196,230,.38);',
      'transition:opacity .4s ease,background .2s ease}',
      '.dslls-root[data-state="leaving"] .dslls-sound{opacity:0;pointer-events:none}'
    ].join('')
  }

  function diagnosticsOn() {
    try {
      return String(globalThis.location && globalThis.location.search).indexOf('dshlinkdiag=1') >= 0
    } catch (ignored) {
      return false
    }
  }

  // --- canvas ---------------------------------------------------------------
  function sizeCanvas() {
    if (canvas === null) return
    var dw = globalThis.innerWidth || 1600
    var dh = globalThis.innerHeight || 900
    viewW = dw
    viewH = dh
    // Cap the ratio: a 4K display at dpr 3 would triple the pixel count for no
    // visible gain, and this runs during boot alongside everything else.
    dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
    var W = Math.round(dw * dpr)
    var H = Math.round(dh * dpr)
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W
      canvas.height = H
    }
    // COVER the viewport: scale by the larger ratio and centre, so the design
    // space bleeds off the short axis rather than letterboxing.
    scale = Math.max(dw / scene.DESIGN.W, dh / scene.DESIGN.H)
    offX = (dw - scene.DESIGN.W * scale) / 2
    offY = (dh - scene.DESIGN.H * scale) / 2
  }

  function hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16)
    ]
  }

  function rgba(hex, alpha) {
    var c = hexToRgb(hex)
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (alpha < 0 ? 0 : alpha > 1 ? 1 : alpha) + ')'
  }

  /**
   * Draw one primitive.
   *
   * The closed set of §4.4 — nothing more. The storyboard rasterizer implements the
   * same set, so drawing anything the frame did not ask for would make the
   * storyboard a lie rather than a preview.
   */
  function drawPrimitive(p) {
    var alpha = typeof p.alpha === 'number' ? p.alpha : 1
    if (!(alpha > 0)) return
    switch (p.k) {
      case 'fill':
        ctx2d.globalAlpha = 1
        ctx2d.fillStyle = p.color
        ctx2d.fillRect(0, 0, viewW, viewH)
        return
      case 'rect':
      case 'bar': {
        ctx2d.globalAlpha = alpha
        ctx2d.fillStyle = p.color
        if (typeof p.radius === 'number' && p.radius > 0 && typeof ctx2d.roundRect === 'function') {
          ctx2d.beginPath()
          ctx2d.roundRect(p.x, p.y, p.w, p.h, p.radius)
          ctx2d.fill()
        } else {
          ctx2d.fillRect(p.x, p.y, p.w, p.h)
        }
        return
      }
      case 'line':
        ctx2d.globalAlpha = alpha
        ctx2d.strokeStyle = p.color
        ctx2d.lineWidth = typeof p.width === 'number' ? p.width : 1
        ctx2d.setLineDash([])
        ctx2d.beginPath()
        ctx2d.moveTo(p.x1, p.y1)
        ctx2d.lineTo(p.x2, p.y2)
        ctx2d.stroke()
        return
      case 'poly': {
        if (!p.points || p.points.length === 0) return
        ctx2d.globalAlpha = alpha
        ctx2d.beginPath()
        ctx2d.moveTo(p.points[0][0], p.points[0][1])
        for (var i = 1; i < p.points.length; i++) ctx2d.lineTo(p.points[i][0], p.points[i][1])
        if (p.close === true || p.fill === true) ctx2d.closePath()
        if (p.fill === true) {
          ctx2d.fillStyle = p.color
          ctx2d.fill()
        } else {
          ctx2d.strokeStyle = p.color
          ctx2d.lineWidth = typeof p.width === 'number' ? p.width : 1
          ctx2d.setLineDash([])
          ctx2d.stroke()
        }
        return
      }
      case 'circle': {
        ctx2d.globalAlpha = alpha
        ctx2d.beginPath()
        ctx2d.arc(p.cx, p.cy, Math.max(0, p.r), 0, Math.PI * 2)
        if (p.fill === true) {
          ctx2d.fillStyle = p.color
          ctx2d.fill()
        } else {
          ctx2d.strokeStyle = p.color
          ctx2d.lineWidth = typeof p.width === 'number' ? p.width : 1
          if (p.dash && p.dash.length > 0) {
            ctx2d.setLineDash(p.dash)
            // A dash pattern is measured from the path start; rotating the phase
            // is what makes the counter-rotating rings visibly turn.
            ctx2d.lineDashOffset = typeof p.rot === 'number' ? p.rot * p.r * 0.35 : 0
          } else {
            ctx2d.setLineDash([])
            ctx2d.lineDashOffset = 0
          }
          ctx2d.stroke()
          ctx2d.setLineDash([])
          ctx2d.lineDashOffset = 0
        }
        return
      }
      case 'arc':
        ctx2d.globalAlpha = alpha
        ctx2d.strokeStyle = p.color
        ctx2d.lineWidth = typeof p.width === 'number' ? p.width : 1
        ctx2d.setLineDash([])
        ctx2d.beginPath()
        ctx2d.arc(p.cx, p.cy, Math.max(0, p.r), p.from, p.to)
        ctx2d.stroke()
        return
      case 'text':
        drawText(p, p.x, p.y, p.color, alpha)
        return
      default:
        // An unknown primitive is a contract violation, not something to skip
        // silently: the storyboard would then disagree with the browser, and a
        // partial frame would render with nothing anywhere saying why. Reported to
        // diagnostics AND the console, once per kind.
        {
          var label = 'unknown primitive ' + String(p.k)
          if (diag.errors.indexOf(label) < 0) {
            diag.errors.push(label)
            console.warn('dsh-link-start: ' + label + ' (frame is incomplete)')
          }
        }
    }
  }

  /** Draw text with `align`, `spacing`, `weight` and `mono` honoured. */
  function drawText(spec, x, y, color, alpha) {
    var text = typeof spec.text === 'string' ? spec.text : ''
    if (text === '') return
    var size = typeof spec.size === 'number' ? spec.size : 14
    if (!(size > 0)) return
    var align = spec.align === 'center' || spec.align === 'right' ? spec.align : 'left'
    var weight = spec.weight === 'bold' ? 'bold' : 'normal'
    var family = spec.mono === true
      ? 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
      : 'system-ui,-apple-system,Segoe UI,Microsoft YaHei,sans-serif'
    ctx2d.globalAlpha = alpha
    ctx2d.fillStyle = color
    ctx2d.textAlign = align
    ctx2d.textBaseline = 'alphabetic'
    ctx2d.font = weight + ' ' + size + 'px ' + family
    var spacing = typeof spec.spacing === 'number' ? spec.spacing : 0
    if (spacing !== 0 && 'letterSpacing' in ctx2d) {
      ctx2d.letterSpacing = (spacing * scale) + 'px'
    }
    ctx2d.fillText(text, x, y)
    if (spacing !== 0 && 'letterSpacing' in ctx2d) ctx2d.letterSpacing = '0px'
  }

  /** Paint one frame's display list, in the pinned composition order. */
  function paint(frame) {
    sizeCanvas()
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx2d.clearRect(0, 0, viewW, viewH)

    // Uniform jitter for the whole frame, derived from `t` so it stays
    // deterministic and never uses Math.random.
    ctx2d.save()
    if (frame.shake > 0) {
      ctx2d.translate((Math.sin(frame.t / 37) * frame.shake), (Math.cos(frame.t / 53) * frame.shake))
    }
    ctx2d.translate(offX, offY)
    ctx2d.scale(scale, scale)

    // 1. background, then 2. layers, in order.
    ctx2d.globalAlpha = 1
    ctx2d.fillStyle = frame.background
    ctx2d.fillRect(-offX / scale, -offY / scale, viewW / scale, viewH / scale)
    for (var i = 0; i < frame.layers.length; i++) drawPrimitive(frame.layers[i])

    // 3. flash — additive white bloom over the art.
    if (frame.flash > 0) {
      ctx2d.setLineDash([])
      ctx2d.globalAlpha = Math.min(frame.flash, 1)
      ctx2d.fillStyle = '#ffffff'
      ctx2d.fillRect(-offX / scale, -offY / scale, viewW / scale, viewH / scale)
    }

    // 4. vignette — radial edge darkening.
    if (frame.vignette > 0) {
      var vx = scene.DESIGN.W / 2
      var vy = scene.DESIGN.H / 2
      var outer = Math.max(scene.DESIGN.W, scene.DESIGN.H) * 0.78
      var grad = ctx2d.createRadialGradient(vx, vy, outer * 0.42, vx, vy, outer)
      grad.addColorStop(0, 'rgba(0,0,0,0)')
      grad.addColorStop(1, rgba('#000000', Math.min(frame.vignette, 1)))
      ctx2d.globalAlpha = 1
      ctx2d.fillStyle = grad
      ctx2d.fillRect(-offX / scale, -offY / scale, viewW / scale, viewH / scale)
    }

    // 5. scanlines.
    if (frame.scanlines > 0) {
      ctx2d.globalAlpha = Math.min(frame.scanlines, 1)
      ctx2d.fillStyle = '#000000'
      var step = 3 / scale
      for (var sy = 0; sy < scene.DESIGN.H; sy += step * 3) {
        ctx2d.fillRect(0, sy, scene.DESIGN.W, step)
      }
    }

    // 6. wordmark.
    var wm = frame.wordmark
    if (wm !== null && wm !== undefined && typeof wm === 'object') {
      var wmAlpha = typeof wm.alpha === 'number' ? wm.alpha : 1
      var glitch = typeof wm.glitch === 'number' ? Math.min(Math.max(wm.glitch, 0), 1) : 0
      var off = glitch > 0 ? 1 + glitch * 3 : 0
      if (off > 0 && settings.glitch !== false && !reduced) {
        drawText(wm, wm.x - off, wm.y, '#ff2a2a', wmAlpha * 0.42)
        drawText(wm, wm.x + off, wm.y, '#2a6aff', wmAlpha * 0.42)
      }
      drawText(wm, wm.x, wm.y, '#ffffff', wmAlpha)
    }

    // 7. telemetry.
    var tel = frame.telemetry
    if (tel !== null && tel !== undefined && tel.length > 0) {
      for (var n = 0; n < tel.length; n++) {
        var e = tel[n]
        drawText(e, e.x, e.y, typeof e.color === 'string' ? e.color : settings.accent,
          typeof e.alpha === 'number' ? e.alpha : 1)
      }
    }

    ctx2d.setLineDash([])
    ctx2d.globalAlpha = 1
    ctx2d.restore()
  }

  // --- progress -------------------------------------------------------------
  /**
   * Read the kernel's own boot progress, or drive the bar from the timeline.
   *
   * `--dsh-boot-arc` is written on the boot card's spinner: 72deg with no active
   * entries, 288deg with all of them. On the Web surface the boot page does not
   * exist yet when this runs; on desktop it already does. Both orderings are
   * handled by reading now if it is there and then keeping watch.
   */
  function readProgress() {
    if (progressSource === null) return null
    var raw = parseFloat(progressSource.style.getPropertyValue('--dsh-boot-arc'))
    if (!isFinite(raw)) return null
    return Math.min(Math.max((raw - ARC_MIN) / ARC_SPAN, 0), 1)
  }

  function startWatching() {
    var doc = globalThis.document
    if (doc === undefined || doc === null) return

    // Two independent concerns, deliberately decoupled:
    //
    //   1. the progress source (the spinner's `--dsh-boot-arc`), and
    //   2. the failure text on the boot card.
    //
    // They are NOT one condition. Requiring the spinner before watching for a failure
    // would miss a boot that fails before it ever renders one — which is exactly the
    // failure worth catching. So the observer attaches to whatever exists, and the
    // progress source is picked up separately when and if it appears.
    var attach = function () {
      var boot = doc.querySelector('[data-dsh-boot]')
      if (boot === null) return false

      if (failureObserver === null && typeof MutationObserver === 'function') {
        failureObserver = new MutationObserver(function () { checkFailure(boot) })
        failureObserver.observe(boot, { childList: true, subtree: true, characterData: true })
      }
      checkFailure(boot)

      var spinner = boot.querySelector('[data-dsh-boot-spinner]')
      if (spinner !== null && progressSource !== spinner) {
        if (progressObserver !== null) progressObserver.disconnect()
        progressSource = spinner
        if (typeof MutationObserver === 'function') {
          progressObserver = new MutationObserver(function () { paintProgress() })
          progressObserver.observe(spinner, { attributes: true, attributeFilter: ['style'] })
        }
        paintProgress()
      }
      // Fully attached only once both halves are present; until then keep polling so
      // a boot page that is built in stages is still picked up.
      return spinner !== null
    }

    if (attach()) return
    // Not there yet (Web ordering): poll briefly, then stop and let the timeline drive
    // the bar. Polling stops as soon as both halves attach.
    var tries = 0
    var timer = setInterval(function () {
      tries += 1
      if (attach() || tries > 200) clearInterval(timer)
    }, 25)
    watchTimers.push(timer)
  }

  function stopWatching() {
    if (progressObserver !== null) { progressObserver.disconnect(); progressObserver = null }
    if (failureObserver !== null) { failureObserver.disconnect(); failureObserver = null }
    for (var i = 0; i < watchTimers.length; i++) clearInterval(watchTimers[i])
    watchTimers = []
  }

  function checkFailure(boot) {
    if (failureDetected || boot === null) return
    var text = boot.textContent || ''
    if (text.indexOf('Failed to load plugins') < 0 && text.indexOf('did not activate') < 0) return
    failureDetected = true
    diag.failed = true
    setAttention(true)
    setHint('DSH FAILED TO START - SHOWING THE ERROR')
    // §5.2a: reveal the diagnosis. maybeEnter schedules the grace.
    maybeEnter(diag.t)
  }

  function paintProgress() {
    if (fillBar === null) return
    var ratio = readProgress()
    if (ratio === null) {
      // Fall back to the timeline so the bar is never stuck at zero.
      ratio = duration > 0 ? Math.min(Math.max(diag.t / duration, 0), 1) : 0
    }
    diag.progress = ratio
    fillBar.style.width = (ratio * 100).toFixed(1) + '%'
  }

  // --- loop -----------------------------------------------------------------
  function stopLoop() {
    if (rafId !== 0) {
      if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(rafId)
      else clearTimeout(rafId)
      rafId = 0
    }
  }

  function stopTimers() {
    if (holdTimer !== 0) { clearTimeout(holdTimer); holdTimer = 0 }
    for (var i = 0; i < watchTimers.length; i++) clearInterval(watchTimers[i])
    watchTimers = []
  }

  /** Schedule the next tick. A frame *offers* a tick; it never defines time. */
  function schedule(fn) {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      rafId = globalThis.requestAnimationFrame(fn)
    } else {
      rafId = setTimeout(function () { fn(now()) }, 16)
    }
  }

  function tick() {
    rafId = 0
    if (entered) return
    try {
      var elapsed = now() - startedAt
      if (elapsed < 0) elapsed = 0

      // Click mode loops the sequence; every other mode runs once and holds.
      var t = settings.enterMode === 'click' ? elapsed % duration : elapsed
      diag.t = t

      var frame = sceneHandle.frame(t)
      diag.phase = frame.phaseLabel
      paint(frame)
      paintProgress()

      // FPS, for the diagnostic readout only.
      if (lastFrameAt !== 0) {
        var delta = now() - lastFrameAt
        if (delta > 0) {
          fpsAccum += 1000 / delta
          fpsCount += 1
          if (fpsCount >= 15) { diag.fps = Math.round(fpsAccum / fpsCount); fpsAccum = 0; fpsCount = 0 }
        }
      }
      lastFrameAt = now()

      if (diagnosticsOn()) renderDiagnostics()

      // The handoff is evaluated on every tick and must never be skipped because a
      // later tick stops being scheduled.
      if (maybeEnter(t)) return
      // One past the end in run-once mode: the last frame stays on screen until
      // the handoff condition is satisfied, so there is no need to keep drawing.
      // `maybeEnter` returning false means we are still waiting, so keep ticking
      // even past the end — otherwise a roster that activates later would never be
      // noticed.
      if (!entered) schedule(tick)
    } catch (error) {
      // A render error must not trap the user, and it must not silently stop the
      // handoff either: report it, then treat the timeline as finished so the normal
      // condition (timeline done AND clientReady) can still release the screen.
      noteError('frame loop', error)
      diag.t = duration
      if (maybeEnter(duration)) return
      if (!entered) schedule(tick)
    }
  }

  function renderDiagnostics() {
    setHint('STATE ' + diag.state
      + ' | T ' + Math.round(diag.t)
      + ' | PHASE ' + diag.phase
      + ' | FPS ' + diag.fps
      + ' | BOOTED ' + (bootedAt === null ? 'no' : 'yes')
      + ' | REDUCED ' + (reduced ? 'yes' : 'no')
      + ' | FAILED ' + (failureDetected ? 'yes' : 'no')
      + ' | ERR ' + (diag.errors.length === 0 ? '-' : diag.errors.length + ' ' + diag.errors[diag.errors.length - 1]))
  }

  // --- interaction ----------------------------------------------------------
  /** Turn sound on for the running animation, without leaving the screen. */
  function toggleSound() {
    if (settings.sound !== true) return
    audioUnlocked = !audioUnlocked
    if (audioUnlocked) {
      if (audio === null) chime()
      else {
        try {
          if (audio.state === 'suspended' && typeof audio.resume === 'function') audio.resume()
        } catch (error) { noteError('resume audio', error) }
      }
    } else {
      closeAudio()
    }
    renderSound(null)
  }

  /**
   * A press. While the clip is silent the first press unlocks audio and stays;
   * once unlocked (or when sound is off, so there is nothing to unlock) a press
   * leaves. A key press always leaves — a user reaching for Esc does not want a
   * two-step.
   */
  function press() {
    if (entered) return
    if (settings.sound === true && !audioUnlocked) {
      audioUnlocked = true
      chime()
      renderSound(null)
      if (settings.enterMode !== 'click') setHint('SOUND ON - PRESS AGAIN TO ENTER')
      return
    }
    enter('gesture')
  }  function inSoundControl(event) {
    var node = event && event.target
    return !!(node && node.closest && node.closest('.dslls-sound'))
  }

  function onKey(event) {
    if (entered) return
    if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') {
      enter('key')
    }
  }

  function defaultHint() {
    if (settings.enterMode === 'click') return 'PRESS TO START'
    if (settings.sound === true && !audioUnlocked) return 'PRESS FOR SOUND - THEN TO ENTER'
    return 'PRESS TO ENTER'
  }

  // --- assembly -------------------------------------------------------------
  function mount() {
    var doc = globalThis.document
    ensureStyle()
    var parts = build()
    root = parts.root
    canvas = parts.canvas
    fillBar = parts.fill
    hintEl = parts.hint
    titleEl = parts.title
    soundBtn = parts.sound

    handle.el = root
    if (titleEl !== null) titleEl.textContent = String(settings.title)

    var parent = doc.body !== null && doc.body !== undefined ? doc.body : doc.documentElement
    if (parent === null || parent === undefined) return false
    parent.appendChild(root)

    ctx2d = canvas.getContext ? canvas.getContext('2d') : null
    if (ctx2d === null) {
      // No canvas: hand over immediately rather than holding a black screen.
      noteError('canvas 2d context', new Error('unavailable'))
      diag.t = duration
      maybeEnter(duration)
      return true
    }

    root.addEventListener('pointerdown', function (event) {
      if (inSoundControl(event)) return
      press()
    }, true)
    globalThis.addEventListener('keydown', onKey)

    renderSound(null)
    setHint(defaultHint())
    startWatching()
    // Drive the bar from the timeline until the kernel's own progress source
    // attaches (or forever, on a surface that never has one). Tracked so
    // `destroy()` and the dissolve both stop it.
    var barTimer = setInterval(function () {
      if (entered) return
      paintProgress()
    }, 120)
    watchTimers.push(barTimer)
    return true
  }

  /** The hold budget: a slow boot changes the wording, never the decision. */
  function armHold() {
    holdTimer = setTimeout(function () {
      if (entered || failureDetected) return
      if (bootedAt !== null) return
      setAttention(true)
      setHint('SLOW START - PRESS TO CONTINUE')
    }, settings.holdMs)
  }

  // --- public surface -------------------------------------------------------
  handle = {
    el: null,
    get state() { return diag.state },
    /**
     * The client roster has activated. Part of the handoff condition, so this must
     * be safe to call twice and must not throw.
     */
    clientReady: function () {
      if (bootedAt === null) bootedAt = now()
      diag.booted = true
      if (entered) return
      setState('ready')
      // The roster is up, so the "slow start" escalation is over: clear the amber and
      // put the ordinary affordance back before evaluating the handoff. A late
      // clientReady must both release the screen AND stop claiming it is stalled.
      setAttention(failureDetected)
      if (!diagnosticsOn()) setHint(failureDetected ? 'DSH FAILED TO START' : defaultHint())
      maybeEnter(diag.t)
    },
    /** Begin the dissolve now. */
    skip: function () { enter('skip') },
    /**
     * Replay the real overlay on an already-booted page, for the settings card.
     * Returns false when one is already running.
     *
     * A finished run is NOT a blocker: the whole point is to replay it after boot,
     * which is the only time the settings card is reachable. `entered` therefore has
     * to be cleared here, and the check is on whether an overlay is actually on
     * screen (a root that has not been removed), not on whether one has ever run.
     */
    preview: function (overrides) {
      if (previewActive) return false
      if (root !== null && root.parentNode !== null) return false
      var done = null
      if (overrides !== undefined && overrides !== null && typeof overrides.onDone === 'function') {
        done = overrides.onDone
      }
      previewActive = true
      previewDone = done
      entered = false
      failureDetected = false

      rebuildScene(overrides)
      diag.failed = false
      diag.errors = []
      startedAt = now()
      bootedAt = startedAt   // an already-booted page: the timeline alone decides
      diag.booted = true
      lastFrameAt = 0

      if (!mount()) {
        previewActive = false
        previewDone = null
        return false
      }
      setState('booting')
      schedule(tick)
      return true
    },
    /** Remove everything this screen owns and stop all work. */
    destroy: function () {
      stopLoop()
      stopTimers()
      stopWatching()
      if (failureTimer !== 0) { clearTimeout(failureTimer); failureTimer = 0 }
      if (holdTimer !== 0) { clearTimeout(holdTimer); holdTimer = 0 }
      closeAudio()
      try { globalThis.removeEventListener('keydown', onKey) } catch (ignored) { /* nothing bound */ }
      if (root !== null && root.parentNode !== null) root.parentNode.removeChild(root)
      root = null
      canvas = null
      ctx2d = null
      fillBar = null
      hintEl = null
      soundBtn = null
      handle.el = null
      removeStyle()
      diag.state = 'gone'
      entered = true
      previewActive = false
      previewDone = null
    }
  }
  globalThis[OVERLAY] = handle

  // The kernel boot page is constructed synchronously by the shell module on the
  // Web surface, so this runs before it exists there. Mount as soon as a body is
  // available; on desktop one already is.
  function boot() {
    try {
      if (!mount()) {
        globalThis.addEventListener('DOMContentLoaded', function () {
          try { mount() } catch (error) { noteError('late mount', error) }
        }, { once: true })
        return
      }
      startedAt = now()
      lastFrameAt = 0
      armHold()
      schedule(tick)
    } catch (error) {
      noteError('mount', error)
    }
  }

  boot()
})()
