#Requires -Version 5.1
# scripts/bootstrap.ps1 - Prepare the LiteLLM Provider workspace from scratch.
#
# Clones missing child repositories listed in workspace.json and reports local
# development tool prerequisites. The repository registry has ONE source:
# workspace.json -> bootstrap.ps1 / scripts/workspace.mjs / scripts/status.ps1.
#
# Source is pure ASCII on purpose: Windows PowerShell 5.1 parses this file the
# same way regardless of BOM handling.
#
# This script NEVER does any of the following:
#   - reset / clean / stash / checkout / pull / rebase / merge in a child repo
#   - delete, overwrite or re-clone an existing repository
#   - change a remote URL or any git configuration
#   - install software or global npm packages
#   - read or print credentials, API keys or tokens
#
# Behaviour:
#   - repository missing          -> git clone from the workspace.json registry
#   - repository existing         -> inspect only (origin, branch, working tree)
#   - existing wrong origin       -> FAIL CLOSED (no fix, no overwrite)
#   - existing dirty working tree -> report only (left untouched, not synced)
#   - missing development tools   -> report only (source may still be ready)
#
# No switches on purpose: bootstrap builds source workspace state only.
# Dependency installation and repository syncing stay manual and explicit.
#
# Exit codes: 0 = READY or SOURCE READY, 2 = FAILED.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$ExpectedOpenSpecVersion = '1.13.2'

$root = Split-Path -Parent $PSScriptRoot

function Get-NormalizedUrl {
    param([string]$Url)
    $u = ''
    if ($null -ne $Url) { $u = $Url.Trim().ToLowerInvariant() }
    if ($u.StartsWith('git@github.com:')) {
        $u = 'https://github.com/' + $u.Substring('git@github.com:'.Length)
    }
    if ($u.EndsWith('.git')) { $u = $u.Substring(0, $u.Length - 4) }
    while ($u.EndsWith('/')) { $u = $u.Substring(0, $u.Length - 1) }
    return $u
}

function Get-CommandOutput {
    # Runs a native command, returns trimmed combined output as a string.
    param([string]$FilePath, [string[]]$ArgumentList)
    $out = & $FilePath @ArgumentList 2>&1 | Out-String
    return $out.Trim()
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
$gitAvailable = ($null -ne $gitCmd)
$gitVersion = ''
if ($gitAvailable) { $gitVersion = Get-CommandOutput 'git' @('--version') }

Write-Output 'LiteLLM Provider Workspace Bootstrap'
Write-Output ''
Write-Output 'Workspace:'
Write-Output ('  root: ' + $root)
if ($gitAvailable) {
    Write-Output ('  git: OK (' + $gitVersion + ')')
} else {
    Write-Output '  git: MISSING (required)'
}

# --- repository registry (single source: workspace.json) ---------------------
$registry = $null
$registryError = ''
$registryPath = Join-Path $root 'workspace.json'
if (-not (Test-Path -LiteralPath $registryPath)) {
    $registryError = 'workspace.json not found: ' + $registryPath
} else {
    try {
        # -Encoding UTF8 matters: workspace.json is UTF-8 without BOM and PS 5.1
        # would otherwise read it as ANSI and fail to parse.
        $registry = Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $registryError = 'workspace.json cannot be parsed: ' + $_.Exception.Message
    }
}

$repoFailures = 0
$dirtyCount = 0

Write-Output ''
Write-Output 'Repositories:'

if ($registryError.Length -gt 0) {
    Write-Output ('  FAILED: ' + $registryError)
    $repoFailures++
}

$entries = @()
if ($null -ne $registry -and $null -ne $registry.PSObject.Properties['repos'] -and $null -ne $registry.repos) {
    $entries = @($registry.repos)
}

foreach ($entry in $entries) {
    $name = ''
    $url = ''
    $branch = 'main'
    if ($null -ne $entry.PSObject.Properties['name']) { $name = [string]$entry.name }
    if ($null -ne $entry.PSObject.Properties['url']) { $url = [string]$entry.url }
    if ($null -ne $entry.PSObject.Properties['branch'] -and $null -ne $entry.branch) { $branch = [string]$entry.branch }

    Write-Output ''
    Write-Output $name

    if ($name -notmatch '^[A-Za-z0-9._-]+$' -or $url.Length -eq 0) {
        Write-Output '  status: FAILED (invalid workspace.json entry)'
        $repoFailures++
        continue
    }

    $dir = Join-Path $root $name

    if (-not (Test-Path -LiteralPath $dir)) {
        if (-not $gitAvailable) {
            Write-Output '  status: FAILED (cannot clone: git is missing)'
            $repoFailures++
            continue
        }
        $null = Get-CommandOutput 'git' @('clone', '--', $url, $dir)
        if ($LASTEXITCODE -ne 0) {
            Write-Output '  status: FAILED (git clone failed; directory left as-is)'
            $repoFailures++
            continue
        }
        Write-Output '  status: cloned'
    } else {
        Write-Output '  status: existing'
    }

    # Identity verification (also runs right after a fresh clone).
    if (-not $gitAvailable) {
        Write-Output '  origin: FAILED (cannot verify: git is missing)'
        $repoFailures++
        continue
    }
    if (-not (Test-Path -LiteralPath (Join-Path $dir '.git'))) {
        Write-Output '  origin: FAILED (directory exists but is not a git repository; left untouched)'
        $repoFailures++
        continue
    }

    $origin = Get-CommandOutput 'git' @('-C', $dir, 'remote', 'get-url', 'origin')
    if ($LASTEXITCODE -ne 0) {
        Write-Output '  origin: FAILED (no origin remote; left untouched)'
        $repoFailures++
        continue
    }
    if ((Get-NormalizedUrl $origin) -ne (Get-NormalizedUrl $url)) {
        Write-Output '  origin: MISMATCH - FAIL CLOSED'
        Write-Output ('    expected: ' + $url)
        Write-Output ('    found:    ' + $origin)
        Write-Output '    (left untouched: no set-url, no delete, no re-clone)'
        $repoFailures++
        continue
    }
    Write-Output '  origin: OK'

    $curBranch = Get-CommandOutput 'git' @('-C', $dir, 'rev-parse', '--abbrev-ref', 'HEAD')
    if ($LASTEXITCODE -ne 0) { $curBranch = '(unknown)' }
    Write-Output ('  branch: ' + $curBranch + ' (registry default: ' + $branch + ')')

    $tree = Get-CommandOutput 'git' @('-C', $dir, 'status', '--porcelain')
    if ($LASTEXITCODE -ne 0) {
        Write-Output '  working tree: (cannot determine)'
    } elseif ($tree.Length -eq 0) {
        Write-Output '  working tree: clean'
    } else {
        $count = @($tree -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 }).Count
        Write-Output ('  working tree: dirty (' + $count + ' entries; left untouched, not synced)')
        $dirtyCount++
    }
}

