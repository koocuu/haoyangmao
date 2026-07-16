param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath,

  [double]$Scale = 1,

  [switch]$Json
)

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $ImagePath)) {
  throw "Image not found: $ImagePath"
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1)

function Await-WinRtOperation($Operation, [type]$ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $task = $asTask.Invoke($null, @($Operation))
  $task.Wait() | Out-Null
  return $task.Result
}

$absolutePath = [System.IO.Path]::GetFullPath($ImagePath)
$tempPath = $null

if ($Scale -gt 1) {
  Add-Type -AssemblyName System.Drawing
  $sourceImage = [System.Drawing.Image]::FromFile($absolutePath)
  try {
    $width = [Math]::Max(1, [int]($sourceImage.Width * $Scale))
    $height = [Math]::Max(1, [int]($sourceImage.Height * $Scale))
    $scaled = New-Object System.Drawing.Bitmap($width, $height)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($scaled)
      try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($sourceImage, 0, 0, $width, $height)
      } finally {
        $graphics.Dispose()
      }
      $tempPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "haoyangmao-ocr-$([System.Guid]::NewGuid().ToString('N')).png")
      $scaled.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $absolutePath = $tempPath
    } finally {
      $scaled.Dispose()
    }
  } finally {
    $sourceImage.Dispose()
  }
}

$file = Await-WinRtOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absolutePath)) ([Windows.Storage.StorageFile])
$stream = Await-WinRtOperation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await-WinRtOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-WinRtOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

if ($null -eq $engine) {
  throw "Windows OCR engine is not available for current user profile languages."
}

$result = Await-WinRtOperation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

if ($Json) {
  $lines = @()
  foreach ($line in $result.Lines) {
    $words = @()
    foreach ($word in $line.Words) {
      $rect = $word.BoundingRect
      $words += [pscustomobject]@{
        text = $word.Text
        x = [double]$rect.X
        y = [double]$rect.Y
        width = [double]$rect.Width
        height = [double]$rect.Height
      }
    }
    $lines += [pscustomobject]@{
      text = $line.Text
      words = $words
    }
  }

  [pscustomobject]@{
    text = $result.Text
    width = [int]$decoder.PixelWidth
    height = [int]$decoder.PixelHeight
    lines = $lines
  } | ConvertTo-Json -Depth 8
  if ($tempPath -and (Test-Path -LiteralPath $tempPath)) {
    Remove-Item -LiteralPath $tempPath -Force
  }
  return
}

Write-Output $result.Text

if ($tempPath -and (Test-Path -LiteralPath $tempPath)) {
  Remove-Item -LiteralPath $tempPath -Force
}
