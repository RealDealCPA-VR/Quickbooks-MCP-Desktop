<#
.SYNOPSIS
  Gracefully close QuickBooks Desktop (the same as clicking the main window's X).

.DESCRIPTION
  Used by qb_company_open closeCurrentCompany:true (src/util/qb-desktop-launch.ts
  defaultCloseQBDesktop). Posts WM_CLOSE to each QB process's main frame
  window (class "MauiFrame") and waits for the processes to exit. It NEVER
  force-kills: QB then runs its normal shutdown, and any prompt (unsaved
  form, backup reminder, exit confirmation) is left for the operator.

  Why not Process.CloseMainWindow(): on QB Enterprise 24 (observed
  2026-10-05) .NET picked a toolbar-like "Afx:..." top-level window as the
  process's MainWindowHandle. WM_CLOSE sent there was ignored and QB stayed
  open. The MauiFrame window is the real application frame.

  Prints one JSON line:
    {"outcome":"not-running"} | {"outcome":"closed"} |
    {"outcome":"timeout","windows":["<visible QB window titles>"]}
#>
param(
  [int]$TimeoutMs = 90000,
  [string]$ProcessNames = 'QBW,QBW32'
)

$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$o) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
  exit 0
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class QbCloseWin32 {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  const uint WM_CLOSE = 0x0010;

  static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  static string TextOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }

  public static IntPtr FindFrame(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && ClassOf(h) == "MauiFrame") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool PostClose(IntPtr h) { return PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }

  public static List<string> VisibleTitles(uint pid) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) { var t = TextOf(h); if (t.Length > 0) list.Add(t); }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

  $names = $ProcessNames.Split(',') | ForEach-Object { $_.Trim() }
  $procs = @(Get-Process -Name $names -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { Write-Result @{ outcome = 'not-running' } }

  $sent = @{}
  $start = Get-Date
  $deadline = $start.AddMilliseconds([Math]::Max(1000, $TimeoutMs))
  while ((Get-Date) -lt $deadline) {
    $alive = @($procs | Where-Object { -not $_.HasExited })
    if ($alive.Count -eq 0) { Write-Result @{ outcome = 'closed' } }
    foreach ($p in $alive) {
      if ($sent.ContainsKey($p.Id)) { continue }
      $frame = [QbCloseWin32]::FindFrame([uint32]$p.Id)
      if ($frame -ne [IntPtr]::Zero) {
        [void][QbCloseWin32]::PostClose($frame)
        $sent[$p.Id] = $true
      } elseif (((Get-Date) - $start).TotalSeconds -gt 20) {
        # No MauiFrame after 20s (older QB build or still starting): fall back.
        [void]$p.CloseMainWindow()
        $sent[$p.Id] = $true
      }
    }
    Start-Sleep -Milliseconds 500
  }

  $titles = @()
  foreach ($p in @($procs | Where-Object { -not $_.HasExited })) { $titles += [QbCloseWin32]::VisibleTitles([uint32]$p.Id) }
  Write-Result @{ outcome = 'timeout'; windows = @($titles) }
} catch {
  Write-Result @{ outcome = 'error'; detail = $_.Exception.Message }
}
