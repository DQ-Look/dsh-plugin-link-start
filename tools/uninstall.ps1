# uninstall.ps1 - remove dsh-link-start from a DSH profile.
#
# The exact inverse of install.ps1:
#   1. drop the "- insert:" row install.ps1 appended
#   2. remove the directory junction install.ps1 created
#
# The package directory itself is never deleted, and nothing else in the patch
# layer is touched. package.json is not touched and pnpm is not run.
#
# Paths are derived exactly the way install.ps1 derives them, so this works on
# any machine. -ProfileName defaults to desktop, matching install.ps1, because
# that is the profile the Electron app actually runs.
#
# ---------------------------------------------------------------------------
# Why the patch layer is handled as BYTES here, not as lines.
#
# A previous generation of this script read the file back and wrote it out with
# ReadAllLines/WriteAllLines. WriteAllLines terminates EVERY line with
# [Environment]::NewLine - CRLF on Windows - so a layer whose own lines used LF
# came back entirely rewritten: "the row was removed" arrived with a whole-file
# change to a file this plugin does not own.
#
# cordis.patch.yml is also BOM-less UTF-8 and routinely carries CJK (a provider's
# displayName, a comment). Two cmdlet traps, both measured:
#
#   * `Set-Content -Encoding utf8` on PowerShell 5.1 means UTF-8 WITH a BOM (the
#     output began 239,187,191), so a Get-Content/Set-Content pair adds one.
#   * `Get-Content` without -Encoding uses the machine's default file encoding -
#     the system ANSI codepage (936/GBK here) on a default Windows install, so
#     BOM-less UTF-8 is decoded as mojibake and written back that way. It depends
#     on the machine: this one has the Windows UTF-8 beta on and decodes fine,
#     which is exactly why the script cannot be built on that assumption.
#
# So both directions go through .NET's UTF-8 codec:
#   [System.IO.File]::ReadAllText($p, $utf8NoBom) / WriteAllText($p, $text, $utf8NoBom)
# Every kept byte is copied unchanged, and the write adds no BOM and normalises no
# terminator. The byte total is asserted before anything is written: if the
# removal does not account for every byte, NOTHING is written and the patch layer
# is left exactly as it was.
#
# This file is pure ASCII on purpose, for the same reason as install.ps1.
# ---------------------------------------------------------------------------
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1 -ProfileName web
#   powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1 -DshHome C:\Users\me\.dsh

param(
  [string]$PackageDir = (Split-Path $PSScriptRoot -Parent),
  [string]$DshHome = '',
  [string]$ProfileName = 'desktop'
)

$ErrorActionPreference = 'Continue'

$PluginName = 'dsh-link-start'
$Namespace = 'link-start'

$ConfirmPreference = 'None'

function Say($m) { Write-Host "$(Get-Date -Format 'HH:mm:ss') $m" }
function Warn($m) { Write-Host "$(Get-Date -Format 'HH:mm:ss') WARNING: $m" }
function Fail($m) { Say "FAILED: $m"; exit 2 }

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# One complete expression per line: PowerShell does not continue a statement that
# ends in "+" when the statement is already complete, and the half-built pattern
# that results is reported nowhere under $ErrorActionPreference = 'Continue'.
$QuotePattern = '[\x22\x27]?'
$EolPattern = '(?:\r\n|\n|\r)'

# Exactly the three lines install.ps1 appends, plus the terminator that ends the
# row. The terminator that install.ps1 may have ADDED to start the block on its
# own line is deliberately not part of this pattern - see the note below.
function Get-InsertBlockPattern {
  return (@(
    '(?m)^[ \t]*-[ \t]*insert:[ \t]*' + $EolPattern,
    '[ \t]*-[ \t]*id:[ \t]*' + $QuotePattern + $Namespace + $QuotePattern + '[ \t]*' + $EolPattern,
    '[ \t]*name:[ \t]*' + $QuotePattern + [regex]::Escape($PluginName) + $QuotePattern + '[ \t]*' + $EolPattern + '?'
  ) -join '')
}

# Any row that names this id without mounting anything - the settings service
# writes one of these once a value has been saved.
function Get-IdRowPattern {
  return (@(
    '(?m)^[ \t]*-[ \t]*id:[ \t]*',
    $QuotePattern + $Namespace + $QuotePattern + '[ \t]*$'
  ) -join '')
}

# ---------------------------------------------------------------------------
Say '=== 1/4 preconditions ==='

if (-not [string]::IsNullOrWhiteSpace($DshHome)) {
  # -DshHome wins.
} elseif (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
  $DshHome = $env:DSH_HOME
} elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
  $DshHome = Join-Path $env:USERPROFILE '.dsh'
} else {
  Fail 'cannot guess the DSH home; pass -DshHome <dir>.'
}

