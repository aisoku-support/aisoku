param([ValidateSet('Prepare','Run')][string]$Mode = 'Run')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$datasetPath = Join-Path $PSScriptRoot 'thread_title_ab_20260927_dataset.json'
$resultPath = Join-Path $PSScriptRoot 'thread_title_ab_20260927_results.json'
$reportPath = Join-Path $PSScriptRoot 'thread_title_ab_20260927_report.md'
$logPath = Join-Path $PSScriptRoot 'thread_title_ab_20260927_run.log'
if ($Mode -eq 'Prepare' -or -not (Test-Path $datasetPath)) { & (Join-Path $PSScriptRoot 'prepare_thread_title_ab.ps1'); if ($Mode -eq 'Prepare') { return } }
$ErrorActionPreference = 'Stop'

function Read-EnvFile([string]$path) {
  $map = @{}
  if (Test-Path $path) {
    foreach ($line in Get-Content -LiteralPath $path -Encoding utf8) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
        $value = $matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { $value = $value.Substring(1, $value.Length - 2) }
        $map[$matches[1]] = $value
      }
    }
  }
  return $map
}
function Get-CategoryCode([string]$category) {
  if ($category -eq ([string][char]0x0049+[char]0x0054+[char]0x30fb+[char]0x30ac+[char]0x30b8+[char]0x30a7+[char]0x30c3+[char]0x30c8)) { return 'IT' }
  if ($category -eq ([string][char]0x30c8+[char]0x30ec+[char]0x30f3+[char]0x30c9)) { return 'Trend' }
  if ($category -eq ([string][char]0x30a8+[char]0x30f3+[char]0x30bf+[char]0x30e1)) { return 'Entertainment' }
  if ($category -eq ([string][char]0x30b5+[char]0x30d6+[char]0x30ab+[char]0x30eb)) { return 'Subculture' }
  if ($category -eq ([string][char]0x30de+[char]0x30cd+[char]0x30fc)) { return 'Money' }
  return 'Other'
}
function Save-Results($state) { $state | ConvertTo-Json -Depth 18 | Set-Content -LiteralPath $resultPath -Encoding utf8 }
function Get-ApiErrorDetail($exception) {
  try {
    if (-not $exception.Response) { return $null }
    $stream = $exception.Response.GetResponseStream()
    if (-not $stream) { return $null }
    $reader = [IO.StreamReader]::new($stream)
    $body = $reader.ReadToEnd() | ConvertFrom-Json
    return @{ status = $body.error.status; code = $body.error.code; message = [string]$body.error.message }
  } catch { return $null }
}

$envs = Read-EnvFile (Join-Path $root '.env.server')
if (-not $envs.GEMINI_API_KEY) { $envs = Read-EnvFile (Join-Path $root '.env') }
$apiKey = $envs.GEMINI_API_KEY
if (-not $apiKey) { throw 'GEMINI_API_KEY not found in .env.server or .env (value not printed).' }
$dataset = Get-Content -LiteralPath $datasetPath -Raw -Encoding utf8 | ConvertFrom-Json
$state = [ordered]@{ started_at = (Get-Date).ToUniversalTime().ToString('o'); source_file = 'thread_title_ab_20260927_dataset.json'; models = [ordered]@{}; requests = @(); stop_reason = $null }
$headers = @{ 'x-goog-api-key' = $apiKey }

