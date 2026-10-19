/**
 * verify/_harness.mjs — the tiny shared assertion + runner library for every suite.
 *
 * No dependencies, no timers, no network, no ports. Each suite is a standalone
 * `.mjs` that imports this, declares named assertions, and calls `suite.run()`.
 *
 * EXIT STATUS PROTOCOL (uniform across every suite)
 *   0  every assertion passed
 *   1  at least one assertion FAILED
 *   3  the suite could not run because a file another teammate owns has not
 *      landed yet  ("pending"). This is deliberately distinct from a failure: it
 *      means "not proven", never "proven good". `verify-all.mjs` treats it as a
 *      failure of the overall run unless `--allow-pending` is given, so a pending
 *      suite can never be mistaken for a green one.
 *   2  the suite itself is broken (bad usage / unreadable own fixture)
 *
 * Every assertion is named, and every failure prints what was expected, what was
 * actually found, and (where useful) a diff or an excerpt. A suite that cannot
 * fail is worthless, so no assertion is written as `assert(true)`.
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')

export const EXIT = { PASS: 0, FAIL: 1, PENDING: 3, USAGE: 2 }

const TTY = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
const c = (code, s) => (TTY ? `\u001b[${code}m${s}\u001b[0m` : s)
export const paint = {
  red: (s) => c('31', s),
  green: (s) => c('32', s),
  yellow: (s) => c('33', s),
  cyan: (s) => c('36', s),
  dim: (s) => c('2', s),
  bold: (s) => c('1', s),
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const MAX_SHOWN = 400

export function show(value) {
  if (typeof value === 'string') {
    return value.length > MAX_SHOWN ? `${JSON.stringify(value.slice(0, MAX_SHOWN))}… (${value.length} chars)` : JSON.stringify(value)
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`
  let s
  try {
    s = JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s === undefined) return String(value)
  return s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}…` : s
}

/** Structural equality with a readable diff for the common cases. */
function deepEqual(a, b, seen = new Set()) {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  if (seen.has(a)) return false
  seen.add(a)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], seen)) return false
    return true
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual(a[k], b[k], seen)) return false
  }
  return true
}

/**
 * First structural difference, as a path + the two values. Keeps a determinism
 * failure diagnosable by pointing at the exact field that moved.
 */
export function firstDiff(a, b, at = '$') {
  if (Object.is(a, b)) return null
  if (typeof a !== typeof b) return { at, a, b, why: 'type' }
  if (a === null || b === null || typeof a !== 'object') return { at, a, b, why: 'value' }
  if (Array.isArray(a) !== Array.isArray(b)) return { at, a: Array.isArray(a) ? 'array' : 'object', b: Array.isArray(b) ? 'array' : 'object', why: 'shape' }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return { at: `${at}.length`, a: a.length, b: b.length, why: 'length' }
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${at}[${i}]`)
      if (d !== null) return d
    }
    return null
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${at}.${k}`)
    if (d !== null) return d
  }
  return null
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/** Resolve a package-relative path. */
export function at(rel) {
  return path.resolve(ROOT, rel)
}

export function exists(rel) {
  return fs.existsSync(at(rel))
}

export function readText(rel) {
  return fs.readFileSync(at(rel), 'utf8')
}

export function readJSON(rel) {
  return JSON.parse(readText(rel))
}

