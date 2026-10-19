/**
 * verify/_dom.mjs — a hand-written stub DOM plus a VIRTUAL CLOCK.
 *
 * `src/boot-screen.js` is a classic script that runs against the real browser DOM.
 * This module supplies the smallest environment it actually uses, so the overlay
 * can be driven deterministically in Node with no browser, no real timers and no
 * sleeping.
 *
 * THE CLOCK IS THE POINT. Real timers would make every assertion flaky and force
 * `setTimeout` waits. Instead:
 *
 *   - `clock.now()` is the overlay's injected clock (`cfg.now`).
 *   - `setTimeout`/`setInterval` register callbacks against a virtual time base
 *     and are NEVER fired by the event loop.
 *   - `clock.advance(ms)` moves virtual time and runs whatever became due, in
 *     due-time order, repeatedly — so a callback that schedules another callback
 *     is honoured within a single `advance`.
 *   - `clock.tickFrame()` runs the queued animation-frame callback once, which is
 *     how the render loop is stepped.
 *
 * This makes "the dissolve begins at the right virtual millisecond" a deterministic
 * assertion rather than a race.
 */

// ---------------------------------------------------------------------------
// Virtual clock
// ---------------------------------------------------------------------------

export function createClock(start = 0) {
  let now = start
  let seq = 0
  const timers = new Map() // id -> { at, fn, every|null, args }
  let rafQueue = []
  const log = []

  const clock = {
    get now() {
      return now
    },
    /** Advance virtual time, firing everything due. Returns the sequence fired. */
    advance(ms) {
      const target = now + ms
      const fired = []
      // Guard against a callback that reschedules itself at the same instant.
      let guard = 0
      for (;;) {
        let next = null
        for (const [id, t] of timers) {
          if (t.at <= target && (next === null || t.at < next.t.at || (t.at === next.t.at && id < next.id))) {
            next = { id, t }
          }
        }
        if (next === null) break
        if (++guard > 100000) throw new Error('clock.advance: too many timer firings (runaway interval?)')
        now = next.t.at
        const { id, t } = next
        if (t.every !== null) t.at = now + t.every
        else timers.delete(id)
        t.fn(...t.args)
        fired.push(id)
      }
      now = target
      return fired
    },
    /** Run pending animation-frame callbacks once (one simulated frame). */
    tickFrame() {
      const q = rafQueue
      rafQueue = []
      for (const fn of q) fn(now)
      return q.length
    },
    /** Run frames until `fn()` is true or `max` frames elapse. */
    runFrames(fn, max = 2000) {
      let n = 0
      while (n < max) {
        clock.tickFrame()
        n++
        if (fn()) return n
      }
      return -1
    },
    pendingTimers() {
      return [...timers.entries()].map(([id, t]) => ({ id, at: t.at, every: t.every }))
    },
    /** Timer ids of the one-shot timers still scheduled (for leak assertions). */
    pendingTimeouts() {
      return [...timers.values()].filter((t) => t.every === null).length
    },
    pendingIntervals() {
      return [...timers.values()].filter((t) => t.every !== null).length
    },
    pendingFrames() {
      return rafQueue.length
    },
    log,
  }

  clock.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++seq
    timers.set(id, { at: now + Math.max(0, ms | 0), fn, every: null, args })
    return id
  }
  clock.setInterval = (fn, ms = 16, ...args) => {
    const id = ++seq
    const period = Math.max(1, ms | 0)
    timers.set(id, { at: now + period, fn, every: period, args })
    return id
  }
  clock.clearTimer = (id) => {
    timers.delete(id)
  }
  clock.requestAnimationFrame = (fn) => {
    rafQueue.push(fn)
    return ++seq
  }
  clock.cancelAnimationFrame = (id) => {
    rafQueue = rafQueue.filter((_, i) => i + 1 !== id)
  }

  return clock
}

// ---------------------------------------------------------------------------
// Stub DOM
// ---------------------------------------------------------------------------

class ClassList {
  constructor(node) {
    this.node = node
    this.set = new Set()
  }
  add(...names) {
    for (const n of names) this.set.add(n)
    this.node._className = [...this.set].join(' ')
  }
  remove(...names) {
    for (const n of names) this.set.delete(n)
    this.node._className = [...this.set].join(' ')
  }
  contains(n) {
    return this.set.has(n)
  }
  toggle(n, force) {
    const on = force === undefined ? !this.set.has(n) : !!force
    if (on) this.add(n)
    else this.remove(n)
    return on
  }
}

