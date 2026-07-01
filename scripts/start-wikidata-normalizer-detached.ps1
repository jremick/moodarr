param(
  [string]$Root = "F:\moodarr-wikidata",
  [string]$SourceVersion = "wikidata-dump-2026-06-30-full-min5",
  [int]$MinSitelinks = 5,
  [int]$ProgressInterval = 1000000,
  [string]$RunName = "full-min5",
  [int]$MaxEntities = 0,
  [int]$LimitMedia = 0
)

$ErrorActionPreference = "Stop"

$runner = Join-Path $Root "run-wikidata-normalizer.ps1"
$arguments = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$runner`"",
  "-RunName", "`"$RunName`"",
  "-SourceVersion", "`"$SourceVersion`"",
  "-MinSitelinks", "$MinSitelinks",
  "-ProgressInterval", "$ProgressInterval"
)

if ($MaxEntities -gt 0) {
  $arguments += @("-MaxEntities", "$MaxEntities")
}
if ($LimitMedia -gt 0) {
  $arguments += @("-LimitMedia", "$LimitMedia")
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
  throw "Failed to start normalizer process. Win32_Process.Create returned $($result.ReturnValue)."
}

[pscustomobject]@{
  processId = $result.ProcessId
  runName = $RunName
  commandLine = $commandLine
} | ConvertTo-Json -Depth 3
