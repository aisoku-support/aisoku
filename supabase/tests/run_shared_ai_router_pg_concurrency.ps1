$ErrorActionPreference = 'Stop'

# PostgreSQL's Windows page links to EDB's installer-free binary ZIP.
# EDB PostgreSQL 17.11-4 x64, SHA-256 published in EDB's installer repository.
$postgresVersion = '17.11-4'
$downloadUrl = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-4-windows-x64-binaries.zip'
$expectedSha256 = 'B9424EE7BC60B52450FF910A3630225DF32E633F3CB29C1D126D9299D59AEA28'
$cacheRoot = Join-Path $env:TEMP 'shared-ai-router-postgres-17.11-4'
$archivePath = Join-Path $cacheRoot 'postgresql-17.11-4-windows-x64-binaries.zip'
$partialArchivePath = "$archivePath.partial"
$binaryRoot = Join-Path $cacheRoot 'binaries'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runRoot = Join-Path $env:TEMP "shared-ai-router-pg-run-$([guid]::NewGuid().ToString('N'))"
$dataDir = Join-Path $runRoot 'data'
$logPath = Join-Path $runRoot 'postgres.log'
$serverStarted = $false
$oldTestUrl = $env:SHARED_AI_TEST_DATABASE_URL
$oldDenoDir = $env:DENO_DIR
$oldPgAppName = $env:PGAPPNAME
$oldPgMaxPipeline = $env:PGMAX_PIPELINE

function Assert-LastExitCode([string]$operation) {
  if ($LASTEXITCODE -ne 0) {
    throw "$operation failed with exit code $LASTEXITCODE"
  }
}

