# dsh-link-start

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that replaces the
kernel boot page with a full-window, procedurally drawn **《刀剑神域》"LINK START"** start
sequence, then dissolves into the app.

**No video. No images. No fonts. No audio files. No network requests on the boot path.**
The animation is a pure function of time: `frame(t)` returns a display list every frame, and
the renderer draws it. First paint is therefore immediate, because there is nothing to fetch
and nothing to decode before the first frame exists.

```text
VOID  ->  GRID  ->  RETICLE  ->  LINK  ->  SURGE  ->  RESOLVE  ->  dissolve
0.00     0.07      0.30         0.50     0.72       0.86         1.00
```

---

## Install

### Desktop (the `desktop` profile) — the script is the only route

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

`dsh plugin --profile desktop add` is **refused**:

```
error: profile "desktop" is managed exclusively by the Electron application
```

The desktop profile is owned by the Electron app, so the CLI will not write into it. The
link + patch-row method is therefore not a fallback for that profile — it is the only way in.
That is why `tools/install.ps1` defaults to `-ProfileName desktop`.

The script does exactly two things:

1. a directory junction at `<profile>\node_modules\dsh-link-start` → this directory;
2. one appended `- insert:` row in `<profile>\cordis.patch.yml`.

It does **not** touch `package.json`, does **not** run pnpm, and does **not** restart DSH.
It backs the patch layer up first and prints the backup path.

```powershell
# another profile, an explicit home, or a different probe port
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -ProfileName web
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -DshHome C:\Users\me\.dsh
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Port 19387
```

> **The patch layer is edited as bytes, and the docs say so on purpose.** `cordis.patch.yml`
> is BOM-less UTF-8 and routinely carries CJK (a provider `displayName`, a comment). The usual
> cmdlets break it in three measured ways:
>
> * `Set-Content -Encoding utf8` on PowerShell 5.1 means *UTF-8 with a BOM* — the written file
>   began `EF BB BF`.
> * `Get-Content` without `-Encoding` decodes with the machine's default file encoding — the
>   system ANSI codepage (936/GBK here) on a default Windows install — so BOM-less UTF-8 comes
>   back as mojibake and is written back that way. It is machine-dependent, which is the point:
>   this machine has the Windows UTF-8 beta enabled and happens to decode fine, so correctness
>   cannot rest on it.
> * `ReadAllLines`/`WriteAllLines` terminates every line with `[Environment]::NewLine`, so an
>   LF layer came back all-CRLF — a 306-byte file became 314 bytes. A whole-file rewrite
>   reported as a one-row change.
>
> Both scripts therefore use `[System.IO.File]::ReadAllText`/`WriteAllText` with
> `New-Object System.Text.UTF8Encoding($false)`, and `uninstall.ps1` asserts the byte
> accounting **before** it writes anything. Both scripts are pure ASCII (every byte < 128;
> max byte 125), because a BOM-less `.ps1` is decoded the same way and a CJK byte can terminate
> a string literal.

### Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1
```

Reverses exactly the two changes, leaving `cordis.patch.yml` **byte-identical except for the
row it owns**. The link is removed with `cmd /c rmdir`, never `Remove-Item -Recurse` — a
recursive delete follows a junction into the package directory and destroys it. Any path that
is not a reparse point is refused rather than deleted.

---

## Using it

Settings live at **Settings → Plugins → Plugin configuration**, on the **LINK START** row
(collapsed by default — click it). Every control is documented in
[MANUAL.md](MANUAL.md) (Chinese, the user-facing document): master switch, `durationMs`,
`fadeMs`, `enterMode`, `accent`, `sound`, `glitch`, `scanlines`, `telemetry`, `wordmark`,
`title`, `respectReducedMotion`, `seed`, `holdMs`.

**Changes take effect on a page reload, not a DSH restart** — with one exception, and it is
the single most likely thing to waste an afternoon:

> A change to `src/client.js` needs `node build-client.mjs` and then a **hard refresh
> (Ctrl+Shift+R)**. Client bundles are served `cache-control: max-age=31536000, immutable`,
> and the `rev` in the bundle URL is a per-process nonce that does not track content, so a
> plain F5 can keep serving the old bundle.

The animation itself is not in that bundle, so it only ever needs an F5.

### Change → what it takes

| Changed | To see it | Why |
|---|---|---|
| any setting | page reload (F5) | volatile values commit into the same reference; the loader emits `loader/volatile-update` instead of restarting the fiber |
| `src/style.css` | page reload (F5) | the host re-reads it per index render |
| `src/scene.js` | page reload (F5) | same |
| `src/boot-screen.js` | page reload (F5) | same |
| `src/client.js` | `node build-client.mjs` + **Ctrl+Shift+R** | immutable client bundle with a per-process revision |
| `index.js` | **restart DSH** | the running process holds the old module |
| `tools/install.ps1` just ran | restart once | the new patch row has to enter the loader graph |

### Diagnostics

`?dshlinkdiag=1` turns the hint line into a live readout — `state`, `t`, `phase`, `fps`,
`booted`, `reduced`, `failed`, `errors` — so a stuck screen can be diagnosed from a
screenshot.

---

## Architecture

Two halves. The host half is Node; the browser halves are classic scripts injected as text,
plus one bundled client module.

| Half | File | Job |
|---|---|---|
| Host (Node) | `index.js` | `Config` schema, `webserver/index-inject` rows, 2 inspection routes |
| Pre-boot browser | `src/scene.js` | Pure timeline → display list. No DOM. |
| Pre-boot browser | `src/style.css` | Overlay chrome CSS (injected as a `style` row) |
| Pre-boot browser | `src/boot-screen.js` | Canvas renderer, DOM overlay, handoff, WebAudio |
| Client (browser) | `src/client.js` → `lib/client.js` | `clientReady()` + settings card |

### The two DSH facts everything rests on

**1. `webserver/index-inject` is the only moment early enough — on the Web surface.**
`@deepseek-ai/dsh-host-webserver` collects an injection table on every index render. `head`
rows are spliced in immediately after the opening `<head>` tag — ahead of the shell's own
`<script type="module">` — so a parser-blocking classic script pushed there runs before any
module executes, and therefore before the kernel synchronously constructs its own
`[data-dsh-boot]` page.

**The desktop app is a different ordering, and it matters (INTERFACES.md §9b).** The app
takes the **same** table over IPC, but the Electron shell does **not** render the rows into
the document. Its `serveWebDocument` serves the asar-local `dist/index.html` with only a
deferred `__DSH_BOOT_READY__` spliced into `<head>`, and the frontend entry applies every
row at runtime inside `dshDesktopBoot.ready().then(...)` — strictly **after** it has already
constructed the kernel boot page. No row `kind` or `placement` can change that. So on
desktop the sequence is *boot page → our overlay → app*, not *our overlay instead of the
boot page*; the overlay is written to be correct under both orderings, and a genuinely
pre-boot desktop overlay would need a shell-level hook, i.e. a DSH-app change.
`MANUAL.md` states this user-visibly.

A `script` row's text is interpolated **verbatim**: it is not escaped. Every injected source
must therefore be free of the literal sequence `</script`; `index.js` asserts this and refuses
to inject (with a warning) rather than shipping a broken page. (On desktop the row is applied
via `textContent`, where that sequence is harmless — but on Web the same text sits in HTML
text, which is the surface the guard protects.)

**2. A settings namespace is the profile entry id, and only `.volatile()` fields are served.**
`@deepseek-ai/dsh-settings` derives the editable form from `entry.fiber.runtime.Config`.
`volatileForm()` keeps only fields whose schema node carries `meta.volatile`, and `describe()`
drops every entry whose projected form is empty. The namespace is the `- insert: id:` in the
profile patch — here **`link-start`**.

Two consequences that are load-bearing:

* Every config field must be `.volatile()`, or the namespace is never served and the settings
  card is **silently** absent — no error anywhere.
* A volatile value arrives in `apply(ctx, config)` as a stable reference (`{ get() }`), not as
  a value, so it must be read through `readField()`. That is also why a settings edit needs
  only a page reload: when only volatile values change, the loader commits into the same
  reference and emits `loader/volatile-update` instead of restarting the fiber.

The two strings `- insert: id:` in `cordis.patch.yml` and `SETTINGS_NAMESPACE` in
`src/client.js` must be identical. Nothing in DSH checks that, so `verify/verify-namespace.mjs`
does.

### Package identity

```
package name        dsh-link-start
row id              link-start
settings namespace  link-start
route prefix        /plugins/dsh-link-start
design space        1600 x 900 (W x H), origin top-left, +y down
```

`@deepseek-ai/schemastery` is a **peer**, never a dependency: `index.js` imports it statically
at module evaluation, and app-boot's linked-directory rule resolves the peer name against the
runtime table — the kernel's own copy. `engines.dsh` is deliberately omitted: declaring it
makes app-boot enforce a SemVer range, and prerelease range matching is a trap that would
refuse the very version this was built against. A runtime version check warns instead.

`dsh.client.inject` is deliberately absent, and `exports.inject` in the client half must stay
empty: a required service leaves the fiber PENDING in a profile that lacks it, web boot treats
any non-active entry as fatal, and the **entire GUI** fails to mount with
`web boot: N entries did not activate`.

---

## Build and test

```sh
node build-client.mjs            # regenerate lib/client.js from src/client.js
node verify/verify-all.mjs       # every offline suite together; non-zero on failure
node tools/storyboard.mjs        # render the timeline to PNGs, one per phase
node tools/preview.mjs           # local static preview of the injection, no DSH
```

The verification suites are Node-only: no DSH process, no ports, no prompts, no network, no
dependencies. Together they prove, among other things, that `scene.js` loads in a bare `vm`
context, that `frame(t)` is deterministic (two calls stringify-equal), that the primitive set
is exactly the documented one and stays within 600 primitives per frame, that
`Config.toJSON()` projects a non-empty form for **every** field (the settings-visibility
proof), that exactly 3 rows are injected when enabled and **0** when disabled, that no injected
source contains `</script`, and that `lib/client.js` matches a fresh build of `src/client.js`.

[`INTERFACES.md`](INTERFACES.md) is the frozen contract: package identity (§3), the config
field table (§7.1), the docs and tooling deliverable (§9), the operational facts confirmed by
recon (§9a), and the invariants that must never regress (§10). Read it before changing
anything that crosses a half boundary.

---

## 中文说明

`dsh-link-start` 把 DSH 的内核启动页换成一段全屏的《刀剑神域》**「LINK START」**开机
序列，演完再溶解进界面。

**没有视频、没有图片、没有字体、没有音频文件，启动路径上零网络请求。** 动画是**时间的
纯函数**：`frame(t)` 返回每一帧的显示列表，渲染器照着画。所以**第一帧立刻就有**——
没有东西要下载，也没有东西要在第一帧出现之前先解码。

### 安装

桌面版（`desktop` profile）**只能用脚本装**：

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

因为 `dsh plugin --profile desktop add` 会被直接拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

桌面版 profile 由 Electron 应用独占管理，命令行不允许往里写。所以对桌面版来说这个
「链接 + 补丁行」的办法**是唯一的路**，不是备选。`tools\install.ps1` 的 `-ProfileName`
默认就是 `desktop`，理由就是这个。

脚本**只做两件事**：在 `<profile>\node_modules\dsh-link-start` 建一个目录联接；往
`<profile>\cordis.patch.yml` 追加一行 `- insert:`。**不碰 `package.json`，不跑 pnpm。**
装之前自动备份，并打印备份路径。

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -ProfileName web
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -DshHome C:\Users\你\.dsh
```

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1
```

### 一个必须知道的坑

> **改代码之后，普通 F5 就够了——但 `src/client.js`（设置卡片那一半）例外。**
> 它改完必须跑 `node build-client.mjs`，然后在浏览器里按 **Ctrl+Shift+R 硬刷新**。
> 因为客户端包的服务响应头是 `cache-control: max-age=31536000, immutable`，而且 URL 上
> 那个 `rev` 是**进程启动时分配的一次性编号，不跟内容走**，所以 F5 很可能还是旧的包，
> 看上去「改了没反应」。
>
> **动画本身不在这个包里**：`src/scene.js`、`src/style.css`、`src/boot-screen.js` 是宿主
> 每次渲染页面**重新读文件**再注入的，改完按一次普通 F5 就生效。

改设置、改动画代码 → **刷新页面**；改 `index.js` → **重启 DSH**。

详细的使用说明、全部设置项、声音规则、减少动态效果、诊断读数（`?dshlinkdiag=1`）和
故障排查表，都在 **[MANUAL.md](MANUAL.md)**（中文）。

---

## License

MIT.
