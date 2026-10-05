<#
.SYNOPSIS
  Fill QuickBooks Desktop's company-file login dialog from the DPAPI vault.

.DESCRIPTION
  Started by the session manager right after it launches QB Desktop with a
  .qbw (qb_company_open with launchIfClosed / closeCurrentCompany). Looks up
  the vault entry for -CompanyFile, waits for a QuickBooks window that
  contains a masked password edit box (the login dialog), types the user
  name and password, and presses OK.

  The password is decrypted only inside this process and is never written
  to stdout/stderr. Prints exactly one JSON line:
    {"status":"filled"}           credentials submitted and the dialog closed
    {"status":"rejected"}         QB showed a message and kept the login window (wrong password)
    {"status":"submit-failed"}    login typed in, but no automated OK press was accepted
    {"status":"no-credentials"}   no vault entry with a user name for this file
    {"status":"no-login-window"}  no login dialog appeared before the timeout
    {"status":"error","detail":"..."}

  Submits once and never retries, so a wrong password can't trip a lockout.

  Mechanism: plain Win32 (EnumWindows / EnumChildWindows / WM_SETTEXT /
  BM_CLICK), not managed UI Automation. On the dev box the .NET UIA client
  reported Win32 and WinForms edit boxes as generic "Pane" elements with
  IsPassword=false (no client-side proxies), including QB's own "Edit"
  controls. Win32 messages see the real class names and ES_PASSWORD style.

  Login-dialog shape assumption: a visible top-level window owned by the QB
  process that contains an edit control with the ES_PASSWORD style. The
  user name is the first visible non-password edit (or the edit inside the
  first combo box) in that window. Validated against a stand-in WinForms
  dialog. The real QB 24 login dialog has NOT been observed yet: the dev-box
  sample file has no password. -ProcessIds lets tests target a stand-in.
#>
param(
  [Parameter(Mandatory = $true)][string]$VaultPath,
  [Parameter(Mandatory = $true)][string]$CompanyFile,
  [int]$TimeoutSeconds = 150,
  [string]$ProcessNames = 'QBW,QBW32',
  [string]$ProcessIds = ''
)

$ErrorActionPreference = 'Stop'
$Entropy = [Text.Encoding]::UTF8.GetBytes('quickbooks-desktop-mcp/credentials/v1')

function Exit-Result([string]$status, [string]$detail) {
  $o = @{ status = $status }
  if ($detail) { $o.detail = $detail }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
  exit 0
}

function Get-NormalizedPath([string]$p) {
  try { return [IO.Path]::GetFullPath($p).ToLowerInvariant() } catch { return $p.ToLowerInvariant() }
}

