# Captura a janela da ilha durante o modo --reel e grava os pixels crus.
#
#   powershell -ExecutionPolicy Bypass -File scripts/record-reel.ps1
#
# Grava BGRA cru em vez de PNG por frame: codificar PNG dentro do laco derruba
# a taxa para uns 10fps, e a mola da animacao vive nos primeiros 200ms de cada
# morph -- e justamente ali que a taxa importa.
#
# O modo --reel desenha um fundo proprio, entao a captura nao pega nada do que
# estiver atras da janela transparente.
#
# Sem acentos de proposito: o PowerShell 5.1 le .ps1 sem BOM como ANSI, e
# caractere acentuado quebra o parser.

param(
    [int]$Fps = 20,
    [double]$Seconds = 15.5,
    [string]$Out = "$env:TEMP\perch-reel"
)

Add-Type -AssemblyName System.Drawing, System.Windows.Forms

# A janela tem tamanho e posicao fixos (WIN_WIDTH/WIN_HEIGHT no main).
# A captura e em pixels fisicos, entao a escala de DPI entra na conta.
$logicalW = 760
$logicalH = 360
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

Add-Type @"
using System;using System.Runtime.InteropServices;
public class DpiProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc,int i);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h,IntPtr dc);
}
"@ -ErrorAction SilentlyContinue

$dc = [DpiProbe]::GetDC([IntPtr]::Zero)
$physW = [DpiProbe]::GetDeviceCaps($dc, 118)
[DpiProbe]::ReleaseDC([IntPtr]::Zero, $dc) | Out-Null
$scale = $physW / $screen.Width

$w = [int]($logicalW * $scale)
$h = [int]($logicalH * $scale)
$x = [int]((($screen.Width - $logicalW) / 2) * $scale)
$y = 0

$frames = [int]($Fps * $Seconds)
$interval = 1000.0 / $Fps

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$rawPath = Join-Path $Out 'frames.raw'
$stream = [System.IO.File]::Create($rawPath)

$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$size = New-Object System.Drawing.Size($w, $h)
$buffer = New-Object byte[] ($w * $h * 4)

Write-Host "capturando ${w}x${h} em ($x,$y) - $frames frames a ${Fps}fps"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$captured = 0

for ($i = 0; $i -lt $frames; $i++) {
    $target = $i * $interval
    $wait = $target - $sw.Elapsed.TotalMilliseconds
    if ($wait -gt 1) { Start-Sleep -Milliseconds ([int]$wait) }

    $gfx.CopyFromScreen($x, $y, 0, 0, $size)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buffer, 0, $buffer.Length)
    $bmp.UnlockBits($data)
    $stream.Write($buffer, 0, $buffer.Length)
    $captured++
}

$sw.Stop()
$stream.Close()
$gfx.Dispose()
$bmp.Dispose()

$elapsed = $sw.Elapsed.TotalSeconds
$real = [math]::Round($captured / $elapsed, 1)
$took = [math]::Round($elapsed, 1)
$mb = [math]::Round((Get-Item $rawPath).Length / 1MB)

$meta = @{ width = $w; height = $h; frames = $captured; fps = $real }
$meta | ConvertTo-Json | Set-Content (Join-Path $Out 'meta.json') -Encoding ascii

Write-Host "  $captured frames em $took s  =>  $real fps reais"
Write-Host "  $rawPath  -  $mb MB"
