<#
.SYNOPSIS
  DeepSeek Harness desktop pet - a real, transparent, always-on-top mascot.

.DESCRIPTION
  Renders the pet as a frameless, per-pixel-transparent window that floats above
  every other window and never appears in the taskbar or Alt+Tab.

  The window is deliberately dumb: it never opens a socket. It polls a small
  JSON snapshot the host plugin writes, and appends one JSON line per user
  interaction to an action log the host drains. That keeps the boundary trivial
  to test and immune to port conflicts, firewalls and DSH's own authentication.

  IMPORTANT: this file is deliberately pure ASCII. Windows PowerShell 5.1
  decodes a .ps1 file without a UTF-8 BOM using the system ANSI codepage, which
  mangles non-ASCII text and can even break parsing. All user-facing strings,
  including every Chinese label, therefore arrive through the JSON config
  (`labels`), which is read with an explicit -Encoding UTF8.

  Requires Windows PowerShell 5.1 (WPF ships with .NET Framework). Run with
  -STA; WPF refuses to build a window on an MTA thread.

.PARAMETER ConfigPath
  Path to the JSON config the host plugin writes (desktop.json).

.PARAMETER Probe
  Build the whole visual tree, report the window's real Win32 state as JSON,
  and exit. This is how the automated tests assert that the pet is genuinely
  transparent and on top without a human looking at the screen.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Diagnostics, set up before anything else can fail
# ---------------------------------------------------------------------------
# The window is launched by a host process with no console, so an unhandled
# error would otherwise vanish without a trace. The log is opened first, using
# only cmdlets that need no extra assembly, and the whole body runs inside a
# trap that records the failure before the process exits.
$script:logFile = $null
try {
  $preConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $preLog = $preConfig.PSObject.Properties['logFile']
  if ($null -ne $preLog -and $preLog.Value -is [string] -and $preLog.Value.Length -gt 0) {
    $script:logFile = $preLog.Value
  }
} catch { }

if (-not $script:logFile) { $script:logFile = "$ConfigPath.log" }

function Write-PetLog {
  param([string]$Message, [string]$Level = 'info')
  $line = "[{0}] {1} {2}" -f (Get-Date).ToString('HH:mm:ss.fff'), $Level.ToUpperInvariant(), $Message
  try {
    [System.IO.File]::AppendAllText($script:logFile, "$line`r`n", [System.Text.UTF8Encoding]::new($false))
  } catch { }
  Write-Verbose $line
}

trap {
  $detail = "$($_.Exception.GetType().Name): $($_.Exception.Message) at $($_.InvocationInfo.PositionMessage)"
  Write-PetLog $detail 'ERROR'
  Write-PetLog $_.ScriptStackTrace 'ERROR'
  # The log file may be unwritable (a missing config directory, for example), so
  # the failure also goes to stderr where the caller is guaranteed to see it.
  try {
    [Console]::Error.WriteLine("desktop-pet: $detail")
  } catch { }
  exit 1
}

Write-PetLog "script entered (pid=$PID, ps=$($PSVersionTable.PSVersion), config=$ConfigPath)"

# ---------------------------------------------------------------------------
# Environment quirks
# ---------------------------------------------------------------------------
# Some Windows machines carry a stale LIB/INCLUDE pointing at an uninstalled
# Visual Studio, which makes any Add-Type compilation fail as a warning-as-error.
# Nothing here needs the C++ toolchain, so neutralize them defensively.
$env:LIB = ''
$env:INCLUDE = ''
$env:LIBPATH = ''

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Write-PetLog 'WPF assemblies loaded'

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "desktop-pet: config not found: $ConfigPath"
}
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Get-ConfigValue {
  param([string]$Name, $Default)
  $property = $config.PSObject.Properties[$Name]
  if ($null -ne $property -and $null -ne $property.Value) { return $property.Value }
  return $Default
}

Write-PetLog "config parsed ($ConfigPath)"

