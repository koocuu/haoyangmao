$signature = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class Win32Windows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

Add-Type -TypeDefinition $signature

$rows = New-Object System.Collections.Generic.List[object]
$callback = [Win32Windows+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)

  if (-not [Win32Windows]::IsWindowVisible($hWnd)) {
    return $true
  }

  $builder = New-Object System.Text.StringBuilder 512
  [Win32Windows]::GetWindowText($hWnd, $builder, $builder.Capacity) | Out-Null
  $title = $builder.ToString().Trim()
  if (-not $title) {
    return $true
  }

  [uint32]$pid = 0
  [Win32Windows]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
  $process = Get-Process -Id $pid -ErrorAction SilentlyContinue

  $rows.Add([PSCustomObject]@{
    Handle = $hWnd.ToString()
    ProcessId = $pid
    ProcessName = if ($process) { $process.ProcessName } else { "" }
    Title = $title
  }) | Out-Null

  return $true
}

[Win32Windows]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
$rows | Sort-Object ProcessName, Title | Format-Table -AutoSize