export function stat(rel) {
  try {
    const s = fs.statSync(at(rel))
    return { size: s.size, mtime: s.mtime.toISOString() }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export function createSuite(title) {
  const results = []
  const pending = []
  let crashed = null

  const api = {
    title,
    /** The list of files this suite needs; declared up front for honest reporting. */
    requires: [],

    /**
     * Record a dependency on a file another teammate owns. Returns false (and
     * schedules a PENDING) when the file is absent — the suite must then stop
     * verifying it, never stub it into existence.
     */
    need(rel, owner = 'another teammate') {
      if (fs.existsSync(at(rel))) return true
      pending.push(`${rel} has not landed yet (owned by ${owner})`)
      return false
    },

    /** A named assertion. `ok` may be a boolean or a predicate. */
    check(name, ok, detail) {
      results.push({ name, ok: ok === true, detail: ok === true ? undefined : detail })
      return ok === true
    },

    /** Assert a value equals an expected one, structurally. */
    eq(name, actual, expected) {
      const ok = deepEqual(actual, expected)
      results.push({
        name,
        ok,
        detail: ok ? undefined : `expected ${show(expected)}\n      actual   ${show(actual)}`,
      })
      return ok
    },

    /** Assert a predicate holds, reporting the actual value when it does not. */
    is(name, actual, predicate, describePredicate = 'predicate') {
      let ok = false
      try {
        ok = predicate(actual) === true
      } catch (err) {
        results.push({ name, ok: false, detail: `predicate threw: ${show(err)}\n      actual ${show(actual)}` })
        return false
      }
      results.push({ name, ok, detail: ok ? undefined : `${describePredicate}\n      actual ${show(actual)}` })
      return ok
    },

    /** Assert two values are structurally equal and report the FIRST differing path. */
    same(name, a, b) {
      const d = firstDiff(a, b)
      results.push({ name, ok: d === null, detail: d === null ? undefined : `first difference at ${d.at} (${d.why}):\n      a ${show(d.a)}\n      b ${show(d.b)}` })
      return d === null
    },

    /** Assert a function throws, optionally matching a message pattern. */
    throws(name, fn, pattern) {
      try {
        const value = fn()
        results.push({ name, ok: false, detail: `expected a throw, but it returned ${show(value)}` })
        return false
      } catch (err) {
        const msg = String(err && err.message ? err.message : err)
        if (pattern !== undefined && !pattern.test(msg)) {
          results.push({ name, ok: false, detail: `threw, but the message did not match ${pattern}\n      message ${show(msg)}` })
          return false
        }
        results.push({ name, ok: true })
        return true
      }
    },

    /** Assert a function does not throw. */
    notThrows(name, fn) {
      try {
        const value = fn()
        results.push({ name, ok: true })
        return { ok: true, value }
      } catch (err) {
        results.push({ name, ok: false, detail: `threw: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : show(err)}` })
        return { ok: false, error: err }
      }
    },

    /** Run a block, converting an unexpected throw into one named failure. */
    section(name, fn) {
      try {
        fn()
      } catch (err) {
        results.push({
          name: `${name} — section completed without throwing`,
          ok: false,
          detail: `threw: ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n      ') : show(err)}`,
        })
      }
    },

    /** Abort early: this suite cannot meaningfully continue. */
    fatal(message) {
      crashed = message
    },

    get failures() {
      return results.filter((r) => !r.ok)
    },

    get passed() {
      return results.filter((r) => r.ok)
    },

    get isPending() {
      return results.length === 0 && pending.length > 0 && crashed === null
    },

    /**
     * Print the report and return the process exit code.
     * Nothing is padded out: a suite with zero assertions and no pending reason
     * FAILS, because a suite that asserts nothing is not evidence.
     */
    finish() {
      const label = paint.bold(title)
      if (crashed !== null) {
        console.log(`\n${paint.red('✗')} ${label}\n  ${paint.red('could not run:')} ${crashed}`)
        for (const p of pending) console.log(`  ${paint.dim('·')} ${p}`)
        console.log(`  ${paint.dim('exit 2')}`)
        return EXIT.USAGE
      }
      if (results.length === 0) {
        if (pending.length > 0) {
          console.log(`\n${paint.yellow('◌')} ${label} ${paint.yellow('PENDING')} ${paint.dim('(exit 3 — not proven, not failed)')}`)
          for (const p of pending) console.log(`  ${paint.dim('·')} ${p}`)
          return EXIT.PENDING
        }
        console.log(`\n${paint.red('✗')} ${label}\n  ${paint.red('made no assertions at all — a suite that cannot fail is not evidence')}`)
        return EXIT.USAGE
      }
      const bad = api.failures
      if (bad.length === 0 && pending.length > 0) {
        // Partially provable: report the green partial result AND the gap, so a
        // partial suite can never be read as a full pass.
        console.log(`\n${paint.yellow('◌')} ${label} ${paint.yellow('PARTIAL')} ${paint.dim(`(exit 3 — ${results.length} assertions passed, ${pending.length} dependency still pending)`)}`)
        for (const p of pending) console.log(`  ${paint.yellow('◌ pending:')} ${p}`)
        return EXIT.PENDING
      }
      if (bad.length === 0) {
        console.log(`${paint.green('✓')} ${label} ${paint.dim(`— ${results.length} assertions`)}`)
        return EXIT.PASS
      }
      console.log(`\n${paint.red('✗')} ${label} ${paint.red(`— ${bad.length}/${results.length} assertions FAILED`)}`)
      for (const f of bad) {
        console.log(`  ${paint.red('✗')} ${paint.bold(f.name)}`)
        if (f.detail !== undefined) console.log(`      ${f.detail}`)
      }
      if (api.passed.length > 0) console.log(`  ${paint.dim(`${api.passed.length} assertion(s) passed before these failures`)}`)
      for (const p of pending) console.log(`  ${paint.yellow('◌ also pending:')} ${p}`)
      console.log(`  ${paint.dim('exit 1')}`)
      return EXIT.FAIL
    },
  }
  return api
}

/** Standard bottom-of-file runner: finish, set exitCode, and let stdout flush. */
export function runSuite(suite) {
  const code = suite.finish()
  process.exitCode = code
  return code
}

/** Assert a value is a finite number, reporting NaN/Infinity explicitly. */
export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

// ---------------------------------------------------------------------------
// Comment stripping — a real scanner, not a regex
// ---------------------------------------------------------------------------

/**
 * Remove `//` and block comments from JS/CSS source while LEAVING EVERY STRING
 * AND TEMPLATE LITERAL INTACT.
 *
 * A naive line-comment regex is actively dangerous on this codebase:
 * `src/client.js` holds its card CSS inside a template literal, and CSS contains
 * `//`-looking sequences; measured on the real file, the naive two-regex version
 * deleted 13,940 of 48,260 bytes (29%) — including the entire CSS blob and the
 * `clientReady()` call — which turns correct code into reported failures. Since
 * EVERY regex assertion in `verify/` runs against stripped text (AGENTS.md: "strip
 * comments before ANY regex assertion"), the stripper has to be right.
 *
 * Tracks: single/double quotes, template literals (with `${}` nesting), regex
 * literals, block comments and line comments. Preserves newlines and offsets so
 * line numbers stay meaningful.
 *
 * @param {string} code
 * @param {{mode?:'js'|'css'}} [opts] - `'css'` handles `/* *\/` only and does not
 *   treat `//` as a comment (CSS has no line comments, and `url(http://…)` is not
 *   one).
 */
export function stripComments(code, opts = {}) {
  const css = opts.mode === 'css'
  let out = ''
  let i = 0
  const n = code.length
  // A small stack: 'quote' | 'template' | 'regex' | 'brace' (for ${ } nesting)
  const stack = []

  // Heuristic: is a `/` at position p the start of a regex literal rather than a
  // division? Look back for the last significant character.
  function regexAllowed(p) {
    for (let k = p - 1; k >= 0; k--) {
      const ch = code[k]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue
      if ('})]'.includes(ch)) return false
      if ('=+-*%&|^!~<>?:,;([{'.includes(ch)) return true
      // A keyword like `return` / `typeof` also allows a regex.
      const before = code.slice(Math.max(0, k - 5), k + 1)
      if (/(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|do|else|yield|await)$/.test(before)) return true
      return false
    }
    return true
  }

  while (i < n) {
    const ch = code[i]
    const next = code[i + 1]
    const top = stack[stack.length - 1]

    if (top === 'quote') {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === stack.__quote) stack.pop()
      i++
      continue
    }

    if (top === 'template') {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === '`') {
        stack.pop()
        i++
        continue
      }
      if (ch === '$' && next === '{') {
        out += next
        i += 2
        stack.push('brace')
        continue
      }
      i++
      continue
    }

    if (top === 'regex') {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === '/') stack.pop()
      i++
      continue
    }

    if (top === 'brace') {
      if (ch === '{') stack.push('brace')
      else if (ch === '}') stack.pop()
      else if (ch === '"' || ch === "'") {
        stack.push('quote')
        stack.__quote = ch
      } else if (ch === '`') stack.push('template')
      out += ch
      i++
      continue
    }

    // --- top level of the file (or inside ${ }) ---
    if (ch === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      // Preserve newlines so line numbers survive.
      for (let k = i; k < stop; k++) if (code[k] === '\n') out += '\n'
      i = stop
      continue
    }
    if (!css && ch === '/' && next === '/') {
      const end = code.indexOf('\n', i)
      i = end === -1 ? n : end
      continue
    }
    if (ch === '"' || ch === "'") {
      stack.push('quote')
      stack.__quote = ch
      out += ch
      i++
      continue
    }
    if (ch === '`') {
      stack.push('template')
      out += ch
      i++
      continue
    }
    if (!css && ch === '/' && regexAllowed(i)) {
      stack.push('regex')
      out += ch
      i++
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Walk a JSON-ish structure, yielding every [path, value] pair. */
export function* walk(value, at_ = '$') {
  yield [at_, value]
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) yield* walk(value[i], `${at_}[${i}]`)
    } else {
      for (const k of Object.keys(value)) yield* walk(value[k], `${at_}.${k}`)
    }
  }
}

