$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$sourcePath = Join-Path $root 'test/embedding/real_news/articles.json'
$outputPath = Join-Path $PSScriptRoot 'thread_title_ab_20260927_dataset.json'
$source = Get-Content -LiteralPath $sourcePath -Raw -Encoding utf8 | ConvertFrom-Json
$valid = @($source.articles | Where-Object { $_.topic_id -and $_.subject -and $_.event })
$quotas = [ordered]@{ ([string]([char]0x0049)+[char]0x0054+[char]0x30fb+[char]0x30ac+[char]0x30b8+[char]0x30a7+[char]0x30c3+[char]0x30c8) = 13; ([string][char]0x30c8+[char]0x30ec+[char]0x30f3+[char]0x30c9) = 8; ([string][char]0x30a8+[char]0x30f3+[char]0x30bf+[char]0x30e1) = 8; ([string][char]0x30b5+[char]0x30d6+[char]0x30ab+[char]0x30eb) = 5; ([string][char]0x30de+[char]0x30cd+[char]0x30fc) = 6 }
$selected = [System.Collections.Generic.List[object]]::new()
foreach ($category in $quotas.Keys) {
  $seen = @{}
  $rows = @($valid | Where-Object { $_.topic_category -eq $category } | Sort-Object saved_at, article_id)
  foreach ($row in $rows) {
    if (-not $seen.ContainsKey($row.topic_id)) {
      [void]$selected.Add([ordered]@{ id = [string]$row.topic_id; subject = [string]$row.subject; event = [string]$row.event; category = [string]$row.topic_category; source_article_id = [string]$row.article_id })
      $seen[$row.topic_id] = $true
      if (($seen.Count) -ge $quotas[$category]) { break }
    }
  }
}
if ($selected.Count -ne 40 -or (@($selected | ForEach-Object { $_['id'] } | Select-Object -Unique).Count -ne 40)) { throw "Expected 40 unique Topics; selected $($selected.Count)." }
$dataset = [ordered]@{ schema_version = '1.0'; created_at = (Get-Date).ToUniversalTime().ToString('o'); source_file = 'test/embedding/real_news/articles.json'; source_extracted_at = $source.extracted_at; selection = $quotas; total = $selected.Count; topics = @($selected) }
$dataset | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputPath -Encoding utf8
Write-Output "SAVED $outputPath ($($selected.Count) Topics)"
