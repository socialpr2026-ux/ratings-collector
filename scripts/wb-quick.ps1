$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$brands = @('Арбидол','Кагоцел','Рафамин','Эргоферон','Анаферон','Гриппферон','Ингавирин','Циклоферон','Полиоксидоний','Трекрезан','Цитовир-3','Бронхо-мунал','Амиксин','Номидес','Триазавирин','Нобазит','Исмиген')
$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(30)
$byId = @{}
$errors = [System.Collections.Generic.List[object]]::new()

function Normalize-Brand([string]$value) {
  if ($null -eq $value) { return '' }
  return (($value.ToLowerInvariant().Replace('ё','е')) -replace '[^a-zа-я0-9]+','')
}

function Get-Page([string]$brand, [int]$page) {
  $encoded = [Uri]::EscapeDataString($brand)
  $url = "https://u-search.wb.ru/exactmatch/ru/common/v18/search?ab_testing=false&appType=1&curr=rub&dest=-1257786&hide_dtype=13&lang=ru&page=$page&query=$encoded&resultset=catalog&sort=popular&spp=30&suppressSpellcheck=false"
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $url)
    [void]$request.Headers.TryAddWithoutValidation('accept','application/json, text/plain, */*')
    [void]$request.Headers.TryAddWithoutValidation('accept-language','ru-RU,ru;q=0.9')
    [void]$request.Headers.TryAddWithoutValidation('referer','https://www.wildberries.ru/')
    [void]$request.Headers.TryAddWithoutValidation('user-agent','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36')
    try {
      $response = $client.SendAsync($request).GetAwaiter().GetResult()
      $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if ($response.IsSuccessStatusCode) { return $body | ConvertFrom-Json }
      if ([int]$response.StatusCode -notin @(403,429,498) -or $attempt -eq 3) { throw "WB HTTP $([int]$response.StatusCode)" }
    } finally {
      $request.Dispose()
      if ($null -ne $response) { $response.Dispose() }
    }
    Start-Sleep -Milliseconds (250 * $attempt)
  }
}

try {
  foreach ($brand in $brands) {
    $seenPages = @{}
    $rawSeen = 0
    try {
      for ($page = 1; $page -le 50; $page++) {
        $result = Get-Page $brand $page
        $products = @($result.products)
        if ($products.Count -eq 0) { break }
        $signature = ($products | ForEach-Object { [string]$_.id }) -join ','
        if ($seenPages.ContainsKey($signature)) { break }
        $seenPages[$signature] = $true
        $rawSeen += $products.Count
        $needle = Normalize-Brand $brand
        foreach ($product in $products) {
          $id = [string]$product.id
          $title = [string]$product.name
          $rawBrand = [string]$product.brand
          if ($id -notmatch '^\d+$' -or [string]::IsNullOrWhiteSpace($title)) { continue }
          if ((Normalize-Brand "$title $rawBrand") -notlike "*$needle*") { continue }
          $reviews = [int]$product.nmFeedbacks
          $rating = [double]$product.nmReviewRating
          if ($reviews -lt 0 -or ($reviews -gt 0 -and ($rating -le 0 -or $rating -gt 5))) {
            $errors.Add([pscustomobject]@{brand=$brand;listingId=$id;error='invalid nm-specific metrics'})
            continue
          }
          if ($byId.ContainsKey($id) -and $byId[$id].brand -ne $brand) {
            $errors.Add([pscustomobject]@{brand=$brand;listingId=$id;error="duplicate with $($byId[$id].brand)"})
            continue
          }
          $byId[$id] = [pscustomobject]@{
            domain='wildberries.ru'; platform='wildberries'; listingId=$id; brand=$brand
            canonicalUrl="https://www.wildberries.ru/catalog/$id/detail.aspx"; product=$title
            reviews=$reviews; rating=$(if($reviews -eq 0){$null}else{$rating}); rawRating=$(if($reviews -eq 0){$null}else{$rating})
            rawRatingScale=5; status=$(if($reviews -eq 0){'no_reviews'}else{'ok'}); capturedAt=[DateTime]::UtcNow.ToString('o')
            groupId=[string]$product.root; source='wildberries-u-search-v18-urgent'
          }
        }
        if ($null -ne $result.total -and $rawSeen -ge [int]$result.total) { break }
      }
    } catch {
      $errors.Add([pscustomobject]@{brand=$brand;error=$_.Exception.Message})
    }
  }
} finally {
  $client.Dispose()
}

$observations = @($byId.Values | Sort-Object @{Expression={$brands.IndexOf($_.brand)}}, product, @{Expression={[long]$_.listingId}})
New-Item -ItemType Directory -Path outputs -Force | Out-Null
$observations | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 outputs/wb-quick.json
$errors | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 outputs/wb-quick-errors.json
[pscustomobject]@{collected=$observations.Count;errors=$errors.Count;byBrand=[ordered]@{}} | ConvertTo-Json -Compress
