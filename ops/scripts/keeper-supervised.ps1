<#
.SYNOPSIS
  Runs Cascade's keeper (pnpm ops run --live) unattended, and restarts it when it crashes.

.DESCRIPTION
  Starts `pnpm ops run --live` in ops/ for one deployment, with the keeper's keystore and password
  file. This script passes their paths only: it never opens either file. Every line the keeper prints
  goes, with a timestamp, to ops/logs/keeper-<deployment>-<yyyy-MM-dd>.log (a new file each day).

  When the keeper exits:
    3          with its line "THE KEEPER STOPPED ITSELF": it stopped on something that needs a person
               (the keeper wallet holding code, a wrong key, a record that changed or isn't verified,
               a revert nothing explains, another keeper running): not restarted. Its last lines in
               the log say why.
    2          with its usage text: a usage error: not restarted.
    0          it ended normally: not restarted.
    any other  a crash (a 3 or 2 without that line too: cmd's or pnpm's own): restarted after 10 s,
               then 20 s, 40 s, ... at most 5 minutes. A keeper that ran for 10 minutes or more starts
               the count again.

  It refuses to start while another keeper runs: a node process whose command line runs cli.ts with
  `run` (a keeper started by hand counts), or another supervisor holding ops/logs/keeper.lock. A lock
  whose supervisor is gone is stale, and is taken over unless a keeper it started still runs. A keeper
  is never started without that check succeeding: a failed check (WMI) is tried again until it works.

  Stop it with Ctrl-C in its window, or from any PowerShell window with -Stop. Either way the keeper's
  whole process tree is ended: Windows would otherwise leave the keeper's node process running. Ending
  the keeper's node.exe by hand is a crash, so the supervisor would start it again: use -Stop.

  It runs the keeper from the working tree it sits in, at each start and restart: keep the branch you
  mean to run (main) checked out while it runs.

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
# pnpm ops run's exit codes (ops/src/keeper/actions.ts KEEPER_STOPPED; a usage error in ops/src/cli.ts),
# and the lines that prove them its own (STOPPED_BANNER; the start of USAGE in ops/src/args.ts)
$ExitKeeperStopped = 3
$StoppedBanner = 'THE KEEPER STOPPED ITSELF'
$ExitUsage = 2
$UsageLine = 'usage: pnpm ops'
# A run at least this long resets the restart delay
$StableRunSeconds = 600
# How long to wait before trying a failed process check again
$CheckRetrySeconds = 10
# Two start times of one process, read through WMI and through Get-Process, differ by less than 1 ms
$SameStartTicks = 10000
$EventPrefix = 'cascade-keeper-'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

$script:LockStream = $null
# Every process of the keeper's tree seen so far (cmd, pnpm's node, the keeper's node), in the order found
$script:Tree = @()
$script:Finished = $false
$script:LogBroken = $false
# What the current run of the keeper printed: its stop line, its usage text
$script:SawBanner = $false
$script:SawUsage = $false

# ---- logging ----

function Get-LogPath {
    $name = if ($Deployment) { $Deployment } else { 'supervisor' }
    return (Join-Path $LogDir ('keeper-{0}-{1}.log' -f $name, (Get-Date -Format 'yyyy-MM-dd')))
}