try {
  $modelResponse = Invoke-WebRequest -Uri 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000' -Headers $headers -Method Get -TimeoutSec 30
  $modelList = $modelResponse.Content | ConvertFrom-Json
  $modelNames = @($modelList.models | ForEach-Object { $_.name -replace '^models/', '' })
} catch {
  $state.stop_reason = 'models_list_transport_or_http_failure'
  $state.model_list_error = $_.Exception.GetType().Name
  $detail = Get-ApiErrorDetail $_.Exception
  if ($detail) { $state.model_list_http_status = $detail.code; $state.model_list_api_error = $detail.status; $state.model_list_error_message = $detail.message }
  Save-Results $state
  @('# AI-speed Thread title Gemini A/B test', '', '## Execution stopped before generation', '', 'The Gemini models.list request failed before an HTTP response. No GenerateContent requests were sent. The error type is recorded in the paired results JSON; credentials and exception text are omitted.', '', "Error type: $($state.model_list_error)", "Timestamp: $($state.started_at)", '', 'Prepared dataset: 40 unique Topics; see thread_title_ab_20260927_dataset.json.', '', 'Retry command from Windows PowerShell after network/TLS access is available:', '', '```powershell', 'powershell -NoProfile -ExecutionPolicy Bypass -File tools/benchmarks/run_thread_title_ab_20260927.ps1', '```') | Set-Content -LiteralPath $reportPath -Encoding utf8
  Write-Output "STOP: Gemini models.list failed ($($state.model_list_error)); no generation calls made. Results saved without credentials."
  exit 2
}
$state.model_list_checked_at = (Get-Date).ToUniversalTime().ToString('o')
$primaryId = 'gemini-3.1-flash-lite-preview'
$replacementId = 'gemini-3.1-flash-lite'
if ($modelNames -contains $primaryId) { $modelA = $primaryId; $state.model_a_id = $primaryId }
elseif ($modelNames -contains $replacementId) { $modelA = $replacementId; $state.model_a_id = $replacementId; $state.model_a_substitution = 'Preview shutdown/unavailable; stable 3.1 used.' }
else { $state.stop_reason = 'no_usable_3_1_model_listed'; Save-Results $state; Write-Output 'STOP: no usable 3.1 model listed; no generation calls made.'; exit 3 }
$modelB = 'gemini-3.5-flash-lite'
if ($modelNames -notcontains $modelB) { $state.stop_reason = '3_5_not_listed'; Save-Results $state; Write-Output 'STOP: Gemini 3.5 Flash-Lite is not listed; no generation calls made.'; exit 4 }
$state.model_b_id = $modelB
$state.protocol = [ordered]@{ temperature = 0; thinkingLevel = 'high'; maxOutputTokens = 8192; timeoutSeconds = 30; retries = 0; batchSize = 4; maxTitleLength = 47 }
$promptParts = @(([string][char]0x3053+[char]0x306e+[char]0x30cb+[char]0x30e5+[char]0x30fc+[char]0x30b9+[char]0x3067+[char]0x0032+[char]0x0063+[char]0x0068+[char]0x002f+[char]0x0035+[char]0x0063+[char]0x0068+[char]0x306e+[char]0x30b9+[char]0x30ec+[char]0x30bf+[char]0x30a4+[char]0x3092+[char]0x0031+[char]0x3064+[char]0x4f5c+[char]0x3063+[char]0x3066+[char]0x304f+[char]0x3060+[char]0x3055+[char]0x3044+[char]0x3002), '', ([string][char]0x0034+[char]0x0037+[char]0x6587+[char]0x5b57+[char]0x4ee5+[char]0x5185+[char]0x3002), 'JSON'+[char]0x3060+[char]0x3051+[char]0x8fd4+[char]0x3057+[char]0x3066+[char]0x304f+[char]0x3060+[char]0x3055+[char]0x3044+[char]0x3002, '', ([string][char]0x7981+[char]0x6b62+[char]0x003a), ([string][char]0x002d+[char]0x0020+[char]0x500b+[char]0x4eba+[char]0x3084+[char]0x4f01+[char]0x696d+[char]0x3078+[char]0x306e+[char]0x8a00+[char]0x8a7b+[char]0x4e2d+[char]0x50b7), ([string][char]0x002d+[char]0x0020+[char]0x5dee+[char]0x5225+[char]0x8868+[char]0x73fe), ([string][char]0x002d+[char]0x0020+[char]0x6839+[char]0x62e0+[char]0x306e+[char]0x306a+[char]0x3044+[char]0x72af+[char]0x7f6a+[char]0x002f+[char]0x4e0d+[char]0x6b63+[char]0x306e+[char]0x65ad+[char]0x5b9a), ([string][char]0x002d+[char]0x0020+[char]0x75c5+[char]0x6c17+[char]0x002f+[char]0x6b7b+[char]0x4ea1+[char]0x002f+[char]0x91cd+[char]0x5927+[char]0x4e8b+[char]0x6545+[char]0x3092+[char]0x60aa+[char]0x8cea+[char]0x306b+[char]0x8336+[char]0x5316+[char]0x3059+[char]0x8868+[char]0x73fe))
$prompt = $promptParts -join "`n"
$state.evidence = [ordered]@{ inputFormat = 'contents text = JSON.stringify({topics:[{id,subject,event},...]})'; prompt = $prompt; structuredSchema = 'object.titles=array(minItems=4,maxItems=4).items={id:string,thread_title:string};required=[titles];items.required=[id,thread_title]' }
$maxTries = @{}; $attemptCount = @{}
$modelsToRun = @([ordered]@{ key = 'A'; id = $modelA }, [ordered]@{ key = 'B'; id = $modelB })

