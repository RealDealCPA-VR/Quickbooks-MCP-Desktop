#!/usr/bin/env node

// STUB — full implementation tracked as todo.md #91.
// Probes that the full doctor will run:
//   - Node version (winax requires v20.x; v22+ breaks)
//   - Platform (Windows + WOW64 for 64-bit Node)
//   - QuickBooks Desktop installed (registry / Program Files)
//   - QBXMLRP2 COM registration
//   - QB_COMPANY_FILE / QB_COMPANY_ROOT env vars set and existing on disk
//   - Optional winax install rebuilt against current Node ABI
// Exit-code contract for the real implementation: 0 = all green, 1 = problems found, 2 = could not run.

console.log("quickbooks-desktop-mcp-doctor — stub");
console.log("");
console.log("The diagnostic CLI is not yet implemented (tracked as todo.md #91).");
console.log("Once shipped, this command will probe Node version, platform, QuickBooks Desktop install,");
console.log("QBXMLRP2 COM registration, env vars, and winax ABI compatibility, then exit 0/1/2.");
console.log("");
console.log("In the meantime, the server itself prints its mode + config on startup:");
console.log("  node dist/index.js");

process.exit(2);