# ASCII defaults; the host supplies the localized text through config.labels.
$ui = @{
  greeting        = 'Hello! Poke me if you need anything.'
  dragReaction    = 'Nice view from here!'
  trayTooltip     = 'DeepSeek Pet'
  trayShowHide    = 'Show / hide pet'
  trayOpenPage    = 'Open pet page'
  trayOpenDsh     = 'Open DSH'
  trayRefreshQuota = 'Refresh quota'
  trayQuit        = 'Quit'
  menuGreet       = 'Say hello'
  menuQuota       = 'Check quota'
  menuOpenPage    = 'Open pet page'
  menuFocus       = 'Focus 25 min'
  menuStopTimer   = 'Stop timer'
  menuQuiet       = 'Quiet for a while'
  menuOpenDsh     = 'Open DSH'
  menuHide        = 'Hide pet'
  menuQuit        = 'Quit pet'
  tooltipLevel    = 'Level'
  tooltipBalance  = 'Balance'
  tooltipToday    = 'Done today'
  tooltipTasks    = 'task(s)'
  tooltipAffection = 'Affection'
  tooltipTimer    = 'Timer'
  tooltipMinutes  = 'm'
  tooltipSeconds  = 's'
  reading         = 'reading...'
}
$labelProperty = $config.PSObject.Properties['labels']
if ($null -ne $labelProperty -and $null -ne $labelProperty.Value) {
  foreach ($key in @($ui.Keys)) {
    $value = $labelProperty.Value.PSObject.Properties[$key]
    if ($null -ne $value -and $value.Value -is [string] -and $value.Value.Length -gt 0) {
      $ui[$key] = $value.Value
    }
  }
}

$liveFile = Get-ConfigValue 'liveFile' $null
$actionsFile = Get-ConfigValue 'actionsFile' $null
$commandFile = Get-ConfigValue 'commandFile' $null
$assetsDir = Get-ConfigValue 'assetsDir' (Join-Path $PSScriptRoot 'assets')
$imageName = Get-ConfigValue 'image' 'pet.png'
$baseWidth = [double](Get-ConfigValue 'width' 220)
$baseHeight = [double](Get-ConfigValue 'height' 220)
$scale = [double](Get-ConfigValue 'scale' 1.0)
$startX = Get-ConfigValue 'x' $null
$startY = Get-ConfigValue 'y' $null
$alwaysOnTop = [bool](Get-ConfigValue 'alwaysOnTop' $true)
$soundEnabled = [bool](Get-ConfigValue 'sound' $false)
$dsUrl = [string](Get-ConfigValue 'dsUrl' '')
$pollMs = [int](Get-ConfigValue 'pollMs' 600)
$startMinimized = [bool](Get-ConfigValue 'startMinimized' $false)

if ($scale -le 0) { $scale = 1.0 }
$scale = [Math]::Min(3.0, [Math]::Max(0.5, $scale))

# Reserve a band above the pet for the speech bubble.
$bubbleBand = [Math]::Round(96 * [Math]::Max(1.0, $scale))
$winWidth = [Math]::Round($baseWidth * $scale)
$winHeight = [Math]::Round($baseHeight * $scale) + $bubbleBand

# ---------------------------------------------------------------------------
# Image loading
# ---------------------------------------------------------------------------
function Resolve-PetImage {
  param([string]$Directory, [string]$Name)

  $candidates = New-Object System.Collections.ArrayList
  [void]$candidates.Add((Join-Path $Directory $Name))
  [void]$candidates.Add((Join-Path $Directory 'pet.png'))
  [void]$candidates.Add((Join-Path $Directory 'pet-fallback.png'))

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      try {
        $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
        $bitmap.BeginInit()
        # OnLoad avoids holding a file lock, and CacheOption keeps the decoded
        # pixels so the source file can be replaced while the pet is running.
        $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bitmap.CreateOptions = [System.Windows.Media.Imaging.BitmapCreateOptions]::IgnoreImageCache
        $bitmap.UriSource = New-Object System.Uri($candidate, [System.UriKind]::Absolute)
        $bitmap.EndInit()
        $bitmap.Freeze()
        return $bitmap
      } catch {
        Write-Warning "desktop-pet: cannot decode $candidate : $($_.Exception.Message)"
      }
    }
  }
  return $null
}

$petBitmap = Resolve-PetImage -Directory $assetsDir -Name $imageName

# ---------------------------------------------------------------------------
# Visual tree, built in code rather than XAML: no namescope surprises, and the
# layout depends on runtime values anyway.
# ---------------------------------------------------------------------------
$window = New-Object System.Windows.Window
$window.Title = 'DeepSeek Pet'
$window.WindowStyle = [System.Windows.WindowStyle]::None
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $alwaysOnTop
$window.ShowInTaskbar = $false
$window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$window.SizeToContent = [System.Windows.SizeToContent]::Manual
$window.Width = $winWidth
$window.Height = $winHeight
$window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
$window.UseLayoutRounding = $true
$window.SnapsToDevicePixels = $true

# Place the window. Default to the lower-right corner of the primary work area.
$workArea = [System.Windows.SystemParameters]::WorkArea
if ($null -ne $startX -and $null -ne $startY) {
  $window.Left = [double]$startX
  $window.Top = [double]$startY
} else {
  $window.Left = $workArea.Right - $winWidth - 24
  $window.Top = $workArea.Bottom - $winHeight - 24
}

$root = New-Object System.Windows.Controls.Grid
$root.Background = [System.Windows.Media.Brushes]::Transparent

