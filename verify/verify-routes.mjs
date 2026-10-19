#!/usr/bin/env node
/**
 * verify/verify-routes.mjs — the two inspection routes, on stub req/res.
 *
 * §7 requires:
 *   - exact `GET /plugins/dsh-link-start/state.json` → `{ name, version, dsh, config, phase }`,
 *     `no-store`;
 *   - exact `GET /plugins/dsh-link-start/boot.js` → the exact composed injected
 *     script text as `application/javascript`, `no-store`.
 *
 * The routes exist so a test and a human can fetch precisely what the page received
 * instead of reconstructing it from three files by hand. That only works if the
 * content type is right and the response is NEVER cached — a cached `no-store`-less
 * response would show a stale boot.js while the page reloads, which is the exact
 * class of bug the plugin's whole F5 story depends on not having.
 *
 * `apply()` is driven with a stub `ctx`; the route handlers are captured and then
 * called with stub `req`/`res` objects. No server is constructed, no port is bound.
 *
 * Exit: 0 pass · 1 fail · 3 pending
 */

import { createSuite, runSuite, exists, show, EXIT } from './_harness.mjs'

const suite = createSuite('verify-routes — state.json / boot.js: content type + no-store')

const ROUTE = '/plugins/dsh-link-start'

let m = null
try {
  m = await import('../index.js')
} catch (err) {
  suite.fatal(`import('../index.js') threw: ${err && err.message ? err.message : err}`)
}

