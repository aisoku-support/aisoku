# Upstash Redis プリセットRSS設定スクリプト (Refined Version 2026-09-03)
# 実行には .env ファイルに UPSTASH_REDIS_REST_URL と UPSTASH_REDIS_REST_TOKEN が必要です。

$ErrorActionPreference = "Stop"

$envFile = Join-Path $PSScriptRoot "../../.env"
if (!(Test-Path $envFile)) { Write-Error ".env file not found"; exit }

$url = ""
$token = ""

Get-Content $envFile | ForEach-Object {
    if ($_ -match "^UPSTASH_REDIS_REST_URL=(.+)$") { $url = $matches[1].Trim() }
    if ($_ -match "^UPSTASH_REDIS_REST_TOKEN=(.+)$") { $token = $matches[1].Trim() }
}

if (!$url -or !$token) { Write-Error "Credentials not found in .env"; exit }

# プリセット定義 (50件)
$presets = @(
    # トレンド (100-190)
    @{ url = "https://www3.nhk.or.jp/rss/news/cat0.xml"; name = "NHKニュース"; category = "トレンド"; order = 100 },
    @{ url = "https://news.yahoo.co.jp/rss/topics/top-picks.xml"; name = "Yahoo!主要"; category = "トレンド"; order = 110 },
    @{ url = "https://news.yahoo.co.jp/rss/topics/domestic.xml"; name = "Yahoo!国内"; category = "トレンド"; order = 120 },
    @{ url = "https://news.yahoo.co.jp/rss/topics/world.xml"; name = "Yahoo!海外"; category = "トレンド"; order = 130 },
    @{ url = "https://news.yahoo.co.jp/rss/media/kyodonews/all.xml"; name = "共同通信"; category = "トレンド"; order = 140 },
    @{ url = "https://news.yahoo.co.jp/rss/media/fnnprimev/all.xml"; name = "FNNプライム"; category = "トレンド"; order = 150 },
    @{ url = "https://news.yahoo.co.jp/rss/media/jct/all.xml"; name = "J-CASTニュース"; category = "トレンド"; order = 160 },
    @{ url = "https://news.yahoo.co.jp/rss/media/bengocom/all.xml"; name = "弁護士ドットコムニュース"; category = "トレンド"; order = 170 },

    # エンタメ (200-290)
    @{ url = "https://news.yahoo.co.jp/rss/topics/entertainment.xml"; name = "Yahoo!エンタメ"; category = "エンタメ"; order = 200 },
    @{ url = "https://news.yahoo.co.jp/rss/media/oric/all.xml"; name = "オリコン"; category = "エンタメ"; order = 210 },
    @{ url = "https://news.yahoo.co.jp/rss/media/mdpr/all.xml"; name = "モデルプレス"; category = "エンタメ"; order = 220 },
    @{ url = "https://news.yahoo.co.jp/rss/media/nataliee/all.xml"; name = "映画ナタリー"; category = "エンタメ"; order = 230 },
    @{ url = "https://news.yahoo.co.jp/rss/media/jprime/all.xml"; name = "週刊女性PRIME"; category = "エンタメ"; order = 240 },
    @{ url = "https://news.yahoo.co.jp/rss/media/friday/all.xml"; name = "FRIDAYデジタル"; category = "エンタメ"; order = 250 },
    @{ url = "https://news.yahoo.co.jp/rss/media/tospoweb/all.xml"; name = "東スポWEB"; category = "エンタメ"; order = 260 },

    # スポーツ (300-390)
    @{ url = "https://news.yahoo.co.jp/rss/topics/sports.xml"; name = "Yahoo!スポーツ"; category = "スポーツ"; order = 300 },
    @{ url = "https://news.yahoo.co.jp/rss/media/nksports/all.xml"; name = "日刊スポーツ"; category = "スポーツ"; order = 310 },
    @{ url = "https://news.yahoo.co.jp/rss/media/sanspo/all.xml"; name = "サンケイスポーツ"; category = "スポーツ"; order = 320 },
    @{ url = "https://news.yahoo.co.jp/rss/media/soccerk/all.xml"; name = "サッカーキング"; category = "スポーツ"; order = 330 },
    @{ url = "https://news.yahoo.co.jp/rss/media/fullcount/all.xml"; name = "Full-Count"; category = "スポーツ"; order = 340 },
    @{ url = "https://news.yahoo.co.jp/rss/media/sph/all.xml"; name = "スポーツ報知"; category = "スポーツ"; order = 350 },
    @{ url = "https://news.yahoo.co.jp/rss/media/theanswer/all.xml"; name = "THE ANSWER"; category = "スポーツ"; order = 360 },
    @{ url = "https://news.yahoo.co.jp/rss/media/soccermzw/all.xml"; name = "Football ZONE"; category = "スポーツ"; order = 370 },

    # サブカル (400-491)
    @{ url = "https://news.yahoo.co.jp/rss/media/denfami/all.xml"; name = "電ファミニコ"; category = "サブカル"; order = 400 },
    @{ url = "https://news.yahoo.co.jp/rss/media/gamespav/all.xml"; name = "GameSpark"; category = "サブカル"; order = 410 },
    @{ url = "https://news.yahoo.co.jp/rss/media/nataliec/all.xml"; name = "コミックナタリー"; category = "サブカル"; order = 420 },
    @{ url = "https://news.yahoo.co.jp/rss/media/it_nlab/all.xml"; name = "ねとらぼ"; category = "サブカル"; order = 430 },
    @{ url = "https://news.yahoo.co.jp/rss/media/magmix/all.xml"; name = "マグミクス"; category = "サブカル"; order = 440 },
    @{ url = "https://news.yahoo.co.jp/rss/media/isd/all.xml"; name = "インサイド"; category = "サブカル"; order = 450 },
    @{ url = "https://automaton-media.com/feed/"; name = "AUTOMATON"; category = "サブカル"; order = 460 },
    @{ url = "http://kai-you.net/contents/feed.rss"; name = "KAI-YOU"; category = "サブカル"; order = 470 },
    @{ url = "https://www.moguravr.com/feed"; name = "Mogura VR / MoguLive"; category = "サブカル"; order = 480 },
    @{ url = "https://www.4gamer.net/rss/index.xml"; name = "4Gamer"; category = "サブカル"; order = 490 },
    @{ url = "https://game.watch.impress.co.jp/data/rss/1.0/gmw/feed.rdf"; name = "GAME Watch"; category = "サブカル"; order = 491 },

    # マネー (500-590)
    @{ url = "https://news.yahoo.co.jp/rss/topics/business.xml"; name = "Yahoo!経済"; category = "マネー"; order = 500 },
    @{ url = "https://news.yahoo.co.jp/rss/media/toyo/all.xml"; name = "東洋経済"; category = "マネー"; order = 510 },
    @{ url = "https://news.yahoo.co.jp/rss/media/diamond/all.xml"; name = "ダイヤモンド"; category = "マネー"; order = 520 },
    @{ url = "https://news.yahoo.co.jp/rss/media/moneyplus/all.xml"; name = "MONEY PLUS"; category = "マネー"; order = 530 },
    @{ url = "https://news.yahoo.co.jp/rss/media/president/all.xml"; name = "プレジデントオンライン"; category = "マネー"; order = 540 },
    @{ url = "https://news.yahoo.co.jp/rss/media/toushin/all.xml"; name = "LIMO"; category = "マネー"; order = 550 },
    @{ url = "https://news.yahoo.co.jp/rss/media/gonline/all.xml"; name = "THE GOLD ONLINE"; category = "マネー"; order = 560 },
    @{ url = "https://news.yahoo.co.jp/rss/media/finasee/all.xml"; name = "Finasee"; category = "マネー"; order = 570 },

    # IT・ガジェット (600-690)
    @{ url = "https://news.yahoo.co.jp/rss/topics/it.xml"; name = "Yahoo!IT"; category = "IT・ガジェット"; order = 600 },
    @{ url = "https://news.yahoo.co.jp/rss/media/ascii/all.xml"; name = "アスキー"; category = "IT・ガジェット"; order = 610 },
    @{ url = "https://news.yahoo.co.jp/rss/media/giz/all.xml"; name = "ギズモード"; category = "IT・ガジェット"; order = 620 },
    @{ url = "https://news.yahoo.co.jp/rss/media/impress/all.xml"; name = "Impress Watch"; category = "IT・ガジェット"; order = 630 },
    @{ url = "https://news.yahoo.co.jp/rss/media/zdn_n/all.xml"; name = "ITmedia NEWS"; category = "IT・ガジェット"; order = 640 },
    @{ url = "https://news.yahoo.co.jp/rss/media/zdn_m/all.xml"; name = "ITmedia Mobile"; category = "IT・ガジェット"; order = 650 },
    @{ url = "https://news.yahoo.co.jp/rss/media/imppcw/all.xml"; name = "PC Watch"; category = "IT・ガジェット"; order = 660 },
    @{ url = "https://news.yahoo.co.jp/rss/media/impktw/all.xml"; name = "ケータイ Watch"; category = "IT・ガジェット"; order = 670 }
)

