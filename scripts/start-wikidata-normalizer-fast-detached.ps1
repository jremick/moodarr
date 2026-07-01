param(
  [string]$Root = "F:\moodarr-wikidata",
  [string]$SourceVersion = "wikidata-dump-2026-06-30-fast-min5",
  [int]$MinSitelinks = 5,
  [int]$ProgressInterval = 1000000,
  [string]$RunName = "fast-min5",
  [string]$ClassIndex = "",
  [int]$Workers = 8,
  [int]$BatchSize = 250,
  [int]$QueueBatches = 8,
  [int]$OutputGzipLevel = 1,
  [string]$Decompressor = "auto",
  [int]$DecompressorWorkers = 0,
  [int]$MaxEntities = 0,
  [int]$LimitMedia = 0,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$runner = Join-Path $Root "run-wikidata-normalizer-fast.ps1"
$arguments = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$runner`"",
  "-RunName", "`"$RunName`"",
  "-SourceVersion", "`"$SourceVersion`"",
  "-MinSitelinks", "$MinSitelinks",
  "-ProgressInterval", "$ProgressInterval",
  "-Workers", "$Workers",
  "-BatchSize", "$BatchSize",
  "-QueueBatches", "$QueueBatches",
  "-OutputGzipLevel", "$OutputGzipLevel",
  "-Decompressor", "`"$Decompressor`"",
  "-DecompressorWorkers", "$DecompressorWorkers"
)

if (-not [string]::IsNullOrWhiteSpace($ClassIndex)) {
  $arguments += @("-ClassIndex", "`"$ClassIndex`"")
}
if ($MaxEntities -gt 0) {
  $arguments += @("-MaxEntities", "$MaxEntities")
}
if ($LimitMedia -gt 0) {
  $arguments += @("-LimitMedia", "$LimitMedia")
}
if ($Force) {
  $arguments += "-Force"
}

$commandLine = "powershell.exe " + ($arguments -join " ")
$result = Invoke-CimMethod `
  -ClassName Win32_Process `
  -MethodName Create `
  -Arguments @{
    CommandLine = $commandLine
    CurrentDirectory = $Root
  }

if ($result.ReturnValue -ne 0) {
  throw "Failed to start fast normalizer process. Win32_Process.Create returned $($result.ReturnValue)."
}

[pscustomobject]@{
  processId = $result.ProcessId
  runName = $RunName
  commandLine = $commandLine
} | ConvertTo-Json -Depth 3