try {
  Add-Type -AssemblyName System.Security

  # ---- vault lookup ------------------------------------------------------
  if (-not (Test-Path -LiteralPath $VaultPath)) { Exit-Result 'no-credentials' 'credential vault not found' }
  $vault = ([IO.File]::ReadAllText($VaultPath)).TrimStart([char]0xFEFF) | ConvertFrom-Json
  $target = Get-NormalizedPath $CompanyFile
  $entry = @($vault.entries) | Where-Object { $_ -and (Get-NormalizedPath ([string]$_.companyFile)) -eq $target } | Select-Object -First 1
  if (-not $entry -or [string]::IsNullOrWhiteSpace([string]$entry.username)) {
    Exit-Result 'no-credentials' 'no saved login for this company file'
  }
  $userName = [string]$entry.username
  $password = ''
  if ($entry.password) {
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect(
      [Convert]::FromBase64String([string]$entry.password), $Entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $password = [Text.Encoding]::UTF8.GetString($bytes)
  }

  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class QbLoginWin32 {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", EntryPoint = "GetWindowLong")] static extern int GetWindowLong32(IntPtr hWnd, int idx);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
  static extern IntPtr SendMessageStr(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  const int GWL_STYLE = -16;
  const int ES_PASSWORD = 0x20;
  const uint WM_SETTEXT = 0x000C;
  const uint BM_CLICK = 0x00F5;

  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static string TextOf(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
  static bool IsEditClass(string c) { return c.IndexOf("edit", StringComparison.OrdinalIgnoreCase) >= 0; }
  public static bool IsPasswordEdit(IntPtr h) {
    return IsEditClass(ClassOf(h)) && (GetWindowLong32(h, GWL_STYLE) & ES_PASSWORD) != 0;
  }

  public static List<IntPtr> TopWindows(uint[] pids) {
    var set = new HashSet<uint>(pids);
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (set.Contains(pid) && IsWindowVisible(h)) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static List<IntPtr> Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }

  // Returns the password edit inside `win`, or IntPtr.Zero.
  public static IntPtr FindPasswordEdit(IntPtr win) {
    foreach (var c in Children(win)) if (IsWindowVisible(c) && IsPasswordEdit(c)) return c;
    return IntPtr.Zero;
  }

  // First visible non-password edit (combo boxes host an inner edit, which
  // EnumChildWindows also returns, so they are covered).
  public static IntPtr FindUserEdit(IntPtr win) {
    foreach (var c in Children(win)) {
      if (!IsWindowVisible(c)) continue;
      if (IsEditClass(ClassOf(c)) && !IsPasswordEdit(c)) return c;
    }
    return IntPtr.Zero;
  }

  public static IntPtr FindOkButton(IntPtr win) {
    foreach (var c in Children(win)) {
      if (!IsWindowVisible(c)) continue;
      if (ClassOf(c).IndexOf("button", StringComparison.OrdinalIgnoreCase) < 0) continue;
      var t = TextOf(c).Replace("&", "").Trim();
      if (t.Equals("OK", StringComparison.OrdinalIgnoreCase) ||
          t.Equals("Log in", StringComparison.OrdinalIgnoreCase) ||
          t.Equals("Login", StringComparison.OrdinalIgnoreCase) ||
          t.Equals("Sign in", StringComparison.OrdinalIgnoreCase)) return c;
    }
    return IntPtr.Zero;
  }

  public static void SetText(IntPtr h, string text) { SendMessageStr(h, WM_SETTEXT, IntPtr.Zero, text); }

  // Ways to press OK, tried in order until the login window closes. All are
  // POSTED, not sent: a press that opens a modal "wrong password" box would
  // otherwise block this script until a human dismisses it.
  //   0 BM_CLICK       standard Windows buttons
  //   1 mouse click    custom-drawn buttons. QuickBooks 24's OK is a
  //                    "MauiPushButton" that ignored BM_CLICK (observed
  //                    live 2026-10-05: fields filled, OK never pressed).
  //   2 WM_COMMAND     the dialog's own OK command (control id, BN_CLICKED)
  //   3 Enter key      in the password box; the operator pressing Enter worked
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  const uint WM_COMMAND = 0x0111, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101;

  public static void Press(int method, IntPtr dlg, IntPtr ok, IntPtr pwEdit) {
    switch (method) {
      case 0:
        PostMessage(ok, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
        break;
      case 1: {
        RECT r; GetClientRect(ok, out r);
        int x = Math.Max(1, (r.Right - r.Left) / 2), y = Math.Max(1, (r.Bottom - r.Top) / 2);
        IntPtr pos = (IntPtr)((y << 16) | (x & 0xFFFF));
        PostMessage(ok, WM_LBUTTONDOWN, (IntPtr)1, pos);
        PostMessage(ok, WM_LBUTTONUP, IntPtr.Zero, pos);
        break;
      }
      case 2:
        PostMessage(dlg, WM_COMMAND, (IntPtr)(GetDlgCtrlID(ok) & 0xFFFF), ok);
        break;
      case 3:
        PostMessage(pwEdit, WM_KEYDOWN, (IntPtr)0x0D, (IntPtr)0x001C0001);
        PostMessage(pwEdit, WM_KEYUP, (IntPtr)0x0D, unchecked((IntPtr)(int)0xC01C0001));
        break;
    }
  }

  public static readonly string[] PressNames = { "bm-click", "mouse-click", "wm-command", "enter-key" };
}
'@

  function Get-TargetPids {
    if ($ProcessIds) { return [uint32[]]@($ProcessIds.Split(',') | ForEach-Object { [uint32]$_.Trim() }) }
    $names = $ProcessNames.Split(',') | ForEach-Object { $_.Trim() }
    return [uint32[]]@(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  }

  # ---- wait for the login dialog ---------------------------------------
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $win = [IntPtr]::Zero
  $pwEdit = [IntPtr]::Zero
  while ((Get-Date) -lt $deadline -and $pwEdit -eq [IntPtr]::Zero) {
    $pids = Get-TargetPids
    if ($pids.Count -gt 0) {
      foreach ($w in [QbLoginWin32]::TopWindows($pids)) {
        $pe = [QbLoginWin32]::FindPasswordEdit($w)
        if ($pe -ne [IntPtr]::Zero) { $win = $w; $pwEdit = $pe; break }
      }
    }
    if ($pwEdit -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 750 }
  }
  if ($pwEdit -eq [IntPtr]::Zero) { Exit-Result 'no-login-window' "no QuickBooks login dialog appeared within $TimeoutSeconds s" }

  $userEdit = [QbLoginWin32]::FindUserEdit($win)
  if ($userEdit -ne [IntPtr]::Zero) { [QbLoginWin32]::SetText($userEdit, $userName) }
  [QbLoginWin32]::SetText($pwEdit, $password)
  $password = $null

  $ok = [QbLoginWin32]::FindOkButton($win)
  if ($ok -eq [IntPtr]::Zero) { Exit-Result 'submit-failed' 'login dialog found but it has no OK button; the login was filled in but not submitted' }

  # ---- press OK, escalating, and watch what QuickBooks does -------------
  # Outcomes after each press:
  #   login window closed                         -> filled
  #   QuickBooks opened another window (its error
  #   message) while the login window stays up    -> rejected (stop; never resubmit)
  #   nothing changed                             -> the press was ignored; try the next method
  function Test-DialogGone { return (-not [QbLoginWin32]::IsWindow($win) -or -not [QbLoginWin32]::IsWindowVisible($win)) }
  $baseline = @{}
  foreach ($w in [QbLoginWin32]::TopWindows((Get-TargetPids))) { $baseline[[string]$w] = $true }
  for ($m = 0; $m -lt [QbLoginWin32]::PressNames.Length; $m++) {
    [QbLoginWin32]::Press($m, $win, $ok, $pwEdit)
    $until = (Get-Date).AddSeconds(4)
    $newWindow = $null
    while ((Get-Date) -lt $until) {
      Start-Sleep -Milliseconds 250
      if (Test-DialogGone) { Exit-Result 'filled' ("submitted via " + [QbLoginWin32]::PressNames[$m]) }
      if (-not $newWindow) {
        foreach ($w in [QbLoginWin32]::TopWindows((Get-TargetPids))) {
          if (-not $baseline.ContainsKey([string]$w) -and $w -ne $win) { $newWindow = $w; $until = (Get-Date).AddSeconds(6); break }
        }
      }
    }
    if ($newWindow) {
      if (Test-DialogGone) { Exit-Result 'filled' ("submitted via " + [QbLoginWin32]::PressNames[$m]) }
      $title = [QbLoginWin32]::TextOf($newWindow)
      Exit-Result 'rejected' ("QuickBooks answered the login for user '$userName' with a message window" + $(if ($title) { " ('$title')" } else { '' }) + " and kept the login window open - the saved password is probably wrong. Fix it on the logins page (qb_company_credentials_edit).")
    }
  }
  Exit-Result 'submit-failed' "The login for user '$userName' was filled in, but QuickBooks' OK button did not respond to any automated press. Press Enter in the QuickBooks login window."
} catch {
  Exit-Result 'error' $_.Exception.Message
}
