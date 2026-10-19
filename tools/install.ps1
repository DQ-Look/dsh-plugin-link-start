# install.ps1 - install dsh-link-start into a DSH profile.
#
# It does exactly two things, and nothing else:
#   1. a directory junction at <profile>\node_modules\dsh-link-start -> this package
#   2. one appended "- insert:" row in <profile>\cordis.patch.yml
#
# It does NOT touch package.json, does NOT run pnpm, and does NOT restart or
# otherwise poke at a running DSH.
#
# Why a script at all, when `dsh plugin` exists: the desktop profile - the one the
# Electron app actually runs - is REFUSED by the CLI with
#   error: profile "desktop" is managed exclusively by the Electron application
# so for that profile this link + patch-row method is the only route, not a
# fallback. -ProfileName therefore defaults to desktop.
#
# Undo with tools\uninstall.ps1, which reverses exactly these two changes.
#
# ---------------------------------------------------------------------------
# The patch layer is the USER'S file, and this script edits it as BYTES.
#
# cordis.patch.yml is BOM-less UTF-8 and routinely carries CJK - a provider's
# displayName, a comment. Two things go wrong if it is touched with the usual
# cmdlets:
#
#   * `Set-Content -Encoding utf8` on PowerShell 5.1 means UTF-8 WITH a BOM.
#     Measured on this machine: the written file starts 239,187,191. That is a
#     change to a file this script does not own.
#   * `Get-Content` without -Encoding decodes using the machine's default file
#     encoding. On a default Windows install that is the system ANSI codepage
#     (936/GBK here), so BOM-less UTF-8 comes back as mojibake and is written
#     back that way. It is machine-dependent, not universal - this machine has
#     the Windows UTF-8 beta enabled, so its Get-Content happens to decode
#     correctly - and that is precisely why this script does not rely on it.
#
# ReadAllLines/WriteAllLines fails in a third way: WriteAllLines terminates every
# line with [Environment]::NewLine, so a layer that uses LF comes back entirely in
# CRLF. Measured: a 306-byte LF layer came back 314 bytes with 8 CRLF. A
# whole-file rewrite, reported as if only the row had changed.
#
# So: ReadAllText/WriteAllText with New-Object System.Text.UTF8Encoding($false).
# Never Get-Content, never Set-Content, never ReadAllLines, never WriteAllLines.
#
# This file is pure ASCII on purpose, for the same reason: a BOM-less .ps1 is
# decoded as ANSI by 5.1, and a CJK byte sequence inside a string literal can
# terminate the literal. Every byte of this script is below 128.
# ---------------------------------------------------------------------------
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -ProfileName web
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -DshHome C:\Users\me\.dsh
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Port 19387

param(
  [string]$PackageDir = (Split-Path $PSScriptRoot -Parent),
  [string]$DshHome = '',
  [string]$ProfileName = 'desktop',
  [int]$Port = 0
)

$ErrorActionPreference = 'Continue'

$PluginName = 'dsh-link-start'
$Namespace = 'link-start'
$SchemaName = '@deepseek-ai/schemastery'
$SchemaMinVersion = [version]'3.18.4'

# Non-interactive: a prompt in a script nobody is watching is a hang.
$ConfirmPreference = 'None'

function Say($m) { Write-Host "$(Get-Date -Format 'HH:mm:ss') $m" }
function Warn($m) { Write-Host "$(Get-Date -Format 'HH:mm:ss') WARNING: $m" }
function Fail($m) { Say "FAILED: $m"; exit 2 }

# The only UTF-8 codec this script is allowed to use: no BOM on write.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------------------
# Pattern helpers
# ---------------------------------------------------------------------------
# Both patterns are assembled with -join over an array of complete strings, never
# with a trailing "+" continuation. PowerShell does not continue a statement that
# ends in "+" when the statement is already complete, so a following line
# starting with "+" parses as a unary plus, throws at runtime, and - under
# $ErrorActionPreference = 'Continue' - is swallowed. The value is then silently
# half-built and matches the wrong block. One complete expression per line.
$QuotePattern = '[\x22\x27]?'
$EolPattern = '(?:\r\n|\n|\r)'