function Invoke-Batch([string]$key, [string]$modelId, [int]$batchIndex, $topics) {
  $body = [ordered]@{
    systemInstruction = @{ parts = @(@{ text = $state.evidence.prompt }) }
    contents = @(@{ parts = @(@{ text = (ConvertTo-Json -InputObject ([ordered]@{ topics = @($topics | ForEach-Object { [ordered]@{ id = $_.id; subject = $_.subject; event = $_.event } }) }) -Compress -Depth 8) }) })
    generationConfig = @{
      responseMimeType = 'application/json'
      responseSchema = @{ type = 'object'; properties = @{ titles = @{ type = 'array'; minItems = 4; maxItems = 4; items = @{ type = 'object'; properties = @{ id = @{ type = 'string' }; thread_title = @{ type = 'string' } }; required = @('id','thread_title') } } }; required = @('titles') }
      thinkingConfig = @{ thinkingLevel = 'high' }; temperature = 0; maxOutputTokens = 8192
    }
  }
  $json = $body | ConvertTo-Json -Depth 18 -Compress
  $request = [ordered]@{ model_key = $key; model_id = $modelId; batch_index = $batchIndex; topic_ids = @($topics | ForEach-Object { $_.id }); status = 'pending'; started_at = (Get-Date).ToUniversalTime().ToString('o'); elapsed_ms = $null; http_status = $null; retry_after = $null; usage = $null; finish_reason = $null; titles = @(); errors = @() }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try {
    $response = Invoke-WebRequest -Uri "https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent" -Headers (@{ 'x-goog-api-key' = $apiKey; 'Content-Type' = 'application/json' }) -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 30
    $request.http_status = [int]$response.StatusCode
    $payload = $response.Content | ConvertFrom-Json
    $request.usage = $payload.usageMetadata
    $candidate = $payload.candidates | Select-Object -First 1
    $request.finish_reason = $candidate.finishReason
    $rawText = (@($candidate.content.parts | ForEach-Object { $_.text }) -join '').Trim()
    if ($rawText -match '^```(?:json)?\s*([\s\S]*?)\s*```$') { $rawText = $matches[1] }
    try { $parsed = $rawText | ConvertFrom-Json -ErrorAction Stop } catch { $request.status = 'invalid_json'; $request.errors += 'invalid_json'; return $request }
    if ($parsed.titles -isnot [array]) { $request.status = 'schema_invalid'; $request.errors += 'schema_invalid'; return $request }
    $seen = @{}; $byId = @{}
    foreach ($row in $parsed.titles) {
      if (-not $row.id -or $row.id -notin $request.topic_ids) { $request.errors += 'unknown_id'; continue }
      if ($seen.ContainsKey([string]$row.id)) { $request.errors += 'duplicate_id'; $byId[[string]$row.id] = @{ title = $null; status = 'duplicate_id' }; continue }
      $seen[[string]$row.id] = $true
      if ($row.thread_title -isnot [string]) { $byId[[string]$row.id] = @{ title = $null; status = 'schema_invalid' }; $request.errors += 'schema_invalid'; continue }
      $title = $row.thread_title.Trim(); $len = [System.Globalization.StringInfo]::ParseCombiningCharacters($title).Length
      if (-not $title) { $byId[[string]$row.id] = @{ title = $null; status = 'empty' }; $request.errors += 'empty' }
      elseif ($len -gt 47) { $byId[[string]$row.id] = @{ title = $title; status = 'too_long' }; $request.errors += 'too_long' }
      else { $byId[[string]$row.id] = @{ title = $title; status = 'success' } }
    }
    foreach ($id in $request.topic_ids) { if (-not $byId.ContainsKey($id)) { $byId[$id] = @{ title = $null; status = 'missing_id' }; $request.errors += 'missing_id' } }
    $request.titles = @($request.topic_ids | ForEach-Object { [ordered]@{ id = $_; title = $byId[$_].title; status = $byId[$_].status; length = if ($byId[$_].title) { [System.Globalization.StringInfo]::ParseCombiningCharacters($byId[$_].title).Length } else { 0 } } })
    if (@($request.titles | Where-Object status -ne 'success').Count -eq 0) { $request.status = 'success' } else { $request.status = 'partial_failure' }
  } catch {
    $request.status = 'http_or_transport_error'; $request.errors += $_.Exception.GetType().Name
    if ($_.Exception.Response) { try { $request.http_status = [int]$_.Exception.Response.StatusCode; $request.retry_after = $_.Exception.Response.Headers['Retry-After'] } catch {}; $detail = Get-ApiErrorDetail $_.Exception; if ($detail) { $request.api_error_status = $detail.status; $request.api_error_code = $detail.code; $request.api_error_message = $detail.message } }
  } finally { $timer.Stop(); $request.elapsed_ms = [Math]::Round($timer.Elapsed.TotalMilliseconds, 1); $request.completed_at = (Get-Date).ToUniversalTime().ToString('o') }
  return $request
}

