param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs
)

$ErrorActionPreference = "Stop"

$ProjectRoot = $env:INDICATOR_PROJECT_ROOT
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = "D:\Code\Tauri\indicator"
}
$StateDir = Join-Path $ProjectRoot "state"
$LogsDir = Join-Path $ProjectRoot "logs"
$StatusPath = Join-Path $StateDir "status.json"
$EventsPath = Join-Path $StateDir "events.jsonl"
$LogPath = Join-Path $LogsDir "indicator.log"

function ConvertFrom-CodePoints {
    param([int[]]$CodePoints)

    return -join ($CodePoints | ForEach-Object { [char]$_ })
}

function Get-JsonProperty {
    param(
        [object]$Object,
        [string[]]$Names
    )

    if ($null -eq $Object) {
        return $null
    }

    $properties = $Object.PSObject.Properties
    foreach ($name in $Names) {
        $property = $properties[$name]
        if ($null -ne $property) {
            return $property.Value
        }
    }

    return $null
}

function ConvertTo-ShortText {
    param(
        [object]$Value,
        [int]$MaxLength = 360
    )

    if ($null -eq $Value) {
        return ""
    }

    if ($Value -is [System.Array]) {
        $Value = ($Value | Where-Object { $null -ne $_ }) -join " "
    } elseif (-not ($Value -is [string])) {
        $Value = $Value | ConvertTo-Json -Compress -Depth 16
    }

    $text = ([string]$Value -replace "\s+", " ").Trim()
    if ($text.Length -le $MaxLength) {
        return $text
    }

    return $text.Substring(0, [Math]::Max(0, $MaxLength - 3)) + "..."
}

function Read-EventJson {
    param([string[]]$PayloadArgs)

    if ($PayloadArgs.Count -gt 0) {
        return ($PayloadArgs -join " ")
    }

    try {
        if ([Console]::IsInputRedirected) {
            return [Console]::In.ReadToEnd()
        }
    } catch {
        return ""
    }

    return ""
}

function ConvertFrom-EventJson {
    param([string]$Json)

    if ([string]::IsNullOrWhiteSpace($Json)) {
        return $null
    }

    try {
        return $Json | ConvertFrom-Json -Depth 32
    } catch [System.Management.Automation.ParameterBindingException] {
        return $Json | ConvertFrom-Json
    }
}

function ConvertFrom-NotifyText {
    param([string]$Text)

    $detail = ConvertTo-ShortText $Text
    if ([string]::IsNullOrWhiteSpace($detail)) {
        return $null
    }

    if ($detail -match "\bagent-turn-complete\b") {
        return [pscustomobject]@{
            type = "agent-turn-complete"
            source = "codex"
            detail = $detail
        }
    }

    return [pscustomobject]@{
        type = "notify"
        source = "codex"
        detail = $detail
    }
}

function ConvertFrom-EventInput {
    param([string]$InputText)

    if ([string]::IsNullOrWhiteSpace($InputText)) {
        return $null
    }

    $trimmed = $InputText.Trim()
    if ($trimmed.StartsWith("{") -or $trimmed.StartsWith("[")) {
        try {
            return ConvertFrom-EventJson $trimmed
        } catch {
            return $null
        }
    }

    return ConvertFrom-NotifyText $trimmed
}

