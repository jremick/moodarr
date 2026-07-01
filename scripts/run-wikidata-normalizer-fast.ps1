param(
  [string]$Root = "F:\moodarr-wikidata",
  [string]$Python = "C:\Python313\python.exe",
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

$dump = Join-Path $Root "latest-all.json.bz2"
$normalizer = Join-Path $Root "normalize-wikidata-dump-fast.py"
$workDir = Join-Path $Root "work\$RunName"
$outDir = Join-Path $Root "out"
$logsDir = Join-Path $Root "logs"
$output = Join-Path $outDir "moodarr-wikidata-catalog-$RunName.jsonl.gz"
$manifest = Join-Path $outDir "moodarr-wikidata-catalog-$RunName.manifest.json"
$outLog = Join-Path $logsDir "$RunName.out.log"
$errLog = Join-Path $logsDir "$RunName.err.log"

if ([string]::IsNullOrWhiteSpace($ClassIndex)) {
  $existingClassIndex = Join-Path $Root "work\full-min5\wikidata-class-index.json"
  if (Test-Path $existingClassIndex) {
    $ClassIndex = $existingClassIndex
  }
}

New-Item -ItemType Directory -Force -Path $workDir, $outDir, $logsDir | Out-Null

$normalizerArgs = @(
  $normalizer,
  "--dump", $dump,
  "--work-dir", $workDir,
  "--output", $output,
  "--manifest", $manifest,
  "--source-version", $SourceVersion,
  "--min-sitelinks", "$MinSitelinks",
  "--progress-interval", "$ProgressInterval",
  "--workers", "$Workers",
  "--batch-size", "$BatchSize",
  "--queue-batches", "$QueueBatches",
  "--output-gzip-level", "$OutputGzipLevel",
  "--decompressor", $Decompressor,
  "--decompressor-workers", "$DecompressorWorkers"
)

if (-not [string]::IsNullOrWhiteSpace($ClassIndex)) {
  $normalizerArgs += @("--class-index", $ClassIndex)
}
if ($MaxEntities -gt 0) {
  $normalizerArgs += @("--max-entities", "$MaxEntities")
}
if ($LimitMedia -gt 0) {
  $normalizerArgs += @("--limit-media", "$LimitMedia")
}
if ($Force) {
  $normalizerArgs += "--force"
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
