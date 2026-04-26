# QuickBooks Desktop MCP Server

A **Model Context Protocol (MCP)** server that provides comprehensive tools for managing client books in QuickBooks Desktop via the QBXML SDK.

## Overview

This MCP server acts as a bridge between AI agents/LLMs and QuickBooks Desktop, translating tool calls into QBXML messages — the standard XML-based protocol for QuickBooks Desktop SDK communication. It supports two operating modes:

- **Live mode** — Communicates with a real QuickBooks Desktop instance via the QBXMLRP2 request processor (requires Windows + QuickBooks Desktop installed)
- **Simulation mode** — In-memory mock data store for development, testing, and non-Windows environments (default)

## Tools (36 total)

### Customers
| Tool | Description |
|------|-------------|
| `qb_customer_list` | List/search customers with filters |
| `qb_customer_add` | Create a new customer |
| `qb_customer_update` | Update customer details |
| `qb_customer_delete` | Delete a customer |

### Vendors
| Tool | Description |
|------|-------------|
| `qb_vendor_list` | List/search vendors |
| `qb_vendor_add` | Create a new vendor |
| `qb_vendor_update` | Update vendor details |
| `qb_vendor_delete` | Delete a vendor |

### Chart of Accounts
| Tool | Description |
|------|-------------|
| `qb_account_list` | List accounts (filterable by type) |
| `qb_account_add` | Create a new account |
| `qb_account_update` | Update account details |

### Invoices
| Tool | Description |
|------|-------------|
| `qb_invoice_list` | List/search invoices with date/status filters |
| `qb_invoice_create` | Create an invoice with line items |
| `qb_invoice_update` | Update invoice details |
| `qb_invoice_delete` | Delete an invoice |

### Bills (Accounts Payable)
| Tool | Description |
|------|-------------|
| `qb_bill_list` | List/search bills |
| `qb_bill_create` | Create a new bill |
| `qb_bill_delete` | Delete a bill |

### Items (Products & Services)

QuickBooks has no generic "Item" — every item belongs to one of five subtypes. The `itemType` arg selects the subtype: `Service`, `Inventory`, `NonInventory`, `OtherCharge`, or `Group`.

| Tool | Description |
|------|-------------|
| `qb_item_list` | List/search items. `itemType` is optional — omit to query all five subtypes and merge. |
| `qb_item_add` | Create a new item. `itemType` is required. |
| `qb_item_update` | Update item details. `itemType` is required and must match the stored subtype. |
| `qb_item_delete` | Delete an item. `itemType` is required so the correct `ListDelType` is sent. |

### Payments
| Tool | Description |
|------|-------------|
| `qb_payment_receive` | Record a received payment |
| `qb_payment_list` | List received payments |

### Estimates
| Tool | Description |
|------|-------------|
| `qb_estimate_list` | List estimates/quotes |
| `qb_estimate_create` | Create a new estimate |

### Employees
| Tool | Description |
|------|-------------|
| `qb_employee_list` | List/search employees |
| `qb_employee_add` | Create an employee record |
| `qb_employee_update` | Update employee details |

### Reports & Queries
| Tool | Description |
|------|-------------|
| `qb_company_info` | Get company/connection info |
| `qb_balance_summary` | Account balance overview |
| `qb_ar_aging` | Accounts receivable aging |
| `qb_ap_aging` | Accounts payable aging |
| `qb_raw_query` | Execute raw QBXML queries |

### Session Management
| Tool | Description |
|------|-------------|
| `qb_session_connect` | Open a QuickBooks session |
| `qb_session_disconnect` | Close the session |

## Architecture

```
┌─────────────┐     MCP/stdio      ┌──────────────────────┐
│  AI Agent /  │◄──────────────────►│  QuickBooks Desktop  │
│  LLM Client  │                    │  MCP Server          │
└─────────────┘                    │                      │
                                    │  ┌────────────────┐  │
                                    │  │ Tool Registry   │  │     QBXML
                                    │  │ (36 tools)      │──│──────────────┐
                                    │  └────────────────┘  │              │
                                    │  ┌────────────────┐  │    ┌─────────▼─────────┐
                                    │  │ QBXML Builder   │  │    │ QuickBooks Desktop │
                                    │  │ & Parser        │  │    │ (via QBXMLRP2)    │
                                    │  └────────────────┘  │    │ — or —             │
                                    │  ┌────────────────┐  │    │ Simulation Store   │
                                    │  │ Session Manager │  │    └───────────────────┘
                                    │  └────────────────┘  │
                                    └──────────────────────┘
```

## Setup

### Install dependencies
```bash
cd quickbooks-mcp
npm install
```

### Build
```bash
npm run build
```

### Run (standalone)
```bash
npm start
```

### Configure as MCP server (opencode.jsonc)
```jsonc
{
  "mcpServers": {
    "quickbooks-desktop": {
      "command": "node",
      "args": ["quickbooks-mcp/dist/index.js"],
      "env": {
        "QB_SIMULATION": "true",
        "QB_APP_NAME": "MCP QuickBooks Manager"
      }
    }
  }
}
```

### Configure for Claude Desktop (claude_desktop_config.json)
```json
{
  "mcpServers": {
    "quickbooks-desktop": {
      "command": "node",
      "args": ["/absolute/path/to/quickbooks-mcp/dist/index.js"],
      "env": {
        "QB_COMPANY_FILE": "C:\\Users\\Public\\Documents\\Intuit\\QuickBooks\\MyCompany.qbw",
        "QB_LIVE": "1"
      }
    }
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `QB_COMPANY_FILE` | Path to .qbw company file | Sample file path |
| `QB_APP_NAME` | App name for QB registration | `MCP QuickBooks Manager` |
| `QB_APP_ID` | Application ID (optional) | — |
| `QB_QBXML_VERSION` | QBXML protocol version | `16.0` |
| `QB_CONNECTION_MODE` | `localOnly`, `remoteOnly`, or `optimistic` | `optimistic` |
| `QB_SIMULATION` | Force simulation mode | `true` on non-Windows |
| `QB_LIVE` | Set to `1` for live QB connection | — |

## How It Works

1. **QBXML Protocol**: The server constructs standard QBXML request messages (the XML protocol developed by Intuit for QuickBooks Desktop SDK communication) and parses QBXML response messages.

2. **Session Manager**: Manages the connection lifecycle with QuickBooks Desktop, opening sessions via the QBXMLRP2 request processor and handling the send/receive cycle for QBXML messages.

3. **Simulation Store**: In non-Windows/non-live environments, an in-memory store with realistic seed data (customers, vendors, accounts, items, invoices) processes QBXML requests locally, enabling full development and testing without QuickBooks Desktop installed.

4. **MCP Tools**: Each tool maps to one or more QBXML request types, providing validated input schemas, structured responses, and error handling.

## QBXML Reference

The server targets QBXML version 16.0 and supports the following request types:
- `CustomerQueryRq/AddRq/ModRq` — Customer management
- `VendorQueryRq/AddRq/ModRq` — Vendor management
- `AccountQueryRq/AddRq/ModRq` — Chart of Accounts
- `InvoiceQueryRq/AddRq/ModRq` — Invoices
- `BillQueryRq/AddRq` — Bills
- `ItemQueryRq/AddRq/ModRq` — Items
- `ReceivePaymentAddRq/QueryRq` — Payments
- `EstimateQueryRq/AddRq` — Estimates
- `EmployeeQueryRq/AddRq/ModRq` — Employees
- `ListDelRq / TxnDelRq` — Deletions
