$envFile = "../../.env"
if (-not (Test-Path $envFile)) {
    Write-Error ".env file not found at $envFile"
    exit
}

$url = ""
$token = ""

Get-Content $envFile | ForEach-Object {
    if ($_ -match "^UPSTASH_REDIS_REST_URL=(.+)$") { $url = $matches[1].Trim() }
    if ($_ -match "^UPSTASH_REDIS_REST_TOKEN=(.+)$") { $token = $matches[1].Trim() }
}

if ([string]::IsNullOrWhiteSpace($url) -or [string]::IsNullOrWhiteSpace($token)) {
    Write-Error "UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not found in .env"
    exit
}

$newsList = @()
for ($i = 1; $i -le 27; $i++) {
    $newsList += @{
        title = "Benchmark News $i"
        url = "https://example.com/news/$i"
        time = "12:00"
        published_at = "2026-09-01T12:00:00+09:00"
        feed_id = 1
    }
}

$json = $newsList | ConvertTo-Json -Compress

$restUri = "$url/set/benchmark:news:list"

Write-Host "Sending data to Upstash Redis..."
$response = Invoke-RestMethod -Uri $restUri -Method Post -Headers @{ "Authorization" = "Bearer $token" } -Body $json

if ($response.result -eq "OK") {
    Write-Host "Success: 27 benchmark news items stored in benchmark:news:list"
} else {
    Write-Error "Failed to store data: $($response | ConvertTo-Json)"
}
