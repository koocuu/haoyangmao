param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [int]$ChunkHeight = 900,

  [int]$Overlap = 180
)

if (-not (Test-Path -LiteralPath $ImagePath)) {
  throw "Image not found: $ImagePath"
}

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $OutputDir)) {
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

$absolutePath = [System.IO.Path]::GetFullPath($ImagePath)
$image = [System.Drawing.Image]::FromFile($absolutePath)

try {
  $index = 0
  $step = [Math]::Max(1, $ChunkHeight - $Overlap)
  for ($y = 0; $y -lt $image.Height; $y += $step) {
    $height = [Math]::Min($ChunkHeight, $image.Height - $y)
    $bitmap = New-Object System.Drawing.Bitmap $image.Width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.DrawImage($image, 0, 0, [System.Drawing.Rectangle]::new(0, $y, $image.Width, $height), [System.Drawing.GraphicsUnit]::Pixel)
    $outputPath = Join-Path $OutputDir ("chunk-{0:D3}.png" -f $index)
    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
    Write-Output $outputPath
    $index += 1
  }
}
finally {
  $image.Dispose()
}