# One line, timestamped, to the console and (unless -DryRun) to today's log file. Never throws: a log
# that can't be written (a full disk, a locked file) leaves the line on the console only.
function Write-Log([string]$Line, [string]$From = 'supervisor') {
    $stamped = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'), $From, $Line
    if (-not $DryRun) {
        try {
            if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
            [System.IO.File]::AppendAllText((Get-LogPath), $stamped + [Environment]::NewLine, $Utf8)
            $script:LogBroken = $false
        } catch {
            if (-not $script:LogBroken) {
                $script:LogBroken = $true
                try { Write-Host ('{0} [supervisor] could not write the log ({1}): lines go to this console only until it can' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'), $_.Exception.Message) } catch { }
            }
        }
    }
    try { Write-Host $stamped } catch { }
}

# ---- processes ----

function Get-Ticks($Date) { return [string]$Date.ToUniversalTime().Ticks }

# Whether two recorded start times (ticks) are one process's: WMI and Get-Process differ by under 1 ms
function Test-SameStart([string]$A, [string]$B) {
    try { return ([Math]::Abs([long]$A - [long]$B) -lt $SameStartTicks) } catch { return $false }
}

# Whether the process an entry ({ Id, Started }) names still runs as itself. Get-Process, not WMI.
function Test-EntryAlive($Entry) {
    try {
        $p = Get-Process -Id ([int]$Entry.Id) -ErrorAction Stop
        return (Test-SameStart (Get-Ticks $p.StartTime) ([string]$Entry.Started))
    } catch {
        return $false
    }
}

function Get-AllProcesses { return @(Get-CimInstance -ClassName Win32_Process) }

# A keeper: node running ops' cli.ts with the run command (pnpm's own node process names no cli.ts)
function Test-KeeperCommandLine([string]$CommandLine) {
    if (-not $CommandLine) { return $false }
    return (($CommandLine -match 'cli\.ts') -and ($CommandLine -match '(^|[\s"''])run([\s"'']|$)'))
}

# The keepers running now (WMI: throws when it can't be read)
function Get-KeeperProcesses {
    return @(Get-AllProcesses | Where-Object { $_.Name -eq 'node.exe' -and (Test-KeeperCommandLine $_.CommandLine) })
}

# The keepers running now, the check tried again every CheckRetrySeconds until it works: a keeper is never
# started on a check that failed. $null when a stop is asked for meanwhile.
function Get-KeeperProcessesChecked {
    while ($true) {
        try {
            return , @(Get-KeeperProcesses)
        } catch {
            Write-Log ('could not check for a running keeper ({0}): trying again in {1} s; nothing starts until it works' -f $_.Exception.Message, $CheckRetrySeconds)
            if (Wait-OrStop $CheckRetrySeconds) { return $null }
        }
    }
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
# stays on the list), and records it in the lock for -Stop. Throws when WMI or the lock can't be written.
function Update-Tree([int]$RootId) {
    $added = $false
    foreach ($t in (Get-ProcessTree $RootId)) {
        $known = @($script:Tree | Where-Object { [int]$_.Id -eq $t.Id -and (Test-SameStart ([string]$_.Started) $t.Started) })
        if ($known.Count -eq 0) {
            $script:Tree += $t
            $added = $true
        }
    }
    if ($added) { Update-Lock }
}

# Update-Tree, never fatal: a passing WMI or disk error is logged, and the keeper runs on
function Update-TreeSafely([int]$RootId) {
    try {
        Update-Tree $RootId
    } catch {
        Write-Log ('could not read the keeper''s process tree ({0}): the keeper runs on; trying again shortly' -f $_.Exception.Message)
    }
}

# Ends each process of `Tree` still running as itself (same id and start time), last found first, and
# returns those still running after (none, normally). Never throws.
function Stop-Tree([object[]]$Tree) {
    if (-not $Tree -or $Tree.Count -eq 0) { return , @() }
    for ($i = $Tree.Count - 1; $i -ge 0; $i--) {
        $t = $Tree[$i]
        if (-not (Test-EntryAlive $t)) { continue }
        try {
            Stop-Process -Id ([int]$t.Id) -Force -Confirm:$false -ErrorAction Stop
            Write-Log ('ended {0} (PID {1})' -f $t.Name, $t.Id)
        } catch {
            # a parent often exits by itself once its child is ended: only one still running is a problem
            if (Test-EntryAlive $t) { Write-Log ('could not end {0} (PID {1}): {2}' -f $t.Name, $t.Id, $_.Exception.Message) }
        }
    }
    return , @($Tree | Where-Object { Test-EntryAlive $_ })
}

# Ends the keeper's whole tree: everything seen so far, and whatever its first process (cmd) has
# started since. What can't be ended stays on the list, for the next try. Never throws.
function Stop-KeeperTree {
    if ($script:Tree.Count -gt 0) { Update-TreeSafely ([int]$script:Tree[0].Id) }
    $left = Stop-Tree $script:Tree
    $script:Tree = @($left | Where-Object { $_ })
    try { Update-Lock } catch { }
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

# The keeper tree a lock records, as { Id, Name, Started }
function Get-LockTree($Lock) {
    return @(Get-Field $Lock 'keeper' | Where-Object { $_ } | ForEach-Object { [pscustomobject]@{ Id = [int]$_.id; Name = [string]$_.name; Started = [string]$_.started } })
}

# Whether the supervisor a lock names is still running: the same process id and start time
function Test-LockHolder($Lock) {
    $id = Get-Field $Lock 'supervisorPid'
    if (-not $id) { return $false }
    return (Test-EntryAlive ([pscustomobject]@{ Id = [int]$id; Started = [string](Get-Field $Lock 'supervisorStarted') }))
}

# What the lock holds: this supervisor, its deployment and log, and the keeper's process tree
function Update-Lock {
    if (-not $script:LockStream) { return }
    $info = [ordered]@{
        supervisorPid = $PID
        supervisorStarted = (Get-Ticks ([System.Diagnostics.Process]::GetCurrentProcess().StartTime))
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
# lock whose supervisor is gone is stale and taken over, unless a keeper it started still runs; a live
# one refuses.
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
        $left = @(Get-LockTree $held | Where-Object { Test-EntryAlive $_ })
        if ($left.Count -gt 0) {
            throw ('the lock is stale, but a keeper its supervisor started still runs ({0}): end it with {1} -Stop, then start again' -f (($left | ForEach-Object { '{0} PID {1}' -f $_.Name, $_.Id }) -join ', '), $PSCommandPath)
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
    try { $script:LockStream.Dispose() } catch { }
    $script:LockStream = $null
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}

# ---- checks ----

function Get-RecordPath { return (Join-Path $OpsDir ('deployments\{0}.json' -f $Deployment)) }

# The lock `pnpm ops run` takes for the deployment (ops/src/keeper/runlock.ts runLockPath)
function Get-RunLockPath { return (Join-Path $OpsDir ('deployments\{0}.run.lock' -f $Deployment)) }

# The pnpm cmd will run: a program on PATH (pnpm.cmd or pnpm.exe), never PowerShell's pnpm.ps1
function Get-Pnpm { return (Get-Command pnpm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1) }

# What stops a real start: `Usage` collects setup problems (exit 2), `Running` another keeper or
# supervisor (exit 1). With -Retry, a failed process check is tried again until it works ($null when a
# stop is asked for meanwhile); without, it is a problem.
function Get-StartProblems([switch]$Retry) {
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
    $keepers = @()
    if ($Retry) {
        $keepers = Get-KeeperProcessesChecked
        if ($null -eq $keepers) { return $null }
    } else {
        try { $keepers = @(Get-KeeperProcesses) } catch { [void]$running.Add(('could not check for a running keeper: {0}' -f $_.Exception.Message)) }
    }
    foreach ($k in $keepers) {
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
        try {
            $line = $e.SourceEventArgs.Data
            if ($null -ne $line) {
                if ($line.StartsWith($StoppedBanner)) { $script:SawBanner = $true }
                if ($line.StartsWith($UsageLine)) { $script:SawUsage = $true }
                Write-Log $line 'keeper'
            }
        } finally {
            Remove-Event -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue
        }
    }
}

# Runs the keeper once, logging its lines, until it exits or a stop is asked for (-Stop). Its exit code,
# how long it ran, whether a stop was asked for, and whether it printed its stop line or usage text.
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
    $script:SawBanner = $false
    $script:SawUsage = $false
    $started = Get-Date
    $result = { param($Code, [bool]$StopAsked) [pscustomobject]@{ Code = $Code; Seconds = ((Get-Date) - $started).TotalSeconds; StopAsked = $StopAsked; SawBanner = $script:SawBanner; SawUsage = $script:SawUsage } }
    try {
        [void]$proc.Start()
        # its first process is known at once, so its tree can always be found and ended
        $script:Tree = @([pscustomobject]@{ Id = $proc.Id; Name = 'cmd.exe'; Started = (Get-Ticks $proc.StartTime) })
        try { Update-Lock } catch { Write-Log ('could not update the lock ({0}): the keeper runs on' -f $_.Exception.Message) }
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()
        Write-Log ('started the keeper (PID {0}): {1}' -f $proc.Id, $KeeperCommand)
        $nextScan = (Get-Date).AddSeconds(3)
        while (-not $proc.HasExited) {
            [void](Wait-Event -Timeout 1)
            Receive-KeeperLines
            if (Test-Path -LiteralPath $StopFile) {
                Write-Log 'a stop was asked for (-Stop): ending the keeper'
                Stop-KeeperTree
                Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
                return (& $result $null $true)
            }
            if ((Get-Date) -ge $nextScan) {
                Update-TreeSafely $proc.Id
                $nextScan = (Get-Date).AddSeconds(15)
            }
        }
        # the rest of its output
        $proc.WaitForExit()
        Receive-KeeperLines
        $code = $proc.ExitCode
        # anything it left running
        Stop-KeeperTree
        return (& $result $code $false)
    } finally {
        Unregister-Event -SourceIdentifier ($EventPrefix + 'out') -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier ($EventPrefix + 'err') -ErrorAction SilentlyContinue
        Get-Event | Where-Object { $_.SourceIdentifier -like ($EventPrefix + '*') } | Remove-Event -ErrorAction SilentlyContinue
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

# A run lock (deployments/<name>.run.lock) left by a keeper that was ended. Called only right after a
# check found no keeper running, so no process holds it. (The keeper takes over one whose PID is gone by
# itself; this also clears one whose PID Windows has since given to another process.)
function Clear-StaleRunLock {
    $path = Get-RunLockPath
    if (-not (Test-Path -LiteralPath $path)) { return }
    try {
        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
        Write-Log ('removed a stale run lock, {0}: no keeper is running' -f $path)
    } catch {
        Write-Log ('could not remove the stale run lock {0} ({1}): the keeper says whether it can start' -f $path, $_.Exception.Message)
    }
}

# Logs and refuses when `Keepers` lists any; true when it does
function Test-OtherKeepers([object[]]$Keepers, [string]$What) {
    if (-not $Keepers -or $Keepers.Count -eq 0) { return $false }
    foreach ($k in $Keepers) { Write-Log ('{0}: a keeper is already running: PID {1}: {2}' -f $What, $k.ProcessId, $k.CommandLine) }
    Write-Log 'Never run two keepers at once: stop the other one first (see "Running the keeper unattended" in ops/LAUNCH-SETTINGS.md).'
    return $true
}

function Invoke-Supervisor {
    $problems = Get-StartProblems -Retry
    if ($null -eq $problems) {
        Write-Log 'a stop was asked for before the start: not starting'
        return 0
    }
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
    # a keeper started by hand while the lock was being taken
    $others = Get-KeeperProcessesChecked
    if ($null -eq $others) { return 0 }
    if (Test-OtherKeepers $others 'REFUSING TO START') { return 1 }
    Write-Log ('supervising the keeper for {0} (OPS_CADENCE={1}, keystore {2}, password file {3}); logs in {4}' -f $Deployment, $Cadence, $Keystore, $PasswordFile, $LogDir)
    $restarts = 0
    while ($true) {
        # every start follows a check that found no keeper running
        Clear-StaleRunLock
        $run = Invoke-KeeperOnce
        if ($run.StopAsked) {
            Write-Log 'stopped on request'
            return 0
        }
        $code = [int]$run.Code
        if ($code -eq $ExitKeeperStopped -and $run.SawBanner) {
            Write-Log ('THE KEEPER STOPPED ITSELF (exit code {0}): its last lines above say why. Not restarting: fix the cause, then start the supervisor again.' -f $code)
            return $ExitKeeperStopped
        }
        if ($code -eq $ExitUsage -and $run.SawUsage) {
            Write-Log 'the keeper refused its command line (exit code 2): not restarting'
            return $ExitUsage
        }
        if ($code -eq 0) {
            Write-Log 'the keeper exited normally (code 0): not restarting'
            return 0
        }
        if ($code -eq $ExitKeeperStopped -or $code -eq $ExitUsage) {
            Write-Log ('exit code {0} came without the keeper''s own line saying why (cmd''s or pnpm''s own code): taken for a crash' -f $code)
        }
        if ($run.Seconds -ge $StableRunSeconds) { $restarts = 0 }
        $restarts++
        $delay = [int][Math]::Min($MaxRestartSeconds, $FirstRestartSeconds * [Math]::Pow(2, $restarts - 1))
        Write-Log ('the keeper exited with code {0} after {1:N0} s: restarting in {2} s (restart {3} in a row)' -f (Format-Code $code), $run.Seconds, $delay, $restarts)
        if (Wait-OrStop $delay) {
            Write-Log 'a stop was asked for (-Stop): not restarting'
            return 0
        }
        $others = Get-KeeperProcessesChecked
        if ($null -eq $others) {
            Write-Log 'a stop was asked for (-Stop): not restarting'
            return 0
        }
        if (Test-OtherKeepers $others 'NOT RESTARTING') { return 1 }
    }
}

# ---- -Stop ----

# Waits up to `Seconds` for `Gone` to say true
function Wait-Until([scriptblock]$Gone, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline -and -not (& $Gone)) { Start-Sleep -Milliseconds 500 }
    return (& $Gone)
}

function Invoke-Stop {
    $held = Read-Lock
    # the supervisor rewrites its lock now and then: a read that caught it mid-write is tried once more
    if (-not $held -and (Test-Path -LiteralPath $LockFile)) {
        Start-Sleep -Milliseconds 500
        $held = Read-Lock
    }
    if (-not $held -and (Test-Path -LiteralPath $LockFile)) {
        # still unreadable: ask anyway (the supervisor watches for the stop file), and wait for its lock to go
        Set-Content -LiteralPath $StopFile -Value ('stop asked by PID {0} at {1}' -f $PID, (Get-Date -Format 'o')) -Encoding ASCII
        Write-Host ('{0} can''t be read: asked whichever supervisor holds it to stop' -f $LockFile)
        if (-not (Wait-Until { -not (Test-Path -LiteralPath $LockFile) } 30)) {
            Write-Host 'The supervisor did not stop within 30 s: end the powershell.exe running keeper-supervised.ps1 (Task Manager, Details), then run -Stop again: it then ends the keeper it leaves.'
            return 1
        }
        $held = $null
    } elseif (-not $held) {
        Write-Host 'No supervisor is running (no lock file).'
    } else {
        if (-not $Deployment) { $script:Deployment = [string](Get-Field $held 'deployment') }
        $keeper = Get-LockTree $held
        $supervisor = Get-Field $held 'supervisorPid'
        if (Test-LockHolder $held) {
            Set-Content -LiteralPath $StopFile -Value ('stop asked by PID {0} at {1}' -f $PID, (Get-Date -Format 'o')) -Encoding ASCII
            Write-Log ('asked the supervisor (PID {0}) to stop' -f $supervisor)
            if (-not (Wait-Until { -not (Test-LockHolder $held) } 30)) {
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
    }
    Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
    $left = @()
    try { $left = @(Get-KeeperProcesses) } catch { Write-Host ('Could not check for a keeper still running ({0}): check by hand (see ops/LAUNCH-SETTINGS.md).' -f $_.Exception.Message); return 1 }
    foreach ($k in $left) { Write-Host ('STILL RUNNING: a keeper this script did not start, PID {0}: {1}' -f $k.ProcessId, $k.CommandLine) }
    if ($left.Count -gt 0) {
        Write-Host 'Stop it where it was started (Ctrl-C in its window), or end it: Stop-Process -Id <PID>'
        return 1
    }
    Write-Host 'Stopped: no keeper is running.'
    return 0
}

# ---- -DryRun ----

function Invoke-DryRun {
    $exists = { param($Path) if (Test-Path -LiteralPath $Path) { 'exists' } else { 'MISSING' } }
    $pnpm = Get-Pnpm
    Write-Host 'keeper-supervised.ps1 -DryRun: nothing is started, stopped or written.'
    Write-Host ''
    Write-Host ('It would run, in {0} (the working tree as it is at each start: keep main checked out):' -f $OpsDir)
    Write-Host ('  {0} {1}' -f $Shell, $ShellArguments)
    Write-Host ('  (pnpm: {0})' -f $(if ($pnpm) { $pnpm.Path } else { 'NOT FOUND on PATH' }))
    Write-Host 'with these variables set for it alone (the files are passed by path, never opened here):'
    Write-Host ('  OPS_DEPLOYMENT={0}' -f $Deployment)
    Write-Host ('  OPS_KEEPER_KEYSTORE={0}  ({1})' -f $Keystore, (& $exists $Keystore))
    Write-Host ('  OPS_KEEPER_PASSWORD_FILE={0}  ({1})' -f $PasswordFile, (& $exists $PasswordFile))
    Write-Host ('  OPS_CADENCE={0}' -f $Cadence)
    if ($Deployment) {
        Write-Host ('Deployment record: {0}  ({1})' -f (Get-RecordPath), (& $exists (Get-RecordPath)))
        $runLock = if (Test-Path -LiteralPath (Get-RunLockPath)) { 'present: removed before a start once no keeper is found running' } else { 'absent' }
        Write-Host ('Run lock: {0}  ({1})' -f (Get-RunLockPath), $runLock)
    }
    Write-Host ('Log: {0}  (one file a day, by its name)' -f (Get-LogPath))
    $held = Read-Lock
    $lockState = if (-not (Test-Path -LiteralPath $LockFile)) { 'free' } elseif (Test-LockHolder $held) { 'HELD by a running supervisor, PID ' + (Get-Field $held 'supervisorPid') } else { 'stale (its supervisor is gone): a start would take it over' }
    Write-Host ('Lock: {0}  ({1})' -f $LockFile, $lockState)
    Write-Host ('On exit: 3 with the keeper''s own stop line, 2 with its usage text, or 0, is not restarted; any other exit restarts it after {0} s, doubling to at most {1} s; a run of {2} min or more resets the delay.' -f $FirstRestartSeconds, $MaxRestartSeconds, ($StableRunSeconds / 60))
    Write-Host ('Stop: Ctrl-C in its window, or: {0} -Stop  (never by ending node.exe: that is a crash, and it restarts)' -f $PSCommandPath)
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
# keeper's tree is ended and the lock released; no failing log write or process read can skip that.
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
        try { if ($script:Tree.Count -gt 0) { Stop-KeeperTree } } catch { try { Write-Host ('could not end the keeper''s tree: {0}' -f $_.Exception.Message) } catch { } }
        try { Exit-Lock } catch { }
    }
    return $code
}

# Dot-sourced (. .\keeper-supervised.ps1), it only defines its functions, to check them by hand
if ($MyInvocation.InvocationName -eq '.') { return }
exit (Invoke-Main)
