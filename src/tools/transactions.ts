/**
 * Cross-type transaction tools (Phase 10 #40+).
 *
 * `qb_transaction_list_by_account` is the QBXML SDK's TransactionQueryRq —
 * unlike per-type list tools (qb_invoice_list, qb_bill_list, …), one call
 * returns postings from any transaction shape (Invoice, Bill, Check,
 * JournalEntry, ReceivePayment, …) filtered primarily by AccountFilter.
 * That's the foundation for "what hit this account" workflows the operator
 * cannot reconstruct from per-type lists without N round trips.
 *
 * `qb_transaction_list` (Phase 16 #72) is a composite over typed entity
 * queries — fans out across the customer-side (or vendor-side) txn types
 * with a shared EntityFilter + TxnDateRangeFilter, returns a unified
 * chronologically-sorted feed. Same composite pattern as #48
 * qb_customer_balance_detail and #51 qb_vendor_balance_detail — the
 * literal "single TransactionQueryRq with IncludeAll" spec in todo.md
 * was rejected because (a) IncludeAll is not in the QBXML schema and
 * (b) TransactionQueryRq requires AccountFilter on the wire, so it
 * returns line-level postings rather than transaction headers.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

// Txn types that accept EntityFilter scoping by Customer (CustomerRef).
// Maps to sim's EntityFilter chain at simulation-store.ts:282-296.
const CUSTOMER_SIDE_TYPES = [
  "Invoice",
  "SalesReceipt",
  "ReceivePayment",
  "CreditMemo",
  "StatementCharge",
  "Estimate",
  "SalesOrder",
] as const;

// Txn types that accept EntityFilter scoping by Vendor (VendorRef or
// PayeeEntityRef — sim falls through the chain).
const VENDOR_SIDE_TYPES = [
  "Bill",
  "BillPaymentCheck",
  "BillPaymentCreditCard",
  "Check",
  "CreditCardCharge",
  "CreditCardCredit",
  "PurchaseOrder",
] as const;

type TxnType =
  | (typeof CUSTOMER_SIDE_TYPES)[number]
  | (typeof VENDOR_SIDE_TYPES)[number];

const ALL_TXN_TYPES = [
  ...CUSTOMER_SIDE_TYPES,
  ...VENDOR_SIDE_TYPES,
] as const;

// Defaults: AR-affecting types under customer scope (omits Estimate +
// SalesOrder — non-posting; operator opts in via `types`). AP-affecting
// types under vendor scope (omits PurchaseOrder — non-posting). Driven
// by the canonical "show me everything for customer X in March" use case.
const DEFAULT_CUSTOMER_TYPES: TxnType[] = [
  "Invoice",
  "SalesReceipt",
  "ReceivePayment",
  "CreditMemo",
  "StatementCharge",
];
const DEFAULT_VENDOR_TYPES: TxnType[] = [
  "Bill",
  "BillPaymentCheck",
  "BillPaymentCreditCard",
  "Check",
  "CreditCardCharge",
];

function isCustomerSide(t: TxnType): boolean {
  return (CUSTOMER_SIDE_TYPES as readonly string[]).includes(t);
}

function isVendorSide(t: TxnType): boolean {
  return (VENDOR_SIDE_TYPES as readonly string[]).includes(t);
}

export function registerTransactionTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_transaction_list_by_account",
    "List every posting (line-level) that hit a specific GL account, optionally bounded by date. Returns rows sorted by TxnDate ascending with a running balance computed in the tool layer (TransactionQueryRq does NOT compute running balance server-side). Sign convention: positive Amount = increases the target account's natural balance (e.g. a $500 bill posts +500 to Rent Expense; a customer refund posts -500 to Sales Revenue). Pass either accountName (FullName) or accountListId — at least one is required.",
    {
      accountName: z.string().optional()
        .describe("Account FullName (e.g. 'Rent Expense'). Either this or accountListId is required."),
      accountListId: z.string().optional()
        .describe("Account ListID. Either this or accountName is required."),
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the date window (YYYY-MM-DD, inclusive). Omit for all-time."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the date window (YYYY-MM-DD, inclusive). Omit for through-current."),
      maxReturned: z.number().optional()
        .describe("Maximum rows. Defaults to QB's per-batch cap (~500) if unset."),
      includeRunningBalance: z.boolean().optional()
        .describe("Compute per-row RunningBalance from currentBalance backwards (default true). Set false to skip the AccountQueryRq round trip when only the row list is needed."),
    },
    async (args) => {
      const session = getSession();

      if (!args.accountName && !args.accountListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either accountName or accountListId is required",
            }),
          }],
          isError: true,
        };
      }

      // TransactionQueryRq schema-required child order (QBXML 16.0 SDK):
      //   TxnID? → MaxReturned? → ModifiedDateRangeFilter? → TxnDateRangeFilter?
      //   → EntityFilter? → AccountFilter → RefNumberFilter? →
      //   TransactionTypeFilter? → PostedFilter? → DetailLevel?
      // Out-of-order children fall through the same statusCode -1 "found an
      // error when parsing" trap that bit qb_pnl_report on 2026-05-09. Pinned
      // for this query in tests/builder-emit-order.test.ts.
      const filters: Record<string, unknown> = {};
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = {
          FromTxnDate: args.fromDate,
          ToTxnDate: args.toDate,
        };
      }
      if (args.accountListId) {
        filters.AccountFilter = { ListID: args.accountListId };
      } else {
        filters.AccountFilter = { FullName: args.accountName };
      }

      try {
        const rows = await session.queryTransactions(filters);

        // Stable chronological sort (sim does this; live's response order is
        // QB-driven and not guaranteed). TimeCreated tiebreaker keeps same-
        // date rows in insertion order so running balance walks deterministically.
        const sorted = [...rows].sort((a, b) => {
          const ad = String(a.TxnDate ?? "");
          const bd = String(b.TxnDate ?? "");
          if (ad !== bd) return ad < bd ? -1 : 1;
          const at = String(a.TimeCreated ?? "");
          const bt = String(b.TimeCreated ?? "");
          return at < bt ? -1 : at > bt ? 1 : 0;
        });

        // Running balance — computed in this handler because TransactionQueryRq
        // does NOT return a running balance (real QB only computes running
        // balance for ReportQueryRq's TransactionDetail report). Algorithm
        // (per Phase 10 #40 HANDOFF math):
        //   1. Pull the account's CURRENT balance (Account.Balance) via a
        //      separate AccountQueryRq.
        //   2. Sum the period-window posting amounts from the rows we just
        //      received.
        //   3. openingBalance = currentBalance − periodSum.
        //   4. Walk forward per row; runningBalance += row.Amount.
        // This is exact when toDate ≥ now (the typical case). When toDate is
        // historical AND postings exist after toDate, openingBalance is
        // overstated by those after-period postings — documented limitation
        // (the alternative, fetching the full history, costs a wider round
        // trip). To avoid the approximation, omit toDate.
        let openingBalance: number | null = null;
        let currentBalance: number | null = null;
        let runningBalanceErr: string | null = null;

        if (args.includeRunningBalance !== false) {
          try {
            const targetName = args.accountName;
            const targetListId = args.accountListId;
            const accountFilter: Record<string, unknown> = targetListId
              ? { ListID: targetListId }
              : { FullName: targetName };
            const accountResults = await session.queryEntity("Account", accountFilter);
            if (accountResults.length === 0) {
              runningBalanceErr =
                "Account not found — cannot compute running balance";
            } else {
              const acct = accountResults[0];
              currentBalance = Number(acct.Balance ?? 0);
              if (!Number.isFinite(currentBalance)) currentBalance = 0;
              const periodSum = sorted.reduce(
                (s, r) => s + Number(r.Amount ?? 0),
                0
              );
              openingBalance =
                Math.round((currentBalance - periodSum) * 100) / 100;
              let running = openingBalance;
              for (const row of sorted) {
                running += Number(row.Amount ?? 0);
                row.RunningBalance = Math.round(running * 100) / 100;
              }
            }
          } catch (err) {
            runningBalanceErr = `Running-balance computation failed: ${(err as Error).message}`;
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: sorted.length,
              account: args.accountName ?? args.accountListId,
              fromDate: args.fromDate ?? null,
              toDate: args.toDate ?? null,
              ...(currentBalance !== null ? { currentBalance } : {}),
              ...(openingBalance !== null ? { openingBalance } : {}),
              ...(runningBalanceErr ? { runningBalanceError: runningBalanceErr } : {}),
              transactions: sorted,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TransactionQueryRq failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_transaction_list (Phase 16 #72)
  //
  // Cross-type unified transaction list. Composite over typed entity queries
  // — one underlying *QueryRq per requested TxnType, all sharing the same
  // EntityFilter + TxnDateRangeFilter. Replaces the "fan out across 5+
  // tools and merge client-side" pattern for the operator's canonical
  // "show me everything for customer X in March" workflow.
  //
  // Architectural call (mirrors #48 / #51): TransactionQueryRq with
  // TransactionTypeFilter would be one wire call, but real QB rejects
  // TransactionQueryRq without AccountFilter (statusCode 3120) and even
  // when AccountFilter is supplied, returns LINE-LEVEL POSTINGS rather
  // than transaction headers — wrong cardinality for this UX. Walking
  // typed entities directly returns the headers the operator wants and
  // collapses to N round trips for N requested types (typically ≤5).
  //
  // Scope direction:
  //   - customerName / customerListId → customer-side fanout
  //   - vendorName / vendorListId     → vendor-side fanout
  //   - none → date-range-only mode (defaults to customer-side types)
  //   - both customer AND vendor scope → rejected (3120)
  //
  // Type validation: under a customer scope, `types` may contain only
  // customer-side types; under a vendor scope, only vendor-side. Mixed
  // types are allowed only when no entity scope is supplied (e.g. an
  // audit walk over a date window). Validation rejects upfront with
  // statusCode 3120 + actionable message.
  //
  // JournalEntry deliberately NOT exposed in this tool's type enum:
  // JE's per-line EntityRef is not modeled in sim's EntityFilter chain
  // (handleQuery walks header refs only — simulation-store.ts:282-296),
  // and JE postings against AR/AP are reachable via
  // qb_transaction_list_by_account on the AR/AP account directly.
  // Operator workflows that need JE alongside customer txns walk
  // qb_journal_entry_list separately.
  // -----------------------------------------------------------------------
  server.tool(
    "qb_transaction_list",
    "Cross-type unified transaction list. Single call returns invoices + sales receipts + payments + credit memos + statement charges (under a customer scope), OR bills + bill payments + checks + credit-card charges (under a vendor scope), sorted chronologically with a TxnType tag on every row. Composite over typed *QueryRq calls — one round trip per requested type. Replaces 5–6 separate per-type list tool calls when answering 'show me everything for Customer X in March'. Pass exactly one of {customerName, customerListId} OR {vendorName, vendorListId} (mutually exclusive directions), plus optional fromDate / toDate. Types arg lets you narrow the fanout (e.g. types:['Invoice','ReceivePayment'] for AR-only). Under a customer scope, only customer-side types are accepted; under a vendor scope, only vendor-side; mixed types are allowed only when no entity scope is supplied. JournalEntry is NOT exposed — JE entity refs are per-line and not modeled in sim's EntityFilter; use qb_transaction_list_by_account on the AR/AP account or qb_journal_entry_list directly. Each row carries the full *Ret shape from the underlying query plus an injected TxnType tag.",
    {
      customerName: z.string().optional()
        .describe("Customer FullName for customer-side scope. Mutually exclusive with vendor scope; resolved against the live customer list before being passed as EntityFilter.FullName."),
      customerListId: z.string().optional()
        .describe("Customer ListID for customer-side scope. Alternative to customerName."),
      vendorName: z.string().optional()
        .describe("Vendor FullName for vendor-side scope. Mutually exclusive with customer scope."),
      vendorListId: z.string().optional()
        .describe("Vendor ListID for vendor-side scope. Alternative to vendorName."),
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the date window (YYYY-MM-DD, inclusive). Passed through as TxnDateRangeFilter.FromTxnDate on every underlying query."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the date window (YYYY-MM-DD, inclusive). Omit for through-current."),
      types: z.array(z.enum(ALL_TXN_TYPES)).min(1).optional()
        .describe(`Subset of transaction types to fan out across. Customer-side: ${CUSTOMER_SIDE_TYPES.join(', ')}. Vendor-side: ${VENDOR_SIDE_TYPES.join(', ')}. If unset, defaults to AR-affecting types (Invoice, SalesReceipt, ReceivePayment, CreditMemo, StatementCharge) under customer or no scope, and AP-affecting types (Bill, BillPaymentCheck, BillPaymentCreditCard, Check, CreditCardCharge) under vendor scope. Under a customer scope, only customer-side types are accepted; under a vendor scope, only vendor-side.`),
      maxPerType: z.number().int().positive().optional()
        .describe("Cap per underlying typed query. Default 500 (QB's per-batch cap). Hitting the cap on any type surfaces a warning in the response."),
      includeLineItems: z.boolean().optional()
        .describe("When true, threaded as IncludeLineItems on every underlying query so the response rows carry full *LineRet detail. Default false — header-only shape, matching #41's strip-by-default policy."),
    },
    async (args) => {
      const session = getSession();

      // ---------- VALIDATION ----------
      const hasCustomer = !!(args.customerName || args.customerListId);
      const hasVendor = !!(args.vendorName || args.vendorListId);

      if (hasCustomer && hasVendor) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage:
                "Customer scope and vendor scope are mutually exclusive — pass either customerName/customerListId OR vendorName/vendorListId, not both",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      if (args.customerName && args.customerListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage:
                "Pass either customerName or customerListId, not both",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      if (args.vendorName && args.vendorListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage:
                "Pass either vendorName or vendorListId, not both",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      // Require SOME bound — preventing accidental "scan everything ever".
      // Either a scope (customer or vendor) or a date range satisfies this.
      if (!hasCustomer && !hasVendor && !args.fromDate && !args.toDate) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage:
                "At least one of customerName / customerListId / vendorName / vendorListId / fromDate / toDate is required to bound the fanout",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      // Resolve default types from scope direction, then validate any
      // user-supplied types against the scope.
      let effectiveTypes: TxnType[];
      if (args.types && args.types.length > 0) {
        effectiveTypes = args.types as TxnType[];
        if (hasCustomer) {
          const bad = effectiveTypes.filter((t) => !isCustomerSide(t));
          if (bad.length > 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  statusCode: 3120,
                  statusMessage: `Type(s) ${bad.join(", ")} are vendor-side and incompatible with customer scope. Customer-side types: ${CUSTOMER_SIDE_TYPES.join(", ")}.`,
                  humanReadable: qbStatusCodeMessage(3120),
                }),
              }],
              isError: true,
            };
          }
        } else if (hasVendor) {
          const bad = effectiveTypes.filter((t) => !isVendorSide(t));
          if (bad.length > 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  statusCode: 3120,
                  statusMessage: `Type(s) ${bad.join(", ")} are customer-side and incompatible with vendor scope. Vendor-side types: ${VENDOR_SIDE_TYPES.join(", ")}.`,
                  humanReadable: qbStatusCodeMessage(3120),
                }),
              }],
              isError: true,
            };
          }
        }
      } else {
        effectiveTypes = hasVendor
          ? [...DEFAULT_VENDOR_TYPES]
          : [...DEFAULT_CUSTOMER_TYPES];
      }

      const maxPerType = args.maxPerType ?? 500;

      // ---------- ENTITY RESOLUTION ----------
      // Canonicalize ListID → FullName before building EntityFilter. The sim's
      // match-by-ListID path (simulation-store.ts:282-296) checks ref.ListID
      // directly, but CustomerRefs stored via addEntity with only a FullName
      // don't carry a hydrated ListID — so the FullName form is more robust
      // across sim entities and exactly equivalent in live QB. Same trick
      // qb_customer_balance_detail uses (reports.ts:2549-2566).
      let entityName: string | null = null;
      let entityListId: string | null = null;
      if (hasCustomer) {
        const allCustomers = await session.queryEntity("Customer", {});
        let target = allCustomers as Array<Record<string, unknown>>;
        if (args.customerListId) {
          target = target.filter(
            (c) => String(c.ListID ?? "") === args.customerListId,
          );
        } else if (args.customerName) {
          target = target.filter(
            (c) => String(c.FullName ?? c.Name ?? "") === args.customerName,
          );
        }
        if (target.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                statusCode: 500,
                statusMessage: args.customerListId
                  ? `Customer with ListID '${args.customerListId}' not found`
                  : `Customer with FullName '${args.customerName}' not found`,
                humanReadable: qbStatusCodeMessage(500),
              }),
            }],
            isError: true,
          };
        }
        entityName = String(target[0].FullName ?? target[0].Name ?? "");
        if (target[0].ListID) entityListId = String(target[0].ListID);
      } else if (hasVendor) {
        const allVendors = await session.queryEntity("Vendor", {});
        let target = allVendors as Array<Record<string, unknown>>;
        if (args.vendorListId) {
          target = target.filter(
            (v) => String(v.ListID ?? "") === args.vendorListId,
          );
        } else if (args.vendorName) {
          target = target.filter(
            (v) => String(v.FullName ?? v.Name ?? "") === args.vendorName,
          );
        }
        if (target.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                statusCode: 500,
                statusMessage: args.vendorListId
                  ? `Vendor with ListID '${args.vendorListId}' not found`
                  : `Vendor with FullName '${args.vendorName}' not found`,
                humanReadable: qbStatusCodeMessage(500),
              }),
            }],
            isError: true,
          };
        }
        entityName = String(target[0].FullName ?? target[0].Name ?? "");
        if (target[0].ListID) entityListId = String(target[0].ListID);
      }

      // ---------- BUILD SHARED FILTERS ----------
      // Canonical schema-order for the *QueryRq prefix shared across all
      // customer-side and vendor-side types: MaxReturned → TxnDateRangeFilter
      // → EntityFilter → (type-specific tail) → IncludeLineItems. Pinned in
      // tests/builder-emit-order.test.ts for the individual *QueryRq types.
      const sharedFilters: Record<string, unknown> = { MaxReturned: maxPerType };
      if (args.fromDate || args.toDate) {
        sharedFilters.TxnDateRangeFilter = {
          FromTxnDate: args.fromDate,
          ToTxnDate: args.toDate,
        };
      }
      if (entityName) {
        sharedFilters.EntityFilter = { FullName: entityName };
      }
      if (args.includeLineItems === true) {
        sharedFilters.IncludeLineItems = true;
      }

      // ---------- FANOUT ----------
      const warnings: string[] = [];
      const typeCounts: Record<string, number> = {};
      const allTxns: Array<Record<string, unknown>> = [];

      try {
        const queryPromises = effectiveTypes.map(async (txnType) => {
          const results = await session.queryEntity(txnType, sharedFilters);
          return { txnType, results };
        });
        const results = await Promise.all(queryPromises);

        for (const { txnType, results: rows } of results) {
          typeCounts[txnType] = rows.length;
          if (rows.length >= maxPerType) {
            warnings.push(
              `${txnType} hit maxPerType cap (${maxPerType}) — narrow fromDate/toDate or raise maxPerType for full results`,
            );
          }
          for (const row of rows) {
            allTxns.push({ TxnType: txnType, ...row });
          }
        }
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "qb_transaction_list failed" });
      }

      // Chronological sort with TimeCreated tiebreaker for same-date rows.
      // Matches the sort order of qb_transaction_list_by_account and
      // qb_customer_balance_detail.
      allTxns.sort((a, b) => {
        const ad = String(a.TxnDate ?? "");
        const bd = String(b.TxnDate ?? "");
        if (ad !== bd) return ad < bd ? -1 : 1;
        const at = String(a.TimeCreated ?? "");
        const bt = String(b.TimeCreated ?? "");
        return at < bt ? -1 : at > bt ? 1 : 0;
      });

      // Scope summary for the response — surfaces what was actually fanned out.
      const scope: Record<string, unknown> = {};
      if (hasCustomer) {
        scope.direction = "customer";
        if (entityName) scope.customerName = entityName;
        if (entityListId) scope.customerListId = entityListId;
      } else if (hasVendor) {
        scope.direction = "vendor";
        if (entityName) scope.vendorName = entityName;
        if (entityListId) scope.vendorListId = entityListId;
      } else {
        scope.direction = "all";
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            scope,
            fromDate: args.fromDate ?? null,
            toDate: args.toDate ?? null,
            types: effectiveTypes,
            typeCounts,
            count: allTxns.length,
            transactions: allTxns,
            ...(warnings.length > 0 ? { warnings } : {}),
          }, null, 2),
        }],
      };
    }
  );
}