if (m !== null) {
  /**
   * A stub res that records the head write and the body, and models the real
   * ServerResponse contract the handler relies on (`headersSent`).
   */
  function stubRes() {
    const rec = { status: null, headers: null, body: null, ended: false, headersSent: false }
    return {
      rec,
      writeHead(status, headers) {
        rec.status = status
        rec.headers = headers
        rec.headersSent = true
        return this
      },
      end(body) {
        rec.body = body
        rec.ended = true
        return this
      },
      getHeader(name) {
        return rec.headers ? rec.headers[String(name).toLowerCase()] : undefined
      },
    }
  }

  function stubReq(url = '/') {
    return { method: 'GET', url, headers: {} }
  }

  /** Mount `apply` with a stub ctx and return the captured route table. */
  function mount(config) {
    const routes = []
    const warnings = []
    const ctx = {
      effect(fn) {
        const d = fn()
        return typeof d === 'function' ? d : () => {}
      },
      on() {
        return () => {}
      },
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
      logger: {
        warn: (...a) => warnings.push(a.join(' ')),
        error: (...a) => warnings.push(a.join(' ')),
        info: () => {},
      },
    }
    m.apply(ctx, config)
    return { routes, warnings }
  }

  const settings = m.resolveSettings(undefined)
  const sourcesReady = exists('src/scene.js') && exists('src/boot-screen.js')
  const { routes } = mount(settings)

  const stateRoute = routes.find((r) => r.path === `${ROUTE}/state.json`)
  const bootRoute = routes.find((r) => r.path === `${ROUTE}/boot.js`)

  // -------------------------------------------------------------------------
  // Route registration shape
  // -------------------------------------------------------------------------
  suite.eq('exactly two routes are registered (§7)', routes.length, 2)
  suite.check('the state.json route is registered', stateRoute !== undefined, `registered paths: ${routes.map((r) => r.path).join(', ')}`)
  suite.check('the boot.js route is registered', bootRoute !== undefined, `registered paths: ${routes.map((r) => r.path).join(', ')}`)
  suite.eq(
    '§7 the routes are EXACT, never prefix — a prefix would claim /client.js from dsh-client-modules',
    routes.map((r) => r.kind),
    ['exact', 'exact'],
  )
  suite.check(
    'every route path starts with the §3 route prefix',
    routes.every((r) => typeof r.path === 'string' && r.path.startsWith(`${ROUTE}/`)),
    `paths: ${routes.map((r) => r.path).join(', ')}`,
  )
  suite.check(
    'no route claims the bare prefix itself (that is what shadows /client.js)',
    !routes.some((r) => r.path === ROUTE),
    `a route is registered at exactly ${ROUTE}`,
  )
  suite.check(
    'both routes expose a handler function',
    routes.every((r) => typeof r.handler === 'function'),
    'a route was registered without a handler',
  )

  // -------------------------------------------------------------------------
  // GET /state.json
  // -------------------------------------------------------------------------
  if (stateRoute !== undefined) {
    const res = stubRes()
    const r = suite.notThrows('the state.json handler does not throw', () => stateRoute.handler(stubReq(`${ROUTE}/state.json`), res))
    if (r.ok) {
      suite.eq('state.json answers 200', res.rec.status, 200)
      suite.is(
        'state.json content-type is application/json',
        res.rec.headers && res.rec.headers['content-type'],
        (v) => typeof v === 'string' && v.startsWith('application/json'),
        'expected a content-type starting with application/json',
      )
      suite.eq(
        'state.json sends cache-control: no-store (§7)',
        res.rec.headers && res.rec.headers['cache-control'],
        'no-store',
      )
      suite.check(
        'state.json sets an accurate content-length',
        res.rec.headers && String(res.rec.headers['content-length']) === String(Buffer.byteLength(res.rec.body)),
        `content-length ${show(res.rec.headers && res.rec.headers['content-length'])} vs actual ${Buffer.byteLength(res.rec.body ?? '')}`,
      )
      suite.check('state.json ends the response', res.rec.ended === true, 'the handler never called res.end()')

      let parsed = null
      suite.section('state.json body', () => {})
      const p = suite.notThrows('the state.json body is valid JSON', () => JSON.parse(res.rec.body.toString('utf8')))
      if (p.ok) {
        parsed = p.value
      }
      if (parsed !== null) {
        suite.eq('§7 state.json reports the package name', parsed.name, 'dsh-link-start')
        suite.check('§7 state.json carries a "version"', typeof parsed.version === 'string' && parsed.version.length > 0, `version is ${show(parsed.version)}`)
        suite.check('§7 state.json carries a "dsh" field', 'dsh' in parsed, `keys are ${Object.keys(parsed).join(', ')}`)
        suite.eq('§7 state.json reports phase "host"', parsed.phase, 'host')
        suite.check('§7 state.json carries the resolved config', parsed.config !== null && typeof parsed.config === 'object', `config is ${show(parsed.config)}`)
        if (parsed.config !== null && typeof parsed.config === 'object') {
          // §7: "config is the resolved config read through readField" — i.e. the
          // full resolveSettings() output, which includes `enabled`. (`index.js`
          // omits `enabled` only from the BROADCAST global, via broadcastConfig,
          // because a disabled config produces no rows at all.)
          const expected = ['enabled', 'durationMs', 'fadeMs', 'enterMode', 'accent', 'sound', 'glitch', 'scanlines', 'telemetry', 'wordmark', 'title', 'respectReducedMotion', 'seed', 'holdMs']
          for (const k of expected) {
            suite.check(`state.json config carries "${k}"`, k in parsed.config, `missing "${k}"; config keys: ${Object.keys(parsed.config).join(', ')}`)
          }
          suite.eq('state.json config matches resolveSettings(config) exactly', parsed.config, settings)
        }
      }
    }

    // A throwing handler must be owned, not escape into the server.
    const brokenRoute = mount({ ...settings })
    const stateHandler = brokenRoute.routes.find((r) => r.path === `${ROUTE}/state.json`)
    const res2 = stubRes()
    const r2 = suite.notThrows('the state.json handler owns its own throws (never escapes the route)', () => stateHandler.handler(stubReq(), res2))
    if (r2.ok) {
      suite.check('the state.json handler always answers', res2.rec.status !== null, 'no status was written')
    }
  }

  // -------------------------------------------------------------------------
  // GET /boot.js
  // -------------------------------------------------------------------------
  if (bootRoute !== undefined) {
    const res = stubRes()
    const r = suite.notThrows('the boot.js handler does not throw', () => bootRoute.handler(stubReq(`${ROUTE}/boot.js`), res))
    if (r.ok) {
      suite.is(
        'boot.js content-type is application/javascript',
        res.rec.headers && res.rec.headers['content-type'],
        (v) => typeof v === 'string' && v.startsWith('application/javascript'),
        'expected a content-type starting with application/javascript',
      )
      suite.eq('boot.js sends cache-control: no-store (§7)', res.rec.headers && res.rec.headers['cache-control'], 'no-store')
      suite.check(
        'boot.js sets an accurate content-length',
        res.rec.headers && String(res.rec.headers['content-length']) === String(Buffer.byteLength(res.rec.body)),
        `content-length ${show(res.rec.headers && res.rec.headers['content-length'])} vs actual ${Buffer.byteLength(res.rec.body ?? '')}`,
      )
      suite.check('boot.js ends the response', res.rec.ended === true, 'the handler never called res.end()')
      suite.check('boot.js always answers a status', res.rec.status !== null, 'no status was written')

      const body = res.rec.body.toString('utf8')
      if (sourcesReady && settings.enabled) {
        suite.eq('§7 boot.js answers 200 when the sources are present and readable', res.rec.status, 200)
        // The body must be EXACTLY what the page is given — byte for byte.
        const expected = m.composeOverlay({
          scene: m.readSource('src/scene.js'),
          screen: m.readSource('src/boot-screen.js'),
        })
        suite.eq(
          '§7 boot.js returns the EXACT composed overlay text the page receives (byte for byte)',
          body,
          expected,
        )
        suite.check(
          'the served overlay contains no literal </script (it would be injected into the HTML)',
          !body.toLowerCase().includes('</script'),
          `found "</script" at offset ${body.toLowerCase().indexOf('</script')}`,
        )
        suite.check(
          'the served overlay actually references both halves',
          body.includes('__DSH_LINK_START_SCENE__'),
          'the composed overlay does not define the scene global, so boot-screen.js would bail out',
        )
      } else {
        suite.check(
          '§7 boot.js degrades to 404 (never a throw) when the overlay sources are missing',
          res.rec.status === 404,
          `answered ${res.rec.status} while src/scene.js exists=${exists('src/scene.js')} and src/boot-screen.js exists=${exists('src/boot-screen.js')}`,
        )
      }
    }

    // disabled: must answer, must not serve the overlay
    const { routes: offRoutes } = mount(m.resolveSettings({ enabled: false }))
    const offBoot = offRoutes.find((rr) => rr.path === `${ROUTE}/boot.js`)
    const offRes = stubRes()
    const offR = suite.notThrows('the boot.js handler does not throw when disabled', () => offBoot.handler(stubReq(), offRes))
    if (offR.ok) {
      suite.eq('boot.js sends no-store when disabled too', offRes.rec.headers && offRes.rec.headers['cache-control'], 'no-store')
      suite.check('boot.js always answers a status when disabled', offRes.rec.status !== null, 'no status was written')
      const offBody = offRes.rec.body.toString('utf8')
      // When the sources are unreadable the handler 404s before it reaches the
      // disabled branch, which is correct: there is no overlay to describe.
      if (sourcesReady) {
        suite.eq('boot.js answers 200-with-a-comment when disabled and the sources exist', offRes.rec.status, 200)
        suite.check(
          'boot.js serves no overlay code when disabled, only a comment (§7)',
          !offBody.includes('__DSH_LINK_START_SCENE__'),
          `the disabled boot.js still carried the overlay: ${show(offBody.slice(0, 120))}`,
        )
        suite.check(
          'the disabled boot.js body is a comment explaining why',
          offBody.trimStart().startsWith('/*'),
          `not a comment: ${show(offBody.slice(0, 120))}`,
        )
      } else {
        suite.check(
          'boot.js answers 404 when disabled AND the overlay sources are unreadable (nothing to serve)',
          offRes.rec.status === 404,
          `answered ${offRes.rec.status}`,
        )
      }
      suite.check(
        'the disabled boot.js never serves overlay code',
        !offBody.includes('__DSH_LINK_START_SCENE__'),
        `the disabled boot.js carried the overlay: ${show(offBody.slice(0, 120))}`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // The routing trap: nothing may claim /client.js
  // -------------------------------------------------------------------------
  suite.section('the client-bundle URL is not shadowed', () => {
    const CLIENT_URL = `${ROUTE}/client.js`
    const claiming = routes.filter((r) => {
      if (r.kind === 'exact') return r.path === CLIENT_URL
      // prefix semantics, mirroring webserver.match(): equal, or a path segment prefix
      return CLIENT_URL === r.path || CLIENT_URL.startsWith(`${r.path}/`)
    })
    suite.eq(
      '§7 no registered route claims /plugins/dsh-link-start/client.js (dsh-client-modules owns it)',
      claiming.map((r) => `${r.kind}:${r.path}`),
      [],
    )
  })

  // -------------------------------------------------------------------------
  // Handlers are safe with a hostile/odd req
  // -------------------------------------------------------------------------
  suite.section('handlers tolerate an odd req', () => {
    for (const [label, req] of [
      ['no url', {}],
      ['url undefined', { url: undefined }],
      ['a query string', { url: `${ROUTE}/state.json?x=1` }],
      ['a different path', { url: '/nope' }],
    ]) {
      for (const route of routes) {
        const res = stubRes()
        const r = suite.notThrows(`${route.path} handler tolerates a req with ${label}`, () => route.handler(req, res))
        if (r.ok) {
          suite.check(
            `${route.path} handler answers on a req with ${label}`,
            res.rec.status !== null,
            'the handler returned without writing a response, which would hang the request',
          )
        }
      }
    }
  })
}

runSuite(suite)