# A row that mounts the plugin: "- insert:" then "- id: link-start" then
# "name: dsh-link-start", allowing the id and name to be quoted.
function Get-InsertPattern {
  return (@(
    '(?m)^[ \t]*-[ \t]*insert:[ \t]*' + $EolPattern,
    '[ \t]*-[ \t]*id:[ \t]*' + $QuotePattern + $Namespace + $QuotePattern + '[ \t]*' + $EolPattern,
    '[ \t]*name:[ \t]*' + $QuotePattern + [regex]::Escape($PluginName) + $QuotePattern + '[ \t]*'
  ) -join '')
}

# Any row that merely NAMES this id, whether or not it mounts anything. The
# settings service writes one of these once a value has been saved.
function Get-IdRowPattern {
  return (@(
    '(?m)^[ \t]*-[ \t]*id:[ \t]*',
    $QuotePattern + $Namespace + $QuotePattern + '[ \t]*$'
  ) -join '')
}

function Get-InsertRowCount([string]$raw) {
  return ([regex]::Matches($raw, (Get-InsertPattern))).Count
}

function Get-IdRowCount([string]$raw) {
  return ([regex]::Matches($raw, (Get-IdRowPattern))).Count
}

# ---------------------------------------------------------------------------
# Finding the package
# ---------------------------------------------------------------------------
Say '=== 1/7 preconditions ==='

if (-not (Test-Path (Join-Path $PackageDir 'package.json'))) {
  Fail "no package.json at '$PackageDir'. Pass -PackageDir <dir>."
}
if (-not (Test-Path (Join-Path $PackageDir 'index.js'))) {
  Fail "'$PackageDir' has no index.js - that does not look like this package."
}
if (-not (Test-Path (Join-Path $PackageDir 'cordis.patch.yml'))) {
  Fail "'$PackageDir' has no cordis.patch.yml - that does not look like this package."
}

# ---------------------------------------------------------------------------
# Finding DSH
# ---------------------------------------------------------------------------
if (-not [string]::IsNullOrWhiteSpace($DshHome)) {
  # -DshHome wins.
} elseif (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
  $DshHome = $env:DSH_HOME
} elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
  $DshHome = Join-Path $env:USERPROFILE '.dsh'
} else {
  Fail 'cannot guess the DSH home; pass -DshHome <dir>.'
}

if (-not (Test-Path $DshHome)) { Fail "no DSH home at '$DshHome'; pass -DshHome <dir>." }

$Profile = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$PatchFile = Join-Path $Profile 'cordis.patch.yml'
$ProfileManifest = Join-Path $Profile 'package.json'
$LinkPath = Join-Path $Profile "node_modules\$PluginName"
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Backup = Join-Path $DshHome ".dsh-rollback-$PluginName-$Stamp"

Say "  package : $PackageDir"
Say "  dsh home: $DshHome"
Say "  profile : $Profile"

