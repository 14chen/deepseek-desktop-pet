<#
.SYNOPSIS
  Screenshot the desktop pet window, or the whole desktop.

.DESCRIPTION
  Used by `node bin/pet.mjs capture` and by the automated end-to-end test, which
  needs pixel evidence that the mascot is genuinely drawn on the desktop rather
  than merely present as a window handle.

  The pet window has no title bar and is hidden from the taskbar, so it is
  located by enumerating top-level windows for the title set by the window
  script, then cropped with a margin so the shadow and speech bubble are
  included.

.PARAMETER Out
  Destination PNG path.

.PARAMETER Full
  Capture the entire virtual screen instead of cropping to the pet window.

.PARAMETER Margin
  Extra pixels around the pet window rectangle.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [switch]$Full,
  [int]$Margin = 70
)

$ErrorActionPreference = 'Stop'

# A stale LIB/INCLUDE on some machines turns Add-Type warnings into errors.
$env:LIB = ''
$env:INCLUDE = ''
$env:LIBPATH = ''

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$env:LIB = ''
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PetWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$targets = @('DeepSeek Pet')

function Get-PetRect {
  $found = [IntPtr]::Zero
  $rect = New-Object PetWin+RECT
  $cb = [PetWin+EnumWindowsProc] {
    param($hWnd, $lParam)
    if (-not [PetWin]::IsWindowVisible($hWnd)) { return $true }
    $sb = New-Object System.Text.StringBuilder 256
    [void][PetWin]::GetWindowTextW($hWnd, $sb, 256)
    if ($targets -contains $sb.ToString()) {
      $r = New-Object PetWin+RECT
      if ([PetWin]::GetWindowRect($hWnd, [ref]$r)) {
        $script:found = $hWnd
        $script:rect = $r
      }
      return $false
    }
    return $true
  }
  $script:found = [IntPtr]::Zero
  $script:rect = New-Object PetWin+RECT
  [void][PetWin]::EnumWindows($cb, [IntPtr]::Zero)
  return @{ Handle = $script:found; Rect = $script:rect }
}

$bitmap = $null
$bounds = $null

if (-not $Full) {
  $probe = Get-PetRect
  if ($probe.Handle -ne [IntPtr]::Zero) {
    $r = $probe.Rect
    $bounds = New-Object System.Drawing.Rectangle(
      ($r.Left - $Margin),
      ($r.Top - $Margin),
      (($r.Right - $r.Left) + ($Margin * 2)),
      (($r.Bottom - $r.Top) + ($Margin * 2))
    )
    Write-Output "capture: pet window at ($($r.Left),$($r.Top)) size $($r.Right - $r.Left)x$($r.Bottom - $r.Top)"
  } else {
    Write-Output 'capture: no pet window found; falling back to the full screen'
  }
}

if ($null -eq $bounds) {
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bounds = New-Object System.Drawing.Rectangle($screen.X, $screen.Y, $screen.Width, $screen.Height)
  Write-Output "capture: full screen $($bounds.Width)x$($bounds.Height)"
}

# Clamp to the virtual screen so CopyFromScreen cannot be handed an invalid rect.
$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
$left = [Math]::Max($virtual.Left, $bounds.Left)
$top = [Math]::Max($virtual.Top, $bounds.Top)
$right = [Math]::Min($virtual.Right, $bounds.Right)
$bottom = [Math]::Min($virtual.Bottom, $bounds.Bottom)
$width = [Math]::Max(1, $right - $left)
$height = [Math]::Max(1, $bottom - $top)

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
$graphics.Dispose()

$directory = Split-Path -Parent $Out
if ($directory -and -not (Test-Path -LiteralPath $directory)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Output "capture: saved $Out ($width x $height)"