/**
 * Load a CLASSIC script (not an ES module) in a bare `node:vm` context, the way
 * the page does. `src/scene.js` and `src/boot-screen.js` are classic scripts by
 * contract (§4 / §5), so `import()` would be wrong for both: it would also let
 * them see the verifier's own module scope, which the page would not.
 *
 * The sandbox deliberately exposes NO `require`, NO `process`, NO `window` and no
 * module machinery, so a script that secretly depends on one of them fails here —
 * which is exactly the class of defect that breaks the injected page.
 *
 * @param {string} rel - package-relative path of the classic script.
 * @param {object} [extraGlobals] - globals to define BEFORE the script runs
 *   (e.g. a stub `document`, or `__DSH_LINK_START_CFG__`).
 * @param {{bootstrap?:string}} [opts] - `bootstrap` is run in the context before
 *   the script, for setup that must happen in-context.
 * @returns {{sandbox:object, code:string, path:string, run:()=>void}}
 */
export function loadClassic(rel, extraGlobals = {}, opts = {}) {
  const abs = at(rel)
  const code = fs.readFileSync(abs, 'utf8')

  // A caller may supply an EXISTING context so two classic scripts share one
  // global object — which is exactly how the page works: `boot-screen.js` reads
  // the global that `scene.js` defined, because both are script rows in the same
  // document.
  if (opts.context !== undefined) {
    if (opts.globals !== undefined) Object.assign(opts.context, opts.globals)
    return {
      sandbox: opts.sandbox ?? opts.context,
      context: opts.context,
      code,
      path: abs,
      run() {
        vm.runInContext(code, opts.context, { filename: abs })
      },
    }
  }

  const sandbox = {
    // The intrinsics a self-contained classic script may legitimately touch.
    console,
    Math,
    JSON,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Symbol,
    Map,
    Set,
    WeakMap,
    Promise,
    Error,
    TypeError,
    RangeError,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    TextEncoder,
    TextDecoder,
    ...extraGlobals,
  }
  sandbox.globalThis = sandbox
  if (sandbox.window === undefined) sandbox.window = sandbox
  const context = vm.createContext(sandbox, { name: rel })
  if (opts.bootstrap !== undefined) vm.runInContext(opts.bootstrap, context, { filename: `bootstrap:${rel}` })
  return {
    sandbox,
    context,
    code,
    path: abs,
    run() {
      vm.runInContext(code, context, { filename: abs })
    },
  }
}

/**
 * Load a classic script and return it, converting a syntax/eval error into a
 * readable failure instead of an unhandled rejection.
 */
export function tryLoadClassic(rel, extraGlobals = {}, opts = {}) {
  try {
    const loaded = loadClassic(rel, extraGlobals, opts)
    loaded.run()
    return { ok: true, ...loaded }
  } catch (err) {
    return { ok: false, error: err }
  }
}

export { vm }
