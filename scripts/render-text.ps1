param(
  [string]$text,
  [string]$outPath,
  [int]$width = 1200,
  [int]$fontSize = 18,
  [int]$maxHeight = 7800  # DeepSeek 视觉 API 长边限制约 8192(实测 8124 过 / 9842 拒),留安全余量
)
Add-Type -AssemblyName System.Drawing

$font = New-Object System.Drawing.Font("Microsoft YaHei", $fontSize)
$padding = 40
$usableWidth = $width - $padding
$budget = $maxHeight - $padding

function Get-LineHeight([string]$s, $g, $f, $w) {
  $h = [Math]::Ceiling($g.MeasureString($s, $f, $w).Height)
  if ($h -lt $f.Size + 4) { $h = [int]$f.Size + 4 }  # 空行兜底
  return $h
}

# 单个逻辑行超过单页预算时,二分切分成多个块(每块高度 <= budget)
function Split-LongLine([string]$line, $g, $f, $w, [int]$budget) {
  $result = New-Object System.Collections.Generic.List[string]
  $remaining = $line
  while ($remaining.Length -gt 0) {
    if ((Get-LineHeight $remaining $g $f $w) -le $budget) { $result.Add($remaining); break }
    $lo = 1
    $hi = $remaining.Length
    while ($lo -lt $hi) {
      $mid = [Math]::Ceiling(($lo + $hi) / 2)
      if ((Get-LineHeight ($remaining.Substring(0, $mid)) $g $f $w) -le $budget) { $lo = $mid } else { $hi = $mid - 1 }
    }
    $result.Add($remaining.Substring(0, $lo))
    $remaining = $remaining.Substring($lo)
  }
  return $result
}

# ---- 1) 逐逻辑行测量换行后高度,贪心打包成页(每页总高 <= maxHeight) ----
$probe = [System.Drawing.Bitmap]::new(1, 1)
$g = [System.Drawing.Graphics]::FromImage($probe)
$rawLines = $text -split "`r?`n"
$pages = New-Object System.Collections.Generic.List[string]
$cur = New-Object System.Text.StringBuilder
$curH = 0
foreach ($line in $rawLines) {
  $lineH = Get-LineHeight $line $g $font $usableWidth
  if ($lineH -gt $budget) {
    # 无换行的超长单行:先落当前页,再二分切行逐块成页
    if ($cur.Length -gt 0) {
      $pages.Add($cur.ToString())
      $cur = New-Object System.Text.StringBuilder
      $curH = 0
    }
    foreach ($chunk in (Split-LongLine $line $g $font $usableWidth $budget)) { $pages.Add($chunk) }
    continue
  }
  # 与渲染步骤同一种测量:直接测“候选整页文本”的高度,避免逐行求和误差
  $candidate = $cur.ToString()
  if ($candidate.Length -gt 0) { $candidate += "`r`n" }
  $candidate += $line
  $candH = Get-LineHeight $candidate $g $font $usableWidth
  if ($cur.Length -gt 0 -and $candH -gt $budget) {
    $pages.Add($cur.ToString())
    $cur = New-Object System.Text.StringBuilder
    $curH = 0
  }
  if ($cur.Length -gt 0) { [void]$cur.Append("`r`n") }
  [void]$cur.Append($line)
  $curH = Get-LineHeight $cur.ToString() $g $font $usableWidth
}
if ($cur.Length -gt 0) { $pages.Add($cur.ToString()) }
if ($pages.Count -eq 0) { $pages.Add('') }
$g.Dispose()
$probe.Dispose()

if ($pages.Count -gt 40) {
  Write-Error "too many pages: $($pages.Count)"
  exit 2
}

# ---- 2) 逐页渲染:第 1 页写 outPath,后续页写 <base>-p2.png / -p3.png ... ----
$ext = [System.IO.Path]::GetExtension($outPath)
$base = if ($ext.Length -gt 0) { $outPath.Substring(0, $outPath.Length - $ext.Length) } else { $outPath }
$totalBytes = 0
$paths = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $pages.Count; $i++) {
  $pagePath = if ($i -eq 0) { $outPath } else { "$base-p$($i + 1)$ext" }
  $pageText = $pages[$i]

  $probe2 = [System.Drawing.Bitmap]::new(1, 1)
  $g2 = [System.Drawing.Graphics]::FromImage($probe2)
  $size = $g2.MeasureString($pageText, $font, $usableWidth)
  $g2.Dispose()
  $probe2.Dispose()

  $h = [Math]::Ceiling($size.Height) + $padding
  if ($h -lt 200) { $h = 200 }
  if ($h -gt $maxHeight) { $h = $maxHeight }  # 安全兜底,不应触发

  $bmp = New-Object System.Drawing.Bitmap $width, $h
  $g3 = [System.Drawing.Graphics]::FromImage($bmp)
  $g3.Clear([System.Drawing.Color]::White)
  $rect = New-Object System.Drawing.RectangleF(20, 20, ($width - 40), ($h - 40))
  $g3.DrawString($pageText, $font, [System.Drawing.Brushes]::Black, $rect)
  $g3.Dispose()
  $bmp.Save($pagePath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  $totalBytes += (Get-Item $pagePath).Length
  $paths.Add($pagePath)
}

# 输出协议:首行 "OK <总字节> h=<页数> pages=<页数>",随后每行一个分页文件路径
Write-Output ("OK " + $totalBytes + " h=" + $pages.Count + " pages=" + $pages.Count)
foreach ($p in $paths) { Write-Output $p }
