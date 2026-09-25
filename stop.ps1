# Stops MineGuard: launcher (start.js), serial bridge (bridge.js),
# server (4000) and dashboard (5173).
# Called by stop.bat; can also be run directly:  powershell -File stop.ps1
$killed = @()
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*start.js*' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += 'launcher'
  }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*bridge.js*' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += 'bridge'
  }
Remove-Item (Join-Path $PSScriptRoot 'server\bridge.pid') -ErrorAction SilentlyContinue
foreach ($p in 4000, 5173) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    $killed += "port $p"
  }
}
if ($killed.Count) { Write-Host ("stopped: " + ($killed -join ', ')) }
else { Write-Host "MineGuard was not running" }
