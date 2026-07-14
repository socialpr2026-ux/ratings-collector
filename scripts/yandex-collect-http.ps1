$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::DefaultConnectionLimit = 16
Add-Type -AssemblyName System.Net.Http

$seeds = Get-Content -Raw -Encoding UTF8 'outputs\yandex-quick-errors.json' | ConvertFrom-Json
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(35)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36')
$client.DefaultRequestHeaders.AcceptLanguage.ParseAdd('ru-RU,ru;q=0.9,en;q=0.7')
$client.DefaultRequestHeaders.Accept.ParseAdd('text/html,application/xhtml+xml')

$observations = New-Object System.Collections.Generic.List[object]
$errors = New-Object System.Collections.Generic.List[object]
$batchSize = 8

for ($start = 0; $start -lt $seeds.Count; $start += $batchSize) {
  $end = [Math]::Min($start + $batchSize - 1, $seeds.Count - 1)
  $batch = @($seeds[$start..$end])
  $tasks = @($batch | ForEach-Object { $client.GetStringAsync([string]$_.url) })

  for ($i = 0; $i -lt $batch.Count; $i += 1) {
    $seed = $batch[$i]
    try {
      $html = $tasks[$i].GetAwaiter().GetResult()
      $match = [regex]::Match(
        $html,
        '<script\b[^>]*\btype\s*=\s*(?:"application/ld\+json"|''application/ld\+json''|application/ld\+json)[^>]*>([\s\S]*?)</script>',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
      )
      if (-not $match.Success) { throw 'No JSON-LD Product (block or parser drift)' }
      $product = $match.Groups[1].Value | ConvertFrom-Json
      if ($product.'@type' -ne 'Product') { throw 'JSON-LD root is not Product' }
      $aggregate = $product.aggregateRating
      if ($null -eq $aggregate) {
        $reviewCount = 0
        $rating = $null
        $ratingCount = $null
        $status = 'no_reviews'
      } else {
        if ($null -eq $aggregate.reviewCount -or [string]$aggregate.reviewCount -notmatch '^\d+$') {
          throw 'AggregateRating reviewCount missing or invalid'
        }
        $reviewCount = [int]$aggregate.reviewCount
        $ratingCount = if ($null -ne $aggregate.ratingCount -and [string]$aggregate.ratingCount -match '^\d+$') { [int]$aggregate.ratingCount } else { $null }
        $rating = if ($null -ne $aggregate.ratingValue) {
          [double]::Parse([string]$aggregate.ratingValue, [Globalization.CultureInfo]::InvariantCulture)
        } else { $null }
        $status = if ($reviewCount -eq 0) { 'no_reviews' } else { 'ok' }
      }
      $canonical = [regex]::Match(
        $html,
        '<link\b(?=[^>]*\brel\s*=\s*["'']canonical["''])(?=[^>]*\bhref\s*=\s*["'']([^"'']+)["''])[^>]*>',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
      )
      $canonicalUrl = if ($canonical.Success) { $canonical.Groups[1].Value -replace '\?.*$', '' } else { [string]$seed.url }
      $observations.Add([ordered]@{
        domain = 'market.yandex.ru'
        platform = 'yandex'
        listingId = [string]$seed.listingId
        brand = [string]$seed.brand
        canonicalUrl = $canonicalUrl
        product = [string]$product.name
        reviews = $reviewCount
        rating = $rating
        rawRating = $rating
        rawRatingScale = 5
        ratingCount = $ratingCount
        status = $status
        capturedAt = [DateTime]::UtcNow.ToString('o')
        evidenceRef = "$canonicalUrl#json-ld"
        source = 'yandex_reviews_json_ld'
      })
    } catch {
      $errors.Add([ordered]@{
        listingId = [string]$seed.listingId
        brand = [string]$seed.brand
        url = [string]$seed.url
        error = $_.Exception.Message
      })
    }
  }
  [Console]::Error.WriteLine("COLLECT $($end + 1)/$($seeds.Count); ok=$($observations.Count); errors=$($errors.Count)")
}

$sorted = @($observations | Sort-Object brand, product, listingId)
$sortedErrors = @($errors | Sort-Object brand, listingId)
[IO.File]::WriteAllText((Join-Path $PWD 'outputs\yandex-quick.json'), (($sorted | ConvertTo-Json -Depth 10) + "`n"), (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $PWD 'outputs\yandex-quick-errors.json'), (($sortedErrors | ConvertTo-Json -Depth 10) + "`n"), (New-Object Text.UTF8Encoding($false)))
$summary = [ordered]@{ collected = $sorted.Count; errors = $sortedErrors.Count }
$summary | ConvertTo-Json -Compress

$client.Dispose()
$handler.Dispose()
