/**
 * Simulation store for QuickBooks Desktop MCP.
 *
 * Provides an in-memory data store that simulates QuickBooks Desktop
 * responses for development, testing, and non-Windows environments.
 * Processes QBXML requests and returns properly-formatted QBXML responses.
 */

import { XMLParser } from "fast-xml-parser";
import type { QBXMLResponse, QBXMLResponseBody } from "../types/qbxml.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredEntity {
  [key: string]: unknown;
  ListID?: string;
  TxnID?: string;
  EditSequence?: string;
  TimeCreated?: string;
  TimeModified?: string;
}

type EntityStore = Map<string, StoredEntity>;

// ---------------------------------------------------------------------------
// XML parser for incoming requests
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: true,
  trimValues: true,
});

// ---------------------------------------------------------------------------
// Simulation Store
// ---------------------------------------------------------------------------

export class SimulationStore {
  private stores: Map<string, EntityStore> = new Map();
  private idCounter = 1000;

  constructor() {
    this.seedData();
  }

  // -----------------------------------------------------------------------
  // Request processing
  // -----------------------------------------------------------------------

  processRequest(qbxmlRequest: string): QBXMLResponse {
    const parsed = xmlParser.parse(qbxmlRequest);
    const msgsRq = parsed?.QBXML?.QBXMLMsgsRq;
    if (!msgsRq) {
      return {
        responses: [{
          type: "ErrorRs",
          statusCode: -1,
          statusSeverity: "Error",
          statusMessage: "Invalid QBXML request format",
          data: {},
        }],
      };
    }

    // QBXMLMsgsRq carries an `onError` attribute. The builder hardcodes
    // "stopOnError" — when one *Rq fails, subsequent *Rqs in the same envelope
    // are NOT processed. This matters for Phase 10 #43 (batch JE create) and
    // any future multi-request envelope: the simulation must honor the same
    // semantics so live and sim behave observationally identically.
    const onError = String(msgsRq["@_onError"] ?? "stopOnError");

    const responses: QBXMLResponseBody[] = [];

    // Multi-request envelope handling: when N requests share a *Rq name (e.g.
    // batch JE create), fast-xml-parser packs them as an array under a single
    // key. The outer Object.entries loop fires once per unique key; the inner
    // loop walks the array (or wraps a single object). Each request element
    // carries its own @_requestID attribute, propagated to the response so
    // batch callers can align response-to-input by position.
    outer: for (const [key, value] of Object.entries(msgsRq)) {
      if (key.startsWith("@_")) continue;

      const reqs = Array.isArray(value) ? value : [value];

      for (const req of reqs) {
        const reqData = (typeof req === "object" && req !== null)
          ? req as Record<string, unknown>
          : {};

        const requestID = reqData["@_requestID"] !== undefined
          ? String(reqData["@_requestID"])
          : undefined;

        let response: QBXMLResponseBody;
        if (key === "GeneralSummaryReportQueryRq") {
          response = this.handleReportQuery(key, reqData);
        } else if (key === "TransactionQueryRq") {
          // TransactionQueryRq is a CROSS-TYPE query — fans out across every
          // transaction store and emits per-line postings as TransactionRet.
          // The generic handleQuery would treat it as a per-type query against
          // a "Transaction" store (which doesn't exist) and return empty.
          response = this.handleTransactionQuery(key, reqData);
        } else if (key.endsWith("QueryRq")) {
          response = this.handleQuery(key, reqData);
        } else if (key.endsWith("AddRq")) {
          response = this.handleAdd(key, reqData);
        } else if (key.endsWith("ModRq")) {
          response = this.handleMod(key, reqData);
        } else if (key === "ListDelRq") {
          response = this.handleListDel(reqData);
        } else if (key === "TxnDelRq") {
          response = this.handleTxnDel(reqData);
        } else {
          response = {
            type: key.replace("Rq", "Rs"),
            statusCode: -1,
            statusSeverity: "Error",
            statusMessage: `Unsupported request type: ${key}`,
            data: {},
          };
        }

        if (requestID !== undefined) {
          response = { ...response, requestID };
        }
        responses.push(response);

        if (
          onError === "stopOnError" &&
          response.statusSeverity === "Error" &&
          response.statusCode !== 0
        ) {
          // Per the QBXML spec, stopOnError halts further processing of the
          // envelope on the first error. Skipped requests get no response
          // (the live wire behaves the same way), which is what allows batch
          // callers to derive `skipped` count from `inputCount - responses`.
          break outer;
        }
      }
    }

    return { responses };
  }

  // -----------------------------------------------------------------------
  // Query handler
  // -----------------------------------------------------------------------

