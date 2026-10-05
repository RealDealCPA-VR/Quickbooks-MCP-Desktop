<#
.SYNOPSIS
  Snapshot of QuickBooks Desktop's health for the MCP server.

.DESCRIPTION
  Read-only. Lists:
    - each QuickBooks process (QBW / QBW32): whether Windows considers it
      responding, its start time, and its visible top-level windows (title +
      class). The windows show dialogs that block the SDK, e.g.
      "QuickBooks Desktop Login" or an error box.
    - QuickBooks File Doctor / Tool Hub / repair processes, and any window
      whose title mentions File Doctor.
    - Windows Error Reporting (WerFault) windows that mention QuickBooks,
      i.e. QuickBooks has crashed.
  Prints exactly one JSON line. Used by src/util/qb-health.ts.
#>
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class QbHealthWin32 {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);

  public class Win { public uint Pid; public string Title; public string Cls; }

  public static List<Win> VisibleTopWindows() {
    var list = new List<Win>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      list.Add(new Win { Pid = pid, Title = t.ToString(), Cls = c.ToString() });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

  $wins = [QbHealthWin32]::VisibleTopWindows()
  $qb = @()
  foreach ($p in @(Get-Process -Name 'QBW', 'QBW32' -ErrorAction SilentlyContinue)) {
    $own = @($wins | Where-Object { $_.Pid -eq $p.Id -and ($_.Title -or $_.Cls -eq 'MauiFrame') } | ForEach-Object {
      [ordered]@{ title = $_.Title; className = $_.Cls; isMain = ($_.Cls -eq 'MauiFrame') }
    })
    $started = $null
    try { $started = $p.StartTime.ToUniversalTime().ToString('o') } catch { }
    $qb += [ordered]@{ pid = $p.Id; responding = [bool]$p.Responding; startedAt = $started; mainTitle = $p.MainWindowTitle; windows = $own }
  }

  $doctorRe = '(?i)^(qbfd|qbfiledoctor|filedoctor|quickbookstoolhub|qbtoolhub|qbrepair|qbinstall_tool|quickbooksfiledoctor)$'
  $doctor = @()
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $doctorRe })) {
    $doctor += [ordered]@{ pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle }
  }
  foreach ($w in @($wins | Where-Object { $_.Title -match '(?i)file doctor|tool hub|rebuild data|verify data' })) {
    if (-not ($doctor | Where-Object { $_.pid -eq $w.Pid })) {
      $doctor += [ordered]@{ pid = $w.Pid; name = 'window'; title = $w.Title }
    }
  }

  $crash = @()
  $wer = @(Get-Process -Name 'WerFault' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  foreach ($w in @($wins | Where-Object { $wer -contains $_.Pid -and $_.Title -match '(?i)quickbooks' })) {
    $crash += [ordered]@{ pid = $w.Pid; title = $w.Title }
  }

  $out = [ordered]@{ ok = $true; quickbooks = @($qb); fileDoctor = @($doctor); crashReporter = @($crash) }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Depth 6 -Compress))
} catch {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ ok = $false; error = $_.Exception.Message }) -Compress))
}