$batchTopics = @(); for ($i = 0; $i -lt 40; $i += 4) { $batchTopics += ,@($dataset.topics[$i..($i+3)]) }
foreach ($model in $modelsToRun) { $attemptCount[$model.key] = 0; $maxTries[$model.key] = 0 }
foreach ($model in $modelsToRun) {
  $req = Invoke-Batch $model.key $model.id 0 $batchTopics[0]
  $state.requests += $req; $attemptCount[$model.key]++
  Save-Results $state
  Write-Output "Initial batch $($model.key): status=$($req.status) http=$($req.http_status) usage=$([bool]$req.usage)"
  if ($req.http_status -eq 429 -or $req.status -eq 'http_or_transport_error' -or -not $req.usage) { $state.stop_reason = "initial_$($model.key)_unusable_response"; Save-Results $state; break }
}
if (-not $state.stop_reason) {
  $safeToContinue = $true
  foreach ($req in $state.requests) { if ($req.status -notin @('success','partial_failure') -or $req.http_status -ne 200 -or -not $req.usage) { $safeToContinue = $false } }
  if (-not $safeToContinue) { $state.stop_reason = 'initial_model_response_failed_validation' }
}
if (-not $state.stop_reason) {
  foreach ($model in $modelsToRun) {
    for ($bi = 1; $bi -lt 10; $bi++) {
      Start-Sleep -Milliseconds 4100
      $req = Invoke-Batch $model.key $model.id $bi $batchTopics[$bi]
      $state.requests += $req; $attemptCount[$model.key]++
      Save-Results $state
      Write-Output "Batch $($model.key) $($bi+1)/10: status=$($req.status) http=$($req.http_status) elapsed_ms=$($req.elapsed_ms)"
      if ($req.http_status -eq 429 -or $req.status -eq 'http_or_transport_error' -or -not $req.usage) { $state.stop_reason = "model_$($model.key)_quota_or_transport_stop"; break }
    }
    if ($state.stop_reason) { break }
  }
}
$state.finished_at = (Get-Date).ToUniversalTime().ToString('o')
$state.api_calls_total = $state.requests.Count
$state.summary = [ordered]@{}
foreach ($key in 'A','B') {
  $rows = @($state.requests | Where-Object model_key -eq $key)
  $all = @($rows | ForEach-Object { $_.titles })
  $titles = @($all | Where-Object { $_ })
  $lengths = @($titles | Where-Object title | ForEach-Object { [int]$_.length } | Sort-Object)
  $elapsed = @($rows | Where-Object elapsed_ms -ne $null | ForEach-Object { [double]$_.elapsed_ms } | Sort-Object)
  $p95 = if ($elapsed.Count) { $elapsed[[Math]::Ceiling(.95 * $elapsed.Count) - 1] } else { $null }
  $usageRows = @($rows | ForEach-Object { $_.usage } | Where-Object { $_ })
  $state.summary[$key] = [ordered]@{ batches_attempted = $rows.Count; requests_http_200 = @($rows | Where-Object http_status -eq 200).Count; topic_success = @($titles | Where-Object status -eq 'success').Count; topic_attempted = $titles.Count; json_valid_batches = @($rows | Where-Object status -in @('success','partial_failure')).Count; title_length_compliance = @($titles | Where-Object status -ne 'too_long').Count; mean_ms = if ($elapsed.Count) {[Math]::Round(($elapsed|Measure-Object -Average).Average,1)}else{$null}; median_ms = if ($elapsed.Count) {$elapsed[[Math]::Floor(($elapsed.Count-1)/2)]}else{$null}; p95_ms = $p95; input_tokens = (($usageRows|Measure-Object -Property promptTokenCount -Sum).Sum); output_tokens = (($usageRows|Measure-Object -Property candidatesTokenCount -Sum).Sum); thinking_tokens = (($usageRows|Measure-Object -Property thoughtsTokenCount -Sum).Sum) }
}
$state.requests = @($state.requests)
Save-Results $state

