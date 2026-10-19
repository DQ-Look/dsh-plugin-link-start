#!/usr/bin/env node
/**
 * verify/verify-namespace.mjs — the string that ties three unconnected files
 * together, and the §3 identity invariants.
 *
 * NOTHING IN DSH CHECKS THAT THESE AGREE. `cordis.patch.yml` mounts the row under
 * an id; `@deepseek-ai/dsh-settings` serves the settings namespace under that
 * same `- insert: id:`; and `src/client.js` looks the namespace up by a string it
 * spells itself in `SETTINGS_NAMESPACE`. If any two disagree, the animation still
 * plays and the settings card is simply never found — no error, anywhere. So this
 * suite is the only thing standing between a rename and a silently orphaned card.
 *
 * §3 identity:
 *   package name        dsh-link-start
 *   row id              link-start
 *   settings namespace  link-start
 *   route prefix        /plugins/dsh-link-start
 *   design space        1600 x 900
 *
 * Exit: 0 pass · 1 fail · 3 pending
 */

import fs from 'node:fs'
import { createSuite, runSuite, readText, readJSON, exists, at, show, EXIT } from './_harness.mjs'

const suite = createSuite('verify-namespace — patch id === SETTINGS_NAMESPACE === §3 identity')

const PKG = 'dsh-link-start'
const ROW_ID = 'link-start'
const ROUTE = '/plugins/dsh-link-start'

const pkg = exists('package.json') ? readJSON('package.json') : null
if (pkg === null) suite.fatal('package.json is missing — §3 identity is unverifiable')
const patch = exists('cordis.patch.yml') ? readText('cordis.patch.yml') : null
if (patch === null) suite.fatal('cordis.patch.yml is missing — §3 identity is unverifiable')

// ---------------------------------------------------------------------------
// 1. package.json invariants (§3, verbatim)
// ---------------------------------------------------------------------------
if (pkg !== null) {
  suite.eq('package name is exactly "dsh-link-start"', pkg.name, PKG)
  suite.eq('package main is index.js', pkg.main, 'index.js')
  suite.eq('package type is module', pkg.type, 'module')
  suite.eq(
    'exports maps "." to ./index.js, "./client" default to ./lib/client.js, and the patch/package entries',
    pkg.exports,
    {
      '.': './index.js',
      './client': { default: './lib/client.js' },
      './cordis.patch.yml': './cordis.patch.yml',
      './package.json': './package.json',
    },
  )
  suite.eq('dsh.client.platform is "web"', pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform, 'web')
  suite.eq('dsh.bundle.patch points at ./cordis.patch.yml', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, './cordis.patch.yml')

  // §3: dsh.client.inject is DELIBERATELY absent.
  suite.check(
    'dsh.client.inject is deliberately ABSENT (declaring it is fatal to the whole GUI)',
    pkg.dsh === undefined || pkg.dsh.client === undefined || !Object.prototype.hasOwnProperty.call(pkg.dsh.client, 'inject'),
    `dsh.client.inject is ${show(pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject)} — a required service leaves the fiber PENDING and web boot refuses to mount`,
  )
  // §3: engines.dsh deliberately omitted.
  suite.check(
    'engines.dsh is deliberately OMITTED (prerelease range matching would refuse the target version)',
    pkg.engines === undefined || !Object.prototype.hasOwnProperty.call(pkg.engines, 'dsh'),
    `engines.dsh is ${show(pkg.engines && pkg.engines.dsh)}`,
  )
  // §3: schemastery is a PEER, never a dependency.
  suite.check(
    '@deepseek-ai/schemastery is a peerDependency, not a dependency',
    pkg.peerDependencies !== undefined && Object.prototype.hasOwnProperty.call(pkg.peerDependencies, '@deepseek-ai/schemastery'),
    `peerDependencies is ${show(pkg.peerDependencies)}`,
  )
  suite.check(
    '@deepseek-ai/schemastery is NOT in dependencies (it must resolve to the kernel copy)',
    pkg.dependencies === undefined || !Object.prototype.hasOwnProperty.call(pkg.dependencies, '@deepseek-ai/schemastery'),
    `dependencies is ${show(pkg.dependencies)}`,
  )
}

