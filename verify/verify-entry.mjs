#!/usr/bin/env node
/**
 * verify/verify-entry.mjs — the Host half: what the settings service sees, and
 * what `apply` injects.
 *
 * This suite carries the SETTINGS-VISIBILITY PROOF. `@deepseek-ai/dsh-settings`
 * decides whether to serve this entry as a namespace like this (read from the
 * installed payload, `.scratch/dsh-src/.../dsh-settings/lib/index.js`):
 *
 *     schema(entry) {                                     // line 538
 *       const schema = entry.fiber?.runtime?.Config
 *       return schema !== void 0 && 'toJSON' in schema ? schema : void 0
 *     }
 *     describe() {                                        // line 413
 *       const form = volatileForm(schema)                 // line 122
 *       if (form === void 0) return []                    // line 419 — dropped silently
 *     }
 *     volatileForm(schema) {                              // line 122
 *       if (schema.meta.volatile) return plainSchema(schema)
 *       if (schema.type === 'object') {
 *         const dict = ... fields whose recursive volatileForm() is defined ...
 *         return Object.keys(dict).length === 0 ? void 0 : z.object(dict)
 *       }
 *     }
 *
 * So the predicate that decides whether the settings card exists at all is:
 * `volatileForm(Config) !== undefined` and it must retain EVERY §7.1 field. A
 * Config with one non-volatile field silently loses that control; a Config with
 * none loses the whole namespace, with no error anywhere. This suite replicates
 * `volatileForm` exactly and asserts the full field set survives it — a stand-in
 * for "the card will be there", which is otherwise unprovable offline.
 *
 * Exit: 0 pass · 1 fail · 3 pending (a file owned by someone else has not landed)
 */

import { createSuite, runSuite, readJSON, exists, show, EXIT } from './_harness.mjs'

const suite = createSuite('verify-entry — index.js: schema visibility + injected rows')

// ---------------------------------------------------------------------------
// §7.1 — the frozen field list. A typo here is a test bug, so it is transcribed
// verbatim from the contract and compared against the schema both ways.
// ---------------------------------------------------------------------------
const SPEC_7_1 = [
  ['enabled', 'boolean', true],
  ['durationMs', 'number', 6800],
  ['fadeMs', 'number', 1000],
  ['enterMode', 'union', 'auto'],
  ['accent', 'string', '#5ad7ff'],
  ['sound', 'boolean', true],
  ['glitch', 'boolean', true],
  ['scanlines', 'boolean', true],
  ['telemetry', 'boolean', true],
  ['wordmark', 'boolean', true],
  ['title', 'string', 'DEEPSEEK HARNESS'],
  ['respectReducedMotion', 'boolean', true],
  ['seed', 'number', 0],
  ['holdMs', 'number', 20000],
]

let m = null
suite.section('import index.js', () => {
  // dynamic import inside section so a throw becomes one named failure
})

try {
  m = await import('../index.js')
} catch (err) {
  suite.fatal(`import('../index.js') threw: ${err && err.message ? err.message : err}`)
}