class StubElement {
  constructor(tagName, ownerDoc) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDoc
    this.childNodes = []
    this.parentNode = null
    this.attributes = Object.create(null)
    this.style = makeStyle()
    this.dataset = Object.create(null)
    this._className = ''
    this._textContent = ''
    this._listeners = Object.create(null)
    this.classList = new ClassList(this)
    this.isConnected = false
  }
  get className() {
    return this._className
  }
  set className(v) {
    this._className = v === undefined || v === null ? '' : String(v)
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean))
  }
  /**
   * `id` is a real reflected property in the DOM: `node.id = 'x'` also makes
   * `getAttribute('id') === 'x'` and `getElementById('x')` find it. The overlay's
   * idempotent `ensureStyle()` guard depends on exactly that, so a plain field
   * would make every mount look like a duplicate stylesheet.
   */
  get id() {
    return this._id === undefined ? '' : this._id
  }
  set id(v) {
    this._id = v === undefined || v === null ? '' : String(v)
    if (this._id === '') delete this.attributes.id
    else this.attributes.id = this._id
  }
  get textContent() {
    // Reading textContent on a container returns its descendants' text, as in the
    // real DOM — the overlay reads [data-dsh-boot] textContent for failure text.
    if (this.childNodes.length === 0) return this._textContent
    return this.childNodes.map((c) => c.textContent).join('')
  }
  set textContent(v) {
    this.childNodes = []
    this._textContent = v === undefined || v === null ? '' : String(v)
  }
  appendChild(child) {
    if (child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    child.isConnected = this.isConnected || this.tagName === 'BODY' || this.tagName === 'HTML'
    this.childNodes.push(child)
    return child
  }
  insertBefore(child, ref) {
    const i = this.childNodes.indexOf(ref)
    if (i < 0) return this.appendChild(child)
    if (child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    child.isConnected = this.isConnected
    this.childNodes.splice(i, 0, child)
    return child
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child)
    if (i >= 0) {
      this.childNodes.splice(i, 1)
      child.parentNode = null
      child.isConnected = false
    }
    return child
  }
  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this)
  }
  setAttribute(name, value) {
    const v = String(value)
    this.attributes[name] = v
    if (name === 'class') this.className = v
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = v
  }
  getAttribute(name) {
    // `className` is set as a property in most code paths, so `class` must read
    // through to it — otherwise an overlay node appears to have no class.
    if (name === 'class') return this._className === '' ? null : this._className
    if (name === 'id') return this._id === undefined || this._id === '' ? null : this._id
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }
  removeAttribute(name) {
    delete this.attributes[name]
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
  }
  addEventListener(type, fn) {
    ;(this._listeners[type] ??= []).push(fn)
  }
  removeEventListener(type, fn) {
    if (this._listeners[type] !== undefined) this._listeners[type] = this._listeners[type].filter((f) => f !== fn)
  }
  /** Test helper: dispatch an event to listeners on this node (no bubbling). */
  dispatch(type, props = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {},
      ...props,
    }
    for (const fn of this._listeners[type] ?? []) fn(event)
    return event
  }
  /** Depth-first descendant query by a simple tag / attribute predicate. */
  descendants() {
    const out = []
    const walk = (n) => {
      for (const c of n.childNodes) {
        out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  /** A very small selector engine: tag, .class, #id, [attr], [attr="v"] and combos. */
  querySelectorAll(selector) {
    return this.descendants().filter((n) => matches(n, selector))
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
  get firstChild() {
    return this.childNodes[0] ?? null
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }
  get children() {
    return this.childNodes.filter((c) => c.tagName !== '#TEXT')
  }
}

function matches(node, selector) {
  // Support descendant combinators by splitting on whitespace is unnecessary here;
  // the overlay uses single compound selectors.
  return selector.trim().split(/\s*,\s*/).some((part) => matchesCompound(node, part.trim()))
}

function matchesCompound(node, sel) {
  if (sel === '') return false
  // Walk the compound selector left to right.
  const re = /(^[a-zA-Z][\w-]*)|(\.[\w-]+)|(#[\w-]+)|(\[[^\]]+\])/g
  let m
  let matchedAny = false
  while ((m = re.exec(sel)) !== null) {
    const tok = m[0]
    matchedAny = true
    if (tok.startsWith('.')) {
      if (!node.classList.contains(tok.slice(1))) return false
    } else if (tok.startsWith('#')) {
      if (node.getAttribute('id') !== tok.slice(1)) return false
    } else if (tok.startsWith('[')) {
      const inner = tok.slice(1, -1)
      const eq = /^([\w-]+)\s*=\s*"?([^"]*)"?$/.exec(inner)
      if (eq !== null) {
        if (node.getAttribute(eq[1]) !== eq[2]) return false
      } else if (!node.hasAttribute(inner)) return false
    } else if (node.tagName !== tok.toUpperCase()) return false
  }
  return matchedAny
}

/** A canvas 2d context that records calls instead of drawing. */
function makeCanvasContext() {
  const calls = []
  const rec =
    (name) =>
    (...args) => {
      calls.push({ name, args })
    }
  const ctx = {
    calls,
    canvas: null,
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    rect: rec('rect'),
    arc: rec('arc'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    clearRect: rec('clearRect'),
    setTransform: rec('setTransform'),
    translate: rec('translate'),
    scale: rec('scale'),
    rotate: rec('rotate'),
    fillText: rec('fillText'),
    strokeText: rec('strokeText'),
    measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    drawImage: rec('drawImage'),
    quadraticCurveTo: rec('quadraticCurveTo'),
    bezierCurveTo: rec('bezierCurveTo'),
    clip: rec('clip'),
    setLineDash: rec('setLineDash'),
    getLineDash: () => [],
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px monospace',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowBlur: 0,
    shadowColor: '#000',
    imageSmoothingEnabled: true,
    filter: 'none',
  }
  return ctx
}

function makeStyle() {
  const decl = Object.create(null)
  const style = {
    _decl: decl,
    setProperty(name, value) {
      decl[name] = String(value)
      this[name] = String(value)
    },
    getPropertyValue(name) {
      return decl[name] ?? ''
    },
    removeProperty(name) {
      delete decl[name]
      delete this[name]
    },
  }
  return style
}

/**
 * Build a stub window/document.
 *
 * @param {{bootPage?:boolean|'failed'|'ok', arc?:number, clock:object, reducedMotion?:boolean}} opts
 *   `bootPage` controls whether `[data-dsh-boot]` exists AT MOUNT TIME:
 *     false  -> Web ordering (the overlay mounts before the kernel renders it)
 *     true   -> Desktop ordering (§9b: the boot page already exists)
 *     'failed' -> present AND carrying the kernel failure text
 *   `arc` is the `--dsh-boot-arc` value on the spinner.
 */
export function createDom(opts) {
  const clock = opts.clock

  const document = {}
  const html = new StubElement('html', document)
  const head = new StubElement('head', document)
  const body = new StubElement('body', document)
  html.isConnected = true
  head.isConnected = true
  body.isConnected = true
  html.appendChild(head)
  html.appendChild(body)
  document.documentElement = html
  document.head = head
  document.body = body
  document.createElement = (tag) => {
    const node = new StubElement(tag, document)
    if (String(tag).toLowerCase() === 'canvas') {
      node.width = 300
      node.height = 150
      const ctx = makeCanvasContext()
      ctx.canvas = node
      node.getContext = (kind) => (kind === '2d' ? ctx : null)
      node._ctx = ctx
    }
    return node
  }
  document.createTextNode = (text) => {
    const n = new StubElement('#text', document)
    n._textContent = String(text)
    return n
  }
  document.getElementById = (id) => document.documentElement.descendants().find((n) => n.getAttribute('id') === id) ?? null
  document.querySelector = (sel) => html.querySelector(sel)
  document.querySelectorAll = (sel) => html.querySelectorAll(sel)
  document.addEventListener = () => {}
  document.removeEventListener = () => {}

  // The kernel's boot page, if this ordering has one.
  let bootEl = null
  let spinnerEl = null
  if (opts.bootPage) {
    bootEl = document.createElement('div')
    bootEl.setAttribute('data-dsh-boot', '1')
    spinnerEl = document.createElement('div')
    spinnerEl.setAttribute('data-dsh-boot-spinner', '1')
    if (opts.arc !== undefined) spinnerEl.style.setProperty('--dsh-boot-arc', `${opts.arc}deg`)
    bootEl.appendChild(spinnerEl)
    if (opts.bootPage === 'failed') {
      bootEl.appendChild(document.createTextNode('Failed to load plugins: 2 entries did not activate'))
    } else {
      bootEl.appendChild(document.createTextNode('HARNESS / Loading plugins...'))
    }
    body.appendChild(bootEl)
  }

  const listeners = Object.create(null)
  const window_ = {
    document,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimer,
    setInterval: clock.setInterval,
    clearInterval: clock.clearTimer,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    addEventListener(type, fn) {
      ;(listeners[type] ??= []).push(fn)
    },
    removeEventListener(type, fn) {
      if (listeners[type] !== undefined) listeners[type] = listeners[type].filter((f) => f !== fn)
    },
    matchMedia: (query) => ({
      matches: query.includes('prefers-reduced-motion') ? opts.reducedMotion === true : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    navigator: { userAgent: 'stub' },
    location: { search: opts.search ?? '', href: 'http://stub/' },
    innerWidth: opts.width ?? 1600,
    innerHeight: opts.height ?? 900,
    devicePixelRatio: opts.dpr ?? 1,
    performance: { now: () => clock.now },
    sessionStorage: makeStorage(),
    localStorage: makeStorage(),
  }
  // AudioContext is deliberately ABSENT unless a test opts in, so the default
  // environment exercises the "no audio" path.
  if (opts.audio === true) window_.AudioContext = makeStubAudioContext(clock)
  window_.window = window_
  window_.globalThis = window_
  window_.self = window_

  let mutationObservers = []
  class StubMutationObserver {
    constructor(cb) {
      this.cb = cb
      this.targets = []
      mutationObservers.push(this)
    }
    observe(target, options) {
      this.targets.push({ target, options })
    }
    disconnect() {
      this.targets = []
      mutationObservers = mutationObservers.filter((o) => o !== this)
    }
    takeRecords() {
      return []
    }
  }
  window_.MutationObserver = StubMutationObserver

  const dom = {
    window: window_,
    document,
    html,
    head,
    body,
    bootEl,
    spinnerEl,
    listeners,
    /** Dispatch a window-level event (e.g. keydown, resize). */
    dispatchWindow(type, props = {}) {
      const event = {
        type,
        target: window_,
        preventDefault() {},
        stopPropagation() {},
        ...props,
      }
      for (const fn of listeners[type] ?? []) fn(event)
      return event
    },
    /** Test helper: mutate the boot page's text so a failure observer fires. */
    setBootText(text) {
      if (bootEl === null) throw new Error('setBootText: no [data-dsh-boot] in this DOM')
      bootEl.childNodes = []
      bootEl._textContent = ''
      bootEl.appendChild(document.createTextNode(text))
      for (const o of mutationObservers) {
        for (const { target } of o.targets) {
          if (target === bootEl || bootEl.descendants().includes(target)) o.cb([{ type: 'characterData', target: bootEl }], o)
        }
      }
    },
    /** Test helper: change the spinner's arc custom property. */
    setArc(deg) {
      if (spinnerEl === null) throw new Error('setArc: no [data-dsh-boot-spinner] in this DOM')
      spinnerEl.style.setProperty('--dsh-boot-arc', `${deg}deg`)
      for (const o of mutationObservers) {
        for (const { target } of o.targets) {
          if (target === spinnerEl) o.cb([{ type: 'attributes', attributeName: 'style', target: spinnerEl }], o)
        }
      }
    },
    /** All stylesheets the overlay installed into <head>. */
    styleSheets() {
      return head.childNodes.filter((n) => n.tagName === 'STYLE')
    },
    /** Everything the overlay added to <body>. */
    bodyChildren() {
      return body.childNodes.slice()
    },
    mutationObserverCount() {
      return mutationObservers.length
    },
  }
  return dom
}

function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

/** A minimal WebAudio stub that records what was constructed. */
function makeStubAudioContext(clock) {
  const made = { oscillators: 0, gains: 0, buffers: 0, filters: 0, closed: false, resumed: 0 }
  class StubAudioContext {
    constructor() {
      this.state = 'suspended'
      this.sampleRate = 48000
      this.currentTime = clock.now / 1000
      this.destination = { connect() {} }
      this.made = made
    }
    resume() {
      made.resumed++
      this.state = 'running'
      return Promise.resolve()
    }
    close() {
      made.closed = true
      this.state = 'closed'
      return Promise.resolve()
    }
    createGain() {
      made.gains++
      return { connect() {}, gain: makeParam(), gain: makeParam() }
    }
    createOscillator() {
      made.oscillators++
      return { connect() {}, start() {}, stop() {}, frequency: makeParam(), type: 'sine', onended: null }
    }
    createBuffer(channels, frames) {
      made.buffers++
      const data = new Float32Array(frames)
      return { length: frames, getChannelData: () => data }
    }
    createBufferSource() {
      made.buffers++
      return { connect() {}, start() {}, stop() {}, buffer: null, onended: null }
    }
    createBiquadFilter() {
      made.filters++
      return { connect() {}, frequency: makeParam(), Q: makeParam(), type: 'lowpass' }
    }
  }
  StubAudioContext._made = made
  return StubAudioContext
}

function makeParam() {
  return {
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    setTargetAtTime() {},
    cancelScheduledValues() {},
  }
}