if (-not (Test-Path $ProfileManifest)) {
  $present = @()
  $profilesDir = Join-Path $DshHome 'profiles'
  if (Test-Path $profilesDir) {
    $present = @(Get-ChildItem $profilesDir -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  }
  Fail "no profile at '$Profile'. Profiles present: $($present -join ', '). Pass -ProfileName <name>."
}
if (-not (Test-Path $PatchFile)) { Fail "no cordis.patch.yml at '$PatchFile'." }

# ---------------------------------------------------------------------------
# Back up first. This is a file this script does not own.
# ---------------------------------------------------------------------------
Say '=== 2/7 back up the patch layer ==='
New-Item -ItemType Directory -Force -Path $Backup | Out-Null
Copy-Item $PatchFile (Join-Path $Backup 'cordis.patch.yml') -Force
$hadLink = Test-Path $LinkPath
"hadNodeModulesLink=$hadLink" | Set-Content (Join-Path $Backup 'MANIFEST.txt') -Encoding ascii
Say "  backup = $Backup"
Say '  To undo by hand, copy that cordis.patch.yml back over the live one.'

# ---------------------------------------------------------------------------
# Change 1 of 2: the junction
# ---------------------------------------------------------------------------
Say '=== 3/7 link the package into the profile ==='
if ($hadLink) {
  $existing = Get-Item $LinkPath -Force
  $isLink = ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  if ($isLink) {
    Say "  link already present: $LinkPath"
  } else {
    Warn "$LinkPath exists and is NOT a link; leaving it exactly as it is."
    Say '  Remove it yourself if it is a stale copy of this plugin, then install again.'
  }
} else {
  $parent = Split-Path $LinkPath -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  New-Item -ItemType Junction -Path $LinkPath -Target $PackageDir -Force | Out-Null
  $made = Get-Item $LinkPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $made) {
    Warn "the junction at $LinkPath could not be created; the plugin will not resolve."
  } else {
    $madeIsLink = ($made.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if (-not $madeIsLink) {
      Warn "$LinkPath exists but is not a reparse point; the plugin is not linked."
    } else {
      Say "  linked $LinkPath -> $PackageDir"
    }
  }
}

# ---------------------------------------------------------------------------
# Change 2 of 2: the patch row
# ---------------------------------------------------------------------------
# "Already installed" is NOT "the plugin name appears in the file".
#
# As soon as a value is saved in the settings card, the settings service writes a
# row of its OWN into this same file:
#     - id: link-start
#       config:
#         ...
# with no "insert:" in it. That row is a config override; it mounts nothing. A
# script that searched for the plugin name would find it, conclude "already
# installed", and leave the plugin off the loader graph while reporting success -
# no animation, no error, and nothing to look at. So this counts INSERT rows.
Say '=== 4/7 append the insert row to the patch layer ==='
$raw = [System.IO.File]::ReadAllText($PatchFile, $Utf8NoBom)
$existingInserts = Get-InsertRowCount $raw
$existingIdRows = Get-IdRowCount $raw

if ($existingInserts -gt 0) {
  Say "  an insert row for $PluginName is already present ($existingInserts found); not adding a second."
} else {
  # Use the terminator the file already uses, so the appended block does not
  # introduce a second line-ending style into a file this script does not own.
  $newline = "`n"
  if ($raw.Contains("`r`n")) { $newline = "`r`n" }

  $block = (@(
    '- insert:' + $newline,
    '    - id: ' + $Namespace + $newline,
    '      name: ' + $PluginName + $newline
  ) -join '')

  # An appended block has to start on a line of its own.
  $body = $raw
  if ($body.Length -gt 0 -and -not $body.EndsWith("`n") -and -not $body.EndsWith("`r")) {
    $body = $body + $newline
  }

  [System.IO.File]::WriteAllText($PatchFile, $body + $block, $Utf8NoBom)
  $terminator = 'LF'
  if ($newline -eq "`r`n") { $terminator = 'CRLF' }
  Say "  appended 3 lines (terminator: $terminator)"

  # Say it out loud when a settings-service row for this id is already there: it
  # is invisible in every log, and it is the reason a name search is wrong.
  if ($existingIdRows -gt $existingInserts) {
    Say '  note: the layer already carried a row with this id and no "insert:" (a saved'
    Say '        setting, most likely). That row is a config override - it mounts nothing -'
    Say '        and it has been left exactly as it was.'
  }

  $after = Get-InsertRowCount ([System.IO.File]::ReadAllText($PatchFile, $Utf8NoBom))
  if ($after -ne 1) { Fail "expected exactly 1 insert row after writing, found $after. Backup: $Backup" }
}

# ---------------------------------------------------------------------------
# Report only: can @deepseek-ai/schemastery be resolved?
# ---------------------------------------------------------------------------
# index.js imports it statically at module evaluation, so it must resolve from
# the package directory (Node resolves a junction to its real path, so the
# lookup base is $PackageDir, not the profile). The kernel's own copy lives
# inside the app payload, which Node cannot resolve; a packaged DSH has no
# on-disk copy at all, and that is an EXPECTED state. Without a usable copy the
# Config schema degrades to non-volatile, DSH serves no namespace for this
# entry, and the settings card is simply absent - while the animation itself
# works normally.
#
# This step does not install, link or repair anything, and it does not fail the
# install: the plugin is fully functional without a card.
Say '=== 5/7 check for @deepseek-ai/schemastery (report only) ==='

function Get-SchemaVersion([string]$dir) {
  $manifest = Join-Path $dir 'package.json'
  if (-not (Test-Path $manifest)) { return $null }
  $parsed = $null
  try { $parsed = Get-Content $manifest -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return $null }
  if ($null -eq $parsed) { return $null }
  if ($parsed.name -ne $SchemaName) { return $null }
  if ($null -eq $parsed.version) { return $null }
  $parsedVersion = $null
  try { $parsedVersion = [version]$parsed.version } catch { return $null }
  return $parsedVersion
}

$schemaCandidates = @(
  (Join-Path $PackageDir "node_modules\$SchemaName"),
  (Join-Path $Profile "node_modules\$SchemaName"),
  (Join-Path (Join-Path $DshHome 'profiles') "node_modules\$SchemaName")
)
$schemaFound = ''
foreach ($candidate in $schemaCandidates) {
  if (-not (Test-Path $candidate)) { continue }
  $found = Get-SchemaVersion $candidate
  if ($null -ne $found -and $found -ge $SchemaMinVersion) {
    $schemaFound = "$candidate ($found)"
    break
  }
}

if ($schemaFound -ne '') {
  Say "  usable copy: $schemaFound"
} else {
  Warn "no usable $SchemaName (>= $SchemaMinVersion) was found next to this package."
  Say '  This does NOT stop the animation - it only hides the Settings card, because'
  Say '  DSH serves a settings namespace only for an entry whose Config projects a'
  Say '  form, and that projection keeps .volatile() fields alone.'
  Say '  A packaged DSH keeps its copy inside the application payload, where Node'
  Say '  cannot resolve it, so "not found" is an expected state on a released install.'
  Say '  To get the card, make a copy with .volatile() reachable at:'
  Say "    $(Join-Path $PackageDir "node_modules\$SchemaName")"
  Say "  (looked in: $($schemaCandidates -join ' ; '))"
}

# ---------------------------------------------------------------------------
# Report only: is a dsh server still answering?
# ---------------------------------------------------------------------------
# A step that only checks must not repair anything and must not roll back. If no
# candidate port answers, the honest answer is "this check could not tell",
# because a dsh server that is down and a dsh server on a port that was not
# tried look identical from here. The install stays in place either way. The
# desktop app prints its own port in the window URL and records it nowhere.
Say '=== 6/7 is a dsh server answering (report only) ==='
$ports = @(3080, 19387)
if ($Port -gt 0) { $ports = @($Port) }

$answered = ''
$answeredPort = 0
$curlUsable = $null -ne (Get-Command curl.exe -ErrorAction SilentlyContinue)
if ($curlUsable) {
  foreach ($candidate in $ports) {
    $code = ''
    try {
      $code = curl.exe -s -o NUL -w '%{http_code}' --max-time 3 --noproxy '*' "http://127.0.0.1:$candidate/" 2>$null
    } catch {
      $code = ''
    }
    if ($null -ne $code -and $code -ne '' -and $code -ne '000') {
      $answered = $code
      $answeredPort = $candidate
      break
    }
  }
}

if ($answered -ne '') {
  # Any HTTP status counts as an answer: 401 is normal (the root wants the launch
  # token the printed URL carries) and 200 means a deployment without that gate.
  # Liveness, not authorisation.
  Say "  port $answeredPort answered with HTTP $answered"
  Say '  What this cannot tell you: whether the overlay actually rendered. The page may'
  Say '  need a launch token that only the printed URL carries.'
} elseif (-not $curlUsable) {
  Say '  could not tell: curl.exe is not available here, so no probe was made.'
  Say '  This is a check that could not run, not a failed install.'
} else {
  Say "  could not tell: nothing answered on $($ports -join ', ')."
  Say '  The link and the patch row are IN PLACE and have not been rolled back.'
  Say '  A dsh server that is not running and a dsh server on some other port look'
  Say '  the same from here. For the desktop app, read the port out of the window URL'
  Say '  and re-run with -Port <that number>.'
}

# ---------------------------------------------------------------------------
Say '=== 7/7 done ==='
Say ''
Say '  Next: restart DSH once, so the new row is loaded into the process. If this'
Say '  deployment hot-reloads its patch layer, a page reload is enough.'
Say ''
Say '  IMPORTANT: after that, changes take effect on a page reload, NOT a restart -'
Say '  EXCEPT a change to src/client.js, which needs'
Say '      node build-client.mjs'
Say '  and then a HARD refresh: Ctrl+Shift+R. A plain F5 is NOT enough for that one,'
Say '  because client bundles are served cache-control: immutable with a revision'
Say '  that is allocated per process and does not track content.'
Say ''
Say "  Backup: $Backup"
Say "  Undo  : powershell -ExecutionPolicy Bypass -File $(Join-Path $PackageDir 'tools\uninstall.ps1') -ProfileName $ProfileName"
exit 0
