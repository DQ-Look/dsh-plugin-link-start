#!/usr/bin/env node
/**
 * tools/storyboard.mjs — render `src/scene.js` to PNGs a human can review.
 *
 * Loads the classic script `src/scene.js` in a bare `node:vm` context, walks the
 * frozen phase table, and writes one PNG per phase (sampled at the phase
 * MIDPOINT) plus one EARLY and one LATE sample of the whole timeline, into
 * `storyboard/`. It also writes `storyboard/index.html` (an in-order contact
 * sheet) and `storyboard/report.json` (the machine-readable index).
 *
 * It draws the identical display list the browser draws: every pixel comes from
 * `frame(t)` through `tools/raster.mjs`, which implements exactly §4.4 and
 * re-derives no geometry.
 *
 * Usage
 *   node tools/storyboard.mjs
 *   node tools/storyboard.mjs --scene verify/fixtures/synthetic-scene.js --out storyboard/_selftest
 *
 * Options
 *   --scene <path>   classic script exporting __DSH_LINK_START_SCENE__  (default src/scene.js)
 *   --out <dir>      output directory                                   (default storyboard)
 *   --width <px>     output width; the design frame is box-downsampled  (default 800)
 *   --seed <int>     cfg.seed passed through normalizeConfig            (default 20240518)
 *   --config <json>  extra config overrides, e.g. '{"glitch":false}'
 *   --json           print report.json to stdout instead of the text index
 *
 * Exit status: 0 clean · 1 the scene rendered but something could not be drawn
 * (loudly listed, and the PNGs are still written) · 2 the scene could not be
 * loaded at all.
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { rasterizeFrame, downsample, encodePNG, DESIGN } from './raster.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { scene: 'src/scene.js', out: 'storyboard', width: 800, seed: 20240518, config: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--scene') out.scene = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--width') out.width = Number(argv[++i])
    else if (a === '--seed') out.seed = Number(argv[++i])
    else if (a === '--config') out.config = JSON.parse(argv[++i])
    else if (a === '--json') out.json = true
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ ?\* ?/gm, ''))
      process.exit(0)
    } else {
      console.error(`storyboard: unknown argument ${a}`)
      process.exit(2)
    }
  }
  if (!Number.isFinite(out.width) || out.width < 100) {
    console.error(`storyboard: --width must be a number >= 100, got ${argv[argv.indexOf('--width') + 1]}`)
    process.exit(2)
  }
  return out
}

// ---------------------------------------------------------------------------
// load a classic script (NOT an ES module) the way the page does
// ---------------------------------------------------------------------------

export function loadClassicScript(file, extra = {}) {
  const abs = path.isAbsolute(file) ? file : path.resolve(ROOT, file)
  if (!fs.existsSync(abs)) {
    const hint = path.basename(file) === 'scene.js' && !fs.existsSync(abs)
      ? '\n  src/scene.js has not been written yet (scene-dev owns it).\n' +
        '  To prove the raster/storyboard pipeline without it, run:\n' +
        '    node tools/storyboard.mjs --scene verify/fixtures/synthetic-scene.js --out storyboard/_selftest\n'
      : ''
    console.error(`storyboard: cannot read ${abs}${hint}`)
    process.exit(2)
  }
  const code = fs.readFileSync(abs, 'utf8')
  const sandbox = { console, Math, JSON, Date, Number, String, Boolean, Array, Object, isFinite, isNaN, parseFloat, parseInt, ...extra }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  try {
    vm.runInContext(code, sandbox, { filename: abs })
  } catch (err) {
    console.error(`storyboard: ${abs} threw while loading: ${err && err.stack ? err.stack : err}`)
    process.exit(2)
  }
  const scene = sandbox.__DSH_LINK_START_SCENE__
  if (scene === undefined || scene === null) {
    console.error(`storyboard: ${abs} loaded but did not define globalThis.__DSH_LINK_START_SCENE__`)
    process.exit(2)
  }
  return { scene, sandbox, code }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
const { scene, code } = loadClassicScript(args.scene)

for (const need of ['DESIGN', 'PHASES', 'normalizeConfig', 'createScene', 'totalDuration']) {
  if (scene[need] === undefined) {
    console.error(`storyboard: scene is missing the required export "${need}" (INTERFACES.md §4.1)`)
    process.exit(2)
  }
}

const raw = { seed: args.seed, ...(args.config ?? {}) }
const cfg = scene.normalizeConfig(raw)
const handle = scene.createScene(cfg)
const duration = handle.duration ?? scene.totalDuration(cfg)
const phases = handle.phases ?? scene.PHASES

// --- sample selection ------------------------------------------------------
const samples = [
  { label: 'EARLY', note: 'first 1.5% of the timeline', t: duration * 0.015 },
]
for (const p of phases) {
  samples.push({
    label: `PHASE ${p.id.toUpperCase()}`,
    note: `${p.label} midpoint (t ${(p.from * 100).toFixed(0)}%–${(p.to * 100).toFixed(0)}%)`,
    t: duration * ((p.from + p.to) / 2),
    phaseId: p.id,
  })
}
samples.push({ label: 'LATE', note: 'last 1% of the timeline', t: duration * 0.99 })

// --- render ----------------------------------------------------------------
const outDir = path.isAbsolute(args.out) ? args.out : path.resolve(ROOT, args.out)
fs.mkdirSync(outDir, { recursive: true })
const factor = Math.max(1, Math.round(DESIGN.W / args.width))
const outW = Math.floor(DESIGN.W / factor)
const outH = Math.floor(DESIGN.H / factor)

const index = []
const allProblems = []
const allNotes = []

for (let i = 0; i < samples.length; i++) {
  const s = samples[i]
  const frame = handle.frame(s.t)
  const file = `${String(i).padStart(2, '0')}-${slug(s.label)}.png`
  let rec
  try {
    const surf = rasterizeFrame(frame, { strict: false })
    const small = downsample(surf, factor)
    fs.writeFileSync(path.join(outDir, file), encodePNG(small))
    for (const p of surf.report.problems) allProblems.push(`${file}: ${p}`)
    for (const n of surf.report.notes) allNotes.push(`${file}: ${n}`)
    rec = {
      index: i,
      file,
      label: s.label,
      note: s.note,
      t: frame.t,
      tRounded: Math.round(frame.t),
      phase: frame.phase,
      phaseLabel: frame.phaseLabel,
      phaseProgress: frame.phaseProgress,
      progress: frame.progress,
      done: frame.done,
      layers: Array.isArray(frame.layers) ? frame.layers.length : null,
      primitives: surf.report.counts,
      background: frame.background,
      flash: frame.flash,
      vignette: frame.vignette,
      scanlines: frame.scanlines,
      shake: frame.shake,
      wordmark: frame.wordmark ? frame.wordmark.text : null,
      telemetry: Array.isArray(frame.telemetry) ? frame.telemetry.length : 0,
      problems: surf.report.problems,
      notes: surf.report.notes,
      outW,
      outH,
    }
  } catch (err) {
    allProblems.push(`${file}: rasterizer threw: ${err && err.message ? err.message : err}`)
    rec = { index: i, file, label: s.label, note: s.note, t: Math.round(s.t), error: String(err && err.message ? err.message : err), problems: [], notes: [], primitives: {} }
  }
  index.push(rec)
}

const report = {
  generatedAt: new Date().toISOString(),
  sceneFile: path.isAbsolute(args.scene) ? args.scene : path.relative(ROOT, path.resolve(ROOT, args.scene)).replaceAll('\\', '/'),
  sceneBytes: Buffer.byteLength(code, 'utf8'),
  design: DESIGN,
  output: { file: path.relative(ROOT, outDir).replaceAll('\\', '/'), width: outW, height: outH, downsample: factor },
  config: cfg,
  duration,
  phases: phases.map((p) => ({ id: p.id, label: p.label, from: p.from, to: p.to })),
  frames: index,
  problems: allProblems,
  notes: allNotes,
}
fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
fs.writeFileSync(path.join(outDir, 'index.html'), contactSheet(report))

// --- output ----------------------------------------------------------------
if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  const line = '─'.repeat(78)
  console.log(line)
  console.log(`storyboard — ${report.sceneFile} → ${report.output.file}/`)
  console.log(`  ${outW}x${outH} (design ${DESIGN.W}x${DESIGN.H} / ${factor})   duration ${duration}ms   seed ${cfg.seed}`)
  console.log(`  phases: ${phases.map((p) => `${p.id}[${p.from.toFixed(2)}–${p.to.toFixed(2)}]`).join('  ')}`)
  console.log(line)
  console.log('  #  file                          t(ms)  phase    prog   layers  wm            tel')
  for (const r of index) {
    if (r.error) {
      console.log(`  ${String(r.index).padStart(2)}  ${r.file.padEnd(28)}  ${String(r.tRounded).padStart(5)}  ERROR  ${r.error}`)
      continue
    }
    console.log(
      `  ${String(r.index).padStart(2)}  ${r.file.padEnd(28)}  ${String(r.tRounded).padStart(5)}  ` +
        `${r.phase.padEnd(7)}  ${r.progress.toFixed(3)}  ${String(r.layers).padStart(6)}  ` +
        `${(r.wordmark ?? '—').padEnd(13)} ${String(r.telemetry).padStart(3)}`,
    )
  }
  console.log(line)
  const kinds = new Set()
  for (const r of index) for (const k of Object.keys(r.primitives ?? {})) kinds.add(k)
  console.log(`  primitive kinds seen: ${[...kinds].sort().join(', ') || '(none)'}`)
  console.log(`  contact sheet: ${report.output.file}/index.html`)
  if (allNotes.length > 0) {
    console.log(line)
    console.log(`  ${allNotes.length} note(s):`)
    for (const n of allNotes.slice(0, 20)) console.log(`    · ${n}`)
    if (allNotes.length > 20) console.log(`    · … ${allNotes.length - 20} more`)
  }
  if (allProblems.length > 0) {
    console.log(line)
    console.log(`  !! ${allProblems.length} UNDRAWABLE item(s) — the storyboard does not show the whole frame:`)
    for (const p of allProblems) console.log(`    !! ${p}`)
    console.log(line)
  } else {
    console.log('  no undrawable primitives reported')
  }
}

process.exit(allProblems.length > 0 ? 1 : 0)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function contactSheet(rep) {
  const cards = rep.frames
    .map((r) => {
      const probs = r.problems && r.problems.length > 0
        ? `<ul class="prob">${r.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
        : ''
      return `<figure>
  <img src="./${esc(r.file)}" alt="${esc(r.label)} at ${r.tRounded}ms" width="${rep.output.width}" height="${rep.output.height}">
  <figcaption>
    <b>${esc(r.label)}</b>
    <span class="t">t=${r.tRounded}ms · ${(r.progress ?? 0).toFixed(3)}</span>
    <span class="meta">${esc(r.phase ?? '?')} · ${r.layers ?? '?'} primitives · ${r.note}</span>
    ${r.error ? `<span class="err">RASTER ERROR: ${esc(r.error)}</span>` : ''}
    ${probs}
  </figcaption>
</figure>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>dsh-link-start storyboard</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:24px; background:#05080c; color:#cfe9f5;
         font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace; }
  h1 { font-size:16px; letter-spacing:.18em; font-weight:600; color:#5ad7ff; margin:0 0 4px; }
  .hdr { border:1px solid #12384d; padding:14px 16px; margin-bottom:22px; background:#08121a; }
  .hdr table { border-collapse:collapse; }
  .hdr td { padding:1px 14px 1px 0; vertical-align:top; }
  .hdr td:first-child { color:#5f8ba0; }
  figure { margin:0 0 26px; border:1px solid #12384d; background:#08121a; }
  img { display:block; max-width:100%; height:auto; background:#000; }
  figcaption { padding:8px 12px; border-top:1px solid #12384d; }
  figcaption b { color:#5ad7ff; letter-spacing:.12em; }
  figcaption span { margin-left:12px; color:#7fa6b8; }
  figcaption .meta { color:#5f8ba0; }
  figcaption .err, ul.prob li { color:#ff7b6b; }
  ul.prob { margin:6px 0 0; padding-left:18px; }
  .foot { color:#5f8ba0; margin-top:30px; }
</style></head>
<body>
<h1>DSH LINK START — storyboard</h1>
<div class="hdr"><table>
  <tr><td>scene</td><td>${esc(rep.sceneFile)} (${rep.sceneBytes} bytes)</td></tr>
  <tr><td>output</td><td>${rep.output.width}x${rep.output.height} from design ${rep.design.W}x${rep.design.H} (box ${rep.output.downsample}x)</td></tr>
  <tr><td>duration</td><td>${rep.duration}ms</td></tr>
  <tr><td>config</td><td>${esc(JSON.stringify(rep.config))}</td></tr>
  <tr><td>phases</td><td>${rep.phases.map((p) => `${esc(p.id)} ${p.from.toFixed(2)}–${p.to.toFixed(2)}`).join(' · ')}</td></tr>
  <tr><td>generated</td><td>${esc(rep.generatedAt)}</td></tr>
  <tr><td>problems</td><td>${rep.problems.length === 0 ? 'none' : `<span style="color:#ff7b6b">${rep.problems.length}</span>`}</td></tr>
</table></div>
${cards}
<p class="foot">Rendered offline by <code>tools/storyboard.mjs</code> + <code>tools/raster.mjs</code> — the exact display list <code>src/boot-screen.js</code> draws, no browser involved.</p>
</body></html>
`
}
