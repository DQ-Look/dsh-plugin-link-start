# AGENTS.md — dsh-link-start

Maintainer briefing, for whoever (or whatever) picks this up next: what the package is, the two
facts about DSH it depends on, the rules that each cost a real debugging session, and how to
prove a change is safe.

> Read this first. Then [`INTERFACES.md`](INTERFACES.md) — **the frozen contract**, and the
> single source of truth for every boundary between the halves. It is frozen: if something in
> it is wrong or insufficient, change it deliberately and re-freeze it, rather than letting a
> half drift from it. User-facing usage is [`MANUAL.md`](MANUAL.md) (Chinese); the project
> overview is [`README.md`](README.md).

---

## What it is

A DSH plugin that replaces the kernel's boot page with a full-window, procedurally drawn
《刀剑神域》"LINK START" sequence, then dissolves into the app. No DSH source is modified: it
injects a parser-blocking classic script into `<head>` ahead of the shell, and contributes a
card to Settings → Plugins.

**There is no video, no image, no font, no audio file, and no asset directory anywhere in this
package.** That is the design, not a gap. Every pixel comes from `frame(t)`; the chime is
synthesized. The reference checkout under `.scratch/ref/` is a *shape* reference for docs and
tooling only — it is a different plugin with a different media story, and nothing about its
runtime applies here.

| Half | File | Job |
|---|---|---|
| Host (Node) | `index.js` | `Config` schema, `webserver/index-inject` rows, 2 read-only inspection routes |
| Pre-boot browser | `src/scene.js` | Pure timeline → display list. No DOM, no imports, no `Math.random()` inside `frame` |
| Pre-boot browser | `src/style.css` | Overlay chrome CSS, injected as a `style` row |
| Pre-boot browser | `src/boot-screen.js` | Canvas renderer, DOM overlay, handoff rule, procedural WebAudio |
| Client (browser) | `src/client.js` → `lib/client.js` | `clientReady()` first, then the settings card |
| Build | `build-client.mjs` | Wraps `src/client.js` in the `__ModuleLoader__.load` shell |
| Verify | `verify/*.mjs` | The offline proof. Node only, no DSH, no ports, no prompts |
| Tooling | `tools/install.ps1`, `tools/uninstall.ps1` | Link + patch row, and its exact inverse |
| Tooling | `tools/storyboard.mjs`, `tools/raster.mjs` | Dependency-free PNG rasterizer for the timeline |
| Tooling | `tools/preview.mjs` | Local static preview of the injection, without DSH |

`lib/client.js` is a **build artifact and is committed**. Edit `src/client.js`, then
`node build-client.mjs`. Never hand-edit the artifact.

### The two DSH facts everything rests on

**1. `webserver/index-inject` is the only moment early enough — on the WEB surface.** `@deepseek-ai/dsh-host-webserver`
collects an injection table on every index render; `head` rows are spliced in immediately after
the opening `<head>` tag, ahead of the shell's own module script. A classic (non-module,
non-deferred) script there runs before any module executes and therefore before the kernel
synchronously constructs its own `[data-dsh-boot]` page. Anything later — a slot, an `apply`, a
DOM observer — mounts *over* an already-rendered boot page and an already-arriving app, which
is a different product.

