/**
 * Sales tax tools for QuickBooks Desktop MCP.
 *
 * Phase 17 #77 — sales tax workflows. CPA monthly necessity for any client
 * with taxable sales. Five tools:
 *
 *   • qb_sales_tax_code_list       — SalesTaxCodeQueryRq (TAX / NON / OUT etc.)
 *   • qb_sales_tax_item_list       — ItemSalesTaxQueryRq + ItemSalesTaxGroupQueryRq
 *   • qb_sales_tax_agency_list     — composite over ItemSalesTax + Vendor
 *   • qb_sales_tax_liability_report — GeneralSummaryReportType=SalesTaxLiability
 *   • qb_sales_tax_payment_create  — SalesTaxPaymentCheckAddRq (write the check)
 *
 * **Sales-tax codes vs items vs agencies (real-QB primer):**
 *   - SalesTaxCode is a 1-3 character flag stamped on a customer or line
 *     to indicate WHETHER that party/line is taxable. The default seed
 *     codes are TAX (taxable) and NON (non-taxable); add OUT for out-of-
 *     state exempt sales, RES for resale-cert holders, etc. Codes do NOT
 *     carry rates — they're just classifiers.
 *   - ItemSalesTax (a.k.a. "sales tax item") carries the actual TaxRate
 *     and the TaxVendorRef pointing at the agency that collects it. When
 *     a transaction posts with an ItemSalesTaxRef, real QB applies
 *     TaxRate × taxable-line-subtotal and posts the result as
 *     SalesTaxTotal on the txn header.
 *   - ItemSalesTaxGroup bundles multiple SalesTaxItems so a single line
 *     (e.g. "CA-LA Combined") collects state + county at once. Real QB
 *     resolves group → component items at posting time; this server's
 *     liability report walks ItemSalesTax (not Group) so groups are
 *     list-only here.
 *   - Sales-tax agencies are just Vendors — real QB doesn't have a separate
 *     SalesTaxAgency entity. qb_sales_tax_agency_list derives the agency
 *     set from distinct ItemSalesTax.TaxVendorRef values, optionally
 *     enriched with full Vendor details.
 *
 * **The payment check (SalesTaxPaymentCheckAddRq):** distinct from a normal
 * Check because its lines reduce sales-tax-item liability instead of posting
 * to expense GL. Each line names ItemSalesTaxRef + Amount; the sum is drawn
 * from the BankAccountRef. Real QB also has a "Pay Sales Tax" UI that runs
 * essentially this RPC — the operator selects which tax items + amounts to
 * pay; the wire envelope is one SalesTaxPaymentCheckAddRq.
 *
 * **Live verification deferred** for the whole surface — sim-verified end-
 * to-end, but the wire types haven't been pinned against a real QB Desktop.
 * If a schema-order class of bug surfaces (statusCode -1), capture envelope
 * via QB_DEBUG_QBXML=1 and pin canonical child order in
 * tests/builder-emit-order.test.ts the way #37 did.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";

// ---------------------------------------------------------------------------
// SalesTaxPaymentCheck line schema — one line per ItemSalesTaxRef being paid.
// ---------------------------------------------------------------------------

const salesTaxPaymentLineSchema = z
  .object({
    salesTaxItemName: z.string().optional()
      .describe("FullName of the SalesTaxItem being paid down (from qb_sales_tax_item_list). Identifies which agency liability this line reduces."),
    salesTaxItemListId: z.string().optional()
      .describe("ListID of the SalesTaxItem being paid down. Wins over salesTaxItemName when both provided."),
    amount: z.number().describe("Dollar amount of liability this line pays down. Positive — overpayments are achievable by paying more than the period's TaxCollected (creates an agency credit)."),
    memo: z.string().optional().describe("Optional per-line memo (e.g. 'Q1 2026 collection')."),
  })
  .refine((line) => Boolean(line.salesTaxItemName || line.salesTaxItemListId), {
    message: "Each payment line requires salesTaxItemName or salesTaxItemListId",
  });

export function registerSalesTaxTools(
  server: McpServer,
  getSession: () => QBSessionManager,
): void {
  // -------------------------------------------------------------------------
  // qb_sales_tax_code_list
  // -------------------------------------------------------------------------
  server.tool(
    "qb_sales_tax_code_list",
    "List sales-tax codes (SalesTaxCodeQueryRq). Codes are short flags (typically 1-3 chars: TAX / NON / OUT) stamped on customers and line items to indicate taxable status. Codes themselves carry NO rate — they're classifiers; the actual TaxRate lives on the SalesTaxItem the code is paired with on a posted transaction. Use to discover valid code names for customer / invoice / sales-receipt creation. IsTaxable on each row tells you whether transactions flagged with that code should pick up tax (TAX → true, NON → false, OUT → false typically).",
    {
      nameFilter: z.string().optional().describe("Filter codes by name (Contains match)."),
      activeOnly: z.boolean().optional().describe("Only return active codes (default: true)."),
      maxReturned: z.number().optional().describe("Maximum results."),
      listId: z.string().optional().describe("Fetch a specific code by ListID."),
    },
    async ({ nameFilter, activeOnly, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      // Schema-required child order — selector → MaxReturned → ActiveStatus
      // → NameFilter (see customers.ts for the full reasoning).
      if (listId) filters.ListID = listId;
      if (maxReturned) filters.MaxReturned = maxReturned;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };

      try {
        const codes = await session.queryEntity("SalesTaxCode", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: codes.length, salesTaxCodes: codes }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "SalesTaxCodeQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // qb_sales_tax_item_list
  // -------------------------------------------------------------------------
  server.tool(
    "qb_sales_tax_item_list",
    "List sales-tax items (ItemSalesTaxQueryRq) and/or sales-tax groups (ItemSalesTaxGroupQueryRq). Each item carries TaxRate (decimal percent) and TaxVendorRef (the agency that collects it). Each group bundles multiple items via ItemSalesTaxRef — a group is what an operator stamps on a transaction line when a single line collects multiple component taxes (e.g. CA state + LA county). Default fans across BOTH item and group queries; pass `taxItemType` to scope to one. Each row in the merged response carries an `ItemType` discriminator field ('SalesTaxItem' | 'SalesTaxGroup') so callers can branch without re-querying.",
    {
      taxItemType: z.enum(["Item", "Group"]).optional()
        .describe("Filter by item subtype. Item → sales-tax items only (with TaxRate). Group → sales-tax groups only (collections of items). Omit to query both and merge."),
      nameFilter: z.string().optional().describe("Filter items by name (Contains match)."),
      activeOnly: z.boolean().optional().describe("Only return active items (default: true)."),
      maxReturned: z.number().optional().describe("Maximum results (applied per-store when fanning out)."),
      listId: z.string().optional().describe("Fetch a specific item by ListID."),
    },
    async ({ taxItemType, nameFilter, activeOnly, maxReturned, listId }) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      if (listId) filters.ListID = listId;
      if (maxReturned) filters.MaxReturned = maxReturned;
      if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
      if (nameFilter) filters.NameFilter = { MatchCriterion: "Contains", Name: nameFilter };

      const types: Array<{ entity: "ItemSalesTax" | "ItemSalesTaxGroup"; label: "SalesTaxItem" | "SalesTaxGroup" }> =
        taxItemType === "Item"
          ? [{ entity: "ItemSalesTax", label: "SalesTaxItem" }]
          : taxItemType === "Group"
            ? [{ entity: "ItemSalesTaxGroup", label: "SalesTaxGroup" }]
            : [
                { entity: "ItemSalesTax", label: "SalesTaxItem" },
                { entity: "ItemSalesTaxGroup", label: "SalesTaxGroup" },
              ];

      try {
        const results = await Promise.all(
          types.map(async ({ entity, label }) => {
            const entries = await session.queryEntity(entity, filters);
            return entries.map((e) => ({ ...e, ItemType: label }));
          }),
        );
        const items = results.flat();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: items.length, salesTaxItems: items }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        const op = types.length === 1 ? `${types[0].entity}QueryRq` : "ItemSalesTax*QueryRq";
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? `${op} failed`,
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // qb_sales_tax_agency_list
  // -------------------------------------------------------------------------
  server.tool(
    "qb_sales_tax_agency_list",
    "List sales-tax agencies. Real QB has NO separate SalesTaxAgency entity — agencies are just Vendors that appear as TaxVendorRef on SalesTaxItem records. This tool walks every active SalesTaxItem, extracts the distinct TaxVendorRef set, and (default) enriches each with the full Vendor record (address / phone / 1099 status etc.) plus the list of tax items that pay into that agency. Pure composite over qb_sales_tax_item_list + qb_vendor_list — no new wire type. Set includeVendorDetails:false to skip the per-agency Vendor lookup (faster — avoids N round trips when only the agency identity is needed). Each agency row carries `taxItems: [{name, listId, taxRate}]` so the operator can see what's collected per agency at a glance.",
    {
      includeVendorDetails: z.boolean().optional()
        .describe("When true (default), look up the full Vendor record for each agency (address, phone, etc.). Set false to skip the per-agency lookups — useful when only agencyName / agencyListId is needed."),
      activeOnly: z.boolean().optional().describe("Walk only active SalesTaxItems (default: true). An inactive item still references its agency, but that agency may not have current collection activity."),
    },
    async ({ includeVendorDetails, activeOnly }) => {
      const session = getSession();

      let salesTaxItems: Record<string, unknown>[];
      try {
        const filters: Record<string, unknown> = {};
        if (activeOnly !== false) filters.ActiveStatus = "ActiveOnly";
        salesTaxItems = await session.queryEntity("ItemSalesTax", filters);
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "ItemSalesTaxQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }

      // Group items by agency. Key on ListID when present, FullName otherwise
      // so an agency referenced by both ListID and FullName aliases collapses
      // to a single row.
      type AgencyAccum = {
        agencyName: string;
        agencyListId: string | null;
        taxItems: Array<{ name: string; listId: string; taxRate: number }>;
      };
      const byAgency = new Map<string, AgencyAccum>();
      for (const item of salesTaxItems) {
        const agencyRef = item.TaxVendorRef as Record<string, unknown> | undefined;
        if (!agencyRef) continue; // tax item without an agency — skip
        const agencyName = String(agencyRef.FullName ?? "");
        const agencyListId = agencyRef.ListID ? String(agencyRef.ListID) : null;
        const key = agencyListId ?? agencyName;
        if (!key) continue;

        let accum = byAgency.get(key);
        if (!accum) {
          accum = { agencyName, agencyListId, taxItems: [] };
          byAgency.set(key, accum);
        }
        accum.taxItems.push({
          name: String(item.FullName ?? item.Name ?? ""),
          listId: String(item.ListID ?? ""),
          taxRate: Number(item.TaxRate ?? 0),
        });
      }

      // Optional Vendor enrichment. Lookup by ListID when present (most
      // specific); fall back to a FullName-scoped query when only the name
      // came through. Each lookup is a single VendorQueryRq round trip — N
      // round trips for N agencies. Failure on a single lookup is fail-soft
      // (the row surfaces without vendorDetails rather than failing the
      // whole tool).
      const wantsDetails = includeVendorDetails !== false;
      const agencies = await Promise.all(
        [...byAgency.values()].map(async (a) => {
          let vendorDetails: Record<string, unknown> | null = null;
          if (wantsDetails) {
            try {
              const matches = await session.queryEntity("Vendor", {
                ...(a.agencyListId
                  ? { ListID: a.agencyListId }
                  : { FullName: a.agencyName }),
              });
              vendorDetails = matches[0] ?? null;
            } catch {
              vendorDetails = null;
            }
          }
          return {
            agencyName: a.agencyName,
            agencyListId: a.agencyListId,
            taxItems: a.taxItems.sort((x, y) => x.name.localeCompare(y.name)),
            ...(wantsDetails ? { vendorDetails } : {}),
          };
        }),
      );

      agencies.sort((a, b) => a.agencyName.localeCompare(b.agencyName));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: agencies.length, agencies }, null, 2),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // qb_sales_tax_liability_report
  // -------------------------------------------------------------------------
  server.tool(
    "qb_sales_tax_liability_report",
    "Run the Sales Tax Liability report (GeneralSummaryReportType=SalesTaxLiability). Returns one row per SalesTaxItem with TaxCollected (sum of header SalesTaxTotal on Invoice + SalesReceipt where the txn carried this item, minus CreditMemo returns), TaxPaid (sum of SalesTaxPaymentCheckLineRet.Amount in window), and TaxPayable (= TaxCollected − TaxPaid). Per-agency rollups + grand totals included. Sim mode tracks tax-collection at the HEADER level only (txn.ItemSalesTaxRef + txn.SalesTaxTotal); per-line tax flagging is not modeled — real QB tracks both. For the typical month-end question 'what do I owe each agency this month?' the header-level model is sufficient. **Live verification deferred** — the GeneralSummaryReport adapter uses a row-tree translator built for P&L / BS / SCF; the SalesTaxLiability live shape may emit different column groupings and may need adapter extension on first live exercise.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start of reporting window (YYYY-MM-DD), inclusive. Omit for no lower bound. Typical CPA workflow: first day of the period (month / quarter)."),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End of reporting window (YYYY-MM-DD), inclusive. Omit for no upper bound. Typical: last day of the period."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual. (Note: simulation aggregates the same way regardless of basis — Cash basis revenue recognition lands with live mode.)"),
    },
    async ({ fromDate, toDate, basis }) => {
      const session = getSession();
      try {
        const reportRet = await session.runReport("SalesTaxLiability", {
          fromDate,
          toDate,
          basis,
        });
        const rows = (reportRet.Rows as Array<Record<string, unknown>> | undefined) ?? [];
        const byAgency = (reportRet.ByAgency as Array<Record<string, unknown>> | undefined) ?? [];
        const totals = (reportRet.Totals as Record<string, unknown> | undefined) ?? {};

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              reportTitle: reportRet.ReportTitle ?? "Sales Tax Liability",
              reportBasis: reportRet.ReportBasis ?? basis ?? "Accrual",
              reportPeriod: {
                from: reportRet.FromReportDate ?? fromDate ?? null,
                to: reportRet.ToReportDate ?? toDate ?? null,
              },
              rows: rows.map((r) => ({
                agencyName: String(r.AgencyName ?? ""),
                agencyListId: r.AgencyListID ?? null,
                taxItemName: String(r.TaxItemName ?? ""),
                taxItemListId: String(r.TaxItemListID ?? ""),
                taxRate: Number(r.TaxRate ?? 0),
                taxCollected: Number(r.TaxCollected ?? 0),
                taxPaid: Number(r.TaxPaid ?? 0),
                taxPayable: Number(r.TaxPayable ?? 0),
              })),
              byAgency: byAgency.map((a) => ({
                agencyName: String(a.AgencyName ?? ""),
                agencyListId: a.AgencyListID ?? null,
                taxCollected: Number(a.TaxCollected ?? 0),
                taxPaid: Number(a.TaxPaid ?? 0),
                taxPayable: Number(a.TaxPayable ?? 0),
              })),
              totals: {
                taxCollected: Number(totals.TaxCollected ?? 0),
                taxPaid: Number(totals.TaxPaid ?? 0),
                taxPayable: Number(totals.TaxPayable ?? 0),
              },
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "GeneralSummaryReportQueryRq (SalesTaxLiability) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // qb_sales_tax_payment_create
  // -------------------------------------------------------------------------
  server.tool(
    "qb_sales_tax_payment_create",
    "Write a sales-tax payment check (SalesTaxPaymentCheckAddRq). Distinct from qb_check_create because the lines reduce sales-tax-item liability instead of posting to expense GL — use this when paying down what you owe an agency from qb_sales_tax_liability_report, NOT qb_check_create (a regular Check posted to a tax-liability account would double-count). Each line names ONE SalesTaxItem + an Amount; the sum is drawn from bankAccountName. payeeName is the tax agency vendor (typically the same vendor as the lines' SalesTaxItem.TaxVendorRef — real QB validates this match server-side; sim doesn't). At least one line is required. Standard idempotency on the create call (replay → idempotentReplay:true; key+different-payload → 9002). Read-only sessions reject with 9001.",
    {
      bankAccountName: z.string().optional().describe("FullName of the Bank account the check is drawn from (e.g. 'Checking')."),
      bankAccountListId: z.string().optional().describe("ListID of the bank account. Wins over bankAccountName when both supplied."),
      payeeName: z.string().optional().describe("FullName of the tax agency vendor receiving the check (typically matches the agency on the lines' SalesTaxItem.TaxVendorRef)."),
      payeeListId: z.string().optional().describe("ListID of the payee vendor."),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Check date (YYYY-MM-DD). Default: today."),
      refNumber: z.string().optional().describe("Check / reference number."),
      memo: z.string().optional().describe("Header memo (e.g. 'Q1 2026 sales tax payment')."),
      isToBePrinted: z.boolean().optional().describe("Mark the check 'To be printed' (default false — real QB shows it in the print queue)."),
      lines: z.array(salesTaxPaymentLineSchema).min(1)
        .describe("Per-tax-item allocation lines. At least one required. Each line names a SalesTaxItem + the dollar amount of liability paid down."),
      idempotencyKey: z.string().min(1).optional()
        .describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original payment check without creating a duplicate (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
    },
    async (args) => {
      const session = getSession();

      if (!args.bankAccountName && !args.bankAccountListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either bankAccountName or bankAccountListId is required",
            }),
          }],
          isError: true,
        };
      }
      if (!args.payeeName && !args.payeeListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either payeeName or payeeListId is required",
            }),
          }],
          isError: true,
        };
      }

      const data: Record<string, unknown> = {};

      // Schema-required child order (canonical SalesTaxPaymentCheckAdd
      // <xs:sequence>): BankAccountRef → TxnDate → RefNumber → PayeeEntityRef
      // → IsToBePrinted → Memo → SalesTaxPaymentCheckLineAdd*. JS key
      // insertion order matches what the builder emits (pinned by
      // tests/builder-emit-order.test.ts for similar transaction types).
      if (args.bankAccountListId) {
        data.BankAccountRef = { ListID: args.bankAccountListId };
      } else {
        data.BankAccountRef = { FullName: args.bankAccountName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.payeeListId) {
        data.PayeeEntityRef = { ListID: args.payeeListId };
      } else {
        data.PayeeEntityRef = { FullName: args.payeeName };
      }
      if (args.isToBePrinted !== undefined) data.IsToBePrinted = args.isToBePrinted;
      if (args.memo) data.Memo = args.memo;

      data.SalesTaxPaymentCheckLineAdd = args.lines.map((line) => {
        const lineData: Record<string, unknown> = {};
        if (line.salesTaxItemListId) {
          lineData.ItemSalesTaxRef = { ListID: line.salesTaxItemListId };
        } else {
          lineData.ItemSalesTaxRef = { FullName: line.salesTaxItemName };
        }
        lineData.Amount = line.amount;
        if (line.memo) lineData.Memo = line.memo;
        return lineData;
      });

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("SalesTaxPaymentCheck", data, args.idempotencyKey)
          : { entity: await session.addEntity("SalesTaxPaymentCheck", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              salesTaxPayment: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "SalesTaxPaymentCheckAddRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