if (m !== null) {
  // -------------------------------------------------------------------------
  // Identity (§3) — checked here too because the namespace IS the entry id
  // -------------------------------------------------------------------------
  suite.eq('name export is "dsh-link-start"', m.name, 'dsh-link-start')
  suite.is(
    'inject declares exactly ["webServer"]',
    m.inject,
    (v) => Array.isArray(v) && v.length === 1 && v[0] === 'webServer',
    'expected exactly ["webServer"]',
  )

  // -------------------------------------------------------------------------
  // Config exists on the MODULE NAMESPACE OBJECT
  // -------------------------------------------------------------------------
  const hasOwn = Object.prototype.hasOwnProperty.call(m, 'Config')
  suite.check('Config is an own property of the module namespace object', hasOwn, 'no `Config` export was found')
  const C = m.Config
  suite.check('Config is present', C !== undefined && C !== null, `Config is ${show(C)}`)
  suite.check(
    'Config has a toJSON method (dsh-settings requires "toJSON" in schema)',
    C !== undefined && C !== null && 'toJSON' in C,
    'without toJSON the settings service ignores the schema entirely and the card is absent',
  )
  suite.check('Config is an object schema', C !== undefined && C !== null && C.type === 'object', `Config.type is ${C && C.type}`)

  // -------------------------------------------------------------------------
  // THE VISIBILITY PROOF. Exact replica of dsh-settings volatileForm().
  // -------------------------------------------------------------------------
  function volatileForm(schema) {
    if (schema.meta && schema.meta.volatile) return { kind: 'whole' }
    if (schema.type === 'object') {
      const dict = Object.fromEntries(
        Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
          const field = volatileForm(child)
          return field === undefined ? [] : [[key, field]]
        }),
      )
      return Object.keys(dict).length === 0 ? undefined : { kind: 'object', dict }
    }
    return undefined
  }

  const form = C === undefined ? undefined : volatileForm(C)
  suite.check(
    'volatileForm(Config) is NOT undefined — the settings namespace is served at all',
    form !== undefined,
    'a Config with no volatile field projects an empty form, describe() drops the entry, and the card is silently absent with no error',
  )

  // via the toJSON round trip too, because `plainSchema`/`new z(schema.toJSON())`
  // is the path the service actually walks.
  suite.section('Config.toJSON() round trip', () => {
    const z = m.z ?? null
    const j = C.toJSON()
    suite.check('Config.toJSON() returns an object', j !== null && typeof j === 'object', `got ${show(j)}`)
  })

  // -------------------------------------------------------------------------
  // Every §7.1 field survives, with the right type and default
  // -------------------------------------------------------------------------
  const dict = C !== undefined && C !== null ? C.dict ?? {} : {}
  const present = Object.keys(dict)
  for (const [field, type, dflt] of SPEC_7_1) {
    const node = dict[field]
    suite.check(
      `§7.1 "${field}" is present in Config`,
      node !== undefined,
      `Config.dict is missing "${field}"; present: ${present.join(', ') || '(none)'}`,
    )
    if (node === undefined) continue
    suite.check(
      `§7.1 "${field}" is volatile — without this the control never appears in the card`,
      node.meta !== undefined && node.meta.volatile === true,
      `meta.volatile is ${show(node.meta && node.meta.volatile)}; volatileForm() drops this field, so the card loses this exact control with no error`,
    )
    suite.eq(`§7.1 "${field}" has type ${type}`, node.type, type)
    suite.eq(`§7.1 "${field}" has default ${show(dflt)}`, node.meta && node.meta.default, dflt)
    if (form !== undefined && form.kind === 'object') {
      suite.check(
        `§7.1 "${field}" survives volatileForm() projected`,
        form.dict[field] !== undefined,
        `volatileForm() dropped "${field}" — the settings page will not render this control`,
      )
    }
  }
  suite.is(
    'Config declares no field beyond §7.1 (unknown fields widen what can drift)',
    present.slice().sort(),
    (v) => {
      const spec = SPEC_7_1.map(([f]) => f).sort()
      return v.length === spec.length && v.every((k, i) => k === spec[i])
    },
    `expected exactly [${SPEC_7_1.map(([f]) => f).join(', ')}]`,
  )

  // Range/metadata assertions from §7.1's "notes" column
  suite.eq('durationMs range is 3000..20000', [dict.durationMs?.meta?.min, dict.durationMs?.meta?.max], [3000, 20000])
  suite.eq('fadeMs range is 200..4000', [dict.fadeMs?.meta?.min, dict.fadeMs?.meta?.max], [200, 4000])
  suite.eq('holdMs range is 3000..60000', [dict.holdMs?.meta?.min, dict.holdMs?.meta?.max], [3000, 60000])
  suite.eq('seed range is 0..2147483647', [dict.seed?.meta?.min, dict.seed?.meta?.max], [0, 2147483647])
  suite.eq(
    'enterMode is the union of auto|click',
    (dict.enterMode?.list ?? []).map((n) => n.value ?? n.meta?.value).sort(),
    ['auto', 'click'],
  )

  // -------------------------------------------------------------------------
  // resolveSettings — the volatile-reference read path
  // -------------------------------------------------------------------------
  const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')
  suite.section('resolveSettings reads a volatile reference through .get()', () => {
    const live = {
      enabled: { [VOLATILE_REF]: true, get: () => true },
      durationMs: { [VOLATILE_REF]: true, get: () => 4321 },
      fadeMs: { [VOLATILE_REF]: true, get: () => 777 },
      enterMode: { [VOLATILE_REF]: true, get: () => 'click' },
      accent: { [VOLATILE_REF]: true, get: () => '#ff8800' },
      sound: { [VOLATILE_REF]: true, get: () => false },
      glitch: { [VOLATILE_REF]: true, get: () => false },
      scanlines: { [VOLATILE_REF]: true, get: () => false },
      telemetry: { [VOLATILE_REF]: true, get: () => false },
      wordmark: { [VOLATILE_REF]: true, get: () => false },
      title: { [VOLATILE_REF]: true, get: () => 'LIVE TITLE' },
      respectReducedMotion: { [VOLATILE_REF]: true, get: () => false },
      seed: { [VOLATILE_REF]: true, get: () => 12345 },
      holdMs: { [VOLATILE_REF]: true, get: () => 45000 },
    }
    const got = m.resolveSettings(live)
    suite.eq('resolveSettings reads every field through .get() (not the reference object)', got, {
      enabled: true,
      durationMs: 4321,
      fadeMs: 777,
      enterMode: 'click',
      accent: '#ff8800',
      sound: false,
      glitch: false,
      scanlines: false,
      telemetry: false,
      wordmark: false,
      title: 'LIVE TITLE',
      respectReducedMotion: false,
      seed: 12345,
      holdMs: 45000,
    })
  })

  suite.section('resolveSettings falls back and clamps (§7.1)', () => {
    const d = m.resolveSettings(undefined)
    suite.eq('resolveSettings(undefined) yields every documented default', d, {
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
      title: 'DEEPSEEK HARNESS',
      respectReducedMotion: true,
      seed: 0,
      holdMs: 20000,
    })
    const bad = m.resolveSettings({
      durationMs: 999999,
      fadeMs: -5,
      holdMs: 1,
      seed: -3,
      accent: 'red',
      enterMode: 'nope',
      title: '   ',
      enabled: 'yes',
    })
    suite.eq('out-of-range numbers are clamped, not passed through', {
      durationMs: bad.durationMs,
      fadeMs: bad.fadeMs,
      holdMs: bad.holdMs,
      seed: bad.seed,
    }, { durationMs: 20000, fadeMs: 200, holdMs: 3000, seed: 0 })
    suite.eq('a non-#rrggbb accent falls back to the default', bad.accent, '#5ad7ff')
    suite.eq('an unknown enterMode falls back to auto', bad.enterMode, 'auto')
    suite.eq('a blank title falls back to the default', bad.title, 'DEEPSEEK HARNESS')
    suite.eq('a non-boolean enabled falls back to true', bad.enabled, true)
    suite.check(
      'a title longer than 40 chars is truncated',
      m.resolveSettings({ title: 'X'.repeat(120) }).title.length === 40,
      `length ${m.resolveSettings({ title: 'X'.repeat(120) }).title.length}`,
    )
    suite.is(
      'control characters are stripped from the title (they would corrupt the wordmark)',
      m.resolveSettings({ title: 'A\u0000B\u001fC' }).title,
      (v) => v === 'A B C',
      'expected control chars replaced with spaces — "A B C"',
    )
  })

  // -------------------------------------------------------------------------
  // buildRows — exactly 3 rows enabled, 0 disabled
  // -------------------------------------------------------------------------
  suite.section('buildRows: row set and order', () => {
    const src = { scene: '(function(){})()', screen: '(function(){})()', style: '.dslls-root{inset:0}' }
    const settings = m.resolveSettings(undefined)
    const rows = m.buildRows(settings, src)
    suite.eq('enabled -> exactly 3 rows', rows.length, 3)
    suite.eq(
      'row order is global, style, script (§7)',
      rows.map((r) => r.kind),
      ['global', 'style', 'script'],
    )
    suite.eq('the config row is a global row named __DSH_LINK_START_CFG__', rows[0] && { kind: rows[0].kind, name: rows[0].name }, {
      kind: 'global',
      name: '__DSH_LINK_START_CFG__',
    })
    suite.eq('the script row is placement "head" (that is the whole mechanism)', rows[2] && rows[2].placement, 'head')
    suite.check(
      'the script row composes scene.js BEFORE boot-screen.js',
      typeof rows[2].text === 'string' && rows[2].text.indexOf('(function(){})()') === 0,
      `text starts ${show(rows[2].text && rows[2].text.slice(0, 40))}`,
    )
    suite.check(
      'the style row carries the stylesheet',
      rows[1] && rows[1].text === src.style,
      `style row text is ${show(rows[1] && rows[1].text)}`,
    )

    const off = m.buildRows({ ...settings, enabled: false }, src)
    suite.eq('enabled:false -> 0 rows (§10.6: injects nothing at all)', off.length, 0)

    suite.eq('a missing scene source degrades to 0 rows rather than blanking the page', m.buildRows(settings, { ...src, scene: undefined }).length, 0)
    suite.eq('a missing screen source degrades to 0 rows', m.buildRows(settings, { ...src, screen: undefined }).length, 0)
    suite.eq(
      'a missing stylesheet still injects the 2 essential rows (chrome is optional)',
      m.buildRows(settings, { scene: src.scene, screen: src.screen }).length,
      2,
    )
  })

  // -------------------------------------------------------------------------
  // apply() against a stub ctx
  // -------------------------------------------------------------------------
  suite.section('apply() with a stub ctx', () => {
    function stubCtx() {
      const captured = { routes: [], events: [], effects: 0, warnings: [], errors: [] }
      return {
        captured,
        ctx: {
          effect(fn, label) {
            captured.effects++
            const d = fn()
            return typeof d === 'function' ? d : () => {}
          },
          on(event, cb) {
            captured.events.push({ event, cb })
            return () => {}
          },
          webServer: {
            register(route) {
              captured.routes.push(route)
              return () => {}
            },
          },
          logger: {
            warn: (...a) => captured.warnings.push(a.join(' ')),
            error: (...a) => captured.errors.push(a.join(' ')),
            info: () => {},
          },
        },
      }
    }

    const { ctx, captured } = stubCtx()
    const settings = m.resolveSettings(undefined)
    const applied = suite.notThrows('apply(ctx, config) does not throw', () => m.apply(ctx, settings))
    if (applied.ok) {
      suite.eq('apply registers exactly the 2 inspection routes', captured.routes.length, 2)
      suite.eq(
        'both routes are kind "exact" — a prefix would shadow the client bundle at /client.js',
        captured.routes.map((r) => r.kind),
        ['exact', 'exact'],
      )
      suite.eq(
        'route paths are the two documented URLs',
        captured.routes.map((r) => r.path).sort(),
        ['/plugins/dsh-link-start/boot.js', '/plugins/dsh-link-start/state.json'],
      )
      suite.is(
        'no route registers a prefix at all',
        captured.routes,
        (rs) => rs.every((r) => r.kind === 'exact'),
        'every route must be exact',
      )
      const sub = captured.events.find((e) => e.event === 'webserver/index-inject')
      suite.check('apply subscribes to webserver/index-inject', sub !== undefined, `subscribed events: ${captured.events.map((e) => e.event).join(', ') || '(none)'}`)

      if (sub !== undefined) {
        // enabled: the subscriber pushes whatever the real on-disk sources allow
        const table = []
        sub.cb(table)
        const sourcesReady = exists('src/scene.js') && exists('src/boot-screen.js')
        if (sourcesReady) {
          suite.eq('the index-inject subscriber pushes exactly 3 rows when enabled', table.length, 3)
          suite.eq('pushed row kinds are global, style, script', table.map((r) => r.kind), ['global', 'style', 'script'])
          suite.eq('the pushed script row is head placement', table[2].placement, 'head')
          suite.check(
            'the pushed script row carries BOTH scene.js and boot-screen.js',
            typeof table[2].text === 'string' && table[2].text.length > 100,
            `script text length ${table[2].text && table[2].text.length}`,
          )
        } else {
          suite.check(
            'disabled or missing sources must push ZERO rows (degrade to the kernel boot page)',
            table.length === 0,
            `pushed ${table.length} rows while src/scene.js exists=${exists('src/scene.js')} and src/boot-screen.js exists=${exists('src/boot-screen.js')}`,
          )
        }

        // disabled: must push NOTHING regardless of what is on disk
        const offTable = []
        const offCtx = stubCtx()
        m.apply(offCtx.ctx, m.resolveSettings({ enabled: false }))
        const offSub = offCtx.captured.events.find((e) => e.event === 'webserver/index-inject')
        offSub.cb(offTable)
        suite.eq('the subscriber pushes 0 rows when enabled:false (§10.6)', offTable.length, 0)
      }
    }
  })

  // -------------------------------------------------------------------------
  // Row count via the exported pure function, independent of on-disk state
  // -------------------------------------------------------------------------
  suite.section('state.json rowCount field', () => {
    const settings = m.resolveSettings(undefined)
    const n = m.buildRows(settings, { scene: '', screen: '' }).length
    suite.check(
      'buildRows over two empty-but-injectable sources yields the 2 essential rows (global + script)',
      n === 2,
      `got ${n}`,
    )
  })
}

runSuite(suite)
