# scripts/status.ps1 - Read-only snapshot of the local workspace state.
# Observes only: never fetch/merge/rebase, never reset/clean/stash/checkout,
# never writes to any repository, never prints credentials.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot | Split-Path -Parent   # workspace root (parent of scripts/)

$repos = @('litellm-discovery-core', 'pi-litellm-provider', 'opencode-litellm-provider')

function Read-Provenance {
    param([string]$Path)
    # Reads dist/core-provenance.json; returns repository + full SHA only (no credentials).
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $p = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        if ($p.PSObject.Properties['sha']) {
            $where = if ($p.PSObject.Properties['repository']) { [string]$p.repository } else { '(unknown repository)' }
            return "$where @ $($p.sha)"
        }
    } catch {
        return '(core-provenance.json exists but cannot be parsed)'
    }
    return $null
}

Write-Output "workspace status (read-only) - $root"
Write-Output ("=" * 78)

foreach ($repo in $repos) {
    $dir = Join-Path $root $repo

    Write-Output ""
    Write-Output "[$repo]"

    if (-not (Test-Path -LiteralPath (Join-Path $dir '.git'))) {
        Write-Output "  (not cloned)"
        continue
    }

    # This script only observes; every git call below is a read-only subcommand.
    Push-Location -LiteralPath $dir
    try {
        $remote = git remote get-url origin 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remote)) {
            Write-Output "  remote     : (no 'origin' remote)"
        } else {
            Write-Output "  remote     : $remote"
        }

        $branch = git branch --show-current 2>$null
        if ([string]::IsNullOrWhiteSpace($branch)) { $branch = '(detached)' }
        Write-Output "  branch     : $branch"

        $head = git rev-parse HEAD 2>$null
        if ($LASTEXITCODE -ne 0) { $head = '(no commits)' }
        Write-Output "  HEAD       : $head"

        Write-Output "  status     :"
        $status = git status --short --branch 2>$null
        if ([string]::IsNullOrWhiteSpace($status)) {
            Write-Output "    (clean)"
        } else {
            # Indent each line so sub-repo output stays visually grouped.
            foreach ($line in ($status -split "`r?`n")) {
                if (-not [string]::IsNullOrWhiteSpace($line)) { Write-Output "    $line" }
            }
        }
    } finally {
        Pop-Location
    }

    $provenance = Read-Provenance -Path (Join-Path $dir 'dist/core-provenance.json')
    if ($provenance) {
        Write-Output "  provenance : core $provenance"
    } else {
        Write-Output "  provenance : (no dist/core-provenance.json)"
    }
}

Write-Output ""
Write-Output ("=" * 78)
Write-Output "done. (read-only: no fetch / merge / rebase / reset / clean / stash / checkout)"