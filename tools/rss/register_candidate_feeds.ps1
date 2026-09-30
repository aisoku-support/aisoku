# Yahoo!ニュースRSS一括登録スクリプト (PS 5.1 Compatible)
# このスクリプトは指定されたテキストファイルからURLを読み込み、
# 既存の ensure-rss-feed Edge Function を通じて Upstash Redis へ一括登録します。

$ErrorActionPreference = "Continue"

# 設定
$dataFile = "./data/yahoo_candidate_feeds.txt"
$envFile = "../../.env"

# .env から設定を読み込み
if (!(Test-Path $envFile)) { Write-Error ".env file not found at $envFile"; exit }

$supabaseUrl = ""
$anonKey = ""

Get-Content $envFile | ForEach-Object {
    if ($_ -match "^SUPABASE_URL=(.+)$") { $supabaseUrl = $matches[1].Trim() }
    if ($_ -match "^SUPABASE_PUBLISHABLE_KEY=(.+)$") { $anonKey = $matches[1].Trim() }
}

if (!$supabaseUrl -or !$anonKey) { Write-Error "Supabase configuration not found in .env"; exit }

$edgeFunctionUrl = "$($supabaseUrl.TrimEnd('/'))/functions/v1/ensure-rss-feed"

# データ読み込み
if (!(Test-Path $dataFile)) { Write-Error "Data file not found at $dataFile"; exit }

$rawLines = Get-Content $dataFile
$inputCount = $rawLines.Count

# 前処理：Trim, 重複排除, 空行除外
$urls = $rawLines | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" } | Select-Object -Unique

# バリデーション
$validUrls = @()
$invalidCount = 0
$topicsCount = 0
$categoriesCount = 0
$mediaCount = 0

foreach ($u in $urls) {
    if ($u -like "https://news.yahoo.co.jp/rss/*" -and $u -match "\.xml$") {
        $validUrls += $u
        if ($u -match "/topics/") { $topicsCount++ }
        elseif ($u -match "/categories/") { $categoriesCount++ }
        elseif ($u -match "/media/") { $mediaCount++ }
    } else {
        $invalidCount++
    }
}

# 統計表示
Write-Host "=== RSS Registration Statistics ==="
Write-Host "Input lines    : $inputCount"
Write-Host "Unique URLs    : $($urls.Count)"
Write-Host "Invalid URLs   : $invalidCount"
Write-Host "-------------------------------"
Write-Host "Topics URLs    : $topicsCount"
Write-Host "Categories URLs: $categoriesCount"
Write-Host "Media URLs     : $mediaCount"
Write-Host "Total Valid    : $($validUrls.Count)"
Write-Host "==============================="
Write-Host ""

if ($validUrls.Count -eq 0) {
    Write-Warning "No valid URLs to register. Exiting."
    exit
}

Write-Host "Starting registration to Edge Function (Sequential)..."
Write-Host "Target: $edgeFunctionUrl"
Write-Host ""

$succeeded = 0
$failed = 0
$failedUrls = @()

$counter = 0
foreach ($u in $validUrls) {
    $counter++
    Write-Host "[$counter / $($validUrls.Count)] Registering: $u" -NoNewline

    try {
        $body = @{ url = $u; mark_active = $false } | ConvertTo-Json
        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $response = Invoke-RestMethod -Uri $edgeFunctionUrl -Method Post -Headers @{
            "Authorization" = "Bearer $anonKey"
            "Content-Type" = "application/json"
        } -Body $bodyBytes -ContentType "application/json"

        if ($response.success -eq $true) {
            Write-Host " -> OK" -ForegroundColor Green
            $succeeded++
        } else {
            Write-Host " -> FAILED (Logic Error)" -ForegroundColor Red
            $failed++
            $failedUrls += $u
        }
    } catch {
        Write-Host " -> ERROR: $($_.Exception.Message)" -ForegroundColor Red
        $failed++
        $failedUrls += $u
    }
}

Write-Host ""
Write-Host "=== Final Result ==="
Write-Host "Total     : $($validUrls.Count)"
Write-Host "Succeeded : $succeeded" -ForegroundColor Green
Write-Host "Failed    : $failed" -ForegroundColor Red
Write-Host "===================="

if ($failedUrls.Count -gt 0) {
    Write-Host "`nFailed URLs:"
    $failedUrls | ForEach-Object { Write-Host " - $_" }
}

Write-Host "`nProcess finished."
