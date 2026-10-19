window.__ModuleLoader__.load({ id: "dsh-link-start", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/**
 * dsh-link-start — the browser half.
 *
 * Two jobs, in this order, and the priority is absolute:
 *
 *   1. Report the client roster's activation to the injected pre-boot overlay
 *      (`globalThis.__DSH_LINK_START__.clientReady()`). That call is half of the
 *      overlay's hand-off condition (INTERFACES.md §5.2), so it happens FIRST,
 *      unconditionally, inside its own try/catch, before anything else in this
 *      file can run. A missing overlay is a no-op, not an error; a decorative
 *      overlay must never be able to hold the client roster hostage.
 *
 *   2. Contribute the settings card to Settings -> Plugins.
 *
 * Job 2 is optional by construction. This file declares NO static `inject`,
 * because a required service leaves the fiber PENDING in a profile that lacks
 * it — and then job 1 would never run, the overlay would never learn the roster
 * is ready, and the boot animation would sit there refusing to hand over.
 * Worse, DSH's web boot treats ANY non-active entry as fatal: it throws
 * "web boot: N entries did not activate" and refuses to mount the entire GUI,
 * not merely this plugin. That was observed in the field as
 * "pending (waiting for service: uisession)".
 *
 * The optional services are therefore reached with the dynamic
 * `ctx.inject(deps, callback)` form, which waits for them without gating
 * `apply` at all: the callback fires once they arrive, and simply never fires
 * if they do not. The awaited services are read with `owner.get(name)` (with
 * the property read as a fallback).
 *
 * NOT the one-shot `get` form on the context. That read races activation and
 * silently answers `undefined`: the card then never registers, no error is
 * logged anywhere, and there is nothing on screen to explain the absence. Every
 * other client plugin in this deployment uses the `ctx.inject` form below.
 *
 * Bundle artifact contract: `build-client.mjs` materializes this file as a
 * closure factory (the shell's module-loader call), so
 * `require` is a parameter supplied by the shell's module table. `react` is one
 * of the baseline modules every dynamic bundle may request, so asking for it
 * needs no declaration in package.json.
 */

/**
 * Settings namespace, and this card's slot id.
 *
 * This is the `- insert: id:` in `cordis.patch.yml`. `@deepseek-ai/dsh-settings`
 * serves the editable form under that exact id, and this half reaches the same
 * id through the `configForms` service. Nothing in DSH checks that the two
 * strings agree, so `verify/verify-namespace.mjs` asserts it.
 */
const SETTINGS_NAMESPACE = 'link-start'

/** Slot the Plugins page renders plugin cards through (verified against 0.2.1-rc.2). */
const SLOT = 'plugins.item'

/** Dictionary namespace this card's labels are read from. */
const LOCALE_NAMESPACE = 'linkStart'

/** Id of the style element this card owns. */
const STYLE_ID = 'dsh-link-start-card-style'

/** The accent has to be a literal six-digit hex, both here and in the Host schema. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** Fallbacks for a card reading a profile that predates a field. */
const DEFAULT_ACCENT = '#5ad7ff'
const DEFAULT_TITLE = 'DEEPSEEK HARNESS'
const DEFAULT_DURATION_MS = 6800
const DEFAULT_FADE_MS = 1000
const DEFAULT_HOLD_MS = 20000
const MAX_TITLE = 40
const SEED_MAX = 2147483647

/** Offered dissolve lengths, in milliseconds (spec §7.1: 200..4000). */
const FADE_CHOICES = [200, 500, 1000, 2000, 4000]

/** Offered timeline lengths, in milliseconds (spec §7.1: 3000..20000). */
const DURATION_CHOICES = [3000, 4500, 6800, 9000, 12000]

/** Offered "boot never settled" bounds, in milliseconds (spec §7.1: 3000..60000). */
const HOLD_CHOICES = [5000, 10000, 20000, 30000, 60000]

/** Accent presets. The current value is always shown, even when it is not one of these. */
const ACCENT_CHOICES = ['#5ad7ff', '#7fff8f', '#ffb347', '#ff5a7a', '#a78bfa', '#f2f5f8']

/** Simplified Chinese copy. Primary language for this plugin. */
const DICTIONARY_ZH = {
  title: '启动动画',
  summary: '全屏 LINK START 开场：程序化绘制，结束后溶解进入界面',
  cardDesc: '刀剑神域风格的全屏启动动画：由纯时间线程序化绘制，无视频、无素材、无网络请求',
  expand: '展开：{title}',
  collapse: '收起：{title}',
  nextLoad: '这一页的所有改动都在下次刷新页面（F5）时生效，不需要重启 DSH。',
  seconds: '{value} 秒',

  enabled: '开启启动动画',
  enabledOn: '正在使用：刷新页面时会在原生启动页之前接管屏幕',
  enabledOff: '已关闭：刷新页面后不会注入任何内容，回到 DSH 原生启动页',

  visuals: '画面元素',
  glitch: '色散故障',
  glitchOn: 'LINK 阶段字标带红绿蓝错位闪动，画面更躁',
  glitchOff: '已关闭：字标不再错位，帧也更省',
  scanlines: '扫描线',
  scanlinesOn: '整屏叠加细横纹，像老式监视器',
  scanlinesOff: '已关闭：整屏没有横纹',
  telemetry: '遥测读数',
  telemetryOn: '角落显示随画面推进而递增的 ASCII 仪表读数',
  telemetryOff: '已关闭：不绘制仪表读数，只留图形',
  wordmark: 'LINK START 字标',
  wordmarkOn: '在中心组装出 LINK START 字标',
  wordmarkOff: '已关闭：不绘制字标，动画以纯图形收尾',

  audio: '声音',
  sound: '开机提示音',
  soundOn: '尝试播放一段合成提示音；浏览器要求先有一次操作才允许出声',
  soundOff: '已关闭：完全不创建音频上下文，画面里也不出现声音控件',

  motion: '动效',
  respectReducedMotion: '尊重系统「减弱动效」',
  rrmOn: '系统开启减弱动画时，动画自动变成平静淡入，并缩短到 1200 毫秒以内',
  rrmOff: '已忽略系统设置：始终播放完整动效',

  timing: '时长与进入方式',
  duration: '动画时长',
  durationNote: '当前 {value} 秒：整条时间线（VOID → GRID → RETICLE → LINK → SURGE → RESOLVE）按这个长度缩放',
  fade: '溶解时长',
  fadeNote: '当前 {value} 毫秒：时间线走完后再用这么久把整层淡出，然后移除',
  enterMode: '进入方式',
  modeAuto: '自动进入',
  modeClick: '点击进入',
  modeAutoNote: '当前为自动：时间线走完、客户端也报告就绪，两者都满足才溶解',
  modeClickNote: '当前为点击：时间线循环播放，直到你按下鼠标或 Esc / 空格 / 回车才溶解',
  hold: '等待上限',
  holdNote: '当前 {value} 秒：这么久之后仍未就绪，底部提示会变成「按一下继续」，但绝不会在未就绪时自动进入',

  accentSection: '主色',
  accent: '强调色',
  accentNote: '当前 {value}：隧道、准星与字标的强调色；非法值由宿主回落到 {fallback}',

  textSection: '标题与随机种子',
  titleField: '自定义标题',
  titleNote: '当前标题：{value}',
  titlePlaceholder: '最多 40 个字符',
  seedField: '随机种子',
  seedRandom: '当前为 0：每次启动都重新取种子，画面每次都不一样',
  seedFixed: '当前为 {value}：固定种子，每次启动的画面完全一致，便于复现某一次效果',
  seedInvalid: '种子需要是 0 到 {max} 之间的整数；0 表示每次启动随机',
  seedCommit: '回车或点开别处即保存',

  previewSection: '预览',
  preview: '预览',
  previewing: '预览中…',
  previewHint: '在这一页按当前设置把真正的启动动画跑一遍，并走同一条溶解路径',
  previewUnavailable: '这一页没有可用的预览接口（入场层没有加载，或页面是在这个功能之前打开的）：刷新页面后再试。',
  previewBusy: '已经有一个预览在跑了，等它结束再点。',
  previewFailed: '预览没能启动：{message}',

  noWriter: '这一页没有连上设置文档，改动不会保存。',
  unavailable: '本部署没有提供 link-start 的设置命名空间，卡片只能显示默认值。',
  readOnly: '当前部署的设置为只读，改动不会被接受。',
  saveFailed: '保存失败：{message}',
  saveRefused: '本部署没有接受这次修改，而且没有更多的原因可查。',
  saveRetried: '修订号已过期，已通过设置服务重试写入。',
  renderFailed: '设置面板渲染失败：{message}',
}

/** English half of the same dictionary. */
const DICTIONARY_EN = {
  title: 'Boot animation',
  summary: 'Full-window LINK START sequence, drawn procedurally, then dissolved into the app',
  cardDesc: 'Sword Art Online style full-window boot sequence: drawn from a pure timeline, with no video, no assets and no network request',
  expand: 'Expand: {title}',
  collapse: 'Collapse: {title}',
  nextLoad: 'Every change on this page takes effect on the next page load (F5). No DSH restart is needed.',
  seconds: '{value} s',

  enabled: 'Enable the boot animation',
  enabledOn: 'In use: a page load hands the screen to this animation before the kernel boot page',
  enabledOff: 'Off: a page load injects nothing at all and the kernel boot page shows',

  visuals: 'Frame elements',
  glitch: 'Chromatic glitch',
  glitchOn: 'The LINK wordmark is drawn with RGB offsets, which reads as signal noise',
  glitchOff: 'Off: no chromatic offsets, and a cheaper frame',
  scanlines: 'Scanlines',
  scanlinesOn: 'Fine horizontal banding over the whole frame, like a CRT',
  scanlinesOff: 'Off: no banding anywhere on the frame',
  telemetry: 'Telemetry readout',
  telemetryOn: 'ASCII instrument counters in the corners, derived from the timeline',
  telemetryOff: 'Off: no readout dots and no counters, only geometry',
  wordmark: 'LINK START wordmark',
  wordmarkOn: 'Assembles the LINK START wordmark at the centre',
  wordmarkOff: 'Off: no wordmark; the sequence ends on pure geometry',

  audio: 'Sound',
  sound: 'Startup chime',
  soundOn: 'Tries a short synthesized chime; the browser only allows audio after a gesture',
  soundOff: 'Off: no AudioContext is constructed at all, and no sound control is drawn',

  motion: 'Motion',
  respectReducedMotion: 'Respect the system reduced-motion setting',
  rrmOn: 'With reduced motion on, the sequence becomes a calm fade no longer than 1200 ms',
  rrmOff: 'The system setting is ignored: the full sequence always plays',

  timing: 'Timing and entry',
  duration: 'Timeline length',
  durationNote: 'Currently {value} seconds: the whole timeline (VOID through RESOLVE) scales to this length',
  fade: 'Dissolve length',
  fadeNote: 'Currently {value} ms: after the timeline ends the whole layer fades out over this long, then is removed',
  enterMode: 'How the app is entered',
  modeAuto: 'Automatic',
  modeClick: 'On a click',
  modeAutoNote: 'Automatic: the dissolve waits for both the finished timeline and the ready client roster',
  modeClickNote: 'On a click: the timeline loops until you press the mouse, Esc, Space or Enter',
  hold: 'Wait bound',
  holdNote: 'Currently {value} seconds: after this long without a ready roster the hint says "press to continue" — it never auto-enters un-booted',

  accentSection: 'Accent',
  accent: 'Accent colour',
  accentNote: 'Currently {value}: the accent of the tunnel, reticle and wordmark; an invalid value falls back to {fallback}',

  textSection: 'Title and seed',
  titleField: 'Custom title',
  titleNote: 'Current title: {value}',
  titlePlaceholder: 'Up to 40 characters',
  seedField: 'Random seed',
  seedRandom: 'Currently 0: a fresh seed every boot, so the picture differs each time',
  seedFixed: 'Currently {value}: a fixed seed, so every boot draws exactly the same picture',
  seedInvalid: 'The seed must be an integer from 0 to {max}; 0 means a fresh random seed each boot',
  seedCommit: 'Press Enter, or click away, to save',

  previewSection: 'Preview',
  preview: 'Preview',
  previewing: 'Previewing…',
  previewHint: 'Replay the real boot animation on this page with the settings shown, leaving through the same dissolve',
  previewUnavailable: 'This page has no preview entry point (the overlay is not loaded, or the page predates this feature): reload and try again.',
  previewBusy: 'A preview is already running; wait for it to finish.',
  previewFailed: 'The preview could not start: {message}',

  noWriter: 'This page is not connected to the settings document, so changes cannot be saved.',
  unavailable: 'This deployment does not serve the link-start settings namespace, so the card can only show the defaults.',
  readOnly: 'This deployment stores settings read-only, so changes are refused.',
  saveFailed: 'Save failed: {message}',
  saveRefused: 'The deployment did not accept this change and gave no further reason.',
  saveRetried: 'The revision was stale; the write was retried through the settings service.',
  renderFailed: 'The settings panel failed to render: {message}',
}

// No backtick anywhere in this sheet. It is a plain joined string rather than a
// template literal on purpose: a stray backtick ends the blob early and the
// build silently keeps the previous artifact, which looks exactly like "the
// change had no effect".
//
// The token names and the geometry follow the harness's own plugin card
// (ui-settings-plugins / ui-plugin-manager), so this reads as a shipped card
// rather than a guest: same border, radius, layer colours, header metrics and
// chevron motion. Every token keeps a literal fallback for a page with no theme.
const CSS = [
  '.dslls-card{list-style:none;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.28));',
  'border-radius:16px;background:var(--dsw-alias-bg-layer-3,transparent);',
  'transition:border-color .16s,background .16s;font-family:inherit}',
  '.dslls-card:hover{border-color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.5))}',
  '.dslls-card[data-open="1"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));',
  'border-color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.5))}',
  '.dslls-head{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;',
  'text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}',
  '.dslls-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f9dd9);outline-offset:-2px}',
  '.dslls-headtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
  '.dslls-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,inherit)}',
  '.dslls-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}',
  '.dslls-chev{flex:none;width:7px;height:7px;margin-right:3px;',
  'border-right:1.5px solid var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));',
  'border-bottom:1.5px solid var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));',
  'transform:rotate(45deg);transition:transform .16s}',
  '.dslls-card[data-open="1"] .dslls-chev{transform:rotate(225deg)}',
  '.dslls-body{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));margin:0 16px;padding:14px 0 10px}',
  '.dslls-sec{margin:0 0 18px}',
  '.dslls-sec:last-child{margin-bottom:4px}',
  '.dslls-h{font-size:13px;font-weight:600;line-height:1.5;margin:0 0 6px;color:var(--dsw-alias-label-primary,inherit)}',
  '.dslls-p{margin:0 0 10px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}',
  '.dslls-row{display:flex;flex-wrap:wrap;gap:6px}',
  '.dslls-switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit)}',
  '.dslls-switch input{margin:0;flex:none}',
  '.dslls-opt{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));background:none;color:inherit;',
  'border-radius:8px;padding:5px 12px;font:inherit;font-size:12.5px;cursor:pointer}',
  '.dslls-opt:hover:not(:disabled){background:rgba(127,127,127,.14)}',
  '.dslls-opt[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#07974b);',
  'color:var(--dsw-alias-brand-primary,#07974b);font-weight:600;background:rgba(7,193,96,.1)}',
  '.dslls-opt:disabled{opacity:.45;cursor:default}',
  '.dslls-swatch{width:26px;height:26px;padding:0;border-radius:8px;cursor:pointer;',
  'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4))}',
  '.dslls-swatch[data-on="1"]{outline:2px solid var(--dsw-alias-brand-primary,#4f9dd9);outline-offset:2px}',
  '.dslls-swatch:disabled{opacity:.45;cursor:default}',
  '.dslls-hex{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;',
  'align-self:center;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}',
  '.dslls-input{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));border-radius:8px;',
  'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));color:inherit;font:inherit;font-size:12.5px;',
  'padding:5px 10px;min-width:220px;max-width:100%}',
  '.dslls-input:disabled{opacity:.45}',
  '.dslls-msg{margin-top:8px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8))}',
  '.dslls-msg.err{color:var(--dsw-alias-label-error,#d24a43)}',
  '.dslls-msg.ok{color:var(--dsw-alias-brand-primary,#07974b)}',
].join('')

/** The stable empty snapshot, so `getSnapshot` never returns a fresh object. */
const NO_SNAPSHOT = Object.freeze({
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
})

/** Install the card's stylesheet once per document. */
function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/**
 * Milliseconds as seconds, trimmed: 6800 -> "6.8", 9000 -> "9", 6825 -> "6.83".
 * @param ms - a millisecond count.
 * @returns the shortest exact decimal rendering, at centisecond precision.
 */
function formatSeconds(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '?'
  return String(Math.round((ms / 1000) * 100) / 100)
}

/**
 * One choice list, with the button that matches the CURRENT value marked.
 *
 * `choices` always carries the current value: a profile written before a preset
 * existed (or with a hand-edited value) would otherwise highlight nothing at
 * all, which reads as "this control is broken" rather than "your value is
 * off-preset".
 * @param values - offered values, ascending.
 * @param current - the stored value.
 * @returns the offered values including the current one.
 */
function withCurrent(values, current) {
  if (values.indexOf(current) >= 0) return values
  return values.concat([current]).sort(function (left, right) { return left - right })
}

/**
 * Read one awaited service from the context passed to the inject callback.
 *
 * `get` first, because that is the form every working plugin in this deployment
 * uses and the property proxy is topology-sensitive; the property read is the
 * fallback for a context where the service is a declared own property.
 * @param owner - the context handed to the `ctx.inject` callback.
 * @param name - service name.
 * @returns the service, or undefined when it is not reachable.
 */
function serviceAt(owner, name) {
  try {
    if (owner !== null && owner !== undefined && typeof owner.get === 'function') {
      const value = owner.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch (error) {
    // A global-store miss is the expected miss; the property may still answer.
  }
  try {
    return owner === null || owner === undefined ? undefined : owner[name]
  } catch (error) {
    return undefined
  }
}

/**
 * Human text for whatever a rejected promise or a thrown value carried.
 * @param value - the rejection reason, an error, or a bare string.
 * @returns one sentence fragment safe to interpolate into the card.
 */
function messageOf(value) {
  if (value === undefined || value === null) return 'unknown'
  if (typeof value === 'string') return value
  if (typeof value.message === 'string') return value.message
  return String(value)
}

/**
 * The Plugins page asks every `plugins.item` entry twice: `view: "summary"` for
 * the row's one-liner, and anything else (the page) for the configuration
 * section.
 *
 * They are two COMPONENTS rather than two branches of one, because the summary
 * answer uses no hooks at all and the page answer uses many. One component that
 * returned early for the summary view would call a different number of hooks
 * depending on its props — a conditional hook call, which React rejects the
 * moment one instance is rendered with the other view. The visible symptom is a
 * card that is present but dead: the page's own error boundary unmounts the
 * subtree and every control inside stops responding.
 */

/**
 * The summary answer: one line, returned as a plain string.
 *
 * The page puts it inside a clamped one-line element on the list and inside a
 * `<p>` on the detail page, so returning the card element here would nest a
 * `<li>` in a `<p>`. The shipped pages answer this view with one line.
 * @param props - the slot kit (`t`) plus the owner props (the requested view).
 * @returns the one-line description.
 */
function LinkStartSummary(props) {
  const t = typeof props.t === 'function'
    ? props.t
    : function (key) { return DICTIONARY_ZH[key] === undefined ? key : DICTIONARY_ZH[key] }
  return t('summary')
}

/**
 * The registered entry: pick the shape the page asked for.
 *
 * This component calls no hooks of its own in either branch, and renders the
 * page as a CHILD element rather than calling it, so the page component keeps
 * its own fiber and its own stable hook count no matter how the outlet
 * re-renders.
 * @param props - the slot kit plus the owner props (`view`, `form`).
 * @returns the one-line summary, or the settings page.
 */
function LinkStartEntry(props) {
  const React = props.runtime
  if (props.view === 'summary') return React.createElement(LinkStartSummary, props)
  return React.createElement(LinkStartCard, props)
}

/**
 * The page's settings reader/writer.
 *
 * The Plugins page hands every `plugins.item` entry a `form` prop — `{ state,
 * mutate }`, the same face the shipped configuration pages consume — in
 * addition to whatever the entry's own `inject` face returns (here: `runtime`
 * and the `configForms` scope for this namespace). Preferring the page's own
 * form is what makes the controls work; the injected scope is the observable
 * fallback, and the page's static snapshot is the last resort, so a card with
 * no events at all still renders the current values instead of nothing.
 *
 * Reads need a `subscribe`/`getSnapshot` pair for `useSyncExternalStore`. The
 * snapshot reference must be stable until the fact moves, so an observable
 * source is always preferred over a render-time value.
 * @param props - the slot kit plus the owner props.
 * @returns the reader/writer pair for this card.
 */
function cardForm(props) {
  const pageForm = props.form
  const scope = props.scope
  const pageObservable = pageForm !== undefined && pageForm !== null
    && typeof pageForm.subscribe === 'function' && typeof pageForm.getSnapshot === 'function'
  const scopeObservable = scope !== undefined && scope !== null
    && typeof scope.subscribe === 'function' && typeof scope.getSnapshot === 'function'

  const source = pageObservable ? pageForm : (scopeObservable ? scope : null)

  let fallback = NO_SNAPSHOT
  if (pageForm !== undefined && pageForm !== null && pageForm.state !== undefined) fallback = pageForm.state
  else if (scopeObservable) fallback = scope.getSnapshot()
  else if (scope !== undefined && scope !== null && scope.state !== undefined) fallback = scope.state

  let mutate = null
  if (pageForm !== undefined && pageForm !== null && typeof pageForm.mutate === 'function') {
    mutate = function (ops, revision) { return pageForm.mutate(ops, revision) }
  } else if (scope !== undefined && scope !== null && typeof scope.mutate === 'function') {
    mutate = function (ops, revision) { return scope.mutate(ops, revision) }
  }

  // The RPC itself, reached directly when the form does not expose it. The
  // kernel's `mutate` answers `false` for every rejected write and swallows the
  // reason, so the only way to tell a stale-revision conflict from a refused
  // operation is to issue the same call and read the remote failure. `null`
  // when this bundle cannot see the service, in which case the card reports
  // what it can.
  let remoteMutate = null
  const remote = props.remote
  const settings = remote !== undefined && remote !== null ? remote.settings : undefined
  if (settings !== undefined && settings !== null && typeof settings.mutate === 'function') {
    remoteMutate = function (namespace, ops, revision) {
      return settings.mutate(namespace, ops, revision)
    }
  }

  return { source: source, fallback: fallback, mutate: mutate, remoteMutate: remoteMutate }
}

/**
 * The card.
 *
 * Collapsed by default, like every other card on this page: the Plugins section
 * is a list of plugins, and one that unfolds its controls on arrival pushes
 * everything below it out of view. Disclosure is card-local state.
 *
 * Reads ride an observable source (see `cardForm`) whose snapshot reference is
 * stable until the fact moves. The subscription is taken directly with
 * `useSyncExternalStore` rather than through the renderer's `use<Name>` binding,
 * because a package outside this repository cannot depend on that binding
 * existing for it.
 * @param props - the slot kit (`runtime`, `t`) plus the owner props.
 * @returns the card element.
 */
function LinkStartCard(props) {
  const React = props.runtime
  const t = props.t
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  // A draft is held only while the field is being edited, so a write landing
  // from anywhere else still moves the displayed value.
  const [titleDraft, setTitleDraft] = React.useState(null)
  const [seedDraft, setSeedDraft] = React.useState(null)
  const [previewing, setPreviewing] = React.useState(false)

  const form = cardForm(props)
  const source = form.source

  const subscribe = React.useCallback(
    function (listener) { return source === null ? function () {} : source.subscribe(listener) },
    [source],
  )
  const readSnapshot = React.useCallback(
    function () { return source === null ? form.fallback : source.getSnapshot() },
    [source, form.fallback],
  )
  const snapshot = React.useSyncExternalStore(subscribe, readSnapshot)

  const stored = (snapshot !== undefined && snapshot !== null && snapshot.value) || {}
  const enabled = stored.enabled !== false
  const glitch = stored.glitch !== false
  const scanlines = stored.scanlines !== false
  const telemetry = stored.telemetry !== false
  const wordmark = stored.wordmark !== false
  const sound = stored.sound !== false
  const respectReducedMotion = stored.respectReducedMotion !== false
  const durationMs = typeof stored.durationMs === 'number' && isFinite(stored.durationMs)
    ? stored.durationMs : DEFAULT_DURATION_MS
  const fadeMs = typeof stored.fadeMs === 'number' && isFinite(stored.fadeMs) ? stored.fadeMs : DEFAULT_FADE_MS
  const holdMs = typeof stored.holdMs === 'number' && isFinite(stored.holdMs) ? stored.holdMs : DEFAULT_HOLD_MS
  const enterMode = stored.enterMode === 'click' ? 'click' : 'auto'
  const accent = typeof stored.accent === 'string' && HEX_COLOR.test(stored.accent) ? stored.accent : DEFAULT_ACCENT
  const storedTitle = typeof stored.title === 'string' && stored.title.length > 0
    ? stored.title.slice(0, MAX_TITLE) : DEFAULT_TITLE
  const seed = typeof stored.seed === 'number' && isFinite(stored.seed) ? stored.seed : 0
  const readable = snapshot !== undefined && snapshot !== null && typeof snapshot === 'object'
  const writable = !readable || snapshot.writable !== false

  // A preview covers the whole page with an overlay that the card cannot see, so
  // the bound is a backstop: `onDone` is the real signal, and if an older
  // overlay never calls it the control still becomes usable again.
  React.useEffect(function () {
    if (!previewing) return undefined
    const bound = Math.max(2000, durationMs + fadeMs + 2000)
    const timer = setTimeout(function () { setPreviewing(false) }, bound)
    return function () { clearTimeout(timer) }
  }, [previewing, durationMs, fadeMs])

  ensureStyle()

  /**
   * Stage one field write.
   *
   * The operation is the settings service's own path-op shape — one atomic
   * `set` at a top-level path — so the same call works whether the page handed
   * us its configuration form or we fell back to the injected scope.
   *
   * The revision travels with the write because the Host refuses a mutation
   * composed against a document it has since replaced, and `mutate` reports
   * that refusal as a bare `false`, swallowing the reason. So a refusal is
   * retried ONCE through the remote service with the same operation and no
   * revision fence: if the operation itself is acceptable the retry lands, and
   * if it is not, the remote failure text is shown. Either way the user learns
   * why, instead of a control that quietly does nothing — which is the failure
   * this card exists to avoid.
   * @param field - config field name.
   * @param value - the value to store.
   */
  const write = function (field, value) {
    if (form.mutate === null) {
      setError(t('noWriter'))
      setNotice(null)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)

    // The freshest revision this card can see: the render snapshot is normally
    // current, but a write that landed since this render would otherwise be
    // fenced out by a revision we already know is stale.
    let revision = readable ? snapshot.revision : undefined
    if (source !== null && typeof source.getSnapshot === 'function') {
      try {
        const live = source.getSnapshot()
        if (live !== undefined && live !== null && live.revision !== undefined) revision = live.revision
      } catch (syncError) {
        // Keep the render-time revision; the writer will fence and the retry
        // below still surfaces the reason.
      }
    }

    const ops = [{ op: 'set', path: [field], value: value }]
    let attempt
    try {
      attempt = form.mutate(ops, revision)
    } catch (thrown) {
      setBusy(false)
      setError(t('saveFailed', { message: messageOf(thrown) }))
      return
    }

    Promise.resolve(attempt).then(function (accepted) {
      if (accepted !== false) return undefined
      if (form.remoteMutate === null) {
        setError(t('saveRefused'))
        return undefined
      }
      // Retry through the service, unfenced, to learn WHY it was refused.
      return Promise.resolve(form.remoteMutate(SETTINGS_NAMESPACE, ops, undefined)).then(function (answer) {
        if (answer !== undefined && answer !== null && answer.ok === false) {
          const reason = answer.error === undefined || answer.error === null
            ? t('saveRefused')
            : messageOf(answer.error.message === undefined ? answer.error : answer.error.message)
          setError(t('saveFailed', { message: reason }))
          return
        }
        setNotice(t('saveRetried'))
      })
    }).catch(function (failure) {
      setError(t('saveFailed', { message: messageOf(failure) }))
    }).then(function () {
      setBusy(false)
    })
  }

  const titleText = titleDraft === null ? storedTitle : titleDraft

  const commitTitle = function () {
    if (titleDraft === null) return
    const next = titleDraft.slice(0, MAX_TITLE)
    setTitleDraft(null)
    if (next === storedTitle) return
    write('title', next)
  }

  const seedText = seedDraft === null ? String(seed) : seedDraft

  const commitSeed = function () {
    if (seedDraft === null) return
    const raw = String(seedDraft).trim()
    setSeedDraft(null)
    if (raw === '') {
      if (seed !== 0) write('seed', 0)
      return
    }
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0 || value > SEED_MAX) {
      setError(t('seedInvalid', { max: SEED_MAX }))
      setNotice(null)
      return
    }
    if (value === seed) return
    write('seed', value)
  }

  /**
   * Play the real boot animation, full screen, right now.
   *
   * The overlay is the one the page already carries (`globalThis.__DSH_LINK_START__`,
   * installed by the injected head script), asked to run again with the settings
   * shown at this moment, so the preview reflects unsaved-in-page-load edits.
   * It leaves through the same dissolve and calls back, which is when the button
   * becomes pressable again.
   *
   * The failure worth naming: a page loaded BEFORE this feature existed has the
   * old overlay in memory, whose namespace has no `preview`. Saying so beats a
   * button that appears to do nothing.
   */
  const runPreview = function () {
    const overlay = globalThis.__DSH_LINK_START__
    if (overlay === null || overlay === undefined || typeof overlay.preview !== 'function') {
      setError(t('previewUnavailable'))
      setNotice(null)
      return
    }
    setError(null)
    setNotice(null)
    setPreviewing(true)
    let started
    try {
      started = overlay.preview({
        durationMs: durationMs,
        fadeMs: fadeMs,
        enterMode: enterMode,
        accent: accent,
        sound: sound,
        glitch: glitch,
        scanlines: scanlines,
        telemetry: telemetry,
        wordmark: wordmark,
        title: storedTitle,
        seed: seed,
        respectReducedMotion: respectReducedMotion,
        holdMs: holdMs,
        onDone: function () { setPreviewing(false) },
      })
    } catch (failure) {
      setPreviewing(false)
      setError(t('previewFailed', { message: messageOf(failure) }))
      return
    }
    if (started === false) {
      setPreviewing(false)
      setNotice(t('previewBusy'))
    }
  }

  /**
   * One behaviour switch: label, checkbox, and the sentence for the state it is
   * CURRENTLY in. A plain factory rather than a component — it calls no hooks,
   * which is what lets the card's own hook order stay fixed for every render.
   */
  const switchRow = function (field, labelKey, onKey, offKey, value, extra) {
    return React.createElement('div', { className: 'dslls-sec', key: field },
      React.createElement('label', { className: 'dslls-switch' },
        React.createElement('input', {
          type: 'checkbox',
          checked: value,
          disabled: busy || !writable,
          onChange: function (event) { write(field, event.target.checked) },
        }),
        React.createElement('span', { className: 'dslls-h', style: { margin: '0' } }, t(labelKey))),
      React.createElement('div', { className: 'dslls-p', style: { marginTop: '6px', marginBottom: '0' } },
        value ? t(onKey) : t(offKey)),
      extra === undefined
        ? null
        : React.createElement('div', { className: 'dslls-p', style: { marginTop: '4px', marginBottom: '0' } }, extra))
  }

  /** One discrete choice row: heading, buttons, and the sentence for the current value. */
  const choiceRow = function (key, labelKey, values, current, format, onPick, note) {
    return React.createElement('div', { className: 'dslls-sec', key: key },
      React.createElement('div', { className: 'dslls-h' }, t(labelKey)),
      React.createElement('div', { className: 'dslls-row' },
        values.map(function (value) {
          return React.createElement('button', {
            key: String(value),
            type: 'button',
            className: 'dslls-opt',
            'data-on': value === current ? '1' : '0',
            disabled: busy || !writable,
            onClick: function () { if (value !== current) write(key, value) },
          }, format(value))
        })),
      React.createElement('div', { className: 'dslls-p', style: { marginTop: '8px', marginBottom: '0' } }, note))
  }

  const header = React.createElement('button', {
    type: 'button',
    className: 'dslls-head',
    'aria-expanded': open,
    'aria-label': (open ? t('collapse', { title: t('title') }) : t('expand', { title: t('title') })),
    onClick: function () { setOpen(!open) },
  },
  React.createElement('span', { className: 'dslls-headtext' },
    React.createElement('span', { className: 'dslls-name' }, t('title')),
    React.createElement('span', { className: 'dslls-desc' }, t('cardDesc'))),
  React.createElement('span', { className: 'dslls-chev' }))

  try {
    if (!open) return React.createElement('li', { className: 'dslls-card', 'data-open': '0' }, header)

    const sections = []

    // The master switch comes first: it is the only one that decides whether any
    // of the others run at all.
    sections.push(switchRow('enabled', 'enabled', 'enabledOn', 'enabledOff', enabled, t('nextLoad')))

    sections.push(React.createElement('div', { className: 'dslls-sec', key: 'visuals-head' },
      React.createElement('div', { className: 'dslls-h' }, t('visuals'))))
    for (const entry of [
      ['glitch', 'glitch', 'glitchOn', 'glitchOff', glitch],
      ['scanlines', 'scanlines', 'scanlinesOn', 'scanlinesOff', scanlines],
      ['telemetry', 'telemetry', 'telemetryOn', 'telemetryOff', telemetry],
      ['wordmark', 'wordmark', 'wordmarkOn', 'wordmarkOff', wordmark],
    ]) {
      sections.push(switchRow(entry[0], entry[1], entry[2], entry[3], entry[4]))
    }

    sections.push(React.createElement('div', { className: 'dslls-sec', key: 'motion-head' },
      React.createElement('div', { className: 'dslls-h' }, t('motion'))))
    sections.push(switchRow('respectReducedMotion', 'respectReducedMotion', 'rrmOn', 'rrmOff', respectReducedMotion))

    sections.push(React.createElement('div', { className: 'dslls-sec', key: 'audio-head' },
      React.createElement('div', { className: 'dslls-h' }, t('audio'))))
    sections.push(switchRow('sound', 'sound', 'soundOn', 'soundOff', sound))

    sections.push(React.createElement('div', { className: 'dslls-sec', key: 'timing-head' },
      React.createElement('div', { className: 'dslls-h' }, t('timing'))))
    sections.push(choiceRow(
      'durationMs', 'duration', withCurrent(DURATION_CHOICES, durationMs), durationMs,
      function (value) { return t('seconds', { value: formatSeconds(value) }) },
      null,
      t('durationNote', { value: formatSeconds(durationMs) })))
    sections.push(choiceRow(
      'fadeMs', 'fade', withCurrent(FADE_CHOICES, fadeMs), fadeMs,
      function (value) { return value + ' ms' },
      null,
      t('fadeNote', { value: fadeMs })))
    sections.push(choiceRow(
      'enterMode', 'enterMode', ['auto', 'click'], enterMode,
      function (value) { return value === 'auto' ? t('modeAuto') : t('modeClick') },
      null,
      enterMode === 'auto' ? t('modeAutoNote') : t('modeClickNote')))
    sections.push(choiceRow(
      'holdMs', 'hold', withCurrent(HOLD_CHOICES, holdMs), holdMs,
      function (value) { return t('seconds', { value: formatSeconds(value) }) },
      null,
      t('holdNote', { value: formatSeconds(holdMs) })))

    sections.push(React.createElement('div', { className: 'dslls-sec', key: 'accent' },
      React.createElement('div', { className: 'dslls-h' }, t('accent')),
      React.createElement('div', { className: 'dslls-row' },
        withCurrent(ACCENT_CHOICES, accent).map(function (value) {
          const safe = HEX_COLOR.test(value) ? value : DEFAULT_ACCENT
          return React.createElement('button', {
            key: value,
            type: 'button',
            className: 'dslls-swatch',
            style: { background: safe },
            title: value,
            'aria-label': value,
            'data-on': value === accent ? '1' : '0',
            disabled: busy || !writable,
            onClick: function () { if (value !== accent) write('accent', value) },
          })
        }),
        React.createElement('span', { className: 'dslls-hex' }, accent)),
      React.createElement('div', { className: 'dslls-p', style: { marginTop: '8px', marginBottom: '0' } },
        t('accentNote', { value: accent, fallback: DEFAULT_ACCENT }))))

    sections.push(React.createElement('div', { className: 'dslls-sec', key: 'title' },
      React.createElement('div', { className: 'dslls-h' }, t('titleField')),
      React.createElement('input', {
        className: 'dslls-input',
        type: 'text',
        maxLength: MAX_TITLE,
        value: titleText,
        placeholder: t('titlePlaceholder'),
        disabled: busy || !writable,
        onChange: function (event) { setTitleDraft(event.target.value.slice(0, MAX_TITLE)) },
        onBlur: commitTitle,
        onKeyDown: function (event) { if (event.key === 'Enter') commitTitle() },
      }),
      React.createElement('div', { className: 'dslls-p', style: { marginTop: '8px', marginBottom: '0' } },
        t('titleNote', { value: storedTitle }))))

    sections.push(React.createElement('div', { className: 'dslls-sec', key: 'seed' },
      React.createElement('div', { className: 'dslls-h' }, t('seedField')),
      React.createElement('div', { className: 'dslls-row' },
        React.createElement('input', {
          className: 'dslls-input',
          type: 'number',
          min: 0,
          max: SEED_MAX,
          step: 1,
          value: seedText,
          disabled: busy || !writable,
          onChange: function (event) { setSeedDraft(event.target.value) },
          onBlur: commitSeed,
          onKeyDown: function (event) { if (event.key === 'Enter') commitSeed() },
        }),
        React.createElement('span', { className: 'dslls-hex' }, t('seedCommit'))),
      React.createElement('div', { className: 'dslls-p', style: { marginTop: '8px', marginBottom: '0' } },
        seed === 0 ? t('seedRandom') : t('seedFixed', { value: seed }))))

    sections.push(React.createElement('div', { className: 'dslls-sec', key: 'preview' },
      React.createElement('div', { className: 'dslls-h' }, t('previewSection')),
      React.createElement('div', { className: 'dslls-row' },
        React.createElement('button', {
          type: 'button',
          className: 'dslls-opt',
          disabled: previewing,
          onClick: runPreview,
        }, previewing ? t('previewing') : t('preview'))),
      React.createElement('div', { className: 'dslls-p', style: { marginTop: '8px', marginBottom: '0' } },
        t('previewHint'))))

    if (error !== null) sections.push(React.createElement('div', { className: 'dslls-msg err', key: 'error' }, error))
    if (notice !== null) sections.push(React.createElement('div', { className: 'dslls-msg ok', key: 'notice' }, notice))
    if (readable && snapshot.status === 'unavailable') {
      sections.push(React.createElement('div', { className: 'dslls-msg', key: 'unavailable' }, t('unavailable')))
    }
    if (readable && snapshot.writable === false) {
      sections.push(React.createElement('div', { className: 'dslls-msg', key: 'readonly' }, t('readOnly')))
    }

    return React.createElement('li', { className: 'dslls-card', 'data-open': '1' },
      header,
      React.createElement('div', { className: 'dslls-body' }, sections))
  } catch (failure) {
    // A card that cannot draw itself must still leave the settings page usable.
    return React.createElement('li', { className: 'dslls-card', 'data-open': '1' },
      header,
      React.createElement('div', { className: 'dslls-body' },
        t('renderFailed', { message: messageOf(failure) })))
  }
}

/**
 * Report activation, then contribute the settings card if the shell is willing.
 * @param ctx - the client plugin context.
 */
exports.apply = function apply(ctx) {
  // Job 1. Priority one, and it must not be able to fail for any other reason
  // than itself: a missing overlay is a no-op, not an error. Nothing above this
  // line may throw, and nothing below it may delay it.
  try {
    const overlay = globalThis.__DSH_LINK_START__
    // A missing overlay means the Host half injected nothing (for example
    // `enabled: false`, or a deployment whose boot payload carries no
    // injection), in which case the kernel boot page is the only screen and
    // there is nothing to hand over.
    if (overlay !== undefined && overlay !== null && typeof overlay.clientReady === 'function') {
      overlay.clientReady()
    }
  } catch (error) {
    console.warn('link-start: the client half could not report readiness', error)
  }

  // Job 2. Optional by construction, and reached with the dynamic `ctx.inject`
  // form rather than a declared `inject` or a one-shot service read; see the
  // module header for both reasons.
  try {
    let React = null
    try {
      React = require('react')
    } catch (error) {
      React = null
    }
    if (React === null || React === undefined || typeof React.createElement !== 'function') return
    if (ctx === undefined || ctx === null || typeof ctx.inject !== 'function') return

    ctx.inject(['slots', 'locale', 'configForms'], function (owner) {
      try {
        const slots = serviceAt(owner, 'slots')
        const locale = serviceAt(owner, 'locale')
        const forms = serviceAt(owner, 'configForms')
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') return
        if (typeof slots.register !== 'function') return
        // `configForms` owns both the per-namespace scope and the "is the Host
        // serving it at all" gate.
        if (forms === undefined || forms === null || typeof forms.get !== 'function') return
        if (typeof forms.whileServed !== 'function') return

        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          const dictionaries = function () {
            return locale.register(LOCALE_NAMESPACE, { zh: DICTIONARY_ZH, en: DICTIONARY_EN })
          }
          if (typeof owner.effect === 'function') owner.effect(dictionaries, 'link-start: dictionaries')
          else dictionaries()
        }
        const t = locale !== undefined && locale !== null && typeof locale.bind === 'function'
          ? locale.bind(LOCALE_NAMESPACE)
          : function (key, params) {
            const template = DICTIONARY_ZH[key] === undefined ? key : DICTIONARY_ZH[key]
            if (params === undefined) return template
            return String(template).replace(/\{(\w+)\}/g, function (match, name) {
              return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
            })
          }

        // `whileServed` is the gate: the entry is contributed only while the
        // Host actually serves this namespace, so a profile with no settings
        // provider (or one whose schema library lacks `.volatile()`) shows no
        // tab at all rather than an inert one that can never work.
        //
        // Registration is IDEMPOTENT, and that is load-bearing.
        // `slots.register` throws when a list slot already holds an entry with
        // the same id and priority:
        //
        //   list slot "plugins.item" already has an entry with id "link-start"
        //
        // and that throw lands inside the slot ledger's store notification.
        // React's own subscription rides the same notification, so a duplicate
        // registration does not merely log a line: it kills the card's updates
        // while leaving the rendered DOM in place — a card that is visible and
        // completely dead to both the mouse and the keyboard, with every control
        // still enabled. So the previous handle is disposed before registering
        // again, and every throw is owned here.
        let registration = null
        const withdraw = function () {
          if (registration === null) return
          const dispose = registration
          registration = null
          try {
            if (typeof dispose === 'function') dispose()
          } catch (error) {
            console.warn('link-start: the settings card was not withdrawn cleanly', error)
          }
        }
        const contribute = function () {
          if (registration !== null) withdraw()
          try {
            registration = slots.inject(SLOT, function () {
              return slots.register({
                name: SLOT,
                id: SETTINGS_NAMESPACE,
                order: 60,
                label: function () { return t('title') },
                locale: LOCALE_NAMESPACE,
                // Read lazily: the scope binds when the slot actually renders.
                inject: function () {
                  return { runtime: React, scope: forms.get(SETTINGS_NAMESPACE) }
                },
              }, LinkStartEntry)
            })
          } catch (error) {
            // A racing registration must never become an exception inside the
            // ledger's notification: drop our handle and log, so the card that
            // IS mounted keeps its updates.
            registration = null
            console.warn('link-start: the settings card was not registered', error)
          }
        }
        const serve = function () {
          return forms.whileServed([SETTINGS_NAMESPACE], function () {
            contribute()
            return withdraw
          })
        }
        if (typeof owner.effect === 'function') owner.effect(serve, 'link-start: settings page')
        else serve()

        // The card is silent when it works, which is exactly the state that used
        // to be indistinguishable from "the services never arrived". Diagnostic
        // mode says which one happened.
        if (typeof location !== 'undefined' && String(location.search).indexOf('dshlinkdiag=1') >= 0) {
          console.info('[link-start] settings card registered into ' + SLOT)
        }
      } catch (error) {
        console.warn('link-start: the settings card was not registered', error)
      }
    })
  } catch (error) {
    // The card is a convenience; the animation is the feature.
    console.warn('link-start: settings card wiring failed', error)
  }
}

return module.exports; } });