$rowBubble = New-Object System.Windows.Controls.RowDefinition
$rowBubble.Height = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
$rowPet = New-Object System.Windows.Controls.RowDefinition
$rowPet.Height = New-Object System.Windows.GridLength($winHeight - $bubbleBand)
[void]$root.RowDefinitions.Add($rowBubble)
[void]$root.RowDefinitions.Add($rowPet)

# --- speech bubble -------------------------------------------------------
$bubble = New-Object System.Windows.Controls.Border
$bubble.CornerRadius = New-Object System.Windows.CornerRadius(14)
$bubble.Padding = New-Object System.Windows.Thickness(12, 8, 12, 8)
$bubble.Margin = New-Object System.Windows.Thickness(6, 4, 6, 2)
$bubble.VerticalAlignment = [System.Windows.VerticalAlignment]::Bottom
$bubble.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Stretch
$bubble.MaxWidth = [Math]::Max(240, $winWidth + 60)
$bubble.Opacity = 0
$bubble.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(242, 32, 36, 46))
$bubble.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(120, 120, 190, 255))
$bubble.BorderThickness = New-Object System.Windows.Thickness(1)
$bubble.Effect = New-Object System.Windows.Media.Effects.DropShadowEffect -Property @{
  BlurRadius = 16; ShadowDepth = 2; Opacity = 0.45; Color = [System.Windows.Media.Colors]::Black
}

$bubbleText = New-Object System.Windows.Controls.TextBlock
$bubbleText.TextWrapping = [System.Windows.TextWrapping]::Wrap
$bubbleText.FontSize = [Math]::Round(12.5 * [Math]::Max(1.0, $scale))
$bubbleText.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 235, 240, 250))
$bubbleText.TextAlignment = [System.Windows.TextAlignment]::Center
$bubble.Child = $bubbleText
[System.Windows.Controls.Grid]::SetRow($bubble, 0)
[void]$root.Children.Add($bubble)

# --- pet -----------------------------------------------------------------
$petHost = New-Object System.Windows.Controls.Grid
$petHost.Background = [System.Windows.Media.Brushes]::Transparent
$petHost.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 1.0)

$transformGroup = New-Object System.Windows.Media.TransformGroup
$scaleTransform = New-Object System.Windows.Media.ScaleTransform(1, 1)
$translateTransform = New-Object System.Windows.Media.TranslateTransform(0, 0)
$rotateTransform = New-Object System.Windows.Media.RotateTransform(0, 0.5, 1.0)
[void]$transformGroup.Children.Add($scaleTransform)
[void]$transformGroup.Children.Add($rotateTransform)
[void]$transformGroup.Children.Add($translateTransform)
$petHost.RenderTransform = $transformGroup

if ($null -ne $petBitmap) {
  $image = New-Object System.Windows.Controls.Image
  $image.Source = $petBitmap
  $image.Stretch = [System.Windows.Media.Stretch]::Uniform
  $image.Width = $baseWidth * $scale
  $image.Height = $baseHeight * $scale
  # BitmapScalingMode is an attached property, so it is set through the static
  # setter rather than read off the element.
  [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($image, [System.Windows.Media.BitmapScalingMode]::HighQuality)
  $image.Effect = New-Object System.Windows.Media.Effects.DropShadowEffect -Property @{
    BlurRadius = 22; ShadowDepth = 6; Opacity = 0.4; Color = [System.Windows.Media.Colors]::Black
  }
  [void]$petHost.Children.Add($image)
} else {
  # Last-resort art so the pet is never invisible, even with no assets at all.
  $fallback = New-Object System.Windows.Controls.Border
  $fallback.Width = $baseWidth * $scale
  $fallback.Height = $baseHeight * $scale
  $fallback.CornerRadius = New-Object System.Windows.CornerRadius(48)
  $fallback.Background = New-Object System.Windows.Media.LinearGradientBrush(
    [System.Windows.Media.Color]::FromArgb(255, 90, 160, 255),
    [System.Windows.Media.Color]::FromArgb(255, 60, 90, 220),
    90.0)
  $fallbackText = New-Object System.Windows.Controls.TextBlock
  $fallbackText.Text = ':3'
  $fallbackText.FontSize = 64
  $fallbackText.Foreground = [System.Windows.Media.Brushes]::White
  $fallbackText.HorizontalAlignment = 'Center'
  $fallbackText.VerticalAlignment = 'Center'
  $fallback.Child = $fallbackText
  [void]$petHost.Children.Add($fallback)
}

[System.Windows.Controls.Grid]::SetRow($petHost, 1)
[void]$root.Children.Add($petHost)

$window.Content = $root

# ---------------------------------------------------------------------------
# Ambient animation: a slow breath plus a gentle bob, so the pet reads as alive
# even when nothing is happening.
# ---------------------------------------------------------------------------
$breathStoryboard = New-Object System.Windows.Media.Animation.Storyboard
$breatheX = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 1.035, [TimeSpan]::FromSeconds(1.9))
$breatheY = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 1.055, [TimeSpan]::FromSeconds(1.9))
$breatheX.AutoReverse = $true
$breatheY.AutoReverse = $true
$breatheX.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
$breatheY.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
$breatheX.EasingFunction = New-Object System.Windows.Media.Animation.SineEase
$breatheY.EasingFunction = New-Object System.Windows.Media.Animation.SineEase

