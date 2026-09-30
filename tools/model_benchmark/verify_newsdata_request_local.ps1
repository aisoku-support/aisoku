$root = (Get-Location).Path
$envPath = Join-Path $root '.env'
$envDetected = Test-Path -LiteralPath $envPath
$keyPresent = $false
$keyNonEmpty = $false
$apiKey = $null
if ($envDetected) {
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*NEWSDATA_API_KEY\s*=\s*(.*)\s*$') {
      $keyPresent = $true
      $apiKey = $matches[1].Trim().Trim('"').Trim("'")
      $keyNonEmpty = $apiKey.Length -gt 0
      break
    }
  }
}
$requestHasKey = $false
if ($keyNonEmpty) {
  $encodedKey = [Uri]::EscapeDataString($apiKey)
  $query = @(
    "apikey=$encodedKey",
    'language=ja',
    'size=10',
    'removeduplicate=1',
    'excludedomain=topics.smt.docomo.jp%2Csmartnews.com%2Cjp.investing.com%2Cprtimes.jp%2Cnews.google.com'
  ) -join '&'
  $requestUri = [Uri]::new("https://newsdata.io/api/1/latest?$query")
  $requestHasKey = $requestUri.Query.Contains('apikey=')
}
[pscustomobject]@{
  'env_detected' = if ($envDetected) { 'YES' } else { 'NO' }
  'key_present' = if ($keyPresent) { 'YES' } else { 'NO' }
  'nonempty' = if ($keyNonEmpty) { 'YES' } else { 'NO' }
  'length' = if ($null -eq $apiKey) { 0 } else { $apiKey.Length }
  'request_key_configured' = if ($requestHasKey) { 'YES' } else { 'NO' }
  'http_sent' = 'NO'
} | Format-List
