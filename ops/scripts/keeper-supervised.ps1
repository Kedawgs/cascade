<#
.SYNOPSIS
  Runs Cascade's keeper (pnpm ops run --live) unattended, and restarts it when it crashes.

.DESCRIPTION
  Starts `pnpm ops run --live` in ops/ for one deployment, with the keeper's keystore and password
  file. This script passes their paths only: it never opens either file. Every line the keeper prints
  goes, with a timestamp, to ops/logs/keeper-<deployment>-<yyyy-MM-dd>.log (a new file each day).

  When the keeper exits:
    0          it ended normally: not restarted.
    3          it stopped itself on something that needs a person (the keeper wallet holding code, a
               wrong key, a record that changed or isn't verified, a revert nothing explains): not
               restarted. Its last lines in the log say why.
    2          a usage error: not restarted.
    any other  a crash: restarted after 10 s, then 20 s, 40 s, ... at most 5 minutes. A keeper that
               ran for 10 minutes or more starts the count again.

  It refuses to start while another keeper runs: a node process whose command line runs cli.ts with
  `run` (a keeper started by hand counts), or another supervisor holding ops/logs/keeper.lock. A lock
  whose supervisor is gone is stale, and is taken over.

  Stop it with Ctrl-C in its window, or from any PowerShell window with -Stop. Either way the keeper's
  whole process tree is ended: Windows would otherwise leave the keeper's node process running.

  PowerShell 5.1 or later. Nothing here changes system settings or registers a task.

.EXAMPLE
  .\keeper-supervised.ps1 -Deployment v3-launch
.EXAMPLE
  .\keeper-supervised.ps1 -Deployment v3-launch -DryRun
.EXAMPLE
  .\keeper-supervised.ps1 -Stop
#>
[CmdletBinding()]
param(
    # The deployment (OPS_DEPLOYMENT); its record is ops/deployments/<name>.json. Not needed with -Stop.
    [string]$Deployment = '',
    # The keeper's Foundry keystore (OPS_KEEPER_KEYSTORE), by path
    [string]$Keystore = 'C:/Users/danie/.foundry/keystores/cascade-keeper',
    # The keystore's password file (OPS_KEEPER_PASSWORD_FILE), by path
    [string]$PasswordFile = 'C:/Users/danie/.foundry/cascade-keeper.pw',
    # OPS_CADENCE
    [ValidateSet('launch', 'test')]
    [string]$Cadence = 'launch',
    # The first restart's delay; each restart in a row doubles it, up to MaxRestartSeconds
    [ValidateRange(1, 3600)]
    [int]$FirstRestartSeconds = 10,
    [ValidateRange(1, 86400)]
    [int]$MaxRestartSeconds = 300,
    # Prints what it would run and whether a real start would go ahead; starts, stops and writes nothing
    [switch]$DryRun,
    # Stops a running supervisor and its keeper
    [switch]$Stop
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$OpsDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$LogDir = Join-Path $OpsDir 'logs'
$LockFile = Join-Path $LogDir 'keeper.lock'
$StopFile = Join-Path $LogDir 'keeper.stop'
$KeeperCommand = 'pnpm ops run --live'
$Shell = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
# cmd runs pnpm (a .cmd) and merges the keeper's error output into its output, in order
$ShellArguments = '/d /s /c "' + $KeeperCommand + ' 2>&1"'
# pnpm ops run's exit codes: KEEPER_STOPPED in ops/src/keeper/actions.ts, and a usage error (ops/src/cli.ts)
$ExitKeeperStopped = 3
$ExitUsage = 2
# A run at least this long resets the restart delay
$StableRunSeconds = 600
$EventPrefix = 'cascade-keeper-'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

$script:LockStream = $null
# This supervisor's start time (ticks), as the lock records it
$script:MyStarted = $null
# Every process of the keeper's tree seen so far (cmd, pnpm's node, the keeper's node), in the order found
$script:Tree = @()
$script:Finished = $false

# ---- logging ----

function Get-LogPath {
    $name = if ($Deployment) { $Deployment } else { 'supervisor' }
    return (Join-Path $LogDir ('keeper-{0}-{1}.log' -f $name, (Get-Date -Format 'yyyy-MM-dd')))
}

# One line, timestamped, to the console and (unless -DryRun) to today's log file
function Write-Log([string]$Line, [string]$From = 'supervisor') {
    $stamped = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'), $From, $Line
    if (-not $DryRun) {
        if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
        [System.IO.File]::AppendAllText((Get-LogPath), $stamped + [Environment]::NewLine, $Utf8)
    }
    Write-Host $stamped
}

# ---- processes ----

function Get-Ticks($Date) { return [string]$Date.ToUniversalTime().Ticks }

function Get-AllProcesses { return @(Get-CimInstance -ClassName Win32_Process) }

# A keeper: node running ops' cli.ts with the run command (pnpm's own node process names no cli.ts)
function Test-KeeperCommandLine([string]$CommandLine) {
    if (-not $CommandLine) { return $false }
    return (($CommandLine -match 'cli\.ts') -and ($CommandLine -match '(^|[\s"''])run([\s"'']|$)'))
}

function Get-KeeperProcesses {
    return @(Get-AllProcesses | Where-Object { $_.Name -eq 'node.exe' -and (Test-KeeperCommandLine $_.CommandLine) })
}

function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# A process and every descendant, parents first, as { Id, Name, Started (ticks) }. A child counts only if
# it started after its parent: Windows keeps a dead parent's id on its orphans, and ids are reused.
function Get-ProcessTree([int]$RootId) {
    $all = Get-AllProcesses
    $root = $all | Where-Object { [int]$_.ProcessId -eq $RootId } | Select-Object -First 1
    if (-not $root) { return @() }
    $tree = New-Object System.Collections.ArrayList
    $seen = @{}
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($root)
    while ($queue.Count -gt 0) {
        $p = $queue.Dequeue()
        if ($seen.ContainsKey([int]$p.ProcessId)) { continue }
        $seen[[int]$p.ProcessId] = $true
        [void]$tree.Add([pscustomobject]@{ Id = [int]$p.ProcessId; Name = [string]$p.Name; Started = (Get-Ticks $p.CreationDate) })
        foreach ($c in $all) {
            if ([int]$c.ParentProcessId -eq [int]$p.ProcessId -and [int]$c.ProcessId -ne [int]$p.ProcessId -and $c.CreationDate -ge $p.CreationDate) {
                $queue.Enqueue($c)
            }
        }
    }
    return $tree.ToArray()
}

# Adds what the tree from `RootId` holds now to what was seen before (a process whose parent has died
# stays on the list), and records it in the lock for -Stop
function Update-Tree([int]$RootId) {
    $known = @{}
    foreach ($t in $script:Tree) { $known['{0}/{1}' -f $t.Id, $t.Started] = $true }
    $added = $false
    foreach ($t in (Get-ProcessTree $RootId)) {
        if (-not $known.ContainsKey(('{0}/{1}' -f $t.Id, $t.Started))) {
            $script:Tree += $t
            $added = $true
        }
    }
    if ($added) { Update-Lock }
}

# Ends each process of `Tree` still running as itself (same id and start time), last found first. The
# number ended.
function Stop-Tree([object[]]$Tree) {
    if (-not $Tree -or $Tree.Count -eq 0) { return 0 }
    $all = Get-AllProcesses
    $ended = 0
    for ($i = $Tree.Count - 1; $i -ge 0; $i--) {
        $t = $Tree[$i]
        $live = $all | Where-Object { [int]$_.ProcessId -eq [int]$t.Id -and (Get-Ticks $_.CreationDate) -eq [string]$t.Started }
        if (-not $live) { continue }
        try {
            Stop-Process -Id ([int]$t.Id) -Force -Confirm:$false -ErrorAction Stop
            Write-Log ('ended {0} (PID {1})' -f $t.Name, $t.Id)
            $ended++
        } catch {
            # a parent often exits by itself once its child is ended: only one still running is a problem
            if (Get-Process -Id ([int]$t.Id) -ErrorAction SilentlyContinue) {
                Write-Log ('could not end {0} (PID {1}): {2}' -f $t.Name, $t.Id, $_.Exception.Message)
            }
        }
    }
    return $ended
}

# Ends the keeper's whole tree: everything seen so far, and whatever its first process (cmd) has
# started since
function Stop-KeeperTree {
    if ($script:Tree.Count -gt 0) { Update-Tree ([int]$script:Tree[0].Id) }
    $ended = Stop-Tree $script:Tree
    $script:Tree = @()
    Update-Lock
    return $ended
}

# ---- the lock ----

function Read-Lock {
    if (-not (Test-Path -LiteralPath $LockFile)) { return $null }
    try {
        $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        $fs = New-Object System.IO.FileStream($LockFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
        $reader = New-Object System.IO.StreamReader($fs, $Utf8)
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        return ($text | ConvertFrom-Json)
    } catch {
        return $null
    }
}

# Whether the supervisor a lock names is still running: the same process id and start time
function Test-LockHolder($Lock) {
    $id = Get-Field $Lock 'supervisorPid'
    if (-not $id) { return $false }
    $p = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId={0}' -f [int]$id)
    if (-not $p) { return $false }
    return ((Get-Ticks $p.CreationDate) -eq [string](Get-Field $Lock 'supervisorStarted'))
}

# What the lock holds: this supervisor, its deployment and log, and the keeper's process tree
function Update-Lock {
    if (-not $script:LockStream) { return }
    if (-not $script:MyStarted) {
        $script:MyStarted = Get-Ticks (Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId={0}' -f $PID)).CreationDate
    }
    $info = [ordered]@{
        supervisorPid = $PID
        supervisorStarted = $script:MyStarted
        deployment = $Deployment
        log = (Get-LogPath)
        keeper = @($script:Tree | ForEach-Object { [ordered]@{ id = $_.Id; name = $_.Name; started = $_.Started } })
    }
    $bytes = $Utf8.GetBytes(($info | ConvertTo-Json -Depth 4))
    $script:LockStream.SetLength(0)
    $script:LockStream.Position = 0
    $script:LockStream.Write($bytes, 0, $bytes.Length)
    $script:LockStream.Flush()
}

# Takes the lock: created only if absent, and held open (readable, never deletable) while this runs. A
# lock whose supervisor is gone is stale and taken over; a live one refuses.
function Enter-Lock {
    if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        try {
            $script:LockStream = New-Object System.IO.FileStream($LockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
            Update-Lock
            return
        } catch {
            if (-not (Test-Path -LiteralPath $LockFile)) { throw }
        }
        $held = Read-Lock
        if (Test-LockHolder $held) {
            throw ('another supervisor (PID {0}) is running: it holds {1}. Stop it first with: {2} -Stop' -f (Get-Field $held 'supervisorPid'), $LockFile, $PSCommandPath)
        }
        try {
            Remove-Item -LiteralPath $LockFile -Force -ErrorAction Stop
        } catch {
            throw ('{0} is held open by another process (another supervisor starting?): not starting' -f $LockFile)
        }
        Write-Log ('took over a stale lock: its supervisor (PID {0}) is gone' -f (Get-Field $held 'supervisorPid'))
    }
    throw ('could not take {0}: not starting' -f $LockFile)
}

function Exit-Lock {
    if (-not $script:LockStream) { return }
    $script:LockStream.Dispose()
    $script:LockStream = $null
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}

# ---- checks ----

function Get-RecordPath { return (Join-Path $OpsDir ('deployments\{0}.json' -f $Deployment)) }

# The pnpm cmd will run: a program on PATH (pnpm.cmd or pnpm.exe), never PowerShell's pnpm.ps1
function Get-Pnpm { return (Get-Command pnpm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1) }

# What stops a real start, as lines; none when it can go ahead. `Usage` collects setup problems (exit 2),
# `Running` another keeper or supervisor (exit 1).
function Get-StartProblems {
    $usage = New-Object System.Collections.ArrayList
    $running = New-Object System.Collections.ArrayList
    if (-not $Deployment) {
        [void]$usage.Add('no -Deployment given (e.g. -Deployment v3-launch)')
    } elseif ($Deployment -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        [void]$usage.Add(('-Deployment "{0}" is not a plain name: letters, digits, ".", "_" and "-"' -f $Deployment))
    } elseif (-not (Test-Path -LiteralPath (Get-RecordPath))) {
        [void]$usage.Add(('no deployment record at {0}' -f (Get-RecordPath)))
    }
    if (-not (Test-Path -LiteralPath $Keystore)) { [void]$usage.Add(('no keystore at {0}' -f $Keystore)) }
    if (-not (Test-Path -LiteralPath $PasswordFile)) { [void]$usage.Add(('no password file at {0}' -f $PasswordFile)) }
    if (-not (Get-Pnpm)) { [void]$usage.Add('pnpm is not on PATH') }
    foreach ($k in (Get-KeeperProcesses)) {
        [void]$running.Add(('a keeper is already running: PID {0}: {1}' -f $k.ProcessId, $k.CommandLine))
    }
    $held = Read-Lock
    if ($held -and (Test-LockHolder $held)) {
        [void]$running.Add(('another supervisor (PID {0}) holds {1}' -f (Get-Field $held 'supervisorPid'), $LockFile))
    }
    return [pscustomobject]@{ Usage = $usage.ToArray(); Running = $running.ToArray() }
}

# ---- running the keeper ----

function Receive-KeeperLines {
    $events = @(Get-Event | Where-Object { $_.SourceIdentifier -like ($EventPrefix + '*') } | Sort-Object EventIdentifier)
    foreach ($e in $events) {
        $line = $e.SourceEventArgs.Data
        if ($null -ne $line) { Write-Log $line 'keeper' }
        Remove-Event -EventIdentifier $e.EventIdentifier
    }
}

# Runs the keeper once, logging its lines, until it exits or a stop is asked for (-Stop). Its exit code,
# how long it ran, and whether a stop was asked for.
function Invoke-KeeperOnce {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Shell
    $psi.Arguments = $ShellArguments
    $psi.WorkingDirectory = $OpsDir
    $psi.UseShellExecute = $false
    # its own hidden console: a Ctrl-C here reaches only this script, which then ends the keeper's tree
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $Utf8
    $psi.StandardErrorEncoding = $Utf8
    $psi.EnvironmentVariables['OPS_DEPLOYMENT'] = $Deployment
    $psi.EnvironmentVariables['OPS_KEEPER_KEYSTORE'] = $Keystore
    $psi.EnvironmentVariables['OPS_KEEPER_PASSWORD_FILE'] = $PasswordFile
    $psi.EnvironmentVariables['OPS_CADENCE'] = $Cadence
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $null = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -SourceIdentifier ($EventPrefix + 'out')
    $null = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -SourceIdentifier ($EventPrefix + 'err')
    $started = Get-Date
    try {
        [void]$proc.Start()
        # start times from one source (CIM), so a process is always matched against its own
        $script:Tree = @()
        Update-Tree $proc.Id
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()
        Write-Log ('started the keeper (PID {0}): {1}' -f $proc.Id, $KeeperCommand)
        $nextScan = (Get-Date).AddSeconds(3)
        while (-not $proc.HasExited) {
            [void](Wait-Event -Timeout 1)
            Receive-KeeperLines
            if (Test-Path -LiteralPath $StopFile) {
                Write-Log 'a stop was asked for (-Stop): ending the keeper'
                [void](Stop-KeeperTree)
                Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
                return [pscustomobject]@{ Code = $null; Seconds = ((Get-Date) - $started).TotalSeconds; StopAsked = $true }
            }
            if ((Get-Date) -ge $nextScan) {
                Update-Tree $proc.Id
                $nextScan = (Get-Date).AddSeconds(15)
            }
        }
        # the rest of its output
        $proc.WaitForExit()
        Receive-KeeperLines
        $code = $proc.ExitCode
        # anything it left running
        [void](Stop-KeeperTree)
        return [pscustomobject]@{ Code = $code; Seconds = ((Get-Date) - $started).TotalSeconds; StopAsked = $false }
    } finally {
        Unregister-Event -SourceIdentifier ($EventPrefix + 'out') -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier ($EventPrefix + 'err') -ErrorAction SilentlyContinue
        Get-Event | Where-Object { $_.SourceIdentifier -like ($EventPrefix + '*') } | Remove-Event
        $proc.Dispose()
    }
}

# Waits `Seconds`, or less if a stop is asked for: true when it was
function Wait-OrStop([int]$Seconds) {
    $until = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $until) {
        if (Test-Path -LiteralPath $StopFile) {
            Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
            return $true
        }
        [void](Wait-Event -Timeout 1)
    }
    return $false
}

function Format-Code([int]$Code) { return ('{0} (0x{1})' -f $Code, $Code.ToString('X8')) }

function Invoke-Supervisor {
    $problems = Get-StartProblems
    foreach ($p in $problems.Running) { Write-Log ('REFUSING TO START: {0}' -f $p) }
    foreach ($p in $problems.Usage) { Write-Log ('REFUSING TO START: {0}' -f $p) }
    if ($problems.Running.Count -gt 0) {
        Write-Log 'Never run two keepers at once: stop the other one first (see "Running the keeper unattended" in ops/LAUNCH-SETTINGS.md).'
        return 1
    }
    if ($problems.Usage.Count -gt 0) { return $ExitUsage }
    Enter-Lock
    # a stop asked of an earlier supervisor that never saw it
    Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
    Write-Log ('supervising the keeper for {0} (OPS_CADENCE={1}, keystore {2}, password file {3}); logs in {4}' -f $Deployment, $Cadence, $Keystore, $PasswordFile, $LogDir)
    $restarts = 0
    while ($true) {
        $run = Invoke-KeeperOnce
        if ($run.StopAsked) {
            Write-Log 'stopped on request'
            return 0
        }
        $code = [int]$run.Code
        if ($code -eq 0) {
            Write-Log 'the keeper exited normally (code 0): not restarting'
            return 0
        }
        if ($code -eq $ExitKeeperStopped) {
            Write-Log ('THE KEEPER STOPPED ITSELF (exit code {0}): its last lines above say why. Not restarting: fix the cause, then start the supervisor again.' -f $code)
            return $ExitKeeperStopped
        }
        if ($code -eq $ExitUsage) {
            Write-Log 'the keeper refused its command line (exit code 2): not restarting'
            return $ExitUsage
        }
        if ($run.Seconds -ge $StableRunSeconds) { $restarts = 0 }
        $restarts++
        $delay = [int][Math]::Min($MaxRestartSeconds, $FirstRestartSeconds * [Math]::Pow(2, $restarts - 1))
        Write-Log ('the keeper exited with code {0} after {1:N0} s: restarting in {2} s (restart {3} in a row)' -f (Format-Code $code), $run.Seconds, $delay, $restarts)
        if (Wait-OrStop $delay) {
            Write-Log 'a stop was asked for (-Stop): not restarting'
            return 0
        }
        $others = @(Get-KeeperProcesses)
        if ($others.Count -gt 0) {
            foreach ($k in $others) { Write-Log ('NOT RESTARTING: a keeper is already running: PID {0}: {1}' -f $k.ProcessId, $k.CommandLine) }
            return 1
        }
    }
}

# ---- -Stop ----

function Invoke-Stop {
    $held = Read-Lock
    if (-not $held) {
        Write-Host 'No supervisor is running (no lock file).'
        $left = @(Get-KeeperProcesses)
        foreach ($k in $left) { Write-Host ('A keeper this script did not start is running: PID {0}: {1}' -f $k.ProcessId, $k.CommandLine) }
        if ($left.Count -gt 0) {
            Write-Host 'Stop it where it was started (Ctrl-C in its window), or end it and its parents: Stop-Process -Id <PID>'
            return 1
        }
        return 0
    }
    if (-not $Deployment) { $script:Deployment = [string](Get-Field $held 'deployment') }
    $keeper = @(Get-Field $held 'keeper' | Where-Object { $_ } | ForEach-Object { [pscustomobject]@{ Id = [int]$_.id; Name = [string]$_.name; Started = [string]$_.started } })
    $supervisor = Get-Field $held 'supervisorPid'
    if (Test-LockHolder $held) {
        Set-Content -LiteralPath $StopFile -Value ('stop asked by PID {0} at {1}' -f $PID, (Get-Date -Format 'o')) -Encoding ASCII
        Write-Log ('asked the supervisor (PID {0}) to stop' -f $supervisor)
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline -and (Test-LockHolder $held)) { Start-Sleep -Milliseconds 500 }
        if (Test-LockHolder $held) {
            Write-Log ('the supervisor (PID {0}) did not stop within 30 s: ending it and the keeper' -f $supervisor)
            [void](Stop-Tree $keeper)
            Stop-Process -Id ([int]$supervisor) -Force -Confirm:$false -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
        }
    } else {
        Write-Log ('the lock is stale: its supervisor (PID {0}) is gone; ending any keeper it left running' -f $supervisor)
        [void](Stop-Tree $keeper)
        Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
    $left = @(Get-KeeperProcesses)
    foreach ($k in $left) { Write-Host ('STILL RUNNING: a keeper, PID {0}: {1}' -f $k.ProcessId, $k.CommandLine) }
    if ($left.Count -gt 0) { return 1 }
    Write-Host 'Stopped: no keeper is running.'
    return 0
}

# ---- -DryRun ----

function Invoke-DryRun {
    $exists = { param($Path) if (Test-Path -LiteralPath $Path) { 'exists' } else { 'MISSING' } }
    $pnpm = Get-Pnpm
    Write-Host 'keeper-supervised.ps1 -DryRun: nothing is started, stopped or written.'
    Write-Host ''
    Write-Host ('It would run, in {0}:' -f $OpsDir)
    Write-Host ('  {0} {1}' -f $Shell, $ShellArguments)
    Write-Host ('  (pnpm: {0})' -f $(if ($pnpm) { $pnpm.Path } else { 'NOT FOUND on PATH' }))
    Write-Host 'with these variables set for it alone (the files are passed by path, never opened here):'
    Write-Host ('  OPS_DEPLOYMENT={0}' -f $Deployment)
    Write-Host ('  OPS_KEEPER_KEYSTORE={0}  ({1})' -f $Keystore, (& $exists $Keystore))
    Write-Host ('  OPS_KEEPER_PASSWORD_FILE={0}  ({1})' -f $PasswordFile, (& $exists $PasswordFile))
    Write-Host ('  OPS_CADENCE={0}' -f $Cadence)
    if ($Deployment) { Write-Host ('Deployment record: {0}  ({1})' -f (Get-RecordPath), (& $exists (Get-RecordPath))) }
    Write-Host ('Log: {0}  (one file a day, by its name)' -f (Get-LogPath))
    $held = Read-Lock
    $lockState = if (-not (Test-Path -LiteralPath $LockFile)) { 'free' } elseif (Test-LockHolder $held) { 'HELD by a running supervisor, PID ' + (Get-Field $held 'supervisorPid') } else { 'stale (its supervisor is gone): a start would take it over' }
    Write-Host ('Lock: {0}  ({1})' -f $LockFile, $lockState)
    Write-Host ('On exit: code 0 (ended), 2 (usage) or 3 (the keeper stopped itself) is not restarted; any other code restarts it after {0} s, doubling to at most {1} s; a run of {2} min or more resets the delay.' -f $FirstRestartSeconds, $MaxRestartSeconds, ($StableRunSeconds / 60))
    Write-Host ('Stop: Ctrl-C in its window, or: {0} -Stop' -f $PSCommandPath)
    Write-Host ''
    $problems = Get-StartProblems
    $all = @($problems.Running) + @($problems.Usage)
    if ($all.Count -eq 0) {
        Write-Host 'Self-check passed: a real start would go ahead.'
        return 0
    }
    Write-Host 'A real start would REFUSE:'
    foreach ($p in $all) { Write-Host ('  - {0}' -f $p) }
    return 1
}

# ---- main ----

# The mode asked for. Whatever ends it (a return, an error, or Ctrl-C, which still runs `finally`), the
# keeper's tree is ended and the lock released.
function Invoke-Main {
    $code = 1
    try {
        if ($Stop) {
            $code = Invoke-Stop
        } elseif ($DryRun) {
            $code = Invoke-DryRun
        } else {
            $code = Invoke-Supervisor
        }
        $script:Finished = $true
    } catch {
        Write-Log ('supervisor error: {0}' -f $_.Exception.Message)
        $code = 1
        $script:Finished = $true
    } finally {
        if (-not $script:Finished) { Write-Log 'interrupted (Ctrl-C, or the window closed): ending the keeper' }
        if ($script:Tree.Count -gt 0) { [void](Stop-KeeperTree) }
        Exit-Lock
    }
    return $code
}

# Dot-sourced (. .\keeper-supervised.ps1), it only defines its functions, to check them by hand
if ($MyInvocation.InvocationName -eq '.') { return }
exit (Invoke-Main)