$bob = New-Object System.Windows.Media.Animation.DoubleAnimation(0, -5, [TimeSpan]::FromSeconds(2.4))
$bob.AutoReverse = $true
$bob.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
$bob.EasingFunction = New-Object System.Windows.Media.Animation.SineEase

$pathScaleX = New-Object System.Windows.PropertyPath('ScaleX')
$pathScaleY = New-Object System.Windows.PropertyPath('ScaleY')
$pathOffsetY = New-Object System.Windows.PropertyPath('Y')

[System.Windows.Media.Animation.Storyboard]::SetTarget($breatheX, $scaleTransform)
[System.Windows.Media.Animation.Storyboard]::SetTargetProperty($breatheX, $pathScaleX)
[System.Windows.Media.Animation.Storyboard]::SetTarget($breatheY, $scaleTransform)
[System.Windows.Media.Animation.Storyboard]::SetTargetProperty($breatheY, $pathScaleY)
[System.Windows.Media.Animation.Storyboard]::SetTarget($bob, $translateTransform)
[System.Windows.Media.Animation.Storyboard]::SetTargetProperty($bob, $pathOffsetY)
[void]$breathStoryboard.Children.Add($breatheX)
[void]$breathStoryboard.Children.Add($breatheY)
[void]$breathStoryboard.Children.Add($bob)
[void]$breathStoryboard.Begin()

<#
.SYNOPSIS
  Play a one-shot reaction animation on the pet.