function Get-Timestamp {
    return (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
}

function Get-Encoding {
    return New-Object System.Text.UTF8Encoding($false)
}

function Ensure-StateDirectories {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
}

function Write-LogLine {
    param([string]$Message)

    try {
        Ensure-StateDirectories
        $line = "[{0}] {1}{2}" -f (Get-Timestamp), $Message, [Environment]::NewLine
        [System.IO.File]::AppendAllText($LogPath, $line, (Get-Encoding))
    } catch {
    }
}

function Write-JsonAtomic {
    param(
        [string]$Path,
        [object]$Value
    )

    $json = $Value | ConvertTo-Json -Compress -Depth 16
    $tempPath = "{0}.{1}.tmp" -f $Path, $PID
    [System.IO.File]::WriteAllText($tempPath, $json, (Get-Encoding))
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
}

function Add-JsonLine {
    param(
        [string]$Path,
        [object]$Value
    )

    $json = $Value | ConvertTo-Json -Compress -Depth 16
    [System.IO.File]::AppendAllText($Path, $json + [Environment]::NewLine, (Get-Encoding))
}

$TextWaiting = ConvertFrom-CodePoints @(67, 111, 100, 101, 120, 32, 27491, 22312, 31561, 24453, 25209, 20934)
$TextDone = ConvertFrom-CodePoints @(67, 111, 100, 101, 120, 32, 24050, 23436, 25104)
$TextError = ConvertFrom-CodePoints @(67, 111, 100, 101, 120, 32, 21457, 29983, 38169, 35823)
$TextInterrupted = ConvertFrom-CodePoints @(67, 111, 100, 101, 120, 32, 24050, 20013, 26029)
$TextEvent = ConvertFrom-CodePoints @(67, 111, 100, 101, 120, 32, 20107, 20214)

function Get-EventType {
    param([object]$Event)

    return Get-JsonProperty $Event @("type", "hook_event_name", "hook-event-name")
}

function Get-EventDetail {
    param([object]$Event)

    $directDetail = Get-JsonProperty $Event @("detail")
    $toolInput = Get-JsonProperty $Event @("tool_input", "tool-input")
    $description = Get-JsonProperty $toolInput @("description")
    $command = Get-JsonProperty $toolInput @("command")
    $toolName = Get-JsonProperty $Event @("tool_name", "tool-name")
    $lastMessage = Get-JsonProperty $Event @("last_assistant_message", "last-assistant-message")
    $inputMessages = Get-JsonProperty $Event @("input_messages", "input-messages")
    $cwd = Get-JsonProperty $Event @("cwd")
    $errorValue = Get-JsonProperty $Event @("error", "last_error", "exception", "failure")

    foreach ($value in @($directDetail, $description, $command, $toolName, $lastMessage, $inputMessages, $cwd, $errorValue)) {
        $text = ConvertTo-ShortText $value
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            return $text
        }
    }

    return ""
}

function ConvertTo-StatusRecord {
    param([object]$Event)

    $eventType = Get-EventType $Event
    $source = Get-JsonProperty $Event @("source")
    if ([string]::IsNullOrWhiteSpace($source)) {
        $source = "codex"
    }
    $detail = Get-EventDetail $Event
    $statusValue = ConvertTo-ShortText (Get-JsonProperty $Event @("status"))
    $hasError = -not [string]::IsNullOrWhiteSpace((ConvertTo-ShortText (Get-JsonProperty $Event @("error", "last_error", "exception", "failure"))))

    if ($eventType -eq "PermissionRequest") {
        return [ordered]@{
            Status = "waiting"
            Source = $source
            Event = $eventType
            Summary = $TextWaiting
            Detail = $detail
            WriteStatus = $true
        }
    }

    if ($eventType -eq "Stop" -or $eventType -eq "agent-turn-complete") {
        return [ordered]@{
            Status = "done"
            Source = $source
            Event = $eventType
            Summary = $TextDone
            Detail = $detail
            WriteStatus = $true
        }
    }

    if ($eventType -eq "StopFailure" -or $eventType -eq "interrupted" -or $eventType -eq "user-interrupted") {
        return [ordered]@{
            Status = "interrupted"
            Source = $source
            Event = $eventType
            Summary = $TextInterrupted
            Detail = $detail
            WriteStatus = $true
        }
    }

    if ($hasError -or $statusValue -eq "error" -or $eventType -eq "Error" -or $eventType -eq "agent-turn-error") {
        return [ordered]@{
            Status = "error"
            Source = $source
            Event = $eventType
            Summary = $TextError
            Detail = $detail
            WriteStatus = $true
        }
    }

    return [ordered]@{
        Status = "idle"
        Source = $source
        Event = $eventType
        Summary = $TextEvent
        Detail = $detail
        WriteStatus = $false
    }
}

try {
    $rawJson = Read-EventJson $ScriptArgs
    $event = ConvertFrom-EventInput $rawJson
    if ($null -eq $event) {
        exit 0
    }

    Ensure-StateDirectories
    $record = ConvertTo-StatusRecord $event
    $timestamp = Get-Timestamp
    $eventLine = [ordered]@{
        status = $record.Status
        source = $record.Source
        event = $record.Event
        summary = $record.Summary
        detail = $record.Detail
        createdAt = $timestamp
    }

    Add-JsonLine -Path $EventsPath -Value $eventLine

    if ($record.WriteStatus) {
        $status = [ordered]@{
            status = $record.Status
            source = $record.Source
            event = $record.Event
            summary = $record.Summary
            detail = $record.Detail
            updatedAt = $timestamp
            ttlMs = 0
        }
        Write-JsonAtomic -Path $StatusPath -Value $status
    }
} catch {
    Write-LogLine ("bridge failed: {0}" -f $_.Exception.Message)
}

exit 0
