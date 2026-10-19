#!/usr/bin/env node
/**
 * verify/verify-all.mjs — run every offline suite and report one verdict.
 *
 * This is the project's acceptance gate: `node verify/verify-all.mjs` must be the
 * single command that proves the plugin, offline, with no DSH process, no ports, no
 * prompts, no network and no `npm install`.
 *
 * THREE-STATE EXIT PROTOCOL (deliberately not a boolean)
 *   0  every suite PASSED
 *   1  at least one suite FAILED, or a suite could not be run, or a suite is
 *      PENDING/PARTIAL
 *   2  the runner itself is broken (no suites found)
 *   3  reserved: only returned when every suite that ran is pending AND
 *      `--allow-pending` was passed
 *
 * A **PENDING/PARTIAL** (3) result means "not proven", and is treated as a FAILURE
 * of the overall run by default. A partial suite prints its green count AND its gap,
 * so it can never be mistaken for a green one. `--allow-pending` is an explicit
 * opt-out for a mid-development run; the final acceptance run does NOT pass it.
 *
 * Every suite is also runnable alone (`node verify/verify-scene.mjs`). This runner
 * spawns each in its own process so a crash or a stray `process.exit` in one cannot
 * corrupt another's verdict, and so a suite's own global state cannot leak.
 *
 * Usage
 *   node verify/verify-all.mjs                 # the acceptance run
 *   node verify/verify-all.mjs --allow-pending # tolerate "not proven"
 *   node verify/verify-all.mjs --only scene,routes
 *   node verify/verify-all.mjs --list
 *   node verify/verify-all.mjs --json
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const TTY = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
const c = (code, s) => (TTY ? `\u001b[${code}m${s}\u001b[0m` : s)
const paint = {
  red: (s) => c('31', s),
  green: (s) => c('32', s),
  yellow: (s) => c('33', s),
  cyan: (s) => c('36', s),
  dim: (s) => c('2', s),
  bold: (s) => c('1', s),
}

/** The §8 suite table, in dependency order (fundamentals before integrations). */
const SUITES = [
  { file: 'verify-raster.mjs', proves: 'PNG encoder validity, §4.4 primitive coverage, font legibility' },
  { file: 'verify-scene.mjs', proves: 'scene.js §4: determinism, closed primitive set, budget, NaN-freedom' },
  { file: 'verify-screen.mjs', proves: 'boot-screen.js: handoff matrix, §5.2a, §9b orderings, destroy' },
  { file: 'verify-css.mjs', proves: 'CSS: no backtick, quoted numeric attribute selectors, .dslls- namespacing' },
  { file: 'verify-client.mjs', proves: 'lib/client.js freshness + §6/§10.4 client invariants' },
  { file: 'verify-entry.mjs', proves: 'index.js: settings visibility (§7.1 volatile form) + injected rows' },
  { file: 'verify-namespace.mjs', proves: 'patch id === SETTINGS_NAMESPACE === §3 identity invariants' },
  { file: 'verify-injection-safety.mjs', proves: '</script, < escaping, graceful degradation' },
  { file: 'verify-routes.mjs', proves: 'state.json / boot.js: content type + no-store + composition' },
]

const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, PENDING: 3 }
const EXIT_NAME = { 0: 'PASS', 1: 'FAIL', 2: 'USAGE', 3: 'PENDING' }

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { allowPending: false, only: null, list: false, json: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--allow-pending') out.allowPending = true
    else if (a === '--only') out.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--list') out.list = true
    else if (a === '--json') out.json = true
    else if (a === '--verbose' || a === '-v') out.verbose = true
    else if (a === '-h' || a === '--help') out.help = true
    else {
      console.error(`verify-all: unknown argument "${a}"`)
      process.exit(EXIT.USAGE)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`verify-all — run every offline verification suite.

  node verify/verify-all.mjs                 the acceptance run (pending counts as failure)
  node verify/verify-all.mjs --allow-pending tolerate "not proven" (development only)
  node verify/verify-all.mjs --only scene,client
  node verify/verify-all.mjs --list          list the suites and exit
  node verify/verify-all.mjs --json          machine-readable result
  node verify/verify-all.mjs --verbose       stream each suite's full output

Exit: 0 all passed · 1 any failed/pending/could-not-run · 2 runner misuse`)
  process.exit(EXIT.PASS)
}

// ---------------------------------------------------------------------------
// discover + select
// ---------------------------------------------------------------------------