$expectedCategories = @("トレンド", "エンタメ", "スポーツ", "サブカル", "マネー", "IT・ガジェット")
$duplicateUrls = @($presets | Group-Object { $_["url"] } | Where-Object { $_.Count -gt 1 })
$duplicateOrders = @($presets | Group-Object { $_["order"] } | Where-Object { $_.Count -gt 1 })
$invalidCategories = @($presets | Where-Object { $expectedCategories -notcontains $_.category })
if ($duplicateUrls.Count -gt 0 -or $duplicateOrders.Count -gt 0 -or $invalidCategories.Count -gt 0) {
    throw "Preset definition validation failed. No changes were made."
}

$headers = @{ "Authorization" = "Bearer $token"; "Content-Type" = "application/json" }
function Invoke-UpstashCommand([object[]]$command) {
    $json = $command | ConvertTo-Json -Compress
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $response = Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body $bodyBytes -ContentType "application/json"
    if ($response.error) { throw "Upstash error: $($response.error)" }
    return $response.result
}

Write-Host "Validating Upstash Redis presets ($($presets.Count) feeds)..."

# 既存プリセットを触る前に、全URLが共有マスターへ登録済みであることを確認する。
$missingUrls = @()
foreach ($p in $presets) {
    if ((Invoke-UpstashCommand @("SISMEMBER", "rss:urls", $p.url)) -ne 1) {
        $missingUrls += $p.url
    }
}
if ($missingUrls.Count -gt 0) {
    $missingUrls | ForEach-Object { Write-Warning "Not in rss:urls: $_" }
    throw "Master membership validation failed. No preset changes were made."
}

