param(
  [string]$Root = "/mnt/f/moodarr-wikidata",
  [string]$SourceVersion = "wikidata-dump-2026-06-30-fast-lbzip2-min5",
  [int]$MinSitelinks = 5,
  [int]$ProgressInterval = 1000000,
  [string]$RunName = "fast-lbzip2-min5",
  [string]$ClassIndex = "",
  [int]$Workers = 12,
  [int]$BatchSize = 500,
  [int]$QueueBatches = 16,
  [int]$OutputGzipLevel = 1,
  [string]$Decompressor = "lbzip2",
  [int]$DecompressorWorkers = 16,
  [int]$MaxEntities = 0,
  [int]$LimitMedia = 0,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$script = "$Root/run-wikidata-normalizer-fast-wsl.sh"
$runnerArguments = @(
  "--root", $Root,
  "--source-version", $SourceVersion,
  "--min-sitelinks", "$MinSitelinks",
  "--progress-interval", "$ProgressInterval",
  "--run-name", $RunName,
  "--workers", "$Workers",
  "--batch-size", "$BatchSize",
  "--queue-batches", "$QueueBatches",
  "--output-gzip-level", "$OutputGzipLevel",
  "--decompressor", $Decompressor,
  "--decompressor-workers", "$DecompressorWorkers"
)

if (-not [string]::IsNullOrWhiteSpace($ClassIndex)) {
  $runnerArguments += @("--class-index", $ClassIndex)
}
if ($MaxEntities -gt 0) {
  $runnerArguments += @("--max-entities", "$MaxEntities")
}
if ($LimitMedia -gt 0) {
  $runnerArguments += @("--limit-media", "$LimitMedia")
}
if ($Force) {
  $runnerArguments += "--force"
}

$argumentList = @("bash", $script) + $runnerArguments
$commandLine = "wsl.exe " + ($argumentList -join " ")
$result = Invoke-CimMethod `
  -ClassName Win32_Process `
  -MethodName Create `
  -Arguments @{
    CommandLine = $commandLine
    CurrentDirectory = "F:\moodarr-wikidata"
  }

if ($result.ReturnValue -ne 0) {
  throw "Failed to start WSL fast normalizer process. Win32_Process.Create returned $($result.ReturnValue)."
}

[pscustomobject]@{
  processId = $result.ProcessId
  runName = $RunName
  commandLine = $commandLine
} | ConvertTo-Json -Depth 3
