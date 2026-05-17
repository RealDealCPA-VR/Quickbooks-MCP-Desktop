/**
 * Custom-field (DataExt) discovery tool for QuickBooks Desktop MCP (Phase 13 #61).
 *
 * Wraps `DataExtDefQueryRq` — the QBXML surface that returns the company
 * file's custom-field DEFINITIONS (name, type, which entity types can carry
 * the field). Distinct from custom-field VALUES, which arrive as
 * `DataExtRet` children embedded on the *Ret element of any list/transaction
 * entity query that opts in via `includeCustomFields: true` (sets the
 * underlying `OwnerID` filter on the *QueryRq).
 *
 * Typical use: an agent discovers which CF defs apply to Customers
 * (`assignToObject: "Customer"`), then calls `qb_customer_list` with
 * `includeCustomFields: true` to surface every customer's CF values; the
 * agent can then key on a specific def name like "Engagement Type" to
 * partition customers by tax form.
 *
 * Read-only — no add / update / delete of custom-field definitions is
 * exposed in this server's first cut. Defining new CFs is infrequent setup
 * work that operators do in QB Desktop's UI directly (Lists → Templates /
 * Customer & Vendor Profile Lists / Custom Fields on the Additional Info
 * tab of a customer/vendor); the SDK's DataExtDefAdd surface is verifiable
 * only against a live QB instance and is deferred.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";

// AssignToObject enum per the QBXML SDK reference — the set of entity types
// a custom field can be defined against. Kept here (rather than on the zod
// schema) so callers can pass any of them as the optional `assignToObject`
// filter without hitting a schema rejection on a less-common variant
// (OtherName, JobType, etc.). Real QB rejects unsupported values at the wire.
const ASSIGN_TO_OBJECTS = [
  "Account",
  "Customer",
  "Employee",
  "Item",
  "OtherName",
  "Vendor",
  "Bill",
  "BuildAssembly",
  "Charge",
  "Check",
  "CreditCardCharge",
  "CreditCardCredit",
  "CreditMemo",
  "Deposit",
  "Estimate",
  "InventoryAdjustment",
  "Invoice",
  "ItemReceipt",
  "JournalEntry",
  "PurchaseOrder",
  "ReceivePayment",
  "SalesOrder",
  "SalesReceipt",
  "SalesTaxPaymentCheck",
  "TimeTracking",
  "Transfer",
  "VendorCredit",
] as const;

export function registerCustomFieldTools(
  server: McpServer,
  getSession: () => QBSessionManager,
): void {
  server.tool(
    "qb_custom_field_list",
    "List the custom-field (DataExt) DEFINITIONS configured for the company file — one row per defined field with its name, type, and the set of entity types it can carry on. Pair with `includeCustomFields: true` on the entity list tools (qb_customer_list / qb_vendor_list / qb_invoice_list / qb_bill_list / qb_item_list / qb_account_list / qb_employee_list) to actually read CF VALUES on returned rows. `ownerId` scopes to a single namespace (`\"0\"` is the standard company-defined namespace; UUIDs are third-party app namespaces). `assignToObject` narrows to defs applicable to a specific entity type (Customer, Vendor, Invoice, etc.) — repeated filters are OR-style. Read-only.",
    {
      assignToObject: z
        .enum(ASSIGN_TO_OBJECTS)
        .optional()
        .describe(
          "Filter to CF defs that can carry on the named entity type (e.g. 'Customer' returns every def with 'Customer' in its AssignToObject set). Omit to return all defs across all entity types.",
        ),
      ownerId: z
        .string()
        .optional()
        .describe(
          "Custom-field namespace owner. '0' is the standard company-defined namespace (the typical case). Omit to return defs across all owners. UUID values target a specific third-party app's CF namespace.",
        ),
    },
    async ({ assignToObject, ownerId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // DataExtDefQueryRq schema-required child order: OwnerID? →
      // AssignToObject? (repeated). Filters dict is populated in this
      // exact order so the emitted XML matches; pinned in
      // tests/builder-emit-order.test.ts (Phase 13 #61).
      if (ownerId !== undefined && ownerId !== "") {
        filters.OwnerID = ownerId;
      }
      if (assignToObject) {
        filters.AssignToObject = assignToObject;
      }

      try {
        const defs = await session.queryEntity("DataExtDef", filters);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: defs.length,
                  customFields: defs,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                statusCode: e.statusCode ?? -1,
                statusMessage: e.message ?? "DataExtDefQueryRq failed",
                ...(humanReadable ? { humanReadable } : {}),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