# --- tool prerequisites ------------------------------------------------------
$missingTools = 0

Write-Output ''
Write-Output 'Tools:'

if ($gitAvailable) {
    Write-Output ('Git       OK (' + $gitVersion + ')')
} else {
    Write-Output 'Git       MISSING (required for cloning and verification)'
    $missingTools++
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($null -ne $nodeCmd) {
    Write-Output ('Node      OK (' + (Get-CommandOutput 'node' @('--version')) + ')')
} else {
    Write-Output 'Node      MISSING (development prerequisite)'
    $missingTools++
}

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if ($null -ne $npmCmd) {
    Write-Output ('npm       OK (' + (Get-CommandOutput 'npm' @('--version')) + ')')
} else {
    Write-Output 'npm       MISSING (development prerequisite)'
    $missingTools++
}

$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($null -ne $bunCmd) {
    Write-Output ('Bun       OK (' + (Get-CommandOutput 'bun' @('--version')) + ')')
} else {
    Write-Output 'Bun       MISSING (development prerequisite)'
    $missingTools++
}

$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
if ($null -ne $ghCmd) {
    $ghVersion = Get-CommandOutput 'gh' @('--version')
    $ghVersion = @($ghVersion -split "`r?`n")[0]
    $null = Get-CommandOutput 'gh' @('auth', 'status')
    if ($LASTEXITCODE -eq 0) {
        Write-Output ('GitHub CLI  authenticated (' + $ghVersion + ')')
    } else {
        Write-Output ('GitHub CLI  installed but not authenticated (' + $ghVersion + ')')
        $missingTools++
    }
} else {
    Write-Output 'GitHub CLI  MISSING (development prerequisite)'
    $missingTools++
}

$osCmd = Get-Command openspec -ErrorAction SilentlyContinue
if ($null -ne $osCmd) {
    $osVersion = Get-CommandOutput 'openspec' @('--version')
    if ($osVersion.Contains($ExpectedOpenSpecVersion)) {
        Write-Output ('OpenSpec  OK (' + $ExpectedOpenSpecVersion + ')')
    } else {
        Write-Output ('OpenSpec  found ' + $osVersion + ' (expected ' + $ExpectedOpenSpecVersion + ')')
        Write-Output ('          hint: npm install -g @fission-ai/openspec@' + $ExpectedOpenSpecVersion + ' (not executed)')
        $missingTools++
    }
} else {
    Write-Output ('OpenSpec  MISSING (development prerequisite; expected ' + $ExpectedOpenSpecVersion + ')')
    Write-Output ('          hint: npm install -g @fission-ai/openspec@' + $ExpectedOpenSpecVersion + ' (not executed)')
    $missingTools++
}

# --- result -----------------------------------------------------------------
Write-Output ''
Write-Output 'Bootstrap result:'
if ($repoFailures -gt 0) {
    Write-Output '  FAILED'
    exit 2
}

$notes = @()
if ($dirtyCount -gt 0) {
    $notes += 'UNCOMMITTED CHANGES PRESENT (left untouched; those repositories are not synced)'
}
if ($missingTools -gt 0) {
    $notes += 'DEVELOPMENT PREREQUISITES INCOMPLETE'
}
if ($notes.Count -eq 0) {
    Write-Output '  READY'
} else {
    Write-Output '  SOURCE READY'
    foreach ($note in $notes) { Write-Output ('  ' + $note) }
}
exit 0