**This is the Web/browser path only, and the distinction matters (INTERFACES.md §9b).** The
desktop app takes the same table over IPC, but the Electron shell does **not** render it into
the document: `serveWebDocument` serves the asar-local `dist/index.html` with only a
`__DSH_BOOT_READY__` deferred spliced into `<head>`, and the frontend entry applies every row at
runtime inside `dshDesktopBoot.ready().then(...)` — strictly **after** it has already
constructed the kernel boot page. No row `kind` or `placement` can change that; the row
vocabulary exists in exactly two places in the process (the Host's webserver, which the shell
never calls, and the shipped frontend bundle's `PZ`, reachable only over IPC). So on desktop the
sequence is *boot page → our overlay → app*, not *our overlay instead of the boot page*.

The overlay is written to be correct under **both** orderings: it never requires that it mounted
first, it finds `[data-dsh-boot]` already present on desktop, and it anchors its timeline to its
own mount instant. A genuinely pre-boot desktop overlay is not achievable from a host plugin —
it would need a shell-level hook (`preload` + `webFrame.executeJavaScript` at `document_start`,
or the shell splicing rows into its own `index.html`), which is a DSH-app change.

Row kinds are `global`, `script`, `script-src`, `script-preload`, `style`, `html`. A **`script`
row's text is interpolated verbatim and is not escaped**, so every injected source must be free
of the literal `</script`; `index.js` refuses to inject and warns instead of breaking the page.
(On desktop the row is applied via `textContent`, where that sequence is harmless — but on Web
the same text sits in HTML text, which is the surface the guard protects.)

**2. A settings namespace IS the profile entry id, and only `.volatile()` fields are served.**
`@deepseek-ai/dsh-settings` derives the form from `entry.fiber.runtime.Config`; `volatileForm()`
keeps only fields carrying `meta.volatile`, and `describe()` drops every entry whose projected
form is empty. The namespace is the `- insert: id:` in the profile patch (`link-start`), and the
browser half reaches that same id through `configForms`. A `Config` with no volatile field
yields no namespace, no card, and **no error anywhere**.

---

## Rules that were each learned the hard way

Every line here has a failure behind it. They are not style preferences.

| Rule | What happens if it is broken |
|---|---|
| **The client half declares no static `inject`; `exports.inject` stays empty.** | A required service leaves the fiber `PENDING` in a profile that lacks it, `apply` never runs, `clientReady()` never fires, and the animation refuses to hand over. Worse, web boot treats ANY non-active entry as fatal: it throws `web boot: N entries did not activate` and **the entire GUI refuses to mount**. Observed in the field as `pending (waiting for service: uisession)`. This is fatal to the whole GUI, not just to this plugin. |
| **Reach optional services with `ctx.inject([...], cb)` and read them with `owner.get(name)`. Never `ctx.get(name)`.** | `ctx.get` is a one-shot read that races activation and silently answers `undefined`. The card then never registers and there is no error anywhere. |
| **Read a volatile config field through `.get()` — `readField()` — never directly.** | `.volatile()` puts a stable reference into the applied config, not the value. Reading it directly yields an object, every type guard falls through to the default, and the settings page appears to do nothing while storing values correctly. That is also why an edit needs no restart: when only volatile values change, the loader commits into the same reference (`updateVolatile`) and emits `loader/volatile-update` instead of restarting the fiber. |
| **Every config field the card edits must be `.volatile()`** — and the `@deepseek-ai/schemastery` that resolves beside this package must actually have the method (>= 3.18.4; the kernel's 3.18.5 has it). | `volatileForm()` projects volatile fields and nothing else, so a `Config` with none is not described at all: no namespace, no card, no error. `index.js` probes once (`LIVE_CAPABLE`) and degrades to a non-volatile schema **without throwing during module evaluation**, because throwing there would take the injection down with the card. `apply` then warns with the fix. |
| **Settings-card registration must be idempotent, and own every throw.** | A duplicate `slots.register` throws INSIDE the slot ledger's store notification, which kills the mounted card's React updates while leaving its DOM in place — a visible, completely dead card with no error at the call site. Keep a `registration` handle and dispose the previous one first. |
| **The card's `summary` view and its page view must be two separate components.** | They use a different number of hooks. One component branching between them is a conditional hook call, which React rejects; the visible symptom is a card that renders but whose every control is dead. |
| **`whileServed(['link-start'], register)` gates the contribution.** | Without it, a profile with no settings provider shows an inert tab that can never work. |
| **Client bundles are served `cache-control: max-age=31536000, immutable`, and the `rev` is a per-process nonce that does not track content.** | After editing `src/client.js` and rebuilding, a plain F5 can keep serving the old bundle, so the change looks like it did nothing. **Ctrl+Shift+R** is the documented step, and `install.ps1` says so. This is also exactly why the animation must NOT live in the client bundle: `src/scene.js`, `src/style.css` and `src/boot-screen.js` are re-read per index render and need only an F5. Keep the bundle's job to the settings card. |
| **Register EXACT webserver routes, one per URL. Never put a prefix on the route prefix.** | The webserver resolves prefixes longest-first, so a prefix on `/plugins/dsh-link-start` also claims `/plugins/dsh-link-start/client.js` — the URL `dsh-client-modules` serves this package's own browser bundle at. That request would answer this plugin's 404, the bundle would never materialize, the card would never register, and nothing in any log would say why. `index.js` registers `kind: 'exact'` for `/state.json` and `/boot.js` only. |
| **No backtick anywhere inside a CSS blob** — neither the overlay's `style()` string nor the card's `CSS` string. | The string ends early and the build silently keeps the *previous* artifact. It looks like the change had no effect. |
| **An attribute selector with a numeric value must quote it** — `[data-state="0"]`, never `[data-state=0]`. | An unquoted value must be a CSS identifier, and one starting with a digit is not, so Chrome drops the ENTIRE rule without a word: the switch looks wired and does nothing. `verify-css.mjs` asserts it with comments stripped first. |
| **Strip comments before ANY regex assertion on an artifact.** | The bundles are comment-preserving, so prose explaining an old approach matches as if it were the approach. |
| **`frame(t)` must be deterministic for a given scene handle: no `Math.random()`, no `Date.now()`, inside `frame`.** | Every storyboard render and every assertion in `verify/` depends on it. Randomness is drawn once in `createScene(cfg)` from a seeded PRNG; jitter is precomputed and indexed by `t`. A test calls `frame(t)` twice and compares `JSON.stringify`. |
| **`enabled: false` must inject NOTHING — no config row, no style, no script.** | Injecting a disabled overlay that bails out at runtime looks identical and leaves the whole thing running (with its requests and its globals). The check in `buildRows` is at the top, deliberately. |
| **The PowerShell pair edits `cordis.patch.yml` as BYTES, and accounts for them before writing.** | Three cmdlet traps, each measured. (1) `Set-Content -Encoding utf8` on PS 5.1 means UTF-8 **with** a BOM — output began `EF BB BF` — over a file that is deliberately BOM-less. (2) `Get-Content` without `-Encoding` decodes with the machine's default file encoding, the system ANSI codepage (936/GBK here) on a default Windows install, so the user's Chinese comes back as mojibake and is written back that way. That one is machine-dependent — this machine has the Windows UTF-8 beta on and decodes fine — which is exactly why the scripts may not rest on it. (3) `ReadAllLines`/`WriteAllLines` terminates every line with `[Environment]::NewLine`: a 306-byte LF layer came back 314 bytes, a whole-file rewrite reported as a one-row change. Use `[System.IO.File]::ReadAllText`/`WriteAllText` with `New-Object System.Text.UTF8Encoding($false)`, and have the uninstaller assert `afterBytes + removedBytes == beforeBytes` **before** it writes. |
| **Count INSERT rows, never occurrences of the plugin name.** | Once the settings card has saved a value, the settings service writes its own `- id: link-start` row with a `config:` block and **no `insert:`** into the same file. That row is a config override: it mounts nothing. A name search finds it, concludes "already installed", and leaves the plugin off the loader graph while reporting success — no animation, no error, nothing to look at. Both scripts therefore match the three-line insert block; `uninstall.ps1` deliberately leaves the override row alone and says so. |
| **Remove the node_modules link with `cmd /c rmdir`, NEVER `Remove-Item -Recurse`.** | A recursive delete follows the junction and destroys the package directory. `uninstall.ps1` also refuses any path that is not a reparse point, because a real directory there is the user's data. |
| **A step that only CHECKS must not repair, and must not roll back.** | `tools/install.ps1`'s liveness probe cannot tell "DSH is down" from "DSH is on a port that was not tried". An earlier generation guessed one port, reported FAILED, and rolled back a fully working install. The current script says "could not tell" and leaves the state alone. |
| **Generated `.ps1` / `.bat` / `.cmd` are pure ASCII — content, not filename.** | A BOM-less `.ps1` is decoded as ANSI on PS 5.1, and a CJK byte sequence inside a string literal can terminate the literal. |
| **A PowerShell statement that ends in `+` does not continue onto the next line.** | `$x = 'a' + $y` is already complete, so a following line starting with `+` parses as a *unary* plus, throws at runtime, and — under `$ErrorActionPreference = 'Continue'` — is swallowed. The value is half-built and nothing says so: a split regex assembled this way matched the wrong block and returned a plausible count. Build patterns with `-join` over an array, one complete expression per line. |
| **Injected text never contains `</script`; the config row escapes `<`.** | A `script` row is not escaped. A literal `</script` anywhere in the source — in a string, in a comment — terminates the element early and leaves the rest as markup. The config global goes through `JSON.stringify(v).replaceAll('<','\\u003c')`. |

---

## Change → restart matrix

| Changed | To see it | Why |
|---|---|---|
| any setting in the card | **page reload (F5)** | volatile values commit into the same reference; the loader emits `loader/volatile-update` instead of restarting the fiber |
| `src/style.css` | **page reload (F5)** | re-read per index render |
| `src/scene.js` | **page reload (F5)** | re-read per index render |
| `src/boot-screen.js` | **page reload (F5)** | re-read per index render |
| `src/client.js` | `node build-client.mjs`, then **Ctrl+Shift+R** | immutable client bundle with a per-process revision; a plain F5 can serve the old one |
| `index.js` | **restart DSH** | the running process holds the old module |
| just ran `tools/install.ps1` | **restart DSH once** | the new patch row has to enter the loader graph |

The host reads the three pre-boot sources **per index render** rather than caching them at
module load, specifically so that editing an animation does not require the restart that this
whole design exists to avoid. Do not "optimise" that into a load-time cache.

---

## Installed state

The package is linked into a DSH profile (`<profile>/node_modules/dsh-link-start` → this
directory) with a one-row `- insert:` block in the profile's `cordis.patch.yml`.
`package.json` is not modified and no pnpm install runs.

**For the `desktop` profile the script is the ONLY route.** `dsh plugin --profile desktop add`
is refused with `error: profile "desktop" is managed exclusively by the Electron application`,
because the Electron app owns that profile. `tools/install.ps1` (`-ProfileName`, default
`desktop`) and `tools/uninstall.ps1` do it; each backs the patch layer up and prints the path.

One thing the link does **not** provide: `@deepseek-ai/schemastery`. `index.js` imports it
statically, so it must resolve from this directory, and it must be a copy with `.volatile()`
(>= 3.18.4 — the kernel's own is 3.18.5). A packaged DSH keeps its copy inside the application
payload, where Node cannot resolve it, so "not found on disk" is an **expected** state on a
released install and only costs the settings card, never the animation. `install.ps1` reports
it as a warning and does not fail.

---

## Verifying a change

```sh
node build-client.mjs            # only if src/client.js changed
node --check src/scene.js        # and any other classic script
node verify/verify-all.mjs       # every offline suite together; exits non-zero on failure
node tools/storyboard.mjs        # renders the timeline to PNGs, one per phase, plus an index
node tools/preview.mjs           # local static preview of the injection, no DSH restart
node tools/e2e-injection.mjs     # the overlay against the KERNEL's own index renderer
```

`tools/e2e-injection.mjs` is the one check that runs real kernel code rather than a
re-implementation: it imports the installed payload's `renderIndexInjections`, renders a real
shipped `index.html`, and asserts the composed overlay lands inside `<head>` **ahead of the
shell's module script**, as a classic (non-module, non-deferred) script, with balanced
`</script>` tags — plus that `enabled: false` produces no rows and a clean render is
unchanged. Its `--selftest` flag substitutes synthetic sources, so the harness's own
assertions can be exercised even when the real sources are missing: a green `--selftest` proves
the *checks* work, and only a green run without the flag proves the *plugin* works. Keep both
modes honest.

**Both of that tool's inputs are optional, and it must say so rather than crash.** It reads the
vendored renderer and the shipped `index.html` from `.scratch/`, which is a gitignored local
extraction of the third-party installed payload and therefore **absent on a fresh clone**. Those
two paths are resolved at runtime (exist-check, then a dynamic `import`), never by a static
`import` — a static import makes the tool die with `ERR_MODULE_NOT_FOUND` on every clone, which
reads as a broken plugin rather than a check that cannot run. Missing inputs exit **3 (PENDING)**
with the exact reason, matching `verify/`'s protocol: not proven, never green, never a failure.
Neither `.scratch/` tree is part of this package, so a clone that has never had them is the
normal case, not a broken state.

`verify/` is Node-only: no DSH process, no ports, no prompts, no network, no dependencies. Each
suite must also run **alone**, and `verify/` uses a three-state exit protocol: **0** pass,
**1** fail, and **3** for PENDING/PARTIAL — "not proven", never a stand-in for green. A partial
suite prints both its green count and its gap, and `verify-all.mjs` treats 3 as a failure of the
overall run unless `--allow-pending` is passed. Final acceptance does **not** pass it. What the
set proves:

| Suite | Proves |
|---|---|
| `verify-scene.mjs` | `scene.js` loads in a bare `vm` context; `normalizeConfig` clamps and never throws; `PHASES` is contiguous 0→1; `frame(t)` is deterministic; the primitive set is exactly the documented one; colors are `#rrggbb`; text is ASCII; every frame <= 600 primitives; no `NaN`/`Infinity` anywhere across a dense sample |
| `verify-screen.mjs` | the overlay against a stub DOM: idempotent second load, no-op when `cfg` is missing, `clientReady()` safe twice, the handoff matrix (auto in both orders, `click` needs a gesture, `holdMs` never auto-enters un-booted), `destroy()` leaves no node behind |
| `verify-css.mjs` | no backtick in the CSS blob; numeric attribute selectors are quoted; every selector is `.dslls-`-namespaced; comments stripped before every assertion |
| `verify-client.mjs` | `lib/client.js` matches a fresh build; exactly one `__ModuleLoader__.load`; **no** `exports.inject`; `clientReady` called before any other work; no `ctx.get(` |
| `verify-entry.mjs` | `index.js` imports; `Config` is a property of the module namespace object; `Config.toJSON()` projects a **non-empty form for every §7.1 field** (this is the settings-visibility proof); exactly 3 rows when enabled and 0 when disabled |
| `verify-namespace.mjs` | `- insert: id:` === `SETTINGS_NAMESPACE` === package name / route-prefix invariants |
| `verify-injection-safety.mjs` | no injected source contains `</script`; the config row escapes `<`; a missing source file degrades instead of throwing |
| `verify-routes.mjs` | the two routes answer with the right content type and `cache-control: no-store`, on stub req/res |
| `verify-raster.mjs` | the PNG encoder emits a valid PNG and every primitive kind and Frame field is exercised |

For a host-half change the minimum manual proof is that the module still evaluates, still
exports the schema the settings service looks for, and still injects the same rows:

```sh
node --check index.js
node -e "import('./index.js').then(m => console.log(Object.keys(m), Object.keys(m.Config.toJSON())))"
```

### Known coverage gaps in `verify/` — read this before trusting a green run

`verify/` is frozen, so when a real defect is found that the suites cannot see, the gap is
recorded here rather than closed by editing an assertion. All three below are **gaps in the
checks, not defects in the shipped code** — the product is correct in each case. They are listed
because a green run currently cannot tell "correct" from "reverted" for these behaviours, so they
need a human eye (or the storyboard) rather than a green tick.

| Gap | What the suite misses | Why it misses it | How to check by hand |
|---|---|---|---|
| **Wordmark fit-to-width is unguarded** | Reverting the fit-to-width block in `src/scene.js` back to a fixed `size` leaves `verify-scene` at exit 0, all 397 assertions green. | The safe-box estimator uses `halfW = len*size*0.72/2`, but the rasterizer's cell font advances **6/7 ≈ 0.857** per glyph, so it under-estimates by up to ~171 px; and it compares against `0..1600` rather than the declared `240..1360` central box (it computes `x0`/`x1` and never uses them). It also samples only the **default 16-character title**, so the long-title case that motivated the fix is never exercised. | Render `node tools/storyboard.mjs` and LOOK at it, or measure the wordmark's real ink span at 2/16/40 characters against the 240..1360 box. At a fixed 96 px a 40-character title spans ~3278 px — twice the design space. |
| **`align` is not modelled** | Dropping `align: 'center'` from the wordmark is not caught, because the estimator assumes `wm.x` is the centre of the text and never reads `wm.align`. | Same estimator. With `x = W/2` and no `align`, the string is drawn left-aligned from the midline and lands off the right edge. | Any wordmark at `x = W/2` must carry `align: 'center'`. Both `tools/raster.mjs` and `src/boot-screen.js` honour it. |
| **`frame.t` is not compared to its input** | Removing the clamp on the echoed `t` is not caught: `progress` is computed independently, and nothing compares `frame.t` to the `t` passed in except at `t = 0`. | The suite asserts `progress` and the hostile-`t` cases, not `t` itself. | `frame.t` must be `clamp(t, 0, duration)`. |

The per-suite table above and INTERFACES.md §8 agree; this section adds what they do *not* cover.

For the PowerShell pair, the proof that matters is a **sandboxed round trip**: copy a real
`cordis.patch.yml` (ideally one carrying CJK) into a temp DSH home, run `install.ps1` then
`uninstall.ps1` against it with `-DshHome`, and assert the file is **byte-identical except for
one declared exception** to the copy afterwards, that no BOM appeared, that the non-ASCII byte
count is unchanged, and that a second `install.ps1` does not append a second row.

The exception: if the original file's last line lacks a terminating newline, the install must
start the appended block on its own line and therefore adds that terminator; nothing on disk
records that the file originally lacked it. Uninstall therefore leaves the file ending in a
newline — that one byte (the added `\n`) cannot be restored. The script documents this
behaviour rather than papering over it. YAML and git both expect a trailing newline, so the
deviation is deliberate. When the original ends with a newline (the normal case), the round
trip is strictly byte-identical.

Add a synthetic patch layer containing a `- id: link-start` row with a `config:` block and no
`insert:` — that is the trap the insert-row counter exists for.

---

## When someone reports something

| Report | Look at | Most likely |
|---|---|---|
| "No animation at all" | the `enabled` setting first, then the host log | `enabled: false` injects nothing at all, so it looks exactly like "not installed". After that: `src/scene.js` / `src/boot-screen.js` unreadable or containing `</script`, in which case `index.js` warns and injects nothing by design |
| "The card is not in Settings" | the DSH startup log for a `dsh-link-start:` warning | The warning names it outright: the resolved `@deepseek-ai/schemastery` has no `.volatile()`, so DSH serves no namespace. Otherwise: the row is collapsed by default, or the patch `id` and `SETTINGS_NAMESPACE` disagree |
| "I changed a setting and nothing happened" | whether the page was reloaded | A setting is read on the next index render. No restart is needed and none helps |
| "It works after a hard reload but not a normal one" | whether `src/client.js` was changed | Expected if so: the client bundle is `immutable` with a per-process `rev`. Rebuild and Ctrl+Shift+R. If the animation itself needs a hard reload, something else is wrong |
| "The card renders but every control is dead" | whether `summary` and the page are one component or two | A conditional hook call, or a duplicate `slots.register` throw that killed the store notification. Both leave the DOM in place and completely inert |
| "It never enters" | `?dshlinkdiag=1` — `STATE`, `BOOTED`, `T` | The dissolve needs the timeline done **and** `clientReady()`. If `BOOTED no`, the client half never reported: check the client bundle actually loaded (a prefix route shadowing `/client.js` does exactly this) |
| "No sound" | the `sound` switch, then whether a gesture happened | Browser autoplay policy: it starts silent and needs a press. With `sound: false` there is deliberately no `AudioContext` at all and no control drawn |
| "The transcript/UI is fine but the whole GUI will not boot" | the client half's `inject` / `exports.inject` | A static inject that the profile cannot satisfy leaves the fiber PENDING and web boot refuses to mount: `web boot: N entries did not activate` |
| "The card shows a muted/tan wrong color scheme" or a style visibly did nothing | the attribute selectors in the CSS blob | An unquoted numeric attribute selector was dropped whole by the browser |
| "A CSS change had no effect at all" | the blob for a stray backtick | The string ended early; the build kept the previous artifact |
| "My `cordis.patch.yml` has mojibake / a BOM" | whether anything other than the two `.ps1` scripts wrote it | A `Get-Content`/`Set-Content` or `Out-File` round trip. Restore from the backup the installer printed and redo it with `uninstall.ps1`/`install.ps1` |
| "It says already installed but nothing is mounted" | `install.ps1`'s insert-row count vs the file | A settings-service `- id: link-start` row with a `config:` block and no `insert:`. That row mounts nothing; the insert row is what is missing |
| "Uninstall left a row behind" | the row's shape | If it has `config:` and no `insert:`, that is the settings override holding the user's saved values, left alone on purpose. Removing it by hand is fine |

---

## House rules

- Code comments are English; user-facing copy inside the plugin is Chinese.
- `MANUAL.md` is Chinese and user-facing; `README.md` is **Chinese-first with a full English
  section** (both self-contained, with a language switcher and anchor links at the top of each);
  this file is English.
- Every tool under `tools/` is named in a root document.
- Generated `.ps1` / `.bat` / `.cmd` are pure ASCII — content, not filename.
- `INTERFACES.md` is frozen. Section numbers are cited from code comments; keep them true.
- **`package.json`'s `files` whitelist is what decides the tarball, and it takes precedence over
  `.gitignore`** (and over `.npmignore` for the paths it names). A bare `"verify"` entry therefore
  ships the verifier's throwaway `verify/scratch/` — measured at 53 files and +54 kB of packed
  size — because `.gitignore` has no say there. The entry is narrowed to `"verify/*.mjs"` plus
  `"verify/fixtures"` so the suites and the shared `_harness.mjs` / `_dom.mjs` still ship while
  scratch cannot. If you ever widen it back to `"verify"`, re-run `npm pack --dry-run | grep scratch`
  and expect no output. (`"private": true` means `npm publish` refuses regardless, so this is
  packaging hygiene rather than a boundary.)