#>
function Invoke-Reaction {
  param([ValidateSet('bounce', 'shake', 'nod', 'spin', 'pop', 'sway')][string]$Kind = 'bounce')

  $storyboard = New-Object System.Windows.Media.Animation.Storyboard
  $ease = New-Object System.Windows.Media.Animation.BackEase
  $ease.Amplitude = 0.5
  $ease.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseOut

  # Each branch targets one transform, so a reaction never fights the ambient
  # breathing for the same property.
  switch ($Kind) {
    'bounce' {
      $anim = New-Object System.Windows.Media.Animation.DoubleAnimation(0, -30, [TimeSpan]::FromSeconds(0.22))
      $anim.AutoReverse = $true
      $anim.EasingFunction = $ease
      [System.Windows.Media.Animation.Storyboard]::SetTarget($anim, $translateTransform)
      [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($anim, $pathOffsetY)
      [void]$storyboard.Children.Add($anim)
    }
    'pop' {
      foreach ($path in @($pathScaleX, $pathScaleY)) {
        $anim = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 1.22, [TimeSpan]::FromSeconds(0.16))
        $anim.AutoReverse = $true
        $anim.EasingFunction = $ease
        [System.Windows.Media.Animation.Storyboard]::SetTarget($anim, $scaleTransform)
        [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($anim, $path)
        [void]$storyboard.Children.Add($anim)
      }
    }
    'shake' {
      $anim = New-Object System.Windows.Media.Animation.DoubleAnimation(0, 10, [TimeSpan]::FromSeconds(0.06))
      $anim.AutoReverse = $true
      $anim.RepeatBehavior = New-Object System.Windows.Media.Animation.RepeatBehavior(4)
      [System.Windows.Media.Animation.Storyboard]::SetTarget($anim, $translateTransform)
      [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($anim, (New-Object System.Windows.PropertyPath('X')))
      [void]$storyboard.Children.Add($anim)
    }
    'nod' {
      $anim = New-Object System.Windows.Media.Animation.DoubleAnimation(0, 9, [TimeSpan]::FromSeconds(0.18))
      $anim.AutoReverse = $true
      $anim.RepeatBehavior = New-Object System.Windows.Media.Animation.RepeatBehavior(2)
      [System.Windows.Media.Animation.Storyboard]::SetTarget($anim, $rotateTransform)
      [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($anim, (New-Object System.Windows.PropertyPath('Angle')))
      [void]$storyboard.Children.Add($anim)
    }
    'spin' {
      $anim = New-Object System.Windows.Media.Animation.DoubleAnimation(0, 360, [TimeSpan]::FromSeconds(0.7))
      $anim.EasingFunction = New-Object System.Windows.Media.Animation.CubicEase
      [System.Windows.Media.Animation.Storyboard]::SetTarget($anim, $rotateTransform)
      [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($anim, (New-Object System.Windows.PropertyPath('Angle')))
      [void]$storyboard.Children.Add($anim)
    }
    'sway' {
      $anim = New-Object System.Windows.Media.Animation.DoubleAnimation(0, 7, [TimeSpan]::FromSeconds(0.35))
      $anim.AutoReverse = $true
      $anim.RepeatBehavior = New-Object System.Windows.Media.Animation.RepeatBehavior(3)
      $anim.EasingFunction = New-Object System.Windows.Media.Animation.SineEase
      [System.Windows.Media.Animation.Storyboard]::SetTarget($anim, $rotateTransform)
      [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($anim, (New-Object System.Windows.PropertyPath('Angle')))
      [void]$storyboard.Children.Add($anim)
    }
  }
  [void]$storyboard.Begin()
}

# ---------------------------------------------------------------------------
# Bridge I/O
# ---------------------------------------------------------------------------
$script:lastToastId = $null
$script:lastMood = $null
$script:lastState = $null
$script:bubbleHideAt = [DateTime]::MaxValue

<#
.SYNOPSIS
  Append one interaction to the action log the host drains.
#>
function Send-Action {
  param(
    [Parameter(Mandatory = $true)][string]$Type,
    [hashtable]$Payload = @{}
  )
  if (-not $actionsFile) { return }
  try {
    $record = @{ type = $Type; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    foreach ($key in $Payload.Keys) { $record[$key] = $Payload[$key] }
    $json = ($record | ConvertTo-Json -Compress -Depth 6)
    # One append of one line: atomic enough for a single writer.
    $stream = [System.IO.File]::Open($actionsFile, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("$json`n")
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
    } finally { $stream.Dispose() }
  } catch {
    Write-Warning "desktop-pet: cannot append action: $($_.Exception.Message)"
  }
}

function Read-LiveState {
  if (-not $liveFile -or -not (Test-Path -LiteralPath $liveFile)) { return $null }
  try {
    $raw = [System.IO.File]::ReadAllText($liveFile, [System.Text.Encoding]::UTF8)
    if (-not $raw) { return $null }
    return $raw | ConvertFrom-Json
  } catch {
    # A read racing the host's atomic rename can fail; retry on the next tick.
    return $null
  }
}

function Show-Bubble {
  param([string]$Text, [string]$Kind = 'info', [int]$DurationMs = 9000)

  if ([string]::IsNullOrWhiteSpace($Text)) { return }

  $palette = @{
    done     = @(255, 26, 92, 62)
    question = @(255, 96, 68, 20)
    approval = @(255, 30, 62, 108)
    quota    = @(255, 138, 42, 24)
    error    = @(255, 132, 30, 40)
    pomodoro = @(255, 24, 82, 96)
    reminder = @(255, 34, 74, 84)
    level    = @(255, 96, 62, 132)
    info     = @(255, 32, 36, 46)
  }
  $rgb = if ($palette.ContainsKey($Kind)) { $palette[$Kind] } else { $palette['info'] }
  $bubble.Background = New-Object System.Windows.Media.SolidColorBrush (
    [System.Windows.Media.Color]::FromArgb($rgb[0], $rgb[1], $rgb[2], $rgb[3]))

  $bubbleText.Text = $Text
  $script:bubbleHideAt = (Get-Date).AddMilliseconds($DurationMs)

  $fadeIn = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0, [TimeSpan]::FromMilliseconds(160))
  $bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fadeIn)
}

function Hide-Bubble {
  if ($bubble.Opacity -le 0.01) { return }
  $fadeOut = New-Object System.Windows.Media.Animation.DoubleAnimation($bubble.Opacity, 0.0, [TimeSpan]::FromMilliseconds(260))
  $bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fadeOut)
}

function Play-KindSound {
  param([string]$Kind)
  if (-not $soundEnabled) { return }
  try {
    switch ($Kind) {
      'question' { [System.Media.SystemSounds]::Question.Play() }
      'approval' { [System.Media.SystemSounds]::Exclamation.Play() }
      'quota'    { [System.Media.SystemSounds]::Hand.Play() }
      'error'    { [System.Media.SystemSounds]::Hand.Play() }
      'done'     { [System.Media.SystemSounds]::Asterisk.Play() }
      'level'    { [System.Media.SystemSounds]::Asterisk.Play() }
      default    { [System.Media.SystemSounds]::Beep.Play() }
    }
  } catch { }
}

function Get-MoodReaction {
  param([string]$MoodKind)
  switch ($MoodKind) {
    'celebrate' { return 'pop' }
    'curious'   { return 'bounce' }
    'worried'   { return 'shake' }
    'working'   { return 'nod' }
    'happy'     { return 'pop' }
    'sleepy'    { return 'sway' }
    default     { return 'bounce' }
  }
}

# ---------------------------------------------------------------------------
# Pointer interaction
# ---------------------------------------------------------------------------
$script:dragging = $false
$script:dragStart = $null
$script:windowStart = $null
$script:movedDuringDrag = $false

$petHost.Add_MouseLeftButtonDown({
  param($sender, $event)
  $script:dragging = $true
  $script:movedDuringDrag = $false
  $script:dragStart = [System.Windows.Forms.Cursor]::Position
  $script:windowStart = New-Object System.Windows.Point($window.Left, $window.Top)
  [void]$petHost.CaptureMouse()
  $event.Handled = $true
})

$petHost.Add_MouseMove({
  param($sender, $event)
  if (-not $script:dragging) { return }
  $now = [System.Windows.Forms.Cursor]::Position
  $dx = $now.X - $script:dragStart.X
  $dy = $now.Y - $script:dragStart.Y
  if ([Math]::Abs($dx) -gt 3 -or [Math]::Abs($dy) -gt 3) { $script:movedDuringDrag = $true }
  $window.Left = $script:windowStart.X + $dx
  $window.Top = $script:windowStart.Y + $dy
})

$petHost.Add_MouseLeftButtonUp({
  param($sender, $event)
  if (-not $script:dragging) { return }
  $script:dragging = $false
  [void]$petHost.ReleaseMouseCapture()
  if ($script:movedDuringDrag) {
    Send-Action -Type 'moved' -Payload @{
      x = [Math]::Round($window.Left)
      y = [Math]::Round($window.Top)
    }
    Invoke-Reaction -Kind 'sway'
    Show-Bubble -Text $ui.dragReaction -Kind 'info' -DurationMs 2500
  } else {
    # A click without movement is a stroke: let the host answer with a line.
    Send-Action -Type 'pet'
    Invoke-Reaction -Kind 'pop'
  }
  $event.Handled = $true
})

<#
.SYNOPSIS
  Add one item to a WPF or WinForms menu.
#>
function Add-MenuItem {
  param($Menu, [string]$Header, [scriptblock]$OnClick)
  $item = New-Object System.Windows.Controls.MenuItem
  $item.Header = $Header
  $item.Foreground = [System.Windows.Media.Brushes]::White
  $item.Add_Click($OnClick)
  [void]$Menu.Items.Add($item)
  return $item
}

$petHost.Add_MouseRightButtonUp({
  param($sender, $event)
  $menu = New-Object System.Windows.Controls.ContextMenu
  $menu.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(250, 34, 38, 48))
  $menu.Foreground = [System.Windows.Media.Brushes]::White
  $menu.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(90, 120, 190, 255))

  [void](Add-MenuItem $menu $ui.menuGreet { Send-Action -Type 'pet' -Payload @{ source = 'menu' }; Invoke-Reaction -Kind 'pop' })
  [void](Add-MenuItem $menu $ui.menuQuota { Send-Action -Type 'refresh-quota' -Payload @{ source = 'menu' } })
  [void](Add-MenuItem $menu $ui.menuOpenPage { Send-Action -Type 'open-page' -Payload @{ source = 'menu' } })
  [void](Add-MenuItem $menu $ui.menuOpenDsh { Send-Action -Type 'open-dsh' -Payload @{ source = 'menu' } })
  [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))
  [void](Add-MenuItem $menu $ui.menuFocus { Send-Action -Type 'pomodoro-start' -Payload @{ minutes = 25; source = 'menu' } })
  [void](Add-MenuItem $menu $ui.menuStopTimer { Send-Action -Type 'pomodoro-stop' -Payload @{ source = 'menu' } })
  [void](Add-MenuItem $menu $ui.menuQuiet { Send-Action -Type 'dismiss-all' -Payload @{ source = 'menu' } })
  [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))
  [void](Add-MenuItem $menu $ui.menuHide { Send-Action -Type 'hide-desktop' -Payload @{ source = 'menu' } })
  [void](Add-MenuItem $menu $ui.menuQuit { Send-Action -Type 'quit-desktop' -Payload @{ source = 'menu' } })

  $menu.IsOpen = $true
  $event.Handled = $true
})