try {
  New-Item -ItemType Directory -Force -Path $cacheRoot, $runRoot | Out-Null
  if (Test-Path -LiteralPath $archivePath) {
    $existingHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($existingHash -ne $expectedSha256) {
      throw "Cached PostgreSQL archive SHA-256 mismatch: $archivePath"
    }
  } else {
    Write-Host "Downloading official EDB PostgreSQL $postgresVersion x64 binaries..."
    Remove-Item -LiteralPath $partialArchivePath -Force -ErrorAction SilentlyContinue
    try {
      Invoke-WebRequest -Uri $downloadUrl -OutFile $partialArchivePath
      $downloadHash = (Get-FileHash -LiteralPath $partialArchivePath -Algorithm SHA256).Hash
      if ($downloadHash -ne $expectedSha256) {
        throw "Downloaded PostgreSQL archive SHA-256 mismatch: $downloadHash"
      }
      Move-Item -LiteralPath $partialArchivePath -Destination $archivePath
    } catch {
      Remove-Item -LiteralPath $partialArchivePath -Force -ErrorAction SilentlyContinue
      throw
    }
  }

  $postgresExe = Join-Path $binaryRoot 'pgsql\bin\postgres.exe'
  $initdb = Join-Path $binaryRoot 'pgsql\bin\initdb.exe'
  $pgCtl = Join-Path $binaryRoot 'pgsql\bin\pg_ctl.exe'
  $createdb = Join-Path $binaryRoot 'pgsql\bin\createdb.exe'
  $postgresCatalog = Join-Path $binaryRoot 'pgsql\share\postgres.bki'
  if (@($postgresExe, $initdb, $pgCtl, $createdb, $postgresCatalog).Where({
        -not (Test-Path -LiteralPath $_)
      }).Count -gt 0) {
    New-Item -ItemType Directory -Force -Path $binaryRoot | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    $binaryRootFull = [System.IO.Path]::GetFullPath($binaryRoot).TrimEnd('\') + '\'
    try {
      foreach ($entry in $archive.Entries) {
        if (-not $entry.FullName.StartsWith('pgsql/')) { continue }
        $relativePath = $entry.FullName.Replace('/', '\')
        $destination = [System.IO.Path]::GetFullPath((Join-Path $binaryRoot $relativePath))
        if (-not $destination.StartsWith($binaryRootFull, [StringComparison]::OrdinalIgnoreCase)) {
          throw "Archive entry escaped the isolated binary directory: $($entry.FullName)"
        }
        if ($entry.FullName.EndsWith('/')) {
          New-Item -ItemType Directory -Force -Path $destination | Out-Null
          continue
        }
        $parent = Split-Path -Parent $destination
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        $inputStream = $entry.Open()
        try {
          $outputStream = [System.IO.File]::Open($destination, [System.IO.FileMode]::Create)
          try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
        } finally {
          $inputStream.Dispose()
        }
      }
    } finally {
      $archive.Dispose()
    }
  }
  $binDir = Join-Path $binaryRoot 'pgsql\bin'
  foreach ($exe in @($postgresExe, $initdb, $pgCtl, $createdb)) {
    if (-not (Test-Path -LiteralPath $exe)) {
      throw "PostgreSQL binary missing from verified EDB archive: $exe"
    }
  }

  New-Item -ItemType Directory -Path $dataDir | Out-Null
  & $initdb -D $dataDir -U postgres --encoding=UTF8 --locale=C --auth-local=trust --auth-host=trust
  Assert-LastExitCode 'initdb'

  @"
listen_addresses = '127.0.0.1'
max_connections = 32
"@ | Add-Content -LiteralPath (Join-Path $dataDir 'postgresql.conf') -Encoding ascii
  @"
local all all trust
host all all 127.0.0.1/32 trust
"@ | Set-Content -LiteralPath (Join-Path $dataDir 'pg_hba.conf') -Encoding ascii

  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  Add-Content -LiteralPath (Join-Path $dataDir 'postgresql.conf') -Value "port = $port" -Encoding ascii

  & $pgCtl -D $dataDir -l $logPath -o "-h 127.0.0.1 -p $port" -w start
  Assert-LastExitCode 'pg_ctl start'
  $serverStarted = $true
  & $createdb -h 127.0.0.1 -p $port -U postgres shared_ai_router_test
  Assert-LastExitCode 'createdb'

  $env:SHARED_AI_TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:$port/shared_ai_router_test"
  $env:DENO_DIR = Join-Path $cacheRoot 'deno-cache'
  $env:PGAPPNAME = 'shared-ai-pg-isolated-test'
  $env:PGMAX_PIPELINE = '100'
  Push-Location $repoRoot
  try {
    Write-Host "Testing PostgreSQL $postgresVersion on 127.0.0.1:$port; database=shared_ai_router_test"
    deno test --node-modules-dir=auto --allow-net=127.0.0.1 --allow-env=SHARED_AI_TEST_DATABASE_URL,PGAPPNAME,PGMAX_PIPELINE --allow-read=supabase/migrations supabase/tests/shared_ai_router_pg_concurrency_test.ts
    Assert-LastExitCode 'multi-connection PostgreSQL test'

    deno test --node-modules-dir=auto --allow-env --allow-read supabase/tests/shared_ai_router_test.ts supabase/functions/generate-ai-replies/shared_router_test.ts supabase/functions/generate-ai-replies/handler_test.ts supabase/functions/_shared/topic/stage1_test.ts supabase/functions/_shared/topic/gemma_test.ts
    Assert-LastExitCode 'related regression tests'
  } finally {
    Pop-Location
  }
} finally {
  if ($serverStarted) {
    & $pgCtl -D $dataDir -m fast -w stop
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "PostgreSQL shutdown returned exit code $LASTEXITCODE. Check $logPath"
    } else {
      Write-Host 'Dedicated PostgreSQL test server stopped.'
    }
  }
  if ($null -eq $oldTestUrl) {
    Remove-Item Env:SHARED_AI_TEST_DATABASE_URL -ErrorAction SilentlyContinue
  } else {
    $env:SHARED_AI_TEST_DATABASE_URL = $oldTestUrl
  }
  if ($null -eq $oldDenoDir) {
    Remove-Item Env:DENO_DIR -ErrorAction SilentlyContinue
  } else {
    $env:DENO_DIR = $oldDenoDir
  }
  if ($null -eq $oldPgAppName) {
    Remove-Item Env:PGAPPNAME -ErrorAction SilentlyContinue
  } else {
    $env:PGAPPNAME = $oldPgAppName
  }
  if ($null -eq $oldPgMaxPipeline) {
    Remove-Item Env:PGMAX_PIPELINE -ErrorAction SilentlyContinue
  } else {
    $env:PGMAX_PIPELINE = $oldPgMaxPipeline
  }
}
