<#
.SYNOPSIS
  Encrypt one QuickBooks password with Windows DPAPI for the credential vault.

.DESCRIPTION
  Called by the MCP server's local web page when the operator saves a login
  (src/util/qb-credentials.ts -> protectPassword). Reads ONE line from stdin:
  the password's UTF-8 bytes, base64-encoded. Base64 keeps Windows
  PowerShell 5.1's console code page from mangling non-ASCII characters,
  and keeps the password off the command line, where other processes could
  read it. Prints the DPAPI blob (CurrentUser scope + app entropy) as
  base64 on one line.

  The entropy string must match qb-login-autofill.ps1, which decrypts.
#>
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $entropy = [Text.Encoding]::UTF8.GetBytes('quickbooks-desktop-mcp/credentials/v1')
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { throw 'no input on stdin' }
  $plain = [Convert]::FromBase64String($line.Trim())
  $blob = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Array]::Clear($plain, 0, $plain.Length)
  [Console]::Out.WriteLine([Convert]::ToBase64String($blob))
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
