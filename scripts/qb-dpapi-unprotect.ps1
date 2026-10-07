<#
.SYNOPSIS
  Decrypt saved QuickBooks passwords (DPAPI) for a one-time import into the hub.

.DESCRIPTION
  Called by the QuickBooks connector when the hub asks to import this PC's
  saved logins (src/connector/server.ts -> /v1/logins/export). Reads lines
  from stdin, each a DPAPI blob in base64 as written by qb-dpapi-protect.ps1,
  until an empty line or end of input. Prints one line per input: the
  password's UTF-8 bytes in base64, or an empty line if that blob can't be
  decrypted by this Windows account. Base64 on both sides keeps Windows
  PowerShell 5.1's console code page out of the way, and nothing secret is
  ever on the command line.

  The entropy string must match qb-dpapi-protect.ps1.
#>
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $entropy = [Text.Encoding]::UTF8.GetBytes('quickbooks-desktop-mcp/credentials/v1')
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line.Trim() -eq '') { break }
    $out = ''
    try {
      $blob = [Convert]::FromBase64String($line.Trim())
      $plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      $out = [Convert]::ToBase64String($plain)
      [Array]::Clear($plain, 0, $plain.Length)
    } catch {
      $out = ''
    }
    [Console]::Out.WriteLine($out)
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
