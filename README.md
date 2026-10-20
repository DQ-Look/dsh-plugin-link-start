# dsh-link-start

> **中文** ｜ [English](#english)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把内核启动页
换成一段全屏的、程序化绘制的《刀剑神域》**「LINK START」**开机序列，演完再溶解进界面。

**没有视频、没有图片、没有字体、没有音频文件，启动路径上零网络请求。**
动画是**时间的纯函数**：`frame(t)` 每一帧返回一个显示列表，渲染器照着画。所以**第一帧
立刻就有**——没有东西要下载，也没有东西要在第一帧出现之前先解码。

```text
VOID  ->  GRID  ->  RETICLE  ->  LINK  ->  SURGE  ->  RESOLVE  ->  溶解
0.00     0.07      0.30         0.50     0.72       0.86         1.00
```

---

## 安装

### 桌面版（`desktop` profile）—— 只能用脚本装

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

因为 `dsh plugin --profile desktop add` 会被直接拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

桌面版 profile 由 Electron 应用独占管理，命令行不允许往里写。所以对桌面版来说这个
「目录联接 + 补丁行」的办法**是唯一的路**，不是备选。`tools\install.ps1` 的
`-ProfileName` 默认就是 `desktop`，理由就是这个。

脚本**只做两件事**：

1. 在 `<profile>\node_modules\dsh-link-start` 建一个目录联接，指向本目录；
2. 往 `<profile>\cordis.patch.yml` 追加一行 `- insert:`。

它**不碰** `package.json`、**不跑** pnpm、**不重启** DSH。装之前先备份补丁层，并打印备份路径。

```powershell
# 换 profile、指定 DSH home、或指定探测端口
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -ProfileName web
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -DshHome C:\Users\你\.dsh
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Port 19387
```

> **补丁层是按字节编辑的，文档这么写是故意的。** `cordis.patch.yml` 是无 BOM 的 UTF-8，
> 而且经常带中文（provider 的 `displayName`、一行注释）。常见的 cmdlet 会用三种方式破坏它，
> 每一种都实测过：
>
> * `Set-Content -Encoding utf8` 在 PowerShell 5.1 上意思是 **UTF-8 带 BOM**——写出来的
>   文件开头是 `EF BB BF`。
> * `Get-Content` 不带 `-Encoding` 会用机器默认的文件编码解码——默认 Windows 安装上是系统
>   ANSI 代码页（这里是 936/GBK）——所以无 BOM 的 UTF-8 读回来就是乱码，然后再按乱码写回去。
>   **这一条取决于机器**，而这正是重点：这台机器开了 Windows UTF-8 beta、恰好解码正常，
>   所以正确性不能建立在它之上。
> * `ReadAllLines`/`WriteAllLines` 会给每一行补上 `[Environment]::NewLine`，于是 LF 的补丁层
>   回来整篇变成 CRLF——306 字节的文件变成 314 字节，一次整篇重写却报告成「只改了一行」。
>
> 所以两个脚本都用 `[System.IO.File]::ReadAllText`/`WriteAllText` 配
> `New-Object System.Text.UTF8Encoding($false)`，并且 `uninstall.ps1` 会在**写入之前**先断言
> 字节账目对得上。两个脚本都是纯 ASCII（每个字节 < 128，最大 125），因为无 BOM 的 `.ps1`
> 也会被同样解码，中文字节可能直接把字符串字面量截断。

### 卸载

```powershell
powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1
```

精确反转上面那两件事，`cordis.patch.yml` 会回到**除它自己那一行之外逐字节相同**。
目录联接用 `cmd /c rmdir` 删除，**绝不用** `Remove-Item -Recurse`——递归删除会顺着联接
进去，把插件目录本身毁掉。任何不是 reparse point 的路径会直接拒绝，而不是删除。

---

## 使用

设置项在 **设置 → 插件 →「插件配置」** 的 **LINK START** 那一行（默认收起，点一下展开）。
每一项的说明都在 **[MANUAL.md](MANUAL.md)**（中文，面向使用者）：总开关、`durationMs`、
`fadeMs`、`enterMode`、`accent`、`sound`、`glitch`、`scanlines`、`telemetry`、`wordmark`、
`title`、`respectReducedMotion`、`seed`、`holdMs`。

**改完设置刷新页面就生效，不需要重启 DSH**——只有一个例外，而它是最容易浪费一下午的那件事：

> 改 `src/client.js` 之后需要跑 `node build-client.mjs`，然后在浏览器里按
> **Ctrl+Shift+R 硬刷新**。因为客户端包的响应头是
> `cache-control: max-age=31536000, immutable`，而 URL 上那个 `rev` 是**进程启动时分配的
> 一次性编号，不跟内容走**，所以普通 F5 很可能还在用旧的包。

**动画本身不在那个包里**，所以它改完永远只需要一次普通 F5。

### 改了什么 → 要做什么

| 改动 | 怎么看到 | 为什么 |
|---|---|---|
| 任何设置项 | 刷新页面（F5） | volatile 值提交进同一个引用，loader 发 `loader/volatile-update`，不重启 fiber |
| `src/style.css` | 刷新页面（F5） | 宿主每次渲染 index 都重新读 |
| `src/scene.js` | 刷新页面（F5） | 同上 |
| `src/boot-screen.js` | 刷新页面（F5） | 同上 |
| `src/client.js` | `node build-client.mjs` + **Ctrl+Shift+R** | 客户端包是 immutable 的，`rev` 每个进程一个 |
| `index.js` | **重启 DSH** | 运行中的进程还拿着旧模块 |
| 刚跑过 `tools/install.ps1` | 重启一次 | 新的补丁行要进 loader 图 |

### 诊断

`?dshlinkdiag=1` 会把提示行变成实时读数——`state`、`t`、`phase`、`fps`、`booted`、
`reduced`、`failed`、`errors`——所以一张截图就能诊断卡住的画面。

---

## 架构

两半。宿主那一半是 Node；浏览器那几半是当文本注入的 classic script，外加一个打包的客户端模块。

| 那一半 | 文件 | 干什么 |
|---|---|---|
| 宿主（Node） | `index.js` | `Config` schema、`webserver/index-inject` 行、2 个检查路由 |
| 预启动浏览器 | `src/scene.js` | 纯时间轴 → 显示列表。不碰 DOM。 |
| 预启动浏览器 | `src/style.css` | 叠加层的 chrome 样式（按 `style` 行注入） |
| 预启动浏览器 | `src/boot-screen.js` | 画布渲染、DOM 叠加层、交接、WebAudio |
| 客户端（浏览器） | `src/client.js` → `lib/client.js` | `clientReady()` + 设置卡片 |

### 整个设计依赖的两个 DSH 事实

**1. `webserver/index-inject` 是唯一够早的时机——在 Web 这一面上。**
`@deepseek-ai/dsh-host-webserver` 每次渲染 index 时收集一张注入表。`head` 行会被插到开头
`<head>` 标签之后**紧跟着**的位置——在 shell 自己的 `<script type="module">` **之前**——
所以推到那里的一段会阻塞解析的 classic script，会在任何 module 执行之前就跑起来，因此也在
内核同步构造自己的 `[data-dsh-boot]` 启动页**之前**。

**桌面版是另一种顺序，而且这一点很重要（INTERFACES.md §9b）。** 桌面应用通过 IPC 拿到
**同一张**表，但 Electron 外壳**不会**把这些行渲染进文档。它的 `serveWebDocument` 提供的是
asar 内部的 `dist/index.html`，只往 `<head>` 里塞了一个 `__DSH_BOOT_READY__` deferred，然后
前端入口在 `dshDesktopBoot.ready().then(...)` 里于**运行时**逐行应用——严格发生在它已经
构造完内核启动页**之后**。任何行的 `kind` 或 `placement` 都改变不了这件事。所以在桌面版上
顺序是*启动页 → 我们的叠加层 → 界面*，而不是*我们的叠加层取代启动页*；叠加层被写得在两种
顺序下都正确，而一个真正「先于启动页」的桌面叠加层需要外壳级别的钩子，也就是改 DSH 应用
本身。`MANUAL.md` 里有面向用户的说明。

`script` 行的文本是**原样**插入的，**不做转义**。所以每一段被注入的源码都必须不含字面序列
`</script`；`index.js` 会断言这一点，宁可拒绝注入（并告警）也不交付一个坏掉的页面。
（桌面版那一行是通过 `textContent` 应用的，那里这个序列无害——但 Web 上同一段文本是躺在
HTML 文本里的，而守卫保护的正是这个面。）

**2. 设置 namespace 就是 profile 条目的 id，而且只有 `.volatile()` 字段会被提供。**
`@deepseek-ai/dsh-settings` 从 `entry.fiber.runtime.Config` 推导出可编辑表单。
`volatileForm()` 只保留 schema 节点上带 `meta.volatile` 的字段，`describe()` 则会丢掉每一个
投影后表单为空的条目。这个 namespace 就是 profile 补丁里的 `- insert: id:`——这里是
**`link-start`**。

两个关键后果：

* 每个配置字段都必须是 `.volatile()`，否则 namespace 永远不会被提供，设置卡片会**静默**
  消失——任何地方都不会报错。
* volatile 值传到 `apply(ctx, config)` 里的是一个稳定引用（`{ get() }`）而不是值，所以必须
  通过 `readField()` 去读。这也正是为什么改设置只需要刷新页面：只有 volatile 值变化时，
  loader 会把新快照提交进同一个引用并发 `loader/volatile-update`，而不是重启 fiber。

`cordis.patch.yml` 里的 `- insert: id:` 和 `src/client.js` 里的 `SETTINGS_NAMESPACE`
这两个字符串必须完全一致。DSH 不检查这件事，所以 `verify/verify-namespace.mjs` 来检查。

### 包身份

```
包名                dsh-link-start
行 id               link-start
设置 namespace      link-start
路由前缀            /plugins/dsh-link-start
设计空间            1600 x 900（宽 x 高），原点左上，+y 向下
```

`@deepseek-ai/schemastery` 是 **peer**，永远不是 dependency：`index.js` 在模块求值时就静态
import 它，而 app-boot 的链接目录规则会把 peer 名字解析到运行时表上——也就是内核自己那份。
`engines.dsh` 是**故意省略**的：声明它会让 app-boot 去强制一个 SemVer 范围，而 prerelease
范围匹配是个坑，会拒绝掉这个插件正是对着编译的那个版本。所以改用运行时版本检查来告警。

`dsh.client.inject` 是**故意不写**的，客户端那一半的 `exports.inject` 也必须保持为空：
一个必需服务会让 fiber 在缺少它的 profile 里停在 PENDING，而 web boot 把任何非 active 条目
当成致命错误，于是**整个 GUI** 都会挂不上，报 `web boot: N entries did not activate`。

---

## 构建与测试

```sh
node build-client.mjs            # 从 src/client.js 重新生成 lib/client.js
node verify/verify-all.mjs       # 一次跑完所有离线套件；失败时非零退出
node tools/storyboard.mjs        # 把时间轴渲成 PNG，每个阶段一张
node tools/preview.mjs           # 本地静态预览注入效果，不启动 DSH
```

自检套件只依赖 Node：不启动 DSH 进程、不占端口、不交互、不联网、无第三方依赖。它们合起来
证明了这些事（除其他之外）：`scene.js` 能在裸 `vm` 上下文里加载；`frame(t)` 是确定性的
（同一 t 调用两次，stringify 结果相等）；图元集合恰好是文档里那套，且每帧不超过 600 个图元；
`Config.toJSON()` 对**每一个**字段都投影出非空表单（这就是设置可见性的证明）；启用时恰好
注入 3 行、禁用时注入 **0** 行；没有任何注入源码包含 `</script`；以及 `lib/client.js`
与 `src/client.js` 的一次全新构建逐字节相同。

**[`INTERFACES.md`](INTERFACES.md) 是冻结的契约**：包身份（§3）、配置字段表（§7.1）、
文档与工具交付物（§9）、勘察确认的运行时事实（§9a）、以及绝不能回归的不变量（§10）。
动任何跨越半边边界的东西之前，先读它。

---

## 许可证

MIT。

---

<a id="english"></a>

# English

> [中文](#dsh-link-start) ｜ **English**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that replaces the
kernel boot page with a full-window, procedurally drawn **Sword Art Online "LINK START"** start
sequence, then dissolves into the app.

**No video. No images. No fonts. No audio files. No network requests on the boot path.**
The animation is a pure function of time: `frame(t)` returns a display list every frame, and
the renderer draws it. First paint is therefore immediate, because there is nothing to fetch
and nothing to decode before the first frame exists.

```text
VOID  ->  GRID  ->  RETICLE  ->  LINK  ->  SURGE  ->  RESOLVE  ->  dissolve
0.00     0.07      0.30         0.50     0.72       0.86         1.00
```

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

## License

MIT.