$Profile = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$PatchFile = Join-Path $Profile 'cordis.patch.yml'
$LinkPath = Join-Path $Profile "node_modules\$PluginName"
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Backup = Join-Path $DshHome ".dsh-rollback-$PluginName-undo-$Stamp"

Say "  profile: $Profile"
if (-not (Test-Path $PatchFile)) { Fail "no cordis.patch.yml at '$PatchFile'." }

# ---------------------------------------------------------------------------
Say '=== 2/4 back up the patch layer ==='
New-Item -ItemType Directory -Force -Path $Backup | Out-Null
Copy-Item $PatchFile (Join-Path $Backup 'cordis.patch.yml') -Force
"hadNodeModulesLink=$(Test-Path $LinkPath)" | Set-Content (Join-Path $Backup 'MANIFEST.txt') -Encoding ascii
Say "  backup = $Backup"

# ---------------------------------------------------------------------------
Say '=== 3/4 remove the insert row this plugin owns ==='
$raw = [System.IO.File]::ReadAllText($PatchFile, $Utf8NoBom)
$blockPattern = Get-InsertBlockPattern
# Not `$matches`: that is PowerShell's automatic variable for the last -match and
# assigning to it is both a lint error and a trap for the next reader.
$found = [regex]::Matches($raw, $blockPattern)

if ($found.Count -eq 0) {
  Say "  no insert row for $PluginName found; nothing to remove from the patch layer."
} else {
  $rewritten = [regex]::Replace($raw, $blockPattern, '')

  # Keep the promise the docs make: the bytes that leave the file are exactly the
  # bytes of the rows that were matched. Verify that against the UTF-8 byte count
  # BEFORE writing; if it does not add up, write nothing at all.
  $removedBytes = 0
  foreach ($match in $found) { $removedBytes += $Utf8NoBom.GetByteCount($match.Value) }
  $beforeBytes = $Utf8NoBom.GetByteCount($raw)
  $afterBytes = $Utf8NoBom.GetByteCount($rewritten)

  if (($afterBytes + $removedBytes) -eq $beforeBytes) {
    [System.IO.File]::WriteAllText($PatchFile, $rewritten, $Utf8NoBom)
    Say "  removed $($found.Count) insert row(s), $removedBytes bytes; every other byte is unchanged"
  } else {
    Warn 'the removal did not account for every byte, so NOTHING was written.'
    Say "    file $beforeBytes bytes; kept $afterBytes bytes; removed rows $removedBytes bytes"
    Say '  The patch layer is left exactly as it was.'
  }
}

# One byte case cannot be restored, and it is stated here rather than papered
# over: a patch layer whose final line carried NO terminating newline. install.ps1
# has to start the appended block on a line of its own, so it added that
# terminator, and nothing on disk records that the file used to lack it. The file
# therefore ends on a newline after uninstall, which both YAML and git want.
$idRowsBefore = ([regex]::Matches($raw, (Get-IdRowPattern))).Count
$insertRowsBefore = $found.Count
if ($insertRowsBefore -eq 0) { $idRowsBefore = 0 }
if ($idRowsBefore -gt $insertRowsBefore) {
  Say '  note: a row naming "- id: link-start" with no "insert:" is still in the layer.'
  Say '        That is a CONFIG OVERRIDE the settings service wrote when a value was'
  Say '        saved - it holds your saved settings, it mounts nothing, and it is left'
  Say '        alone on purpose. Delete that block by hand if you want it gone too.'
}

# ---------------------------------------------------------------------------
Say '=== 4/4 remove the directory junction ==='
# The link is a junction, and the whole point is to remove the LINK, not the
# package it points at. `Remove-Item -Recurse` on a junction can prompt and then
# fail as "not empty" in a non-interactive shell; worse, a naive recursive delete
# follows the link and destroys the package directory. `cmd /c rmdir` removes the
# reparse point and never follows it.
#
# Anything that is NOT a reparse point is refused rather than deleted: a real
# directory in that spot is the user's, and this script may not destroy their
# data to tidy up after itself.
if (Test-Path $LinkPath) {
  $item = Get-Item $LinkPath -Force
  $isLink = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  if (-not $isLink) {
    Warn "$LinkPath is a real directory, not a link; refusing to delete it."
    Say '  Remove it yourself if it really is a stale copy of this plugin.'
  } else {
    $null = cmd /c rmdir "$LinkPath" 2>&1
    if (Test-Path $LinkPath) { Warn "could not remove $LinkPath" } else { Say "  removed $LinkPath" }
  }
} else {
  Say '  no link present'
}

# ---------------------------------------------------------------------------
Say ''
Say '  The plugin is off the loader graph now. Reload the page; if this deployment'
Say '  does not hot-reload its patch layer, restart DSH once.'
Say "  Backup: $Backup"
exit 0