const discovered = SUITES.filter((s) => fs.existsSync(path.join(HERE, s.file)))
const missing = SUITES.filter((s) => !fs.existsSync(path.join(HERE, s.file)))

// Any OTHER verify-*.mjs that is not in the table is still run and reported, so a
// newly added suite cannot be silently skipped by being absent from the table.
const known = new Set(SUITES.map((s) => s.file))
const extras = fs
  .readdirSync(HERE)
  .filter((f) => /^verify-.*\.mjs$/.test(f) && f !== 'verify-all.mjs' && !known.has(f))
  .map((f) => ({ file: f, proves: '(not in the §8 table — auto-discovered)' }))

let selected = [...discovered, ...extras]
if (args.only !== null) {
  selected = selected.filter((s) => args.only.some((k) => s.file.includes(k)))
}

if (args.list) {
  for (const s of SUITES) {
    const present = fs.existsSync(path.join(HERE, s.file))
    console.log(`${present ? '  ' : '✗ '}${s.file.padEnd(32)} ${s.proves}`)
  }
  for (const e of extras) console.log(`    ${e.file.padEnd(32)} ${e.proves}`)
  if (missing.length > 0) {
    console.log(`\n${missing.length} suite(s) from the §8 table are MISSING:`)
    for (const m of missing) console.log(`  ✗ ${m.file}`)
  }
  process.exit(missing.length > 0 ? EXIT.FAIL : EXIT.PASS)
}

