# MineGuard Launcher — buttons for everything.
#   ▶ Start   ⏹ Stop   🌐 Open control room   🔗 Copy share link   📱 Open share link
# The permanent read-only share link sits in the box, always visible (no clicks).
# Started by launcher.bat; can also run:  powershell -File launcher.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-Running {
  try { (Invoke-WebRequest "http://localhost:4000/api/state" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 }
  catch { $false }
}
function Get-Share {
  try { Invoke-RestMethod "http://localhost:4000/api/share" -TimeoutSec 2 } catch { $null }
}
function Get-Link {
  $s = Get-Share
  if ($s -and $s.permanent) { return $s.permanent }
  $f = Join-Path $root "SHARE-LINK.txt"
  if (Test-Path $f) {
    $line = Get-Content $f | Where-Object { $_ -match "^http" } | Select-Object -First 1
    if ($line) { return $line.Trim() }
  }
  return "press ▶ Start to create the share link"
}

# ---------------------------------------------------------------- form -----
$form = New-Object System.Windows.Forms.Form
$form.Text = "MineGuard Launcher"
$form.Size = New-Object System.Drawing.Size(580, 250)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 26, 32)

$status = New-Object System.Windows.Forms.Label
$status.Text = "checking..."
$status.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$status.ForeColor = [System.Drawing.Color]::White
$status.Location = New-Object System.Drawing.Point(15, 12)
$status.Size = New-Object System.Drawing.Size(540, 26)
$form.Controls.Add($status)

$linkLabel = New-Object System.Windows.Forms.Label
$linkLabel.Text = "PERMANENT read-only share link (same Wi-Fi) — Ctrl+C to copy:"
$linkLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$linkLabel.ForeColor = [System.Drawing.Color]::FromArgb(170, 175, 185)
$linkLabel.Location = New-Object System.Drawing.Point(15, 44)
$linkLabel.Size = New-Object System.Drawing.Size(540, 18)
$form.Controls.Add($linkLabel)

$linkBox = New-Object System.Windows.Forms.TextBox
$linkBox.Location = New-Object System.Drawing.Point(15, 64)
$linkBox.Size = New-Object System.Drawing.Size(540, 24)
$linkBox.ReadOnly = $true
$linkBox.Font = New-Object System.Drawing.Font("Consolas", 10)
$form.Controls.Add($linkBox)

function New-Button($text, $x, $y, $w, $onClick) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
  $b.Location = New-Object System.Drawing.Point($x, $y)
  $b.Size = New-Object System.Drawing.Size($w, 40)
  $b.FlatStyle = "Flat"
  $b.ForeColor = [System.Drawing.Color]::White
  $b.Add_Click($onClick)
  $form.Controls.Add($b)
  return $b
}

$btnStart = New-Button "▶ Start", 15, 100, 120, {
  $status.Text = "starting..."
  $status.ForeColor = [System.Drawing.Color]::Gold
  Start-Process -FilePath "node" -ArgumentList "start.js" -WorkingDirectory $root -WindowStyle Hidden
}
$btnStop = New-Button "■ Stop", 145, 100, 120, {
  Start-Process -FilePath "powershell" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",(Join-Path $root "stop.ps1") -WindowStyle Hidden
}
$btnOpen = New-Button "🌐 Control room", 275, 100, 150, {
  Start-Process "http://localhost:4000/"
}
$btnShare = New-Button "🔗 Copy link", 435, 100, 120, {
  if ($linkBox.Text -and $linkBox.Text -notmatch "^press") {
    try { Set-Clipboard $linkBox.Text; $btnShare.Text = "✓ Copied"; Start-Sleep -Milliseconds 1500; $btnShare.Text = "🔗 Copy link" } catch {}
  }
}
$btnPhone = New-Button "📱 Open share link", 15, 150, 190, {
  if ($linkBox.Text -and $linkBox.Text -notmatch "^press") { Start-Process $linkBox.Text }
}
$btnFolder = New-Button "📁 Open SHARE-LINK.txt", 215, 150, 210, {
  $f = Join-Path $root "SHARE-LINK.txt"
  if (Test-Path $f) { Start-Process notepad.exe -ArgumentList $f }
}

# -------------------------------------------------------------- timer ------
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
  $running = Test-Running
  if ($running) {
    $status.Text = "● RUNNING — control room on localhost:4000"
    $status.ForeColor = [System.Drawing.Color]::LimeGreen
  } else {
    $status.Text = "● STOPPED"
    $status.ForeColor = [System.Drawing.Color]::Tomato
  }
  if (-not $linkBox.Focused) {
    $link = Get-Link
    if ($linkBox.Text -ne $link) { $linkBox.Text = $link }
  }
})
$timer.Start()

[void]$form.ShowDialog()