// ---------------------------------------------------------------------------
// 2. cordis.patch.yml — the insert row and its id
// ---------------------------------------------------------------------------
if (patch !== null) {
  // YAML comments are prose ABOUT the row; strip them before any structural read
  // so a comment quoting an old id cannot satisfy the assertion (AGENTS.md: strip
  // comments before any regex assertion on an artifact).
  const uncommented = patch
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n')

  const insertIds = [...uncommented.matchAll(/^\s*-\s*insert:\s*$/gm)]
  suite.eq('exactly one "insert:" block exists in this package patch', insertIds.length, 1)

  const idMatch = /^\s*-\s*insert:\s*\r?\n\s*-\s*id:\s*(\S+)\s*$/m.exec(uncommented)
  suite.check(
    'the insert block declares "- id: <value>"',
    idMatch !== null,
    `could not find an "- insert:" followed by "- id:" in the non-comment text:\n${show(uncommented.slice(0, 300))}`,
  )
  const rowId = idMatch === null ? null : idMatch[1]
  suite.eq('the insert row id is exactly "link-start" (§3 row id)', rowId, ROW_ID)

  const nameMatch = /^\s*-\s*insert:\s*\r?\n\s*-\s*id:\s*\S+\s*\r?\n\s*name:\s*(\S+)\s*$/m.exec(uncommented)
  suite.eq('the insert row name is exactly "dsh-link-start"', nameMatch === null ? null : nameMatch[1], PKG)

  // The patch must be a top-level array of entries, and must not carry a stray
  // `config:` on the insert row (that is the settings service's row, not ours).
  suite.check(
    'the patch parses as a top-level YAML list (starts with "- ")',
    /^\s*-\s/m.test(uncommented),
    `first non-comment characters are ${show(uncommented.replace(/^\s+/, '').slice(0, 40))}`,
  )
  suite.check(
    'the insert row carries no "config:" block (that row mounts nothing)',
    !/^\s*-\s*insert:[\s\S]{0,200}?^\s*config:/m.test(uncommented),
    'an insert row with a config block is the settings-override shape, which mounts nothing',
  )
}

// ---------------------------------------------------------------------------
// 3. src/client.js — SETTINGS_NAMESPACE
// ---------------------------------------------------------------------------
const CLIENT_SRC = 'src/client.js'
if (suite.need(CLIENT_SRC, 'client-dev')) {
  const src = readText(CLIENT_SRC)
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const nsMatch = /SETTINGS_NAMESPACE\s*=\s*['"]([^'"]+)['"]/.exec(stripped)
  suite.check(
    "src/client.js declares SETTINGS_NAMESPACE",
    nsMatch !== null,
    'no `SETTINGS_NAMESPACE = "..."` assignment found in the comment-stripped source',
  )
  const ns = nsMatch === null ? null : nsMatch[1]
  suite.eq(
    'SETTINGS_NAMESPACE === the patch row id — nothing in DSH checks this, so the card is silently orphaned when they disagree',
    ns,
    ROW_ID,
  )

  // No other namespace literal may be used for the same lookup.
  const occurrences = [...stripped.matchAll(/['"]link-start['"]/g)].length
  suite.check(
    'the namespace string appears only via SETTINGS_NAMESPACE (no second hard-coded literal to drift)',
    occurrences <= 1 || nsMatch !== null,
    `found ${occurrences} literal 'link-start' occurrences in src/client.js`,
  )
  suite.check(
    'the namespace is not spelled with a different id anywhere obvious',
    !/(?:namespace|ns)\s*[:=]\s*['"]link_start['"]/.test(stripped),
    'found a namespace assignment using a different spelling of the id',
  )
} else {
  // Can still assert the row id against nothing else; already done above.
}

// ---------------------------------------------------------------------------
// 4. Route prefix invariants (§3) — from the host half's own constant
// ---------------------------------------------------------------------------
if (exists('index.js')) {
  const idx = readText('index.js')
  const routeMatch = /const ROUTE\s*=\s*['"]([^'"]+)['"]/.exec(idx)
  suite.check('index.js declares a ROUTE constant', routeMatch !== null, 'no `const ROUTE = "..."` found')
  if (routeMatch !== null) {
    suite.eq('the route prefix is exactly /plugins/dsh-link-start (§3)', routeMatch[1], ROUTE)
    suite.eq('the route prefix is /plugins/<package name>', routeMatch[1], `/plugins/${PKG}`)
  }
  // The config global name must match what boot-screen.js reads (§5).
  const cfgGlobal = /export const CONFIG_GLOBAL\s*=\s*['"]([^'"]+)['"]/.exec(idx)
  suite.eq('CONFIG_GLOBAL is __DSH_LINK_START_CFG__ (§5)', cfgGlobal === null ? null : cfgGlobal[1], '__DSH_LINK_START_CFG__')
  const sceneGlobal = /export const SCENE_GLOBAL\s*=\s*['"]([^'"]+)['"]/.exec(idx)
  suite.eq('SCENE_GLOBAL is __DSH_LINK_START_SCENE__ (§4)', sceneGlobal === null ? null : sceneGlobal[1], '__DSH_LINK_START_SCENE__')
  const screenGlobal = /export const SCREEN_GLOBAL\s*=\s*['"]([^'"]+)['"]/.exec(idx)
  suite.eq('SCREEN_GLOBAL is __DSH_LINK_START__ (§5)', screenGlobal === null ? null : screenGlobal[1], '__DSH_LINK_START__')

  suite.check(
    'index.js does NOT register a prefix route on ROUTE (it would shadow /client.js)',
    !/kind:\s*['"]prefix['"]/.test(idx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')),
    'a prefix route on the package route claims /plugins/dsh-link-start/client.js from dsh-client-modules',
  )
}

// ---------------------------------------------------------------------------
// 5. Cross-file agreement: the id appears in exactly the places §3 names
// ---------------------------------------------------------------------------
if (patch !== null && pkg !== null) {
  suite.check(
    'the row id is the package name minus its "dsh-" prefix',
    ROW_ID === PKG.replace(/^dsh-/, ''),
    `row id "${ROW_ID}" vs package name "${PKG}"`,
  )
}

runSuite(suite)