if (selected.length === 0) {
  console.error('verify-all: no suites found to run')
  process.exit(EXIT.USAGE)
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const results = []
const startedAll = Date.now()

for (const suite of selected) {
  const abs = path.join(HERE, suite.file)
  const t0 = Date.now()
  const proc = spawnSync(process.execPath, [abs], {
    cwd: ROOT,
    encoding: 'utf8',
    // A suite must be self-contained and offline. No network, no prompts.
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const ms = Date.now() - t0
  const status = proc.status === null ? -1 : proc.status
  const statusName = EXIT_NAME[status] ?? `EXIT ${status}`
  results.push({
    file: suite.file,
    proves: suite.proves,
    code: status,
    status: statusName,
    ms,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    signal: proc.signal ?? null,
    error: proc.error !== undefined && proc.error !== null ? String(proc.error.message ?? proc.error) : null,
  })
  if (args.verbose) {
    process.stdout.write(proc.stdout ?? '')
    if (proc.stderr) process.stderr.write(proc.stderr)
  } else {
    // One live line per suite so a long run shows progress.
    const mark = status === 0 ? paint.green('✓') : status === 3 ? paint.yellow('◌') : paint.red('✗')
    process.stdout.write(`${mark} ${suite.file.padEnd(30)} ${paint.dim(`${statusName} ${ms}ms`)}\n`)
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const failed = results.filter((r) => r.status === 'FAIL')
const pending = results.filter((r) => r.status === 'PENDING')
const broken = results.filter((r) => r.status !== 'PASS' && r.status !== 'FAIL' && r.status !== 'PENDING')
const passed = results.filter((r) => r.status === 'PASS')

/** Pull the assertion counts a suite prints, for the summary table. */
function assertionCount(stdout) {
  const m = /—\s*(\d+)\s*assertions?/.exec(stdout)
  if (m !== null) return Number(m[1])
  const m2 = /(\d+)\/(\d+)\s*assertions FAILED/.exec(stdout)
  if (m2 !== null) return Number(m2[2])
  return null
}

if (args.json) {
  console.log(JSON.stringify({ suites: results.map(({ stdout, stderr, ...r }) => ({ ...r, assertions: assertionCount(stdout) })), allowPending: args.allowPending }, null, 2))
} else {
  const line = '─'.repeat(78)
  console.log(line)
  console.log(paint.bold('  dsh-link-start — offline verification'))
  console.log(line)
  console.log(`  ${'suite'.padEnd(30)} ${'result'.padEnd(9)} ${'assertions'.padStart(10)}  time`)
  for (const r of results) {
    const n = assertionCount(r.stdout)
    const mark = r.status === 'PASS' ? paint.green('PASS') : r.status === 'PENDING' ? paint.yellow('PENDING') : paint.red(r.status)
    console.log(`  ${r.file.padEnd(30)} ${mark.padEnd(TTY ? 18 : 9)} ${String(n ?? '-').padStart(10)}  ${r.ms}ms`)
  }
  console.log(line)

  if (missing.length > 0) {
    console.log(`  ${paint.red('✗')} ${missing.length} §8 suite(s) are MISSING from verify/:`)
    for (const m of missing) console.log(`      ✗ ${m.file}  — ${m.proves}`)
    console.log(line)
  }

  // Show what went wrong, without making the reader re-run anything.
  for (const r of failed) {
    console.log(`\n  ${paint.red('✗')} ${paint.bold(r.file)} ${paint.red('FAILED')}`)
    const body = r.stdout
      .split('\n')
      .filter((l) => /^\s*(✗|◌|!!)/.test(l) || /assertions FAILED/.test(l))
      .slice(0, 14)
    for (const l of body) console.log(`      ${l.trim()}`)
    if (r.stderr.trim() !== '') {
      console.log(`      ${paint.dim('stderr:')} ${r.stderr.trim().split('\n').slice(0, 4).join('\n      ')}`)
    }
  }
  for (const r of pending) {
    console.log(`\n  ${paint.yellow('◌')} ${paint.bold(r.file)} ${paint.yellow('PENDING / PARTIAL — not proven, not green')}`)
    const body = r.stdout.split('\n').filter((l) => /pending/i.test(l)).slice(0, 6)
    for (const l of body) console.log(`      ${l.trim()}`)
  }
  for (const r of broken) {
    console.log(`\n  ${paint.red('✗')} ${paint.bold(r.file)} could not run (${r.status}${r.signal !== null ? `, signal ${r.signal}` : ''})`)
    if (r.error !== null) console.log(`      ${r.error}`)
    const body = (r.stderr || r.stdout).trim().split('\n').slice(0, 6)
    for (const l of body) console.log(`      ${l}`)
  }

  const totalAssertions = results.reduce((acc, r) => acc + (assertionCount(r.stdout) ?? 0), 0)
  const elapsed = ((Date.now() - startedAll) / 1000).toFixed(1)
  const partialRun = args.only !== null || selected.length !== SUITES.length + extras.length
  const green = failed.length === 0 && broken.length === 0 && missing.length === 0 && (pending.length === 0 || args.allowPending)

  console.log(
    `\n  ${results.length} suite(s) · ${totalAssertions} assertions · ${elapsed}s` +
      `  →  ${paint.green(`${passed.length} passed`)}` +
      (failed.length > 0 ? `, ${paint.red(`${failed.length} failed`)}` : '') +
      (pending.length > 0 ? `, ${paint.yellow(`${pending.length} pending`)}` : '') +
      (broken.length > 0 ? `, ${paint.red(`${broken.length} could not run`)}` : '') +
      (missing.length > 0 ? `, ${paint.red(`${missing.length} missing`)}` : ''),
  )

  if (green && partialRun) {
    // Never claim whole-project acceptance for a subset run: that is exactly the
    // "green run that quietly skipped three suites" this protocol exists to prevent.
    console.log(`  ${paint.yellow('SUBSET PASSED')} — only ${selected.length} of ${SUITES.length + extras.length} suite(s) were run.`)
    console.log(`  ${paint.dim('This is NOT project acceptance. Run without --only for the acceptance verdict.')}`)
  } else if (green) {
    console.log(`  ${paint.green('ACCEPTED')} — every suite passed offline.`)
    if (pending.length > 0) {
      console.log(`  ${paint.yellow('note:')} --allow-pending was passed, so ${pending.length} pending suite(s) were tolerated.`)
    }
  } else if (pending.length > 0 && failed.length === 0 && broken.length === 0 && missing.length === 0) {
    console.log(`  ${paint.yellow('NOT PROVEN')} — ${pending.length} suite(s) are PENDING/PARTIAL.`)
    console.log(`  ${paint.dim('A pending suite means "not proven", never "proven good". Pass --allow-pending to tolerate it during development.')}`)
  } else {
    console.log(`  ${paint.red('REJECTED')} — see the failures above.`)
  }
  console.log(line)
}

// ---------------------------------------------------------------------------
// exit
// ---------------------------------------------------------------------------

let code
if (failed.length > 0 || broken.length > 0 || missing.length > 0) code = EXIT.FAIL
else if (pending.length > 0) code = args.allowPending ? EXIT.PASS : EXIT.FAIL
else code = EXIT.PASS

process.exit(code)