# 更新前データをローカルへ復元可能なJSONとして保存する（認証情報は含めない）。
$currentPresetUrls = @(Invoke-UpstashCommand @("SMEMBERS", "rss:presets"))
$backupMetaUrls = @($currentPresetUrls + @($presets | ForEach-Object { $_.url }) | Select-Object -Unique)
$backupMetas = @{}
foreach ($feedUrl in $backupMetaUrls) {
    $backupMetas[$feedUrl] = Invoke-UpstashCommand @("GET", "rss:meta:$feedUrl")
}
$backup = @{ created_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"); presets = $currentPresetUrls; metas = $backupMetas }
$backupDir = Join-Path $PSScriptRoot "backups"
if (!(Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
$backupPath = Join-Path $backupDir ("rss-presets-{0}.json" -f (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"))
$backup | ConvertTo-Json -Depth 8 | Set-Content -Path $backupPath -Encoding UTF8
Write-Host "Backup saved: $backupPath"

$tempPresetKey = "rss:presets:setup:$([Guid]::NewGuid().ToString('N'))"
foreach ($p in $presets) {
    try {
        $metaKey = "rss:meta:$($p.url)"
        $existing = Invoke-UpstashCommand @("GET", $metaKey)

        $meta = @{}
        if ($existing) {
            $obj = $existing | ConvertFrom-Json
            foreach ($prop in $obj.psobject.Properties) {
                $meta[$prop.Name] = $prop.Value
            }
        }

        $meta["url"] = $p.url
        $meta["category"] = $p.category
        $meta["display_order"] = $p.order
        if (!$meta.ContainsKey("source_name") -or [string]::IsNullOrWhiteSpace($meta["source_name"])) {
            $meta["source_name"] = $p.name
        }

        $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        $meta["updated_at"] = $now
        if (!$meta.ContainsKey("created_at")) { $meta["created_at"] = $now }

        $jsonMeta = $meta | ConvertTo-Json -Compress
        Invoke-UpstashCommand @("SET", $metaKey, $jsonMeta) | Out-Null
        Invoke-UpstashCommand @("SADD", $tempPresetKey, $p.url) | Out-Null
        Write-Host "  Success: [$($p.category)] $($p.name)"
    } catch {
        try { Invoke-UpstashCommand @("DEL", $tempPresetKey) | Out-Null } catch {}
        throw "Failed to process $($p.name): $($_.Exception.Message). rss:presets was not replaced."
    }
}

$stagedCount = Invoke-UpstashCommand @("SCARD", $tempPresetKey)
if ($stagedCount -ne $presets.Count) {
    Invoke-UpstashCommand @("DEL", $tempPresetKey) | Out-Null
    throw "Staged preset count mismatch ($stagedCount/$($presets.Count)). rss:presets was not replaced."
}

# RENAMEは置換を単一コマンドで行うため、空または途中までの一覧は公開されない。
Invoke-UpstashCommand @("RENAME", $tempPresetKey, "rss:presets") | Out-Null
$actualCount = Invoke-UpstashCommand @("SCARD", "rss:presets")
if ($actualCount -ne $presets.Count) { throw "Post-update preset count mismatch: $actualCount" }

Write-Host "`nPreset update completed ($actualCount feeds)."