$petHost.Add_MouseEnter({ $window.Cursor = [System.Windows.Input.Cursors]::Hand })
$petHost.Add_MouseLeave({ $window.Cursor = [System.Windows.Input.Cursors]::Arrow })

# Tooltip carrying the numbers the user actually wants at a glance.
$tooltip = New-Object System.Windows.Controls.ToolTip
$tooltipText = New-Object System.Windows.Controls.TextBlock
$tooltipText.FontSize = 12
$tooltipText.Foreground = [System.Windows.Media.Brushes]::White
$tooltip.Content = $tooltipText
$tooltip.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(245, 32, 36, 46))
$tooltip.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(110, 120, 190, 255))
$petHost.ToolTip = $tooltip

# ---------------------------------------------------------------------------
# Notification-area icon, so a sticky alert is never missed even when the pet is
# covered by a fullscreen window.
# ---------------------------------------------------------------------------
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = $ui.trayTooltip
$notifyIcon.Visible = $true
try {
  $iconPath = Join-Path $assetsDir 'pet.ico'
  if (Test-Path -LiteralPath $iconPath) {
    $notifyIcon.Icon = New-Object System.Drawing.Icon($iconPath)
  } else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
  }
} catch {
  $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}

$trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$trayMenu.Items.Add($ui.trayShowHide, $null, {
  $window.Visibility = if ($window.Visibility -eq 'Visible') { 'Hidden' } else { 'Visible' }
})
[void]$trayMenu.Items.Add($ui.trayOpenPage, $null, { Send-Action -Type 'open-page' -Payload @{ source = 'tray' } })
[void]$trayMenu.Items.Add($ui.trayOpenDsh, $null, { Send-Action -Type 'open-dsh' -Payload @{ source = 'tray' } })
[void]$trayMenu.Items.Add($ui.trayRefreshQuota, $null, { Send-Action -Type 'refresh-quota' -Payload @{ source = 'tray' } })
[void]$trayMenu.Items.Add($ui.trayQuit, $null, { Send-Action -Type 'quit-desktop' -Payload @{ source = 'tray' }; $window.Close() })
$notifyIcon.ContextMenuStrip = $trayMenu
$notifyIcon.Add_MouseDoubleClick({
  $window.Visibility = [System.Windows.Visibility]::Visible
  [void]$window.Activate()
})
$notifyIcon.Add_BalloonTipClicked({ Send-Action -Type 'open-dsh' })

