param(
  [string]$Root = "F:\moodarr-wikidata",
  [string]$Python = "C:\Python313\python.exe",
  [string]$SourceVersion = "wikidata-dump-2026-06-30-full-min5",
  [int]$MinSitelinks = 5,
  [int]$ProgressInterval = 1000000,
  [string]$RunName = "full-min5",
  [int]$MaxEntities = 0,
  [int]$LimitMedia = 0
)

$ErrorActionPreference = "Stop"

$dump = Join-Path $Root "latest-all.json.bz2"
$normalizer = Join-Path $Root "normalize-wikidata-dump.py"
$workDir = Join-Path $Root "work\$RunName"
$outDir = Join-Path $Root "out"
$logsDir = Join-Path $Root "logs"
$output = Join-Path $outDir "moodarr-wikidata-catalog-$RunName.jsonl.gz"
$manifest = Join-Path $outDir "moodarr-wikidata-catalog-$RunName.manifest.json"
$outLog = Join-Path $logsDir "$RunName.out.log"
$errLog = Join-Path $logsDir "$RunName.err.log"

New-Item -ItemType Directory -Force -Path $workDir, $outDir, $logsDir | Out-Null

$normalizerArgs = @(
  $normalizer,
  "--dump", $dump,
  "--work-dir", $workDir,
  "--output", $output,
  "--manifest", $manifest,
  "--source-version", $SourceVersion,
  "--min-sitelinks", "$MinSitelinks",
  "--progress-interval", "$ProgressInterval"
)

if ($MaxEntities -gt 0) {
  $normalizerArgs += @("--max-entities", "$MaxEntities")
}
if ($LimitMedia -gt 0) {
  $normalizerArgs += @("--limit-media", "$LimitMedia")
}

$process = Start-Process `
  -FilePath $Python `
  -ArgumentList $normalizerArgs `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -Wait `
  -PassThru

exit $process.ExitCode
