# Monitor model names with native resolution, so they can be matched against
# Electron's display list without relying on enumeration order.
$ids = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue)
$modes = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorListedSupportedSourceModes -ErrorAction SilentlyContinue)

foreach ($id in $ids) {
  $name = ($id.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join ''
  $mfr = ($id.ManufacturerName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join ''

  $w = 0
  $h = 0
  foreach ($mode in $modes) {
    if ($mode.InstanceName -ne $id.InstanceName) { continue }
    foreach ($src in $mode.MonitorSourceModes) {
      if (($src.HorizontalActivePixels * $src.VerticalActivePixels) -gt ($w * $h)) {
        $w = $src.HorizontalActivePixels
        $h = $src.VerticalActivePixels
      }
    }
  }

  Write-Output ("{0}|{1}|{2}|{3}" -f $mfr, $name, $w, $h)
}