# ---------------------------------------------------------------------------
# Poll loop
# ---------------------------------------------------------------------------
function Update-FromState {
  param($state)

  if ($null -eq $state) { return }
  $script:lastState = $state

  # --- bubble -----------------------------------------------------------
  $toast = $state.toast
  if ($null -ne $toast -and -not $toast.dismissed) {
    if ($toast.id -ne $script:lastToastId) {
      $script:lastToastId = $toast.id
      if ($toast.title) {
        $text = "$($toast.title)`n$($toast.text)"
      } else {
        $text = [string]$toast.text
      }
      $duration = if ($toast.sticky) { 600000 } else { 11000 }
      Show-Bubble -Text $text -Kind ([string]$toast.kind) -DurationMs $duration
      Invoke-Reaction -Kind (Get-MoodReaction $state.pet.mood)
      Play-KindSound -Kind ([string]$toast.kind)
      if ($toast.kind -eq 'question' -or $toast.kind -eq 'approval' -or $toast.kind -eq 'quota') {
        try {
          $notifyIcon.BalloonTipTitle = [string]$toast.title
          $notifyIcon.BalloonTipText = [string]$toast.text
          $notifyIcon.ShowBalloonTip(8000)
        } catch { }
      }
    }
  } else {
    $script:lastToastId = $null
  }

  if ((Get-Date) -gt $script:bubbleHideAt) { Hide-Bubble }

  # --- ambient mood -----------------------------------------------------
  $mood = [string]$state.pet.mood
  if ($mood -ne $script:lastMood) {
    $script:lastMood = $mood
    switch ($mood) {
      'working' { [void]$breathStoryboard.SetSpeedRatio(1.8) }
      'sleepy'  { [void]$breathStoryboard.SetSpeedRatio(0.55) }
      default   { [void]$breathStoryboard.SetSpeedRatio(1.0) }
    }
  }

  # --- hover tooltip ----------------------------------------------------
  $quota = $state.quota
  $pet = $state.pet
  $activity = $state.activity
  if ($null -ne $quota.totalBalance) {
    if ($quota.currency) {
      $balance = "$($quota.totalBalance) $($quota.currency)"
    } else {
      $balance = "$($quota.totalBalance)"
    }
  } else {
    $balance = $ui.reading
  }
  $lines = @(
    "$($ui.tooltipLevel) $($pet.level)  $($pet.xp)/$($pet.xpToNext) XP",
    "$($ui.tooltipBalance): $balance",
    "$($ui.tooltipToday): $($activity.tasksToday) $($ui.tooltipTasks)",
    "$($ui.tooltipAffection): $($pet.affection)"
  )
  if ($state.pomodoro.running) {
    $remaining = [Math]::Max(0, [int]($state.pomodoro.remainingMs / 1000))
    $minutes = [Math]::Floor($remaining / 60)
    $seconds = $remaining % 60
    $lines += "$($ui.tooltipTimer): $minutes$($ui.tooltipMinutes) $seconds$($ui.tooltipSeconds)"
  }
  $tooltipText.Text = ($lines -join "`n")
}