  private handleQuery(
    reqType: string,
    reqData: Record<string, unknown>
  ): QBXMLResponseBody {
    const entityType = reqType.replace("QueryRq", "");
    const rsType = reqType.replace("Rq", "Rs");
    const retName = `${entityType}Ret`;

    // Iterator state arrives as XML attributes on the *QueryRq element (Item
    // 27). fast-xml-parser surfaces them as @_iterator / @_iteratorID on the
    // request body. The simulation does not actually page — Start returns the
    // full result set in one shot with iteratorRemainingCount=0; Continue/Stop
    // are treated as already-exhausted no-ops. See queryEntityPaginated jsdoc.
    const iteratorMode = reqData["@_iterator"]
      ? String(reqData["@_iterator"])
      : null;
    if (iteratorMode === "Continue" || iteratorMode === "Stop") {
      return {
        type: rsType,
        statusCode: 1,
        statusSeverity: "Info",
        statusMessage: "A query request did not find a matching object in QuickBooks",
        data: {},
      };
    }

    let results: StoredEntity[] = Array.from(this.getStore(entityType).values());

    // Apply filters
    if (reqData.ListID) {
      const ids = Array.isArray(reqData.ListID)
        ? reqData.ListID as string[]
        : [reqData.ListID as string];
      results = results.filter((e) => ids.includes(e.ListID ?? ""));
    }
    if (reqData.TxnID) {
      const ids = Array.isArray(reqData.TxnID)
        ? reqData.TxnID as string[]
        : [reqData.TxnID as string];
      results = results.filter((e) => ids.includes(e.TxnID ?? ""));
    }
    if (reqData.FullName) {
      const names = Array.isArray(reqData.FullName)
        ? reqData.FullName as string[]
        : [reqData.FullName as string];
      results = results.filter((e) =>
        names.includes(String(e.FullName ?? e.Name ?? ""))
      );
    }

    // Transaction filters: EntityFilter matches Customer/Vendor reference on
    // the transaction. Real QB scopes EntityFilter to CustomerRef on
    // Invoice/ReceivePayment/Estimate/SalesReceipt/CreditMemo/SalesOrder, and
    // to VendorRef on Bill/PurchaseOrder/BillPaymentCheck/BillPaymentCreditCard.
    // For the sim, we accept either ref shape — entities only carry one.
    if (reqData.EntityFilter && typeof reqData.EntityFilter === "object") {
      const ef = reqData.EntityFilter as Record<string, unknown>;
      const targetListIds = ef.ListID
        ? (Array.isArray(ef.ListID)
            ? (ef.ListID as unknown[]).map(String)
            : [String(ef.ListID)])
        : null;
      const targetNames = ef.FullName
        ? (Array.isArray(ef.FullName)
            ? (ef.FullName as unknown[]).map(String)
            : [String(ef.FullName)])
        : null;
      if (targetListIds || targetNames) {
        results = results.filter((e) => {
          const ref = (e.CustomerRef ?? e.VendorRef) as
            | Record<string, unknown>
            | undefined;
          if (!ref) return false;
          if (targetListIds && targetListIds.includes(String(ref.ListID ?? ""))) {
            return true;
          }
          if (targetNames && targetNames.includes(String(ref.FullName ?? ""))) {
            return true;
          }
          return false;
        });
      }
    }

    // TxnDateRangeFilter — inclusive date window against TxnDate. Stored as
    // ISO YYYY-MM-DD, which sorts lexicographically.
    if (
      reqData.TxnDateRangeFilter &&
      typeof reqData.TxnDateRangeFilter === "object"
    ) {
      const dr = reqData.TxnDateRangeFilter as Record<string, unknown>;
      const from = dr.FromTxnDate ? String(dr.FromTxnDate) : null;
      const to = dr.ToTxnDate ? String(dr.ToTxnDate) : null;
      if (from || to) {
        results = results.filter((e) => {
          const d = String(e.TxnDate ?? "");
          if (from && d < from) return false;
          if (to && d > to) return false;
          return true;
        });
      }
    }

    if (
      reqData.ModifiedDateRangeFilter &&
      typeof reqData.ModifiedDateRangeFilter === "object"
    ) {
      const dr = reqData.ModifiedDateRangeFilter as Record<string, unknown>;
      const from = dr.FromModifiedDate ? String(dr.FromModifiedDate) : null;
      const to = dr.ToModifiedDate ? String(dr.ToModifiedDate) : null;
      if (from || to) {
        results = results.filter((e) => {
          const m = String(e.TimeModified ?? "");
          if (from && m < from) return false;
          if (to && m > to) return false;
          return true;
        });
      }
    }

    if (reqData.PaidStatus) {
      const status = String(reqData.PaidStatus);
      if (status === "PaidOnly") {
        results = results.filter((e) => e.IsPaid === true);
      } else if (status === "NotPaidOnly") {
        results = results.filter((e) => e.IsPaid !== true);
      }
    }

    // RefNumber — exact match. RefNumberFilter (partial match) deferred.
    if (reqData.RefNumber) {
      const ref = String(reqData.RefNumber);
      results = results.filter((e) => String(e.RefNumber ?? "") === ref);
    }

    if (reqData.NameFilter) {
      const filter = reqData.NameFilter as Record<string, unknown>;
      const matchCriterion = String(filter.MatchCriterion ?? "Contains");
      const nameValue = String(filter.Name ?? "");
      results = results.filter((e) => {
        const name = String(e.FullName ?? e.Name ?? "");
        switch (matchCriterion) {
          case "StartsWith": return name.startsWith(nameValue);
          case "EndsWith": return name.endsWith(nameValue);
          case "Contains": return name.includes(nameValue);
          default: return name.includes(nameValue);
        }
      });
    }
    if (reqData.ActiveStatus === "ActiveOnly") {
      results = results.filter((e) => e.IsActive !== false);
    } else if (reqData.ActiveStatus === "InactiveOnly") {
      results = results.filter((e) => e.IsActive === false);
    }
    if (reqData.MaxReturned) {
      results = results.slice(0, Number(reqData.MaxReturned));
    }

    // IncludeLineItems gate (Phase 10 #41). Real QB strips *LineRet from
    // *QueryRq responses unless <IncludeLineItems>true</IncludeLineItems> is
    // present on the request. The simulation stores entities with their full
    // *LineRet arrays (handleAdd populates them), so we mirror QB's strip
    // here — no-op on list entities (Customer/Vendor/Item don't carry *LineRet
    // keys), behavioral on transaction entities (Invoice/Bill/SR/CM/PO/Estimate).
    // Truthy check accepts both boolean true (in-process tests passing the
    // filter dict directly) and the string "true" (the wire form after a
    // round trip through the parser).
    const includeLineItems =
      reqData.IncludeLineItems === true ||
      String(reqData.IncludeLineItems ?? "").toLowerCase() === "true";
    if (!includeLineItems) {
      results = results.map((e) => this.stripLineRetKeys(e));
    }

    if (results.length === 0) {
      const empty: QBXMLResponseBody = {
        type: rsType,
        statusCode: 1,
        statusSeverity: "Info",
        statusMessage: "A query request did not find a matching object in QuickBooks",
        data: {},
      };
      // On a Start that found no matches, real QB still surfaces an
      // iteratorRemainingCount=0 + iteratorID so the caller knows the
      // iterator was created and is empty. Mirror that.
      if (iteratorMode === "Start") {
        empty.iteratorRemainingCount = 0;
        empty.iteratorID = `SIM-ITER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      return empty;
    }

    const ok: QBXMLResponseBody = {
      type: rsType,
      statusCode: 0,
      statusSeverity: "Info",
      statusMessage: "Status OK",
      data: { [retName]: results },
    };
    if (iteratorMode === "Start") {
      ok.iteratorRemainingCount = 0;
      ok.iteratorID = `SIM-ITER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    return ok;
  }

  // -----------------------------------------------------------------------
  // Report query handler — GeneralSummaryReportQueryRq
  // -----------------------------------------------------------------------

  // Walks income/expense transactions filtered by ReportPeriod, aggregates by
  // account, and emits a simplified ReportRet shape:
  //   { ReportTitle, ReportBasis, FromReportDate, ToReportDate, Sections,
  //     Totals: { GrossProfit?, NetIncome, TotalAssets?, TotalLiabilities?,
  //              TotalEquity? } }
  //
  // Sections are { Name, Accounts: [{ Name, Total }], Subtotal } in canonical
  // QB order. Real QB's wire format uses an interleaved row tree (TextRow /
  // DataRow / SubtotalRow / TotalRow under ReportData) — that's the live-mode
  // shape Phase 7 will need to translate. The simulation owns its wire format
  // until then; the simplified shape is what qb_pnl_report /
  // qb_balance_sheet_report expect.
  //
  // Income side: Invoice + SalesReceipt + CreditMemo (negative). Each line's
  // account is resolved via line.AccountRef (rare on these txns), or via
  // line.ItemRef → item.IncomeAccountRef / item.SalesOrPurchase.AccountRef
  // (Service items use the SalesOrPurchase.AccountRef shape). Lines with no
  // resolvable account land in "Uncategorized Income" so totals still
  // reconcile.
  //
  // Expense side: Bill + Check + CreditCardCharge. ExpenseLineRet carries
  // AccountRef directly (the common path); ItemLineRet resolves the same way
  // as income items (item.ExpenseAccountRef / SalesOrPurchase.AccountRef /
  // COGSAccountRef for Inventory items consumed via Bill ItemLine). JE lines
  // (JournalDebitLineRet / JournalCreditLineRet) also carry AccountRef and
  // contribute (debit increases expense, credit increases income — same sign
  // convention as real QB's posting model).
  //
  // Date filter: TxnDate ∈ [FromReportDate, ToReportDate]. Both bounds
  // inclusive. Missing FromReportDate => no lower bound (all-time). Missing
  // ToReportDate => no upper bound. ReportDate alone (Balance Sheet) is mapped
  // to ToReportDate by the builder — so the filter is unified.
  //
  // BalanceSheet uses the same walk to derive period NetIncome (which closes
  // into Equity), and builds Asset / Liability / Equity sections from
  // Account.Balance (the simulation's snapshot — until Phase 7 we don't have
  // a transaction history rich enough to reconstruct asset/liability balances
  // from txn walks). This means asOfDate is advisory for the AS/LI/EQ
  // sections; the period's NetIncome (which IS walked) reconciles with the
  // P&L for the same range.
  private handleReportQuery(
    reqType: string,
    reqData: Record<string, unknown>
  ): QBXMLResponseBody {
    const rsType = reqType.replace("Rq", "Rs");
    const reportType = String(reqData.GeneralSummaryReportType ?? "");
    const reportPeriod = (reqData.ReportPeriod as Record<string, unknown> | undefined) ?? {};
    const fromDate = reportPeriod.FromReportDate ? String(reportPeriod.FromReportDate) : null;
    const toDate = reportPeriod.ToReportDate ? String(reportPeriod.ToReportDate) : null;
    const basis = String(reqData.ReportBasis ?? "Accrual") as "Accrual" | "Cash";

    if (reportType !== "ProfitAndLossStandard" && reportType !== "BalanceSheetStandard") {
      return {
        type: rsType,
        statusCode: 3120,
        statusSeverity: "Error",
        statusMessage: `Unsupported GeneralSummaryReportType: ${reportType || "(missing)"} (only ProfitAndLossStandard and BalanceSheetStandard are implemented)`,
        data: {},
      };
    }

    if (reportType === "ProfitAndLossStandard") {
      const reportRet = this.buildPnLReport(fromDate, toDate, basis);
      return {
        type: rsType,
        statusCode: 0,
        statusSeverity: "Info",
        statusMessage: "Status OK",
        data: { ReportRet: reportRet },
      };
    }

    // BalanceSheetStandard
    const reportRet = this.buildBalanceSheetReport(toDate, basis);
    return {
      type: rsType,
      statusCode: 0,
      statusSeverity: "Info",
      statusMessage: "Status OK",
      data: { ReportRet: reportRet },
    };
  }

  // -----------------------------------------------------------------------
  // Cross-type transaction query — TransactionQueryRq
  // -----------------------------------------------------------------------

  // Synthesizes per-line postings as TransactionRet rows. Real QB returns one
  // TransactionRet per posting line filtered by AccountFilter; the simulation
  // mirrors that contract by fanning out across every transaction store and
  // emitting rows whose resolved line-level account matches the target.
  //
  // Sign convention: positive Amount = increases the target account's natural
  // balance, negative = decreases. For income/expense lines this collapses to
  // the txn-type sign (Invoice/SR/Bill +; CreditMemo -); for JE lines the sign
  // depends on the account's natural direction (debit on a natural-debit
  // account vs credit on a natural-credit account).
  //
  // First-cut limitation (sim only — live QB returns full posting detail):
  // emits LINE-LEVEL postings only. Implicit counter-postings (AR side of an
  // invoice, AP side of a bill, Bank side of a check, DepositTo side of a
  // ReceivePayment, etc.) are NOT surfaced. This means filtering the sim by
  // a balance-sheet account (AR / AP / Bank / CC) returns empty even when
  // those accounts have real activity. Operators relying on live QB get the
  // full picture; operators using the sim for dev should populate via JE if
  // they need balance-sheet account postings to surface in this view.
  private handleTransactionQuery(
    reqType: string,
    reqData: Record<string, unknown>
  ): QBXMLResponseBody {
    const rsType = "TransactionQueryRs";

    // AccountFilter is required (real QB rejects with statusCode 3120 if
    // missing) — mirror that. Other filters are all optional.
    const accountFilter = (reqData.AccountFilter ?? null) as
      | Record<string, unknown>
      | null;
    if (!accountFilter || (!accountFilter.FullName && !accountFilter.ListID)) {
      return {
        type: rsType,
        statusCode: 3120,
        statusSeverity: "Error",
        statusMessage:
          "There is a missing element: AccountFilter (TransactionQueryRq requires AccountFilter)",
        data: {},
      };
    }

    // Lines store account by FullName (resolveLineAccount returns FullName);
    // canonicalize ListID → FullName via the Account store before matching.
    let targetName: string | null = null;
    if (accountFilter.FullName) {
      targetName = String(accountFilter.FullName);
    } else if (accountFilter.ListID) {
      const acct = this.getStore("Account").get(String(accountFilter.ListID));
      if (acct) targetName = String(acct.FullName ?? acct.Name ?? "");
    }
    if (!targetName) {
      return {
        type: rsType,
        statusCode: 1,
        statusSeverity: "Info",
        statusMessage:
          "A query request did not find a matching object in QuickBooks",
        data: {},
      };
    }

    const dr = reqData.TxnDateRangeFilter as
      | Record<string, unknown>
      | undefined;
    const fromDate = dr?.FromTxnDate ? String(dr.FromTxnDate) : null;
    const toDate = dr?.ToTxnDate ? String(dr.ToTxnDate) : null;
    const inDateWindow = (txnDate: string): boolean => {
      if (fromDate && txnDate < fromDate) return false;
      if (toDate && txnDate > toDate) return false;
      return true;
    };

    // JE sign lookup — natural-debit accounts post +debit/-credit; natural-
    // credit accounts post +credit/-debit. Cached once per query.
    const accountStore = this.getStore("Account");
    const accountTypeByName = new Map<string, string>();
    for (const a of accountStore.values()) {
      const name = String(a.FullName ?? a.Name ?? "");
      if (name) accountTypeByName.set(name, String(a.AccountType ?? ""));
    }
    const NATURAL_DEBIT = new Set([
      "Bank", "AccountsReceivable", "OtherCurrentAsset", "Inventory",
      "FixedAsset", "OtherAsset", "CostOfGoodsSold", "Expense", "OtherExpense",
    ]);
    const targetType = accountTypeByName.get(targetName) ?? "";
    const targetIsNaturalDebit = NATURAL_DEBIT.has(targetType);

    const rows: StoredEntity[] = [];

    const emit = (
      txn: StoredEntity,
      txnType: string,
      amount: number,
      memo?: string
    ): void => {
      if (!Number.isFinite(amount) || amount === 0) return;
      const txnDate = String(txn.TxnDate ?? "");
      if (!inDateWindow(txnDate)) return;
      const entityRef = (txn.CustomerRef ?? txn.VendorRef ?? txn.EntityRef) as
        | Record<string, unknown>
        | undefined;
      const row: StoredEntity = {
        TxnID: String(txn.TxnID ?? ""),
        TxnType: txnType,
        TxnDate: txnDate,
        Account: { FullName: targetName! },
        Amount: Math.round(amount * 100) / 100,
        ...(txn.RefNumber !== undefined ? { RefNumber: String(txn.RefNumber) } : {}),
        ...(memo !== undefined
          ? { Memo: memo }
          : txn.Memo !== undefined
            ? { Memo: String(txn.Memo) }
            : {}),
        ...(entityRef?.FullName
          ? { Entity: { FullName: String(entityRef.FullName) } }
          : {}),
        ...(txn.TimeCreated !== undefined
          ? { TimeCreated: String(txn.TimeCreated) }
          : {}),
        ...(txn.TimeModified !== undefined
          ? { TimeModified: String(txn.TimeModified) }
          : {}),
      };
      rows.push(row);
    };

    const walkLines = (
      storeName: string,
      txnType: string,
      lineKey: string,
      direction: "income" | "expense",
      sign: 1 | -1
    ): void => {
      for (const txn of this.getStore(storeName).values()) {
        const lines = txn[lineKey];
        if (!Array.isArray(lines)) continue;
        for (const line of lines as Record<string, unknown>[]) {
          const accountName = this.resolveLineAccount(line, direction);
          if (accountName !== targetName) continue;
          const amt = Number(line.Amount ?? 0);
          if (!Number.isFinite(amt) || amt === 0) continue;
          emit(txn, txnType, sign * amt, line.Memo ? String(line.Memo) : undefined);
        }
      }
    };

    // Income side — Invoice/SR positive, CreditMemo negative.
    walkLines("Invoice", "Invoice", "InvoiceLineRet", "income", 1);
    walkLines("SalesReceipt", "SalesReceipt", "SalesReceiptLineRet", "income", 1);
    walkLines("CreditMemo", "CreditMemo", "CreditMemoLineRet", "income", -1);

    // Expense side — Bill/Check expense AND item lines.
    walkLines("Bill", "Bill", "ExpenseLineRet", "expense", 1);
    walkLines("Bill", "Bill", "ItemLineRet", "expense", 1);
    walkLines("Check", "Check", "ExpenseLineRet", "expense", 1);
    walkLines("Check", "Check", "ItemLineRet", "expense", 1);

    // Journal entries — line.AccountRef.FullName matches target; sign is the
    // account's natural direction (debit on a natural-debit account = +).
    for (const je of this.getStore("JournalEntry").values()) {
      const debitLines = Array.isArray(je.JournalDebitLineRet)
        ? (je.JournalDebitLineRet as Record<string, unknown>[])
        : [];
      const creditLines = Array.isArray(je.JournalCreditLineRet)
        ? (je.JournalCreditLineRet as Record<string, unknown>[])
        : [];
      for (const line of debitLines) {
        const ref = line.AccountRef as Record<string, unknown> | undefined;
        if (!ref || String(ref.FullName ?? "") !== targetName) continue;
        const amt = Number(line.Amount ?? 0);
        if (!Number.isFinite(amt) || amt === 0) continue;
        const sign = targetIsNaturalDebit ? 1 : -1;
        emit(je, "JournalEntry", sign * amt, line.Memo ? String(line.Memo) : undefined);
      }
      for (const line of creditLines) {
        const ref = line.AccountRef as Record<string, unknown> | undefined;
        if (!ref || String(ref.FullName ?? "") !== targetName) continue;
        const amt = Number(line.Amount ?? 0);
        if (!Number.isFinite(amt) || amt === 0) continue;
        const sign = targetIsNaturalDebit ? -1 : 1;
        emit(je, "JournalEntry", sign * amt, line.Memo ? String(line.Memo) : undefined);
      }
    }

    // Stable chronological ordering — TxnDate ascending, TimeCreated as the
    // tiebreaker so same-date postings walk in insertion order.
    rows.sort((a, b) => {
      const ad = String(a.TxnDate ?? "");
      const bd = String(b.TxnDate ?? "");
      if (ad !== bd) return ad < bd ? -1 : 1;
      const at = String(a.TimeCreated ?? "");
      const bt = String(b.TimeCreated ?? "");
      return at < bt ? -1 : at > bt ? 1 : 0;
    });

    const max = reqData.MaxReturned ? Number(reqData.MaxReturned) : null;
    const trimmed = max && max > 0 ? rows.slice(0, max) : rows;

    if (trimmed.length === 0) {
      return {
        type: rsType,
        statusCode: 1,
        statusSeverity: "Info",
        statusMessage:
          "A query request did not find a matching object in QuickBooks",
        data: {},
      };
    }

    return {
      type: rsType,
      statusCode: 0,
      statusSeverity: "Info",
      statusMessage: "Status OK",
      data: { TransactionRet: trimmed },
    };
  }

  // Resolve the GL account a transaction line posts to. ExpenseLine carries
  // AccountRef directly. ItemLine carries ItemRef → item lookup → its income
  // / expense / COGS account ref (depends on direction). Returns null when
  // unresolvable so the caller can route to an Uncategorized bucket.
  private resolveLineAccount(
    line: Record<string, unknown>,
    direction: "income" | "expense"
  ): string | null {
    const directRef = line.AccountRef as Record<string, unknown> | undefined;
    if (directRef?.FullName) return String(directRef.FullName);
    if (directRef?.ListID) {
      const acct = this.getStore("Account").get(String(directRef.ListID));
      if (acct) return String(acct.FullName ?? acct.Name ?? "");
    }

    const itemRef = line.ItemRef as Record<string, unknown> | undefined;
    if (!itemRef) return null;
    const item = this.findItemByRef(itemRef);
    if (!item) return null;

    if (direction === "income") {
      const ref = (item.IncomeAccountRef ??
        (item.SalesOrPurchase as Record<string, unknown> | undefined)?.AccountRef) as
        | Record<string, unknown>
        | undefined;
      if (ref?.FullName) return String(ref.FullName);
    } else {
      const ref = (item.ExpenseAccountRef ??
        item.COGSAccountRef ??
        (item.SalesOrPurchase as Record<string, unknown> | undefined)?.AccountRef) as
        | Record<string, unknown>
        | undefined;
      if (ref?.FullName) return String(ref.FullName);
    }
    return null;
  }

  // Find an item across all 5 subtype stores by ListID (preferred) or FullName.
  private findItemByRef(ref: Record<string, unknown>): StoredEntity | null {
    const subtypes = ["ItemService", "ItemInventory", "ItemNonInventory", "ItemOtherCharge", "ItemGroup"];
    const listId = ref.ListID ? String(ref.ListID) : null;
    const fullName = ref.FullName ? String(ref.FullName) : null;
    for (const t of subtypes) {
      const store = this.getStore(t);
      if (listId) {
        const hit = store.get(listId);
        if (hit) return hit;
      }
      if (fullName) {
        for (const e of store.values()) {
          if (String(e.FullName ?? e.Name ?? "") === fullName) return e;
        }
      }
    }
    return null;
  }

  // Walk lines on every txn of the given store-list, filtered by TxnDate ∈
  // [from, to]. Returns flat { accountName, amount } records. `negate` flips
  // sign (used for CreditMemo which is AR-negative on income side).
  private walkTxnLines(
    storeNames: string[],
    lineKeys: string[],
    direction: "income" | "expense",
    from: string | null,
    to: string | null,
    negate = false
  ): { accountName: string; amount: number }[] {
    const out: { accountName: string; amount: number }[] = [];
    for (const storeName of storeNames) {
      for (const txn of this.getStore(storeName).values()) {
        const txnDate = String(txn.TxnDate ?? "");
        if (from && txnDate < from) continue;
        if (to && txnDate > to) continue;
        for (const lineKey of lineKeys) {
          const lines = txn[lineKey];
          if (!Array.isArray(lines)) continue;
          for (const line of lines as Record<string, unknown>[]) {
            const amt = Number(line.Amount ?? 0);
            if (!Number.isFinite(amt) || amt === 0) continue;
            const accountName = this.resolveLineAccount(line, direction)
              ?? (direction === "income" ? "Uncategorized Income" : "Uncategorized Expense");
            out.push({ accountName, amount: negate ? -amt : amt });
          }
        }
      }
    }
    return out;
  }

  // Walk JournalEntry lines, filtered by TxnDate. Debit lines post to expense/
  // asset accounts (positive); credit lines post to income/liability accounts
  // (positive on the income side). Returns separate income / expense arrays
  // keyed by the account's AccountType, since a JE can hit any account.
  private walkJournalEntryLines(
    from: string | null,
    to: string | null
  ): { income: { accountName: string; amount: number }[]; expense: { accountName: string; amount: number }[] } {
    const income: { accountName: string; amount: number }[] = [];
    const expense: { accountName: string; amount: number }[] = [];
    const accountStore = this.getStore("Account");
    const lookupType = (accountName: string): string | null => {
      for (const a of accountStore.values()) {
        if (String(a.FullName ?? a.Name ?? "") === accountName) {
          return String(a.AccountType ?? "");
        }
      }
      return null;
    };

    for (const je of this.getStore("JournalEntry").values()) {
      const txnDate = String(je.TxnDate ?? "");
      if (from && txnDate < from) continue;
      if (to && txnDate > to) continue;

      const debitLines = Array.isArray(je.JournalDebitLineRet) ? je.JournalDebitLineRet as Record<string, unknown>[] : [];
      const creditLines = Array.isArray(je.JournalCreditLineRet) ? je.JournalCreditLineRet as Record<string, unknown>[] : [];

      for (const line of debitLines) {
        const ref = line.AccountRef as Record<string, unknown> | undefined;
        const name = ref?.FullName ? String(ref.FullName) : null;
        if (!name) continue;
        const amt = Number(line.Amount ?? 0);
        if (!Number.isFinite(amt) || amt === 0) continue;
        const type = lookupType(name);
        if (type === "Income" || type === "OtherIncome") {
          // Rare — a debit to an income account reduces income.
          income.push({ accountName: name, amount: -amt });
        } else if (type === "CostOfGoodsSold" || type === "Expense" || type === "OtherExpense") {
          expense.push({ accountName: name, amount: amt });
        }
        // Asset/liability/equity debits don't contribute to P&L.
      }
      for (const line of creditLines) {
        const ref = line.AccountRef as Record<string, unknown> | undefined;
        const name = ref?.FullName ? String(ref.FullName) : null;
        if (!name) continue;
        const amt = Number(line.Amount ?? 0);
        if (!Number.isFinite(amt) || amt === 0) continue;
        const type = lookupType(name);
        if (type === "Income" || type === "OtherIncome") {
          income.push({ accountName: name, amount: amt });
        } else if (type === "CostOfGoodsSold" || type === "Expense" || type === "OtherExpense") {
          // Rare — a credit to an expense account reduces expense.
          expense.push({ accountName: name, amount: -amt });
        }
      }
    }

    return { income, expense };
  }

  // Group { accountName, amount } records by AccountType, ordered by the
  // sectionMap. Records whose AccountType doesn't match any section land in a
  // trailing "Other" section so they're visible — but Other does NOT
  // contribute to any of the named subtotals (callers derive section totals
  // from the per-section Subtotal field, not from a global total).
  // Accounts within a section are sorted alphabetically.
  private groupByAccountType(
    records: { accountName: string; amount: number }[],
    sectionMap: { name: string; types: readonly string[] }[]
  ): { Name: string; Accounts: { Name: string; Total: number }[]; Subtotal: number }[] {
    const accountStore = this.getStore("Account");
    const accountTypeByName = new Map<string, string>();
    for (const a of accountStore.values()) {
      const name = String(a.FullName ?? a.Name ?? "");
      const type = String(a.AccountType ?? "");
      if (name) accountTypeByName.set(name, type);
    }

    const buckets = new Map<string, Map<string, number>>();
    for (const sec of sectionMap) buckets.set(sec.name, new Map());
    const unroutedBucket = new Map<string, number>();

    for (const rec of records) {
      const type = accountTypeByName.get(rec.accountName) ??
        (rec.accountName === "Uncategorized Income" ? "Income" :
         rec.accountName === "Uncategorized Expense" ? "Expense" : "");
      let routed = false;
      for (const sec of sectionMap) {
        if (sec.types.includes(type as string)) {
          const m = buckets.get(sec.name)!;
          m.set(rec.accountName, (m.get(rec.accountName) ?? 0) + rec.amount);
          routed = true;
          break;
        }
      }
      if (!routed) {
        unroutedBucket.set(rec.accountName, (unroutedBucket.get(rec.accountName) ?? 0) + rec.amount);
      }
    }

    const sections: { Name: string; Accounts: { Name: string; Total: number }[]; Subtotal: number }[] = [];
    for (const sec of sectionMap) {
      const m = buckets.get(sec.name)!;
      if (m.size === 0) continue;
      const accounts = [...m.entries()]
        .map(([Name, Total]) => ({ Name, Total: Math.round(Total * 100) / 100 }))
        .sort((a, b) => a.Name.localeCompare(b.Name));
      const subtotal = accounts.reduce((s, a) => s + a.Total, 0);
      sections.push({
        Name: sec.name,
        Accounts: accounts,
        Subtotal: Math.round(subtotal * 100) / 100,
      });
    }
    if (unroutedBucket.size > 0) {
      const accounts = [...unroutedBucket.entries()]
        .map(([Name, Total]) => ({ Name, Total: Math.round(Total * 100) / 100 }))
        .sort((a, b) => a.Name.localeCompare(b.Name));
      const subtotal = accounts.reduce((s, a) => s + a.Total, 0);
      sections.push({
        Name: "Other",
        Accounts: accounts,
        Subtotal: Math.round(subtotal * 100) / 100,
      });
    }
    return sections;
  }

  private buildPnLReport(
    from: string | null,
    to: string | null,
    basis: "Accrual" | "Cash"
  ): Record<string, unknown> {
    // Income side: Invoice + SalesReceipt (positive), CreditMemo (negative).
    const incomeLines = [
      ...this.walkTxnLines(["Invoice"], ["InvoiceLineRet"], "income", from, to),
      ...this.walkTxnLines(["SalesReceipt"], ["SalesReceiptLineRet"], "income", from, to),
      ...this.walkTxnLines(["CreditMemo"], ["CreditMemoLineRet"], "income", from, to, true),
    ];
    // Expense side: Bill + Check + CreditCardCharge (ExpenseLine + ItemLine).
    const expenseLines = [
      ...this.walkTxnLines(["Bill"], ["ExpenseLineRet", "ItemLineRet"], "expense", from, to),
      ...this.walkTxnLines(["Check"], ["ExpenseLineRet", "ItemLineRet"], "expense", from, to),
      ...this.walkTxnLines(["CreditCardCharge"], ["ExpenseLineRet", "ItemLineRet"], "expense", from, to),
    ];
    const je = this.walkJournalEntryLines(from, to);
    incomeLines.push(...je.income);
    expenseLines.push(...je.expense);

    // Single grouping pass over all records — section routing is by the
    // record's account's AccountType, so income/expense origin doesn't need
    // to be tracked explicitly. Records that don't match any section's types
    // land in "Other" but DON'T contribute to the named totals.
    const allRecords = [...incomeLines, ...expenseLines];
    const sections = this.groupByAccountType(allRecords, [
      { name: "Income", types: ["Income"] },
      { name: "Other Income", types: ["OtherIncome"] },
      { name: "Cost of Goods Sold", types: ["CostOfGoodsSold"] },
      { name: "Expenses", types: ["Expense"] },
      { name: "Other Expenses", types: ["OtherExpense"] },
    ]);

    const subtotalOf = (name: string): number =>
      sections.find((s) => s.Name === name)?.Subtotal ?? 0;

    const totalIncome = Math.round((subtotalOf("Income") + subtotalOf("Other Income")) * 100) / 100;
    const totalCOGS = subtotalOf("Cost of Goods Sold");
    const totalExpenses = Math.round((subtotalOf("Expenses") + subtotalOf("Other Expenses")) * 100) / 100;
    const grossProfit = Math.round((totalIncome - totalCOGS) * 100) / 100;
    const netIncome = Math.round((totalIncome - totalCOGS - totalExpenses) * 100) / 100;

    return {
      ReportTitle: "Profit & Loss",
      ReportBasis: basis,
      FromReportDate: from,
      ToReportDate: to,
      Sections: sections,
      Totals: {
        TotalIncome: totalIncome,
        TotalCOGS: totalCOGS,
        TotalExpenses: totalExpenses,
        GrossProfit: grossProfit,
        NetIncome: netIncome,
      },
    };
  }

  // Balance Sheet — Asset / Liability / Equity sections from Account.Balance
  // (snapshot — see method-level note on handleReportQuery), plus current-
  // period NetIncome derived from the same txn walk as P&L (FromDate = null,
  // ToDate = asOfDate). The accounting identity Assets = Liabilities + Equity
  // is reconciled by closing NetIncome into Equity; if the seeded balances are
  // off (the known $10,700 phantom AR), that delta surfaces in a "Balancing
  // Adjustment" pseudo-equity row so totals still reconcile mathematically.
  private buildBalanceSheetReport(
    asOfDate: string | null,
    basis: "Accrual" | "Cash"
  ): Record<string, unknown> {
    const accounts = [...this.getStore("Account").values()];

    const sectionMap = [
      { name: "Assets", types: ["Bank", "AccountsReceivable", "OtherCurrentAsset", "Inventory", "FixedAsset", "OtherAsset"] },
      { name: "Liabilities", types: ["AccountsPayable", "CreditCard", "OtherCurrentLiability", "LongTermLiability"] },
      { name: "Equity", types: ["Equity"] },
    ];

    const sections: { Name: string; Accounts: { Name: string; Total: number }[]; Subtotal: number }[] = [];
    const sectionTotals: Record<string, number> = { Assets: 0, Liabilities: 0, Equity: 0 };

    for (const sec of sectionMap) {
      const matched = accounts.filter((a) => sec.types.includes(String(a.AccountType ?? "")));
      if (matched.length === 0) continue;
      const accountRows = matched
        .map((a) => ({
          Name: String(a.FullName ?? a.Name ?? ""),
          Total: Math.round(Number(a.Balance ?? 0) * 100) / 100,
        }))
        .sort((a, b) => a.Name.localeCompare(b.Name));
      const subtotal = accountRows.reduce((s, r) => s + r.Total, 0);
      sections.push({
        Name: sec.name,
        Accounts: accountRows,
        Subtotal: Math.round(subtotal * 100) / 100,
      });
      sectionTotals[sec.name] = subtotal;
    }

    // Current-period NetIncome closes into Equity (mirrors real QB's
    // "Retained Earnings" + "Net Income" line). asOfDate maps to ToReportDate;
    // FromDate is null for the lifetime-to-asOfDate net.
    const pnl = this.buildPnLReport(null, asOfDate, basis);
    const netIncome = Number((pnl.Totals as Record<string, unknown>).NetIncome ?? 0);

    const equitySection = sections.find((s) => s.Name === "Equity");
    if (equitySection) {
      equitySection.Accounts.push({ Name: "Net Income", Total: Math.round(netIncome * 100) / 100 });
      equitySection.Subtotal = Math.round((equitySection.Subtotal + netIncome) * 100) / 100;
      sectionTotals.Equity += netIncome;
    } else {
      sections.push({
        Name: "Equity",
        Accounts: [{ Name: "Net Income", Total: Math.round(netIncome * 100) / 100 }],
        Subtotal: Math.round(netIncome * 100) / 100,
      });
      sectionTotals.Equity = netIncome;
    }

    const totalAssets = Math.round(sectionTotals.Assets * 100) / 100;
    const totalLiabilities = Math.round(sectionTotals.Liabilities * 100) / 100;
    const totalEquity = Math.round(sectionTotals.Equity * 100) / 100;

    // Balancing adjustment: real QB's Assets = Liabilities + Equity holds by
    // construction. The simulation's seed has phantom Account.Balance fields
    // that don't match transaction history (known $10,700 AR phantom). Surface
    // the gap as a pseudo-row so the operator sees totals reconcile.
    const imbalance = Math.round((totalAssets - (totalLiabilities + totalEquity)) * 100) / 100;
    if (imbalance !== 0) {
      const eq = sections.find((s) => s.Name === "Equity");
      const adjRow = { Name: "Balancing Adjustment (simulation seed gap)", Total: imbalance };
      if (eq) {
        eq.Accounts.push(adjRow);
        eq.Subtotal = Math.round((eq.Subtotal + imbalance) * 100) / 100;
      } else {
        sections.push({ Name: "Equity", Accounts: [adjRow], Subtotal: imbalance });
      }
    }

    const finalEquity = Math.round((totalEquity + imbalance) * 100) / 100;

    return {
      ReportTitle: "Balance Sheet",
      ReportBasis: basis,
      AsOfDate: asOfDate,
      Sections: sections,
      Totals: {
        TotalAssets: totalAssets,
        TotalLiabilities: totalLiabilities,
        TotalEquity: finalEquity,
        NetIncome: Math.round(netIncome * 100) / 100,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Add handler
  // -----------------------------------------------------------------------

  private handleAdd(
    reqType: string,
    reqData: Record<string, unknown>
  ): QBXMLResponseBody {
    const entityType = reqType.replace("AddRq", "");
    const rsType = reqType.replace("Rq", "Rs");
    const retName = `${entityType}Ret`;
    const addKey = `${entityType}Add`;
    const store = this.getStore(entityType);

    const addData = (reqData[addKey] ?? reqData) as Record<string, unknown>;
    const isTransaction = this.isTransactionType(entityType);
    const id = this.nextId();
    const now = new Date().toISOString();

    const entity: StoredEntity = {
      ...addData,
      ...(isTransaction ? { TxnID: id } : { ListID: id }),
      EditSequence: this.nextEditSequence(),
      TimeCreated: now,
      TimeModified: now,
      IsActive: true,
    };

    // Set FullName from Name if applicable
    if (addData.Name && !addData.FullName) {
      entity.FullName = String(addData.Name);
    }

    const finalEntity = isTransaction
      ? this.computeTotals(this.convertLinesAddToRet(entity), entityType)
      : entity;

    if (entityType === "ReceivePayment") {
      const applyResult = this.applyReceivePayment(finalEntity);
      if (!applyResult.ok) {
        return {
          type: rsType,
          statusCode: 500,
          statusSeverity: "Error",
          statusMessage: applyResult.error,
          data: {},
        };
      }
    } else if (
      entityType === "BillPaymentCheck" ||
      entityType === "BillPaymentCreditCard"
    ) {
      const applyResult = this.applyBillPayment(finalEntity);
      if (!applyResult.ok) {
        return {
          type: rsType,
          statusCode: 500,
          statusSeverity: "Error",
          statusMessage: applyResult.error,
          data: {},
        };
      }
    } else if (entityType === "CreditMemo") {
      const applyResult = this.applyCreditMemo(finalEntity);
      if (!applyResult.ok) {
        return {
          type: rsType,
          statusCode: 500,
          statusSeverity: "Error",
          statusMessage: applyResult.error,
          data: {},
        };
      }
    } else if (entityType === "JournalEntry") {
      // Balance invariant: sum(debits) === sum(credits) to the cent. Validate
      // BEFORE persisting — a doomed JE must not pollute the store.
      const balanceCheck = this.validateJournalEntryBalance(finalEntity);
      if (!balanceCheck.ok) {
        return {
          type: rsType,
          statusCode: 3030,
          statusSeverity: "Error",
          statusMessage: balanceCheck.error,
          data: {},
        };
      }
    }

    store.set(id, finalEntity);

    if (entityType === "Invoice") {
      this.adjustPartyBalanceForTxn(finalEntity, "Customer", "BalanceRemaining", +1);
    } else if (entityType === "Bill") {
      this.adjustPartyBalanceForTxn(finalEntity, "Vendor", "AmountDue", +1);
    } else if (entityType === "CreditMemo") {
      // AR-negative posting: customer Balance moves by -TotalAmount on memo
      // creation, regardless of whether AppliedToTxnAdd applied any of it to
      // specific invoices. The applied portion shifts the bookkeeping from
      // the credit pool (memo.RemainingValue) to invoice-level (Invoice.
      // BalanceRemaining drops); the customer's overall open balance moves
      // by the full TotalAmount either way. Reversed in handleTxnDel.
      this.adjustPartyBalanceForTxn(finalEntity, "Customer", "TotalAmount", -1);
    }

    return {
      type: rsType,
      statusCode: 0,
      statusSeverity: "Info",
      statusMessage: "Status OK",
      data: { [retName]: finalEntity },
    };
  }

  // -----------------------------------------------------------------------
  // ReceivePayment application — close out invoices, move customer balance
  // -----------------------------------------------------------------------

  // Real QB derives all payment-application bookkeeping server-side: each
  // AppliedToTxn block reduces the named invoice's BalanceRemaining,
  // bumps its AppliedAmount, flips IsPaid when the balance hits zero, and
  // moves the customer's Balance by the *applied* portion only (unapplied
  // payment becomes a customer credit). Mirroring that here keeps every
  // downstream view (qb_invoice_list, qb_ar_aging, qb_customer_list)
  // consistent regardless of mode.
  //
  // Add path: read AppliedToTxnAdd off the payment, delete it, hand the
  // line array to applyTxnApplications.
  // Mod path (qb_payment_apply): handleMod reads AppliedToTxnMod off modData
  // and calls applyTxnApplications directly with the same line shape.
  //
  // Strict on missing TxnIDs (returns 500) — the operator explicitly named
  // a target, so silently dropping an orphan ref would let payments record
  // against ghosts. See DECISIONS.md 2026-04-25 entry.
  private applyReceivePayment(
    payment: StoredEntity
  ): { ok: true } | { ok: false; error: string } {
    const raw = payment.AppliedToTxnAdd;
    delete payment.AppliedToTxnAdd;
    const lines = !raw
      ? []
      : Array.isArray(raw)
        ? (raw as Record<string, unknown>[])
        : [raw as Record<string, unknown>];
    return this.applyTxnApplications(payment, lines);
  }

  // Pure validation pass for AppliedToTxn lines. Splitting validation from
  // mutation lets the qb_payment_apply path validate the new application set
  // BEFORE reversing the existing one — so a doomed mod (orphan TxnID,
  // overapplication) bails out cleanly without disturbing the payment state.
  private validateTxnApplications(
    lines: Record<string, unknown>[],
    totalAmount: number
  ): { ok: true } | { ok: false; error: string } {
    if (lines.length === 0) return { ok: true };

    const invoiceStore = this.getStore("Invoice");
    for (const line of lines) {
      const txnId = String(line.TxnID ?? "");
      if (!txnId) {
        return { ok: false, error: "AppliedToTxn requires TxnID" };
      }
      if (!invoiceStore.has(txnId)) {
        return {
          ok: false,
          error: `Invoice "${txnId}" specified in AppliedToTxn cannot be found`,
        };
      }
    }

    // Overapplication guard — sum(applied) must not exceed TotalAmount. The
    // qb_payment_receive tool enforces this at the schema layer too, but the
    // qb_payment_apply path doesn't see TotalAmount at the tool layer, so the
    // simulation is the authoritative gate.
    const proposedSum = lines.reduce(
      (acc, l) => acc + Number(l.PaymentAmount ?? 0),
      0
    );
    if (proposedSum > totalAmount + 1e-9) {
      return {
        ok: false,
        error: `sum(AppliedToTxn.PaymentAmount) = ${proposedSum} exceeds payment TotalAmount = ${totalAmount}`,
      };
    }

    return { ok: true };
  }

  // Shared application engine used by both the Add path (applyReceivePayment)
  // and the Mod path (handleMod ReceivePayment branch via qb_payment_apply).
  // Two-pass: validate every TxnID first (atomicity — orphan in line N must
  // NOT leave lines 1..N-1 mutated), then apply mutations + build *Ret entries
  // + move customer balance + recompute AppliedAmount/UnusedPayment.
  //
  // Caller is responsible for reversing any prior application before calling
  // this on the mod path — see reverseReceivePaymentApplication. The mod
  // path validates first via validateTxnApplications so the reversal never
  // runs on a request that's destined to fail.
  private applyTxnApplications(
    payment: StoredEntity,
    lines: Record<string, unknown>[]
  ): { ok: true } | { ok: false; error: string } {
    const totalAmount = Number(payment.TotalAmount ?? 0);

    const validation = this.validateTxnApplications(lines, totalAmount);
    if (!validation.ok) return validation;

    if (lines.length === 0) {
      payment.AppliedToTxnRet = [];
      payment.AppliedAmount = 0;
      payment.UnusedPayment = totalAmount;
      return { ok: true };
    }

    const invoiceStore = this.getStore("Invoice");

    // Second pass: apply mutations and build *Ret entries.
    let appliedSum = 0;
    const appliedRet: Record<string, unknown>[] = [];
    for (const line of lines) {
      const txnId = String(line.TxnID);
      const paymentAmount = Number(line.PaymentAmount ?? 0);
      const discountAmount = Number(line.DiscountAmount ?? 0);

      const invoice = invoiceStore.get(txnId)!;
      const balance = Number(invoice.BalanceRemaining ?? 0);
      const applied = Number(invoice.AppliedAmount ?? 0);
      // Discount closes the invoice alongside the payment but does NOT
      // reduce customer A/R (the customer didn't pay it — they got it).
      invoice.BalanceRemaining = balance - paymentAmount - discountAmount;
      invoice.AppliedAmount = applied + paymentAmount;
      invoice.IsPaid = invoice.BalanceRemaining === 0;

      appliedSum += paymentAmount;

      const ret: Record<string, unknown> = {
        TxnLineID: this.nextId(),
        TxnID: txnId,
        PaymentAmount: paymentAmount,
      };
      if (discountAmount > 0) {
        ret.DiscountAmount = discountAmount;
        if (line.DiscountAccountRef) ret.DiscountAccountRef = line.DiscountAccountRef;
      }
      appliedRet.push(ret);
    }

    // Customer.Balance moves by the applied sum, not the gross payment.
    // Unapplied amount is implicitly tracked by UnusedPayment on the
    // payment record — it's a credit, not a reduction in current AR.
    if (appliedSum > 0) {
      const customerRef = payment.CustomerRef as Record<string, unknown> | undefined;
      if (customerRef) {
        this.adjustEntityBalance(
          "Customer",
          {
            listID: customerRef.ListID ? String(customerRef.ListID) : undefined,
            fullName: customerRef.FullName ? String(customerRef.FullName) : undefined,
          },
          -appliedSum
        );
      }
    }

    payment.AppliedToTxnRet = appliedRet;
    payment.AppliedAmount = appliedSum;
    payment.UnusedPayment = totalAmount - appliedSum;

    return { ok: true };
  }

  // Reverse a payment's existing application: undo every per-invoice bump
  // and restore the customer balance. Used by the qb_payment_apply path
  // (handleMod ReceivePayment) before applying the new application set.
  // After this runs, the payment carries an empty AppliedToTxnRet and the
  // invoices it touched are back to their pre-application BalanceRemaining /
  // AppliedAmount / IsPaid state.
  //
  // Tolerates orphan TxnIDs in AppliedToTxnRet (silently skipped) — an
  // invoice deleted between the original application and this reversal
  // shouldn't block the operator from re-applying the payment elsewhere.
  // Customer balance still reverses by the *named* applied amount even when
  // the target invoice is gone, because the original Add path already moved
  // the customer balance and we have to undo that side regardless.
  private reverseReceivePaymentApplication(payment: StoredEntity): void {
    const raw = payment.AppliedToTxnRet;
    if (!raw) return;
    const entries = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
    if (entries.length === 0) return;

    const invoiceStore = this.getStore("Invoice");
    let reversedSum = 0;

    for (const entry of entries) {
      const txnId = String(entry.TxnID ?? "");
      const paymentAmount = Number(entry.PaymentAmount ?? 0);
      const discountAmount = Number(entry.DiscountAmount ?? 0);
      reversedSum += paymentAmount;

      const invoice = invoiceStore.get(txnId);
      if (!invoice) continue;

      invoice.BalanceRemaining =
        Number(invoice.BalanceRemaining ?? 0) + paymentAmount + discountAmount;
      invoice.AppliedAmount =
        Number(invoice.AppliedAmount ?? 0) - paymentAmount;
      invoice.IsPaid = invoice.BalanceRemaining === 0;
    }

    if (reversedSum > 0) {
      const customerRef = payment.CustomerRef as Record<string, unknown> | undefined;
      if (customerRef) {
        this.adjustEntityBalance(
          "Customer",
          {
            listID: customerRef.ListID ? String(customerRef.ListID) : undefined,
            fullName: customerRef.FullName ? String(customerRef.FullName) : undefined,
          },
          +reversedSum
        );
      }
    }

    payment.AppliedToTxnRet = [];
    payment.AppliedAmount = 0;
    payment.UnusedPayment = Number(payment.TotalAmount ?? 0);
  }

  // -----------------------------------------------------------------------
  // BillPayment application — close out bills, move vendor balance
  // -----------------------------------------------------------------------

  // AP-side analog to applyReceivePayment. Each AppliedToTxn block reduces
  // the named bill's AmountDue, flips IsPaid when AmountDue hits zero, and
  // moves the vendor's Balance by the applied portion. BillPayments don't
  // track AppliedAmount / UnusedPayment on the payment header (real QB
  // BillPaymentCheckRet / BillPaymentCreditCardRet have no such fields —
  // the operator-facing TotalAmount is just the sum of the applied amounts,
  // not a separable header total like ReceivePayment carries).
  //
  // Strict on missing TxnIDs (returns 500) — same as the AR side: a named
  // target ghost would let payments record against deleted bills. Two-pass
  // for atomicity: validate every TxnID first (orphan in line N must NOT
  // leave lines 1..N-1 mutated). Discount handling mirrors AR: DiscountAmount
  // closes AmountDue alongside the payment but does NOT reduce vendor balance
  // (the vendor didn't receive it — they granted it).
  private applyBillPayment(
    payment: StoredEntity
  ): { ok: true } | { ok: false; error: string } {
    const raw = payment.AppliedToTxnAdd;
    delete payment.AppliedToTxnAdd;
    const lines = !raw
      ? []
      : Array.isArray(raw)
        ? (raw as Record<string, unknown>[])
        : [raw as Record<string, unknown>];

    if (lines.length === 0) {
      return { ok: false, error: "BillPayment requires at least one AppliedToTxnAdd entry" };
    }

    const billStore = this.getStore("Bill");
    for (const line of lines) {
      const txnId = String(line.TxnID ?? "");
      if (!txnId) {
        return { ok: false, error: "AppliedToTxn requires TxnID" };
      }
      if (!billStore.has(txnId)) {
        return {
          ok: false,
          error: `Bill "${txnId}" specified in AppliedToTxn cannot be found`,
        };
      }
    }

    let appliedSum = 0;
    const appliedRet: Record<string, unknown>[] = [];
    for (const line of lines) {
      const txnId = String(line.TxnID);
      const paymentAmount = Number(line.PaymentAmount ?? 0);
      const discountAmount = Number(line.DiscountAmount ?? 0);

      const bill = billStore.get(txnId)!;
      const amountDue = Number(bill.AmountDue ?? 0);
      bill.AmountDue = amountDue - paymentAmount - discountAmount;
      bill.IsPaid = bill.AmountDue === 0;

      appliedSum += paymentAmount;

      const ret: Record<string, unknown> = {
        TxnLineID: this.nextId(),
        TxnID: txnId,
        PaymentAmount: paymentAmount,
      };
      if (discountAmount > 0) {
        ret.DiscountAmount = discountAmount;
        if (line.DiscountAccountRef) ret.DiscountAccountRef = line.DiscountAccountRef;
      }
      appliedRet.push(ret);
    }

    if (appliedSum > 0) {
      const vendorRef = payment.VendorRef as Record<string, unknown> | undefined;
      if (vendorRef) {
        this.adjustEntityBalance(
          "Vendor",
          {
            listID: vendorRef.ListID ? String(vendorRef.ListID) : undefined,
            fullName: vendorRef.FullName ? String(vendorRef.FullName) : undefined,
          },
          -appliedSum
        );
      }
    }

    payment.AppliedToTxnRet = appliedRet;
    payment.TotalAmount = appliedSum;
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // CreditMemo application — close out invoices, NO customer-balance move
  // -----------------------------------------------------------------------

  // CreditMemo is the AR-negative analog of ReceivePayment: it closes out
  // open invoices via AppliedToTxnAdd / AppliedToTxnMod entries, each
  // reducing a named invoice's BalanceRemaining. The structural difference
  // from ReceivePayment is *where customer balance moves*:
  //
  //   ReceivePayment: customer.Balance moves by -appliedSum at apply time
  //                   (only the applied portion of the payment hits AR; the
  //                   rest sits as UnusedPayment / customer credit).
  //   CreditMemo:     customer.Balance moves by -TotalAmount at MEMO-ADD
  //                   time (regardless of whether any of it is applied to
  //                   specific invoices). Application then shifts the
  //                   bookkeeping from the memo's RemainingValue to the
  //                   invoice's BalanceRemaining without further customer
  //                   balance movement.
  //
  // So applyCreditMemo:
  //   1. Reads AppliedToTxnAdd off the memo, deletes it.
  //   2. Validates each TxnID (orphan in line N must NOT leave 1..N-1 mutated).
  //   3. Validates sum(applied) ≤ TotalAmount (overapplication guard).
  //   4. For each application: invoice.BalanceRemaining -= amount,
  //      invoice.AppliedAmount += amount, IsPaid = (BalanceRemaining === 0).
  //   5. Sets memo.AppliedToTxnRet = [...], memo.AppliedAmount = appliedSum,
  //      memo.RemainingValue = TotalAmount - appliedSum.
  //   6. Does NOT move customer.Balance — that already happened (or will
  //      happen) at the handleAdd customer-balance branch using TotalAmount.
  //
  // CreditMemo's AppliedToTxn shape uses PaymentAmount (matches the QBXML
  // schema — yes, even on a credit memo). DiscountAmount is not exposed by
  // qb_credit_memo_create / _apply (uncommon use case for credit memos);
  // the simulation ignores any DiscountAmount that slips through.
  private applyCreditMemo(
    memo: StoredEntity
  ): { ok: true } | { ok: false; error: string } {
    const raw = memo.AppliedToTxnAdd;
    delete memo.AppliedToTxnAdd;
    const lines = !raw
      ? []
      : Array.isArray(raw)
        ? (raw as Record<string, unknown>[])
        : [raw as Record<string, unknown>];

    return this.applyCreditMemoApplications(memo, lines);
  }

  // Pure validation pass for credit memo AppliedToTxn lines. Splitting
  // validation from mutation lets the qb_credit_memo_apply path validate
  // the new application set BEFORE reversing the existing one — so a doomed
  // mod (orphan TxnID, overapplication) bails out cleanly without disturbing
  // the memo state.
  private validateCreditMemoApplications(
    lines: Record<string, unknown>[],
    totalAmount: number
  ): { ok: true } | { ok: false; error: string } {
    if (lines.length === 0) return { ok: true };

    const invoiceStore = this.getStore("Invoice");
    for (const line of lines) {
      const txnId = String(line.TxnID ?? "");
      if (!txnId) {
        return { ok: false, error: "AppliedToTxn requires TxnID" };
      }
      if (!invoiceStore.has(txnId)) {
        return {
          ok: false,
          error: `Invoice "${txnId}" specified in AppliedToTxn cannot be found`,
        };
      }
    }

    const proposedSum = lines.reduce(
      (acc, l) => acc + Number(l.PaymentAmount ?? 0),
      0
    );
    if (proposedSum > totalAmount + 1e-9) {
      return {
        ok: false,
        error: `sum(AppliedToTxn.PaymentAmount) = ${proposedSum} exceeds credit memo TotalAmount = ${totalAmount}`,
      };
    }

    return { ok: true };
  }

  // Shared application engine used by the Add path (applyCreditMemo) and the
  // Mod path (handleCreditMemoApplyMod via qb_credit_memo_apply). Two-pass:
  // validate every TxnID + overapplication first (atomicity — orphan in line
  // N must NOT leave 1..N-1 mutated), then apply mutations + build *Ret entries
  // + recompute AppliedAmount/RemainingValue. NO customer-balance move (that
  // happens at memo-add/delete level, not at apply time).
  //
  // Caller is responsible for reversing any prior application before calling
  // this on the mod path — see reverseCreditMemoApplication.
  private applyCreditMemoApplications(
    memo: StoredEntity,
    lines: Record<string, unknown>[]
  ): { ok: true } | { ok: false; error: string } {
    const totalAmount = Number(memo.TotalAmount ?? 0);

    const validation = this.validateCreditMemoApplications(lines, totalAmount);
    if (!validation.ok) return validation;

    if (lines.length === 0) {
      memo.AppliedToTxnRet = [];
      memo.AppliedAmount = 0;
      memo.RemainingValue = totalAmount;
      return { ok: true };
    }

    const invoiceStore = this.getStore("Invoice");

    let appliedSum = 0;
    const appliedRet: Record<string, unknown>[] = [];
    for (const line of lines) {
      const txnId = String(line.TxnID);
      const paymentAmount = Number(line.PaymentAmount ?? 0);

      const invoice = invoiceStore.get(txnId)!;
      const balance = Number(invoice.BalanceRemaining ?? 0);
      const applied = Number(invoice.AppliedAmount ?? 0);
      invoice.BalanceRemaining = balance - paymentAmount;
      invoice.AppliedAmount = applied + paymentAmount;
      invoice.IsPaid = invoice.BalanceRemaining === 0;

      appliedSum += paymentAmount;

      appliedRet.push({
        TxnLineID: this.nextId(),
        TxnID: txnId,
        PaymentAmount: paymentAmount,
      });
    }

    memo.AppliedToTxnRet = appliedRet;
    memo.AppliedAmount = appliedSum;
    memo.RemainingValue = totalAmount - appliedSum;

    return { ok: true };
  }

  // Reverse a credit memo's existing application: undo every per-invoice
  // bump (restore BalanceRemaining / AppliedAmount / IsPaid). Used by the
  // qb_credit_memo_apply path (handleCreditMemoApplyMod) before applying a
  // new application set, and by handleTxnDel when deleting a memo that had
  // applications. Does NOT move customer balance — that's reversed at the
  // memo level (handleTxnDel uses adjustPartyBalanceForTxn with TotalAmount).
  //
  // Tolerates orphan TxnIDs (silently skipped) — an invoice deleted between
  // the original application and this reversal shouldn't block the operator
  // from re-applying the credit elsewhere.
  private reverseCreditMemoApplication(memo: StoredEntity): void {
    const raw = memo.AppliedToTxnRet;
    if (!raw) return;
    const entries = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
    if (entries.length === 0) return;

    const invoiceStore = this.getStore("Invoice");

    for (const entry of entries) {
      const txnId = String(entry.TxnID ?? "");
      const paymentAmount = Number(entry.PaymentAmount ?? 0);

      const invoice = invoiceStore.get(txnId);
      if (!invoice) continue;

      invoice.BalanceRemaining =
        Number(invoice.BalanceRemaining ?? 0) + paymentAmount;
      invoice.AppliedAmount =
        Number(invoice.AppliedAmount ?? 0) - paymentAmount;
      invoice.IsPaid = invoice.BalanceRemaining === 0;
    }

    memo.AppliedToTxnRet = [];
    memo.AppliedAmount = 0;
    memo.RemainingValue = Number(memo.TotalAmount ?? 0);
  }

  // -----------------------------------------------------------------------
  // Line conversion: *LineAdd → *LineRet
  // -----------------------------------------------------------------------

  // Real QB returns line items as *LineRet with a generated TxnLineID and a
  // resolved Amount. The simulation has to do the same so downstream tools
  // (totals, payment application, reports) see the response shape they expect.
  private convertLinesAddToRet(
    entity: StoredEntity
  ): StoredEntity {
    const result: StoredEntity = { ...entity };
    for (const key of Object.keys(result)) {
      const match = key.match(/^(.+?)Line(s?)Add$/);
      if (!match) continue;
      const [, prefix, plural] = match;
      const retKey = `${prefix}Line${plural}Ret`;
      const value = result[key];
      const lines = Array.isArray(value)
        ? (value as Record<string, unknown>[])
        : value && typeof value === "object"
          ? [value as Record<string, unknown>]
          : [];
      result[retKey] = lines.map((line) => this.convertLineAddToRet(line));
      delete result[key];
    }
    return result;
  }

  private convertLineAddToRet(
    line: Record<string, unknown>
  ): Record<string, unknown> {
    const qty = line.Quantity;
    const rate = line.Rate;
    const explicitAmount = line.Amount;
    let amount: number;
    if (qty !== undefined && qty !== null && rate !== undefined && rate !== null) {
      amount = Number(qty) * Number(rate);
    } else if (explicitAmount !== undefined && explicitAmount !== null) {
      amount = Number(explicitAmount);
    } else {
      amount = 0;
    }
    return {
      TxnLineID: this.nextId(),
      ...line,
      Amount: amount,
    };
  }

  // -----------------------------------------------------------------------
  // Totals computation: Subtotal / AmountDue / BalanceRemaining / IsPaid
  // -----------------------------------------------------------------------

  // Real QB derives header totals from the lines on the server. The simulation
  // mirrors that so payment application, AR/AP aging, and reports see the same
  // numbers a live response would carry. Runs after convertLinesAddToRet, so
  // every line key is already in *LineRet form (Bill carries two: ExpenseLineRet
  // + ItemLineRet — both contribute).
  private computeTotals(
    entity: StoredEntity,
    entityType: string
  ): StoredEntity {
    const result: StoredEntity = { ...entity };

    let lineSum = 0;
    for (const key of Object.keys(result)) {
      if (!/^(.+?)Line(s?)Ret$/.test(key)) continue;
      const lines = result[key];
      if (!Array.isArray(lines)) continue;
      for (const line of lines as Record<string, unknown>[]) {
        const amt = Number(line.Amount ?? 0);
        if (!Number.isNaN(amt)) lineSum += amt;
      }
    }

    if (
      entityType === "Invoice" ||
      entityType === "Estimate" ||
      entityType === "SalesReceipt" ||
      entityType === "CreditMemo"
    ) {
      result.Subtotal = lineSum;
    }

    if (entityType === "Bill" && result.AmountDue === undefined) {
      result.AmountDue = lineSum;
    }

    if (entityType === "Bill") {
      result.IsPaid = Number(result.AmountDue ?? 0) === 0;
    }

    if (entityType === "Invoice") {
      const salesTaxTotal = Number(result.SalesTaxTotal ?? 0);
      const appliedAmount = Number(result.AppliedAmount ?? 0);
      result.SalesTaxTotal = salesTaxTotal;
      result.AppliedAmount = appliedAmount;
      const subtotal = Number(result.Subtotal ?? 0);
      result.BalanceRemaining = subtotal + salesTaxTotal - appliedAmount;
      result.IsPaid = result.BalanceRemaining === 0;
    }

    // SalesReceipt is a cash sale — instantly closed, no AR posting. TotalAmount
    // is the only derived header total (Subtotal + SalesTaxTotal); there's no
    // BalanceRemaining / AppliedAmount / IsPaid because the sale settles on
    // creation. The deposit destination lives on DepositToAccountRef on the
    // entity itself (set at create time) — no balance bookkeeping needed here.
    if (entityType === "SalesReceipt") {
      const salesTaxTotal = Number(result.SalesTaxTotal ?? 0);
      result.SalesTaxTotal = salesTaxTotal;
      const subtotal = Number(result.Subtotal ?? 0);
      result.TotalAmount = subtotal + salesTaxTotal;
    }

    // CreditMemo is the AR-negative analog of Invoice. TotalAmount = Subtotal +
    // SalesTaxTotal is the credit's face value; AppliedAmount tracks how much
    // of that credit has been applied to invoices (via AppliedToTxnAdd at
    // create time, or AppliedToTxnMod via qb_credit_memo_apply); RemainingValue
    // = TotalAmount - AppliedAmount is the unapplied credit pool. Customer-
    // balance bookkeeping happens at handleAdd / handleTxnDel / handleMod
    // (line-mod path) — NOT here. computeTotals only derives the header
    // numbers. AppliedAmount is preserved across line mods (it's not derived
    // from the line set; it tracks accumulated invoice applications and
    // applyCreditMemo / handleCreditMemoApplyMod own that field).
    if (entityType === "CreditMemo") {
      const salesTaxTotal = Number(result.SalesTaxTotal ?? 0);
      result.SalesTaxTotal = salesTaxTotal;
      const subtotal = Number(result.Subtotal ?? 0);
      const totalAmount = subtotal + salesTaxTotal;
      result.TotalAmount = totalAmount;
      const appliedAmount = Number(result.AppliedAmount ?? 0);
      result.AppliedAmount = appliedAmount;
      result.RemainingValue = totalAmount - appliedAmount;
    }

    // PurchaseOrder is non-posting (no AP balance until received against). The
    // line set aggregates straight to TotalAmount — real QB POs don't expose a
    // separate Subtotal header field. No SalesTaxTotal, no Applied/Remaining
    // bookkeeping. IsManuallyClosed (write-once flag set at create + update)
    // lives on the entity itself; this method doesn't touch it.
    if (entityType === "PurchaseOrder") {
      result.TotalAmount = lineSum;
    }

    // JournalEntry has no single TotalAmount — debit and credit lines are two
    // independent sums that must equal each other (validated separately by
    // validateJournalEntryBalance before persist). Store both for inspection;
    // the lineSum loop above blindly added both sides together so it's not
    // useful here. No Subtotal, no SalesTaxTotal, no AR/AP bookkeeping (the
    // balance invariant is the only structural rule this entity carries).
    if (entityType === "JournalEntry") {
      result.TotalDebit = this.sumLineAmounts(result.JournalDebitLineRet);
      result.TotalCredit = this.sumLineAmounts(result.JournalCreditLineRet);
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // JournalEntry balance invariant
  // -----------------------------------------------------------------------

  // sum(debits) === sum(credits) to the cent. Real QB rejects unbalanced
  // entries with statusCode 3030 ("request data is invalid"); the simulation
  // mirrors that. Tolerance is 0.005 to absorb floating-point drift on the
  // sums (a JE with cents-level amounts shouldn't fail because 0.1 + 0.2 !==
  // 0.3 in IEEE 754).
  //
  // Called from handleAdd BEFORE persist so a doomed JE never lands in the
  // store, and from handleMod AFTER applyLineMods + computeTotals (post-mod
  // sums) BEFORE persist so a mod that breaks the invariant is rejected
  // without corrupting the stored entry.
  private validateJournalEntryBalance(
    entity: StoredEntity
  ): { ok: true } | { ok: false; error: string } {
    const debit = this.sumLineAmounts(entity.JournalDebitLineRet);
    const credit = this.sumLineAmounts(entity.JournalCreditLineRet);
    if (Math.abs(debit - credit) > 0.005) {
      return {
        ok: false,
        error: `JournalEntry debits (${debit.toFixed(2)}) must equal credits (${credit.toFixed(2)})`,
      };
    }
    if (debit === 0 && credit === 0) {
      return {
        ok: false,
        error: "JournalEntry requires at least one debit and one credit line",
      };
    }
    return { ok: true };
  }

  private sumLineAmounts(lines: unknown): number {
    if (!Array.isArray(lines)) return 0;
    let sum = 0;
    for (const line of lines as Record<string, unknown>[]) {
      const amt = Number(line.Amount ?? 0);
      if (!Number.isNaN(amt)) sum += amt;
    }
    return sum;
  }

  // -----------------------------------------------------------------------
  // Cross-store balance mutation
  // -----------------------------------------------------------------------

  // Real QB keeps Customer.Balance / Vendor.Balance in sync with the open AR/AP
  // they own. Reused by Add (positive delta) and TxnDel (negative delta) here;
  // Phase 3 item 5 (payment apply) will reuse it as well — keep the signature
  // generic so the same call site works for any direction.
  //
  // Lookup: ListID first (exact), FullName fallback (invoices created via tools
  // often pass FullName only). Orphan refs are silently ignored — a missing
  // customer must not block transaction creation.
  //
  // TotalBalance mirrors Balance because the simulation has no sub-customer
  // hierarchy. Vendor has no TotalBalance field — don't introduce one.
  private adjustEntityBalance(
    entityType: "Customer" | "Vendor",
    refKey: { listID?: string; fullName?: string },
    delta: number
  ): void {
    if (delta === 0) return;
    const store = this.getStore(entityType);

    let target: StoredEntity | undefined;
    if (refKey.listID) {
      target = store.get(refKey.listID);
    }
    if (!target && refKey.fullName) {
      for (const e of store.values()) {
        if (String(e.FullName ?? e.Name ?? "") === refKey.fullName) {
          target = e;
          break;
        }
      }
    }
    if (!target) return;

    const next = Number(target.Balance ?? 0) + delta;
    target.Balance = next;
    if (entityType === "Customer") {
      target.TotalBalance = next;
    }
  }

  // Thin adapter that pulls the ref + amount off a stored transaction and
  // applies the signed delta. `sign` is +1 on add, -1 on delete. Kept private
  // and entity-type-specific so handleAdd/handleTxnDel stay readable.
  // CreditMemo passes amountField: "TotalAmount" with sign: -1 on add (the
  // credit reduces customer balance) and sign: +1 on delete (reverse).
  private adjustPartyBalanceForTxn(
    txn: StoredEntity,
    partyType: "Customer" | "Vendor",
    amountField: "BalanceRemaining" | "AmountDue" | "TotalAmount",
    sign: 1 | -1
  ): void {
    const refField = partyType === "Customer" ? "CustomerRef" : "VendorRef";
    const ref = txn[refField] as Record<string, unknown> | undefined;
    if (!ref) return;
    const amount = Number(txn[amountField] ?? 0);
    if (!Number.isFinite(amount) || amount === 0) return;
    this.adjustEntityBalance(
      partyType,
      {
        listID: ref.ListID ? String(ref.ListID) : undefined,
        fullName: ref.FullName ? String(ref.FullName) : undefined,
      },
      sign * amount
    );
  }

  // -----------------------------------------------------------------------
  // Mod handler
  // -----------------------------------------------------------------------

  private handleMod(
    reqType: string,
    reqData: Record<string, unknown>
  ): QBXMLResponseBody {
    const entityType = reqType.replace("ModRq", "");
    const rsType = reqType.replace("Rq", "Rs");
    const retName = `${entityType}Ret`;
    const modKey = `${entityType}Mod`;
    const store = this.getStore(entityType);

    const modData = (reqData[modKey] ?? reqData) as Record<string, unknown>;
    const isTransaction = this.isTransactionType(entityType);
    const idField = isTransaction ? "TxnID" : "ListID";
    const id = String(modData[idField] ?? "");

    if (!id) {
      return {
        type: rsType,
        statusCode: 3120,
        statusSeverity: "Error",
        statusMessage: `Missing ${idField} in ${entityType}Mod`,
        data: {},
      };
    }

    const existing = store.get(id);
    if (!existing) {
      return {
        type: rsType,
        statusCode: 500,
        statusSeverity: "Error",
        statusMessage: `Object "${id}" specified in the request cannot be found`,
        data: {},
      };
    }

    // Strict EditSequence check — real QB rejects with 3170 when the caller's
    // EditSequence doesn't match the current one (someone else modified the
    // record since the caller queried it). Mirroring this in the simulation
    // catches a class of "passed in dev, rejected in live" bugs at zero
    // per-tool cost since every existing *_update tool already passes
    // EditSequence. See DECISIONS.md 2026-04-25 entry.
    if (
      modData.EditSequence !== undefined &&
      String(modData.EditSequence) !== String(existing.EditSequence)
    ) {
      return {
        type: rsType,
        statusCode: 3170,
        statusSeverity: "Error",
        statusMessage:
          "The given object's EditSequence does not match the EditSequence in QuickBooks; the object has likely been modified since it was last retrieved",
        data: {},
      };
    }

    // ReceivePayment mod (qb_payment_apply path) is application-only —
    // no *LineMod shape, no header total to recompute. Reverse the existing
    // application, apply the new one, merge any header fields, persist.
    // Short-circuits before the Bill/Invoice line-mod plumbing because the
    // AppliedToTxnMod block doesn't match the /^(.+?)Line(s?)Mod$/ regex
    // and the rest of the path doesn't apply.
    if (entityType === "ReceivePayment") {
      return this.handleReceivePaymentMod(
        rsType, retName, store, id, existing, modData
      );
    }

    // CreditMemo with AppliedToTxnMod (qb_credit_memo_apply path) is the
    // AR-negative analog of qb_payment_apply: re-target an existing memo to
    // a different invoice set without touching the line set or TotalAmount.
    // Falls through to the standard line-mod path when AppliedToTxnMod is
    // not present (qb_credit_memo_update — header / line changes that DO
    // recompute TotalAmount and DO move customer balance by the delta).
    if (entityType === "CreditMemo" && modData.AppliedToTxnMod !== undefined) {
      return this.handleCreditMemoApplyMod(
        rsType, retName, store, id, existing, modData
      );
    }

    // Apply *LineMod arrays (Bill, Invoice, Estimate, SalesReceipt, CreditMemo
    // exercise this path). The mod's line array becomes the entity's new line
    // array, with merge-by-TxnLineID semantics so a partial mod ("change just
    // memo on line L1") doesn't force the operator to reconstruct the whole
    // line.
    //
    // Capture the pre-mod amount that maps to the party's open balance —
    // Bill uses AmountDue (vendor side), Invoice uses BalanceRemaining
    // (customer side), CreditMemo uses TotalAmount (customer side, but
    // sign-inverted: TotalAmount growing means customer balance dropping).
    // Read off `existing` so we get the value BEFORE applyLineMods produces
    // a new line set.
    const oldPartyAmount =
      entityType === "Bill"
        ? Number(existing.AmountDue ?? 0)
        : entityType === "Invoice"
          ? Number(existing.BalanceRemaining ?? 0)
          : entityType === "CreditMemo"
            ? Number(existing.TotalAmount ?? 0)
            : 0;
    const lineModResult = this.applyLineMods(existing, modData);

    const strippedModData = lineModResult.lineModKeys.size > 0
      ? this.omitKeys(modData, lineModResult.lineModKeys)
      : modData;

    let updated: StoredEntity = {
      ...lineModResult.entityWithLines,
      ...strippedModData,
      TimeModified: new Date().toISOString(),
      EditSequence: this.nextEditSequence(),
    };

    if (modData.Name && !modData.FullName) {
      updated.FullName = String(modData.Name);
    }

    // After lines change, the line-derived header totals must be re-derived
    // or they drift. Bill: AmountDue. Invoice: Subtotal, BalanceRemaining,
    // IsPaid (AppliedAmount is preserved — it's not derived from lines, it
    // tracks what payments have already closed against the invoice).
    // Estimate: Subtotal only — estimates have no AmountDue/AppliedAmount/IsPaid
    // (they're a quote, not posted to AR/AP). SalesReceipt: Subtotal +
    // TotalAmount — cash sale, instantly closed, no AR balance to track.
    // CreditMemo: Subtotal + TotalAmount + RemainingValue (= TotalAmount −
    // AppliedAmount). AppliedAmount is preserved (it's not derived from lines;
    // it tracks invoice applications and applyCreditMemo / handleCreditMemo-
    // ApplyMod own that field). Customer balance moves by -(newTotalAmount −
    // oldTotalAmount) below. PurchaseOrder: TotalAmount only — non-posting,
    // so no balance bookkeeping below either.
    // For Invoice / Estimate / SalesReceipt / CreditMemo / PurchaseOrder,
    // computeTotals always overwrites the derived header field so no pre-delete
    // is needed; Bill needs AmountDue cleared because computeTotals only sets
    // it when undefined (preserves explicit overrides).
    if (
      lineModResult.lineModKeys.size > 0 &&
      (entityType === "Bill" ||
        entityType === "Invoice" ||
        entityType === "Estimate" ||
        entityType === "SalesReceipt" ||
        entityType === "CreditMemo" ||
        entityType === "PurchaseOrder" ||
        entityType === "JournalEntry")
    ) {
      if (entityType === "Bill") {
        delete updated.AmountDue;
      }
      updated = this.computeTotals(updated, entityType);
    }

    // JE balance invariant re-check on every mod — both line mods (which can
    // unbalance the entry) and header-only mods (defensive — should already
    // be balanced from the prior add/mod). Return 3030 BEFORE persist so a
    // doomed mod never lands in the store. Runs after computeTotals so
    // TotalDebit/TotalCredit on `updated` reflect the post-mod sums.
    if (entityType === "JournalEntry") {
      const balanceCheck = this.validateJournalEntryBalance(updated);
      if (!balanceCheck.ok) {
        return {
          type: rsType,
          statusCode: 3030,
          statusSeverity: "Error",
          statusMessage: balanceCheck.error,
          data: {},
        };
      }
    }

    store.set(id, updated);

    // Party-balance bookkeeping for a transaction mod: signed delta if the
    // same party, full reverse-then-apply if the ref itself changed.
    if (entityType === "Bill") {
      this.adjustPartyBalanceForTxnMod(
        "Vendor", "VendorRef", "AmountDue",
        existing, updated, oldPartyAmount
      );
    } else if (entityType === "Invoice") {
      this.adjustPartyBalanceForTxnMod(
        "Customer", "CustomerRef", "BalanceRemaining",
        existing, updated, oldPartyAmount
      );
    } else if (entityType === "CreditMemo") {
      // Sign-inverted: TotalAmount growing means customer balance dropping.
      // sign: -1 flips both branches of adjustPartyBalanceForTxnMod (same-
      // party delta and reverse-then-apply for ref changes).
      this.adjustPartyBalanceForTxnMod(
        "Customer", "CustomerRef", "TotalAmount",
        existing, updated, oldPartyAmount, -1
      );
    }

    return {
      type: rsType,
      statusCode: 0,
      statusSeverity: "Info",
      statusMessage: "Status OK",
      data: { [retName]: updated },
    };
  }

  // -----------------------------------------------------------------------
  // ReceivePayment mod handler (qb_payment_apply path)
  // -----------------------------------------------------------------------

  // ReceivePaymentMod with AppliedToTxnMod blocks re-applies a payment to a
  // (possibly different) set of invoices. The flow is validate → reverse →
  // apply, so a doomed mod (orphan TxnID, overapplication) never triggers
  // the reversal:
  //
  //   1. Validate the new application set via validateTxnApplications. On
  //      failure return 500 immediately — payment + invoices stay untouched.
  //   2. Reverse the existing application (restore each named invoice's
  //      BalanceRemaining / AppliedAmount / IsPaid; restore the customer
  //      balance by the previously-applied sum).
  //   3. Apply the new application via applyTxnApplications. Validation is
  //      cheap to run twice; the second invocation re-validates before
  //      mutating but is guaranteed to pass since nothing changed in step 2
  //      that affects validation.
  //   4. Merge header fields (Memo, RefNumber, TxnDate, etc.) onto the
  //      payment, stripping AppliedToTxnMod (consumed in step 3).
  //   5. Bump TimeModified + EditSequence and persist.
  //
  // TotalAmount is intentionally NOT re-derived from the application — the
  // payment amount itself is immutable on this path. Changing the payment
  // amount is a different operation (currently unsupported by any tool;
  // the operator would have to delete + recreate).
  private handleReceivePaymentMod(
    rsType: string,
    retName: string,
    store: EntityStore,
    id: string,
    existing: StoredEntity,
    modData: Record<string, unknown>
  ): QBXMLResponseBody {
    const rawMod = modData.AppliedToTxnMod;
    const newLines = !rawMod
      ? []
      : Array.isArray(rawMod)
        ? (rawMod as Record<string, unknown>[])
        : [rawMod as Record<string, unknown>];

    const totalAmount = Number(existing.TotalAmount ?? 0);
    const validation = this.validateTxnApplications(newLines, totalAmount);
    if (!validation.ok) {
      return {
        type: rsType,
        statusCode: 500,
        statusSeverity: "Error",
        statusMessage: validation.error,
        data: {},
      };
    }

    this.reverseReceivePaymentApplication(existing);
    const applyResult = this.applyTxnApplications(existing, newLines);
    if (!applyResult.ok) {
      // Defensive — validateTxnApplications passed, so apply should too.
      // If invoice state changed between validate and apply (impossible
      // single-threaded, but safer to surface than silently swallow).
      return {
        type: rsType,
        statusCode: 500,
        statusSeverity: "Error",
        statusMessage: applyResult.error,
        data: {},
      };
    }

    // Merge header fields. AppliedToTxnMod is consumed; AppliedToTxnRet /
    // AppliedAmount / UnusedPayment / TotalAmount are derived state that the
    // mod must not overwrite (TotalAmount is immutable on this path).
    const reservedKeys = new Set([
      "AppliedToTxnMod",
      "AppliedToTxnRet",
      "AppliedAmount",
      "UnusedPayment",
      "TotalAmount",
      "TxnID",
      "EditSequence",
    ]);
    const headerMod = this.omitKeys(modData, reservedKeys);

    const updated: StoredEntity = {
      ...existing,
      ...headerMod,
      TimeModified: new Date().toISOString(),
      EditSequence: this.nextEditSequence(),
    };

    store.set(id, updated);

    return {
      type: rsType,
      statusCode: 0,
      statusSeverity: "Info",
      statusMessage: "Status OK",
      data: { [retName]: updated },
    };
  }

  // -----------------------------------------------------------------------
  // CreditMemo apply-mod handler (qb_credit_memo_apply path)
  // -----------------------------------------------------------------------

  // CreditMemoMod with AppliedToTxnMod blocks re-applies a memo to a
  // (possibly different) set of invoices. Structurally identical to
  // handleReceivePaymentMod (validate → reverse → apply, atomically) with
  // two differences:
  //
  //   1. The application engine is applyCreditMemoApplications (no discount
  //      handling, no UnusedPayment field — replaced by RemainingValue).
  //   2. Customer balance is NOT moved here — that already happened at memo-
  //      add time using the FULL TotalAmount, and re-application just shifts
  //      bookkeeping between the credit pool and invoice-level balances
  //      without changing the customer's overall open balance.
  //
  // TotalAmount is intentionally NOT re-derived from the application — the
  // memo's face value is immutable on this path. Changing the credit's face
  // value goes through qb_credit_memo_update (with a new line set), which
  // recomputes TotalAmount and moves customer balance via the standard
  // adjustPartyBalanceForTxnMod call site.
  private handleCreditMemoApplyMod(
    rsType: string,
    retName: string,
    store: EntityStore,
    id: string,
    existing: StoredEntity,
    modData: Record<string, unknown>
  ): QBXMLResponseBody {
    const rawMod = modData.AppliedToTxnMod;
    const newLines = !rawMod
      ? []
      : Array.isArray(rawMod)
        ? (rawMod as Record<string, unknown>[])
        : [rawMod as Record<string, unknown>];

    const totalAmount = Number(existing.TotalAmount ?? 0);
    const validation = this.validateCreditMemoApplications(newLines, totalAmount);
    if (!validation.ok) {
      return {
        type: rsType,
        statusCode: 500,
        statusSeverity: "Error",
        statusMessage: validation.error,
        data: {},
      };
    }

    this.reverseCreditMemoApplication(existing);
    const applyResult = this.applyCreditMemoApplications(existing, newLines);
    if (!applyResult.ok) {
      // Defensive — validate passed, so apply should too.
      return {
        type: rsType,
        statusCode: 500,
        statusSeverity: "Error",
        statusMessage: applyResult.error,
        data: {},
      };
    }

    // Merge header fields. AppliedToTxnMod is consumed; AppliedToTxnRet /
    // AppliedAmount / RemainingValue / TotalAmount are derived state that
    // the mod must not overwrite (TotalAmount is immutable on this path).
    const reservedKeys = new Set([
      "AppliedToTxnMod",
      "AppliedToTxnRet",
      "AppliedAmount",
      "RemainingValue",
      "TotalAmount",
      "TxnID",
      "EditSequence",
    ]);
    const headerMod = this.omitKeys(modData, reservedKeys);

    const updated: StoredEntity = {
      ...existing,
      ...headerMod,
      TimeModified: new Date().toISOString(),
      EditSequence: this.nextEditSequence(),
    };

    store.set(id, updated);

    return {
      type: rsType,
      statusCode: 0,
      statusSeverity: "Info",
      statusMessage: "Status OK",
      data: { [retName]: updated },
    };
  }

  // -----------------------------------------------------------------------
  // Line-mod application
  // -----------------------------------------------------------------------

  // Real QB's *LineMod blocks support per-line modify-or-add (TxnLineID="-1"
  // means new). The simulation matches that semantic with a wholesale-replace
  // of the *LineRet array, merging fields onto the matching existing line
  // when TxnLineID is provided. Lines whose TxnLineID is absent or "-1" get
  // a freshly-generated TxnLineID. Lines NOT mentioned in the mod's array
  // are dropped (matches QB: you supply the post-mod line set).
  private applyLineMods(
    existing: StoredEntity,
    modData: Record<string, unknown>
  ): { entityWithLines: StoredEntity; lineModKeys: Set<string> } {
    const result: StoredEntity = { ...existing };
    const lineModKeys = new Set<string>();

    for (const key of Object.keys(modData)) {
      const match = key.match(/^(.+?)Line(s?)Mod$/);
      if (!match) continue;
      const [, prefix, plural] = match;
      lineModKeys.add(key);
      const retKey = `${prefix}Line${plural}Ret`;

      const raw = modData[key];
      const modLines = Array.isArray(raw)
        ? (raw as Record<string, unknown>[])
        : raw && typeof raw === "object"
          ? [raw as Record<string, unknown>]
          : [];

      const existingLines = Array.isArray(result[retKey])
        ? (result[retKey] as Record<string, unknown>[])
        : [];

      const newLines = modLines.map((modLine) => {
        const txnLineID = modLine.TxnLineID;
        const isNew = !txnLineID || String(txnLineID) === "-1";

        let baseLine: Record<string, unknown> = {};
        if (!isNew) {
          const found = existingLines.find(
            (l) => String(l.TxnLineID ?? "") === String(txnLineID)
          );
          if (found) baseLine = { ...found };
        }

        const merged: Record<string, unknown> = { ...baseLine, ...modLine };
        merged.TxnLineID = isNew ? this.nextId() : String(txnLineID);

        // Re-derive Amount when both sides of the math are present in the
        // merged line. Quantity*Rate (Invoice/Estimate) takes precedence
        // over Quantity*Cost (Bill ItemLine). For ExpenseLineMod (no qty,
        // no rate, no cost) this is a no-op — Amount carries from the merge.
        const qty = merged.Quantity;
        const rate = merged.Rate;
        const cost = merged.Cost;
        if (qty !== undefined && qty !== null && rate !== undefined && rate !== null) {
          merged.Amount = Number(qty) * Number(rate);
        } else if (qty !== undefined && qty !== null && cost !== undefined && cost !== null) {
          merged.Amount = Number(qty) * Number(cost);
        }

        return merged;
      });

      result[retKey] = newLines;
    }

    return { entityWithLines: result, lineModKeys };
  }

  private omitKeys(
    data: Record<string, unknown>,
    keys: Set<string>
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!keys.has(k)) out[k] = v;
    }
    return out;
  }

  // Drops *LineRet / *LinesRet keys from a stored transaction entity.
  // Used by handleQuery to enforce the IncludeLineItems contract: real QB
  // omits line arrays from *QueryRq responses unless explicitly requested.
  // Header-level totals (Subtotal / AmountDue / BalanceRemaining / IsPaid)
  // stay — those are computed from the lines but are HEADER fields. JE
  // posting lines (JournalDebitLineRet / JournalCreditLineRet) are also
  // dropped: they match the *LineRet pattern via the regex. AppliedToTxnRet
  // does NOT match (no "Line" segment) and is preserved — appliedTo is a
  // header-level relationship, not a line breakdown.
  private stripLineRetKeys(
    entity: StoredEntity
  ): StoredEntity {
    const out: StoredEntity = {};
    for (const [k, v] of Object.entries(entity)) {
      if (/Line(s?)Ret$/.test(k)) continue;
      out[k] = v;
    }
    return out;
  }

  // Adjusts party (Customer or Vendor) balance(s) after a transaction mod.
  // Same party → signed delta on the (possibly new) amount field.
  // Party changed → reverse the old party's bump, apply the new party's.
  // Mirrors real QB's behavior when re-pointing a transaction at a different
  // customer/vendor.
  //
  // `partyType` selects Customer or Vendor; `refField` the corresponding ref
  // field on the stored entity (CustomerRef / VendorRef); `amountField` the
  // signed dollar field that maps to the party's open balance — Bill uses
  // AmountDue, Invoice uses BalanceRemaining (which can go negative when a
  // line mod drops the subtotal below the already-applied amount; the negative
  // is intentional — it represents over-application as a customer credit).
  // CreditMemo uses TotalAmount with `sign: -1` because a memo growing means
  // the customer's open balance shrinks (more credit issued); the sign flips
  // the directionality through both same-party and reverse-then-apply paths.
  private adjustPartyBalanceForTxnMod(
    partyType: "Customer" | "Vendor",
    refField: "CustomerRef" | "VendorRef",
    amountField: "AmountDue" | "BalanceRemaining" | "TotalAmount",
    beforeTxn: StoredEntity,
    afterTxn: StoredEntity,
    oldAmount: number,
    sign: 1 | -1 = 1
  ): void {
    const newAmount = Number(afterTxn[amountField] ?? 0);
    const oldRef = beforeTxn[refField] as Record<string, unknown> | undefined;
    const newRef = afterTxn[refField] as Record<string, unknown> | undefined;

    const sameParty = (() => {
      if (!oldRef || !newRef) return oldRef === newRef;
      const oldId = oldRef.ListID ? String(oldRef.ListID) : "";
      const newId = newRef.ListID ? String(newRef.ListID) : "";
      if (oldId && newId) return oldId === newId;
      const oldName = oldRef.FullName ? String(oldRef.FullName) : "";
      const newName = newRef.FullName ? String(newRef.FullName) : "";
      if (oldName && newName) return oldName === newName;
      return false;
    })();

    if (sameParty && newRef) {
      const delta = (newAmount - oldAmount) * sign;
      if (delta !== 0) {
        this.adjustEntityBalance(
          partyType,
          {
            listID: newRef.ListID ? String(newRef.ListID) : undefined,
            fullName: newRef.FullName ? String(newRef.FullName) : undefined,
          },
          delta
        );
      }
      return;
    }

    if (oldRef && oldAmount !== 0) {
      this.adjustEntityBalance(
        partyType,
        {
          listID: oldRef.ListID ? String(oldRef.ListID) : undefined,
          fullName: oldRef.FullName ? String(oldRef.FullName) : undefined,
        },
        -oldAmount * sign
      );
    }
    if (newRef && newAmount !== 0) {
      this.adjustEntityBalance(
        partyType,
        {
          listID: newRef.ListID ? String(newRef.ListID) : undefined,
          fullName: newRef.FullName ? String(newRef.FullName) : undefined,
        },
        newAmount * sign
      );
    }
  }

  // -----------------------------------------------------------------------
  // Delete handlers
  // -----------------------------------------------------------------------

  private handleListDel(reqData: Record<string, unknown>): QBXMLResponseBody {
    const entityType = String(reqData.ListDelType ?? "");
    const listID = String(reqData.ListID ?? "");
    const store = this.getStore(entityType);

    if (!store.has(listID)) {
      return {
        type: "ListDelRs",
        statusCode: 500,
        statusSeverity: "Error",
        statusMessage: `Object "${listID}" specified in the request cannot be found`,
        data: {},
      };
    }

    store.delete(listID);

    return {
      type: "ListDelRs",
      statusCode: 0,
      statusSeverity: "Info",
      statusMessage: "Status OK",
      data: { ListDelType: entityType, ListID: listID },
    };
  }

  private handleTxnDel(reqData: Record<string, unknown>): QBXMLResponseBody {
    const entityType = String(reqData.TxnDelType ?? "");
    const txnID = String(reqData.TxnID ?? "");
    const store = this.getStore(entityType);

    const target = store.get(txnID);
    if (!target) {
      return {
        type: "TxnDelRs",
        statusCode: 500,
        statusSeverity: "Error",
        statusMessage: `Transaction "${txnID}" specified in the request cannot be found`,
        data: {},
      };
    }

    if (entityType === "Invoice") {
      this.adjustPartyBalanceForTxn(target, "Customer", "BalanceRemaining", -1);
    } else if (entityType === "Bill") {
      this.adjustPartyBalanceForTxn(target, "Vendor", "AmountDue", -1);
    } else if (entityType === "CreditMemo") {
      // Reverse the AR-negative posting: customer Balance moves by +TotalAmount
      // (was -TotalAmount on add). Also restore each previously-applied
      // invoice's BalanceRemaining (orphan invoices are silently skipped —
      // a deleted invoice shouldn't block memo deletion).
      this.reverseCreditMemoApplication(target);
      this.adjustPartyBalanceForTxn(target, "Customer", "TotalAmount", +1);
    }

    store.delete(txnID);

    return {
      type: "TxnDelRs",
      statusCode: 0,
      statusSeverity: "Info",
      statusMessage: "Status OK",
      data: { TxnDelType: entityType, TxnID: txnID },
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private getStore(entityType: string): EntityStore {
    if (!this.stores.has(entityType)) {
      this.stores.set(entityType, new Map());
    }
    return this.stores.get(entityType)!;
  }

  private nextId(): string {
    return `${this.idCounter++}-${Date.now().toString(36)}`;
  }

  // ISO timestamp plus a monotonic counter. The counter guarantees a fresh
  // value when create+mod (or back-to-back mods) land in the same millisecond
  // — without it, `EditSequence: new Date().toISOString()` collides on fast
  // hardware and stale-EditSequence rejection (statusCode 3170) silently
  // breaks because the caller's "old" sequence still matches the stored one.
  private nextEditSequence(): string {
    return `${new Date().toISOString()}-${this.idCounter++}`;
  }

  private isTransactionType(entityType: string): boolean {
    return [
      "Invoice", "Bill", "Payment", "Estimate", "SalesReceipt",
      "CreditMemo", "PurchaseOrder", "JournalEntry", "Deposit",
      "Transfer", "Check", "BillPaymentCheck", "BillPaymentCreditCard",
      "ReceivePayment", "SalesOrder",
    ].includes(entityType);
  }

  // -----------------------------------------------------------------------
  // Seed data — realistic sample data for development
  // -----------------------------------------------------------------------

  private seedData(): void {
    const now = new Date().toISOString();
    const customers = this.getStore("Customer");
    const vendors = this.getStore("Vendor");
    const accounts = this.getStore("Account");
    const invoices = this.getStore("Invoice");

    // Sample customers
    const sampleCustomers: StoredEntity[] = [
      {
        ListID: "80000001-1234567890",
        Name: "Acme Corporation",
        FullName: "Acme Corporation",
        IsActive: true,
        CompanyName: "Acme Corporation",
        FirstName: "John",
        LastName: "Smith",
        Phone: "555-0100",
        Email: "john@acmecorp.com",
        Balance: 15000.00,
        TotalBalance: 15000.00,
        BillAddress: {
          Addr1: "123 Main Street",
          City: "Springfield",
          State: "IL",
          PostalCode: "62701",
          Country: "US",
        },
        EditSequence: now,
        TimeCreated: "2024-01-15T09:00:00",
        TimeModified: now,
      },
      {
        ListID: "80000002-1234567890",
        Name: "Global Industries",
        FullName: "Global Industries",
        IsActive: true,
        CompanyName: "Global Industries LLC",
        FirstName: "Jane",
        LastName: "Doe",
        Phone: "555-0200",
        Email: "jane@globalind.com",
        Balance: 8500.00,
        TotalBalance: 8500.00,
        BillAddress: {
          Addr1: "456 Oak Avenue",
          City: "Denver",
          State: "CO",
          PostalCode: "80201",
          Country: "US",
        },
        EditSequence: now,
        TimeCreated: "2024-02-01T10:00:00",
        TimeModified: now,
      },
      {
        ListID: "80000003-1234567890",
        Name: "TechStart Solutions",
        FullName: "TechStart Solutions",
        IsActive: true,
        CompanyName: "TechStart Solutions Inc",
        FirstName: "Alex",
        LastName: "Johnson",
        Phone: "555-0300",
        Email: "alex@techstart.com",
        Balance: 3200.00,
        TotalBalance: 3200.00,
        EditSequence: now,
        TimeCreated: "2024-03-10T11:00:00",
        TimeModified: now,
      },
    ];

    for (const c of sampleCustomers) {
      customers.set(c.ListID as string, c);
    }

    // Sample vendors. The first two are non-1099 (Office Supplies sells goods,
    // Cloud Hosting is a corp); the next three are 1099-eligible — needed by
    // the Phase 10 #44 form-1099 tools so qb_1099_summary / qb_1099_detail
    // return non-trivial dev results without forcing every test to seed its own.
    // VendorTaxIdent + Vendor1099Type drive the per-vendor classification
    // (NEC default for nonemployee compensation, MISC for rents/royalties).
    const sampleVendors: StoredEntity[] = [
      {
        ListID: "90000001-1234567890",
        Name: "Office Supplies Co",
        FullName: "Office Supplies Co",
        IsActive: true,
        CompanyName: "Office Supplies Co",
        Phone: "555-0400",
        Email: "orders@officesupplies.com",
        Balance: 2500.00,
        IsVendorEligibleFor1099: false,
        EditSequence: now,
        TimeCreated: "2024-01-10T09:00:00",
        TimeModified: now,
      },
      {
        ListID: "90000002-1234567890",
        Name: "Cloud Hosting Services",
        FullName: "Cloud Hosting Services",
        IsActive: true,
        CompanyName: "Cloud Hosting Services LLC",
        Phone: "555-0500",
        Email: "billing@cloudhost.com",
        Balance: 1200.00,
        IsVendorEligibleFor1099: false,
        EditSequence: now,
        TimeCreated: "2024-02-05T10:00:00",
        TimeModified: now,
      },
      {
        ListID: "90000003-1234567890",
        Name: "Joe Contractor",
        FullName: "Joe Contractor",
        IsActive: true,
        CompanyName: "Joe Contractor",
        Phone: "555-0600",
        Email: "joe@contractor.example",
        Balance: 0,
        IsVendorEligibleFor1099: true,
        Vendor1099Type: "NEC",
        VendorTaxIdent: "12-3456789",
        VendorAddress: {
          Addr1: "789 Worker Ln",
          City: "Austin",
          State: "TX",
          PostalCode: "73301",
          Country: "US",
        },
        EditSequence: now,
        TimeCreated: "2024-01-05T09:00:00",
        TimeModified: now,
      },
      {
        ListID: "90000004-1234567890",
        Name: "Sarah Designer LLC",
        FullName: "Sarah Designer LLC",
        IsActive: true,
        CompanyName: "Sarah Designer LLC",
        Phone: "555-0700",
        Email: "sarah@designer.example",
        Balance: 0,
        IsVendorEligibleFor1099: true,
        Vendor1099Type: "NEC",
        VendorTaxIdent: "98-7654321",
        VendorAddress: {
          Addr1: "456 Studio Way",
          City: "Brooklyn",
          State: "NY",
          PostalCode: "11201",
          Country: "US",
        },
        EditSequence: now,
        TimeCreated: "2024-01-12T09:00:00",
        TimeModified: now,
      },
      {
        ListID: "90000005-1234567890",
        Name: "ACME Property Mgmt",
        FullName: "ACME Property Mgmt",
        IsActive: true,
        CompanyName: "ACME Property Mgmt LLC",
        Phone: "555-0800",
        Email: "rent@acmepm.example",
        Balance: 0,
        IsVendorEligibleFor1099: true,
        Vendor1099Type: "MISC",
        VendorTaxIdent: "11-2233445",
        VendorAddress: {
          Addr1: "1 Real Estate Plaza",
          City: "Chicago",
          State: "IL",
          PostalCode: "60601",
          Country: "US",
        },
        EditSequence: now,
        TimeCreated: "2024-01-02T09:00:00",
        TimeModified: now,
      },
    ];

    for (const v of sampleVendors) {
      vendors.set(v.ListID as string, v);
    }

    // Sample accounts (Chart of Accounts)
    const sampleAccounts: StoredEntity[] = [
      { ListID: "A0000001", Name: "Checking", FullName: "Checking", AccountType: "Bank", AccountNumber: "1000", Balance: 45000.00, IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "A0000002", Name: "Savings", FullName: "Savings", AccountType: "Bank", AccountNumber: "1010", Balance: 120000.00, IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "A0000003", Name: "Accounts Receivable", FullName: "Accounts Receivable", AccountType: "AccountsReceivable", AccountNumber: "1100", Balance: 26700.00, IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "A0000004", Name: "Accounts Payable", FullName: "Accounts Payable", AccountType: "AccountsPayable", AccountNumber: "2000", Balance: 3700.00, IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "A0000005", Name: "Sales Revenue", FullName: "Sales Revenue", AccountType: "Income", AccountNumber: "4000", Balance: 185000.00, IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "A0000006", Name: "Consulting Revenue", FullName: "Consulting Revenue", AccountType: "Income", AccountNumber: "4100", Balance: 72000.00, IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "A0000007", Name: "Cost of Goods Sold", FullName: "Cost of Goods Sold", AccountType: "CostOfGoodsSold", AccountNumber: "5000", Balance: 95000.00, IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "A0000008", Name: "Rent Expense", FullName: "Rent Expense", AccountType: "Expense", AccountNumber: "6000", Balance: 24000.00, IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "A0000009", Name: "Utilities", FullName: "Utilities", AccountType: "Expense", AccountNumber: "6100", Balance: 4800.00, IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "A0000010", Name: "Payroll Expense", FullName: "Payroll Expense", AccountType: "Expense", AccountNumber: "6200", Balance: 156000.00, IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
    ];

    for (const a of sampleAccounts) {
      accounts.set(a.ListID as string, a);
    }

    // Sample items
    const sampleItems: StoredEntity[] = [
      { ListID: "I0000001", Name: "Consulting Services", FullName: "Consulting Services", IsActive: true, ItemType: "Service", Description: "Professional consulting services", Price: 150.00, EditSequence: now, TimeCreated: "2024-01-15T09:00:00", TimeModified: now },
      { ListID: "I0000002", Name: "Software License", FullName: "Software License", IsActive: true, ItemType: "NonInventory", Description: "Annual software license", Price: 499.00, EditSequence: now, TimeCreated: "2024-01-15T09:00:00", TimeModified: now },
      { ListID: "I0000003", Name: "Widget A", FullName: "Widget A", IsActive: true, ItemType: "Inventory", Description: "Standard widget", Price: 25.00, Cost: 12.00, EditSequence: now, TimeCreated: "2024-02-01T10:00:00", TimeModified: now },
    ];

    // Route each seed item into its per-subtype store. ItemType is the
    // discriminator real QB uses (Service / Inventory / NonInventory /
    // OtherCharge / Group) and maps 1:1 to the entity-type strings the
    // request-handling code derives from `Item<Subtype>QueryRq`.
    for (const i of sampleItems) {
      this.getStore(`Item${i.ItemType}`).set(i.ListID as string, i);
    }

    // Sample invoices
    const sampleInvoices: StoredEntity[] = [
      {
        TxnID: "T0000001-INV",
        CustomerRef: { ListID: "80000001-1234567890", FullName: "Acme Corporation" },
        TxnDate: "2024-11-01",
        DueDate: "2024-12-01",
        RefNumber: "INV-1001",
        Subtotal: 7500.00,
        SalesTaxTotal: 0,
        BalanceRemaining: 7500.00,
        IsPaid: false,
        Memo: "Consulting services - November",
        EditSequence: now,
        TimeCreated: "2024-11-01T09:00:00",
        TimeModified: now,
      },
      {
        TxnID: "T0000002-INV",
        CustomerRef: { ListID: "80000002-1234567890", FullName: "Global Industries" },
        TxnDate: "2024-11-15",
        DueDate: "2024-12-15",
        RefNumber: "INV-1002",
        Subtotal: 8500.00,
        SalesTaxTotal: 0,
        BalanceRemaining: 8500.00,
        IsPaid: false,
        Memo: "Software licenses x17",
        EditSequence: now,
        TimeCreated: "2024-11-15T10:00:00",
        TimeModified: now,
      },
    ];

    for (const inv of sampleInvoices) {
      invoices.set(inv.TxnID as string, inv);
    }

    // Reference lists — supporting types referenced by transactions (Class on
    // invoice/bill lines, Terms on invoice/bill headers, PaymentMethod on
    // ReceivePayment, SalesRep on invoice/sales receipt, CustomerType /
    // VendorType for segmentation). Seed a handful per type so the list tools
    // (qb_class_list, qb_terms_list, etc.) return non-trivial results in dev.
    const classes: StoredEntity[] = [
      { ListID: "C0000001", Name: "East", FullName: "East", IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "C0000002", Name: "West", FullName: "West", IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "C0000003", Name: "Overhead", FullName: "Overhead", IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
    ];
    for (const c of classes) this.getStore("Class").set(c.ListID as string, c);

    const standardTerms: StoredEntity[] = [
      { ListID: "ST0000001", Name: "Net 15", IsActive: true, StdDueDays: 15, StdDiscountDays: 0, DiscountPct: 0, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "ST0000002", Name: "Net 30", IsActive: true, StdDueDays: 30, StdDiscountDays: 0, DiscountPct: 0, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "ST0000003", Name: "2% 10 Net 30", IsActive: true, StdDueDays: 30, StdDiscountDays: 10, DiscountPct: 2, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
    ];
    for (const t of standardTerms) this.getStore("StandardTerms").set(t.ListID as string, t);

    const dateDrivenTerms: StoredEntity[] = [
      { ListID: "DT0000001", Name: "Due on 15th", IsActive: true, DayOfMonthDue: 15, DueNextMonthDays: 5, DiscountDayOfMonth: 0, DiscountPct: 0, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "DT0000002", Name: "Due on 1st", IsActive: true, DayOfMonthDue: 1, DueNextMonthDays: 5, DiscountDayOfMonth: 0, DiscountPct: 0, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
    ];
    for (const t of dateDrivenTerms) this.getStore("DateDrivenTerms").set(t.ListID as string, t);

    const paymentMethods: StoredEntity[] = [
      { ListID: "PM0000001", Name: "Check", IsActive: true, PaymentMethodType: "Check", EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "PM0000002", Name: "Cash", IsActive: true, PaymentMethodType: "Cash", EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "PM0000003", Name: "Visa", IsActive: true, PaymentMethodType: "CreditCard", EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "PM0000004", Name: "MasterCard", IsActive: true, PaymentMethodType: "CreditCard", EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
    ];
    for (const p of paymentMethods) this.getStore("PaymentMethod").set(p.ListID as string, p);

    const salesReps: StoredEntity[] = [
      { ListID: "SR0000001", Initial: "JS", IsActive: true, SalesRepEntityRef: { FullName: "John Smith" }, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "SR0000002", Initial: "AJ", IsActive: true, SalesRepEntityRef: { FullName: "Alex Johnson" }, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
    ];
    for (const s of salesReps) this.getStore("SalesRep").set(s.ListID as string, s);

    const customerTypes: StoredEntity[] = [
      { ListID: "CT0000001", Name: "Commercial", FullName: "Commercial", IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "CT0000002", Name: "Residential", FullName: "Residential", IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "CT0000003", Name: "Government", FullName: "Government", IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
    ];
    for (const c of customerTypes) this.getStore("CustomerType").set(c.ListID as string, c);

    const vendorTypes: StoredEntity[] = [
      { ListID: "VT0000001", Name: "Supplier", FullName: "Supplier", IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "VT0000002", Name: "Subcontractor", FullName: "Subcontractor", IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
      { ListID: "VT0000003", Name: "Service Provider", FullName: "Service Provider", IsActive: true, EditSequence: now, TimeCreated: "2024-01-01T00:00:00", TimeModified: now },
    ];
    for (const v of vendorTypes) this.getStore("VendorType").set(v.ListID as string, v);

    // Company — singleton (real QB has exactly one Company record per file).
    // Stored in a one-entry Map under the "COMPANY" sentinel key so the
    // generic getStore/handleQuery flow handles it without a special-case
    // branch; CompanyQueryRq has no filter inputs in practice (FullName/ListID
    // would be meaningless on a singleton), so the default code path returns
    // [companySeed] verbatim.
    const companySeed: StoredEntity = {
      CompanyName: "Demo Co",
      LegalCompanyName: "Demo Co LLC",
      Address: {
        Addr1: "100 Demo Way",
        City: "Springfield",
        State: "IL",
        PostalCode: "62701",
        Country: "US",
      },
      LegalAddress: {
        Addr1: "100 Demo Way",
        City: "Springfield",
        State: "IL",
        PostalCode: "62701",
        Country: "US",
      },
      Phone: "555-0000",
      Fax: "555-0001",
      Email: "books@demo.co",
      CompanyType: "Corporation",
      EIN: "12-3456789",
      FirstMonthInFiscalYear: "January",
      FirstMonthInIncomeTaxYear: "January",
      TaxForm: "Form1120",
      IsSampleCompany: true,
      SubscriberID: "SIM-SUBSCRIBER-0001",
      CompanyFilePath: "C:\\Users\\Public\\Documents\\Intuit\\QuickBooks\\Sample Company.qbw",
    };
    this.getStore("Company").set("COMPANY", companySeed);

    // Set ID counter beyond seed data
    this.idCounter = 10000;
  }
}