$blind = @(); foreach ($topic in $dataset.topics) {
  $rowA = $null; $rowB = $null
  foreach ($req in $state.requests) { $r = $req.titles | Where-Object id -eq $topic.id | Select-Object -First 1; if ($req.model_key -eq 'A' -and $r) {$rowA=$r}; if ($req.model_key -eq 'B' -and $r) {$rowB=$r} }
  $flip = (($topic.id.GetHashCode() -band 1) -eq 1)
  $blind += [ordered]@{ id=$topic.id; category=(Get-CategoryCode $topic.category); subject=$topic.subject; event=$topic.event; X=if($flip){if($rowA){$rowA.title}else{$null}}else{if($rowB){$rowB.title}else{$null}}; X_status=if($flip){if($rowA){$rowA.status}else{'not_run'}}else{if($rowB){$rowB.status}else{'not_run'}}; Y=if($flip){if($rowB){$rowB.title}else{$null}}else{if($rowA){$rowA.title}else{$null}}; Y_status=if($flip){if($rowB){$rowB.status}else{'not_run'}}else{if($rowA){$rowA.status}else{'not_run'}} }
}
$state.blind = $blind
Save-Results $state
[void]$report.Add('# AI-speed Thread title Gemini A/B test'); [void]$report.Add(''); [void]$report.Add("Run: $($state.started_at) to $($state.finished_at)"); [void]$report.Add(''); [void]$report.Add('## Conditions'); [void]$report.Add(''); [void]$report.Add("Topics: $($dataset.total); stratified categories, unique topic IDs. A=$($state.model_a_id), B=$($state.model_b_id). A uses stable 3.1 because preview is shut down. temperature=0, thinking=high, maxOutputTokens=8192, timeout=30s, retry=0, batch=4, title<=47 chars."); [void]$report.Add('Production prompt, input and schema reused. API keys are not recorded.'); [void]$report.Add(''); [void]$report.Add('## Mechanical results'); [void]$report.Add(''); [void]$report.Add('| Model | Batches | HTTP 200 | Success / output topics | JSON-valid batches | Length compliant | Mean ms | Median ms | p95 ms | Input tokens | Output tokens | Thinking tokens |'); [void]$report.Add('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
[void]$report.Add('# AI-speed Thread title Gemini A/B test'); [void]$report.Add(''); [void]$report.Add("実行: $($state.started_at) ～ $($state.finished_at)"); [void]$report.Add(''); [void]$report.Add('## Conditions'); [void]$report.Add(''); [void]$report.Add("対象: $($dataset.total) Topic、カテゴリ層化・topic_id重複なし。A=`$($state.model_a_id)、B=`$($state.model_b_id)。Model AはpreviewがShutdownのためstable 3.1代替。temperature=0, thinking=high, maxOutputTokens=8192, timeout=30s, retry=0, batch=4, title<=47文字。"); [void]$report.Add('Production thread_title.ts prompt, input and schema reused. API keys are not recorded.'); [void]$report.Add(''); [void]$report.Add('## Mechanical results'); [void]$report.Add(''); [void]$report.Add('| Model | Batches | HTTP 200 | Success / Topics output | JSON-valid batches | Length compliant | Mean ms | Median ms | p95 ms | Input tokens | Output tokens | Thinking tokens |'); [void]$report.Add('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
[void]$report.Add(''); [void]$report.Add('Unrun items are excluded from denominators. See request records for schema/API failures.'); [void]$report.Add(''); [void]$report.Add('## Per-topic model outputs'); [void]$report.Add(''); [void]$report.Add('| ID | Category | subject / event | A title (status) | B title (status) |'); [void]$report.Add('|---|---|---|---|---|')
[void]$report.Add(''); [void]$report.Add('Unrun items are excluded from denominators. See request records for schema/API failures.'); [void]$report.Add(''); [void]$report.Add('## Per-topic model outputs'); [void]$report.Add(''); [void]$report.Add('| ID | Category | subject / event | A title (status) | B title (status) |'); [void]$report.Add('|---|---|---|---|---|')
[void]$report.Add(''); [void]$report.Add('## Blind comparison (fixed X/Y assignment per topic)'); [void]$report.Add(''); [void]$report.Add('| ID | Category | subject / event | X | Y | Humor X/Y | 5ch style X/Y | Naturalness X/Y | Variety X/Y | Consistency X/Y | Inappropriate/invention notes |'); [void]$report.Add('|---|---|---|---|---|---|---|---|---|---|---|'); foreach($item in $blind){[void]$report.Add("| $($item.id) | $($item.category) | $($item.subject) / $($item.event) | $($item.X) [$($item.X_status)] | $($item.Y) [$($item.Y_status)] |  |  |  |  |  |  |")}; [void]$report.Add(''); [void]$report.Add('Subjective fields stay blank until blind review; no subjective scores are fabricated.'); [void]$report.Add(''); [void]$report.Add("Stop reason: $($state.stop_reason)"); [void]$report.Add("Detailed responses, usage, status and blind assignment: $([IO.Path]::GetFileName($resultPath))")
[void]$report.Add(''); [void]$report.Add('## Blind comparison (fixed X/Y assignment per topic)'); [void]$report.Add(''); [void]$report.Add('| ID | Category | subject / event | X | Y | Humor X/Y | 5ch style X/Y | Naturalness X/Y | Variety X/Y | Consistency X/Y | Inappropriate/invention notes |'); [void]$report.Add('|---|---|---|---|---|---|---|---|---|---|---|'); foreach($item in $blind){[void]$report.Add("| $($item.id) | $($item.category) | $($item.subject) / $($item.event) | $($item.X) [$($item.X_status)] | $($item.Y) [$($item.Y_status)] |  |  |  |  |  |  |")}; [void]$report.Add(''); [void]$report.Add('Subjective fields are intentionally blank until blind human review; no subjective scores are fabricated.'); [void]$report.Add(''); [void]$report.Add("停止理由: $($state.stop_reason)"); [void]$report.Add("詳細応答・usage・status・ブラインド割当は同梱JSON: $([IO.Path]::GetFileName($resultPath))")
$report | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Output "DONE calls=$($state.api_calls_total) stop=$($state.stop_reason) results=$resultPath report=$reportPath"