<#
.SYNOPSIS
  Honour a one-line command the host (or the CLI) writes.
#>
function Check-CommandChannel {
  if (-not $commandFile -or -not (Test-Path -LiteralPath $commandFile)) { return }
  try {
    $raw = [System.IO.File]::ReadAllText($commandFile, [System.Text.Encoding]::UTF8)
    if (-not $raw.Trim()) { return }
    [System.IO.File]::WriteAllText($commandFile, '', [System.Text.Encoding]::UTF8)
    $command = $raw | ConvertFrom-Json
    switch ([string]$command.cmd) {
      'quit' { $window.Close() }
      'show' { $window.Visibility = [System.Windows.Visibility]::Visible }
      'hide' { $window.Visibility = [System.Windows.Visibility]::Hidden }
      'reload' {
        $window.Visibility = [System.Windows.Visibility]::Hidden
        Start-Process -FilePath 'powershell.exe' -ArgumentList @(
          '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
          '-File', $PSCommandPath, '-ConfigPath', $ConfigPath
        ) -WindowStyle Hidden | Out-Null
        $window.Close()
      }
    }
  } catch {
    Write-Warning "desktop-pet: bad command payload: $($_.Exception.Message)"
  }
}

$pollTimer = New-Object System.Windows.Threading.DispatcherTimer
$pollTimer.Interval = [TimeSpan]::FromMilliseconds($pollMs)
$pollTimer.Add_Tick({
  try {
    Check-CommandChannel
    Update-FromState (Read-LiveState)
  } catch {
    Write-Warning "desktop-pet: poll failed: $($_.Exception.Message)"
  }
})

# A slower heartbeat hides a bubble whose host stopped sending updates.
$housekeeping = New-Object System.Windows.Threading.DispatcherTimer
$housekeeping.Interval = [TimeSpan]::FromSeconds(3)
$housekeeping.Add_Tick({
  if ((Get-Date) -gt $script:bubbleHideAt) { Hide-Bubble }
})

$window.Add_Loaded({
  Write-PetLog "window loaded; showing at ($($window.Left),$($window.Top)) size $($window.Width)x$($window.Height)"
  $pollTimer.Start()
  $housekeeping.Start()
  # Announce ourselves so the host flips its desktopRunning flag.
  Send-Action -Type 'desktop-ready' -Payload @{ pid = $PID; width = $winWidth; height = $winHeight }
  Show-Bubble -Text $ui.greeting -Kind 'info' -DurationMs 6000
  Write-PetLog 'ready announced'
})

$window.Add_Closed({
  Write-PetLog 'window closed'
  $pollTimer.Stop()
  $housekeeping.Stop()
  Send-Action -Type 'desktop-closed' -Payload @{ pid = $PID }
  try {
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
  } catch { }
})

# ---------------------------------------------------------------------------
# Probe mode: build everything, report the window's real state, then exit.
# ---------------------------------------------------------------------------
if ($Probe) {
  $window.Show()
  $handle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  $report = [ordered]@{
    ok = $true
    hwnd = [int64]$handle
    pid = $PID
    width = $window.Width
    height = $window.Height
    topmost = $window.Topmost
    allowsTransparency = $window.AllowsTransparency
    left = $window.Left
    top = $window.Top
    imageLoaded = ($null -ne $petBitmap)
    imageWidth = if ($null -ne $petBitmap) { $petBitmap.PixelWidth } else { 0 }
    imageHeight = if ($null -ne $petBitmap) { $petBitmap.PixelHeight } else { 0 }
    liveStateReadable = ($null -ne (Read-LiveState))
    labelsLoaded = $ui.greeting
  }
  Write-Output ('PROBE ' + ($report | ConvertTo-Json -Compress))
  $window.Close()
  exit 0
}

if (-not $startMinimized) {
  Write-PetLog 'showing the window'
  $window.Show()
  Write-PetLog "window shown; IsVisible=$($window.IsVisible) ActualWidth=$($window.ActualWidth)"
}
Write-PetLog 'entering the dispatcher loop'
[System.Windows.Threading.Dispatcher]::Run()
Write-PetLog 'dispatcher loop exited'
