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

    const responses: QBXMLResponseBody[] = [];

    for (const [key, value] of Object.entries(msgsRq)) {
      if (key.startsWith("@_")) continue;

      const reqData = (typeof value === "object" && value !== null)
        ? value as Record<string, unknown>
        : {};

      if (key.endsWith("QueryRq")) {
        responses.push(this.handleQuery(key, reqData));
      } else if (key.endsWith("AddRq")) {
        responses.push(this.handleAdd(key, reqData));
      } else if (key.endsWith("ModRq")) {
        responses.push(this.handleMod(key, reqData));
      } else if (key === "ListDelRq") {
        responses.push(this.handleListDel(reqData));
      } else if (key === "TxnDelRq") {
        responses.push(this.handleTxnDel(reqData));
      } else {
        responses.push({
          type: key.replace("Rq", "Rs"),
          statusCode: -1,
          statusSeverity: "Error",
          statusMessage: `Unsupported request type: ${key}`,
          data: {},
        });
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

    if (results.length === 0) {
      return {
        type: rsType,
        statusCode: 1,
        statusSeverity: "Info",
        statusMessage: "A query request did not find a matching object in QuickBooks",
        data: {},
      };
    }

    return {
      type: rsType,
      statusCode: 0,
      statusSeverity: "Info",
      statusMessage: "Status OK",
      data: { [retName]: results },
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
    }

    const storeKey = isTransaction ? id : id;
    store.set(storeKey, finalEntity);

    if (entityType === "Invoice") {
      this.adjustPartyBalanceForTxn(finalEntity, "Customer", "BalanceRemaining", +1);
    } else if (entityType === "Bill") {
      this.adjustPartyBalanceForTxn(finalEntity, "Vendor", "AmountDue", +1);
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

    if (entityType === "Invoice" || entityType === "Estimate") {
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

    return result;
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
  private adjustPartyBalanceForTxn(
    txn: StoredEntity,
    partyType: "Customer" | "Vendor",
    amountField: "BalanceRemaining" | "AmountDue",
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

    // Apply *LineMod arrays (Bill and Invoice exercise this path).
    // The mod's line array becomes the entity's new line array, with
    // merge-by-TxnLineID semantics so a partial mod ("change just memo on
    // line L1") doesn't force the operator to reconstruct the whole line.
    //
    // Capture the pre-mod amount that maps to the party's open balance —
    // Bill uses AmountDue (vendor side), Invoice uses BalanceRemaining
    // (customer side). Read off `existing` so we get the value BEFORE
    // applyLineMods produces a new line set.
    const oldPartyAmount =
      entityType === "Bill"
        ? Number(existing.AmountDue ?? 0)
        : entityType === "Invoice"
          ? Number(existing.BalanceRemaining ?? 0)
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
    // (they're a quote, not posted to AR/AP). For Invoice and Estimate,
    // computeTotals always overwrites Subtotal so no pre-delete is needed;
    // Bill needs AmountDue cleared because computeTotals only sets it when
    // undefined (preserves explicit overrides).
    if (
      lineModResult.lineModKeys.size > 0 &&
      (entityType === "Bill" ||
        entityType === "Invoice" ||
        entityType === "Estimate")
    ) {
      if (entityType === "Bill") {
        delete updated.AmountDue;
      }
      updated = this.computeTotals(updated, entityType);
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
  private adjustPartyBalanceForTxnMod(
    partyType: "Customer" | "Vendor",
    refField: "CustomerRef" | "VendorRef",
    amountField: "AmountDue" | "BalanceRemaining",
    beforeTxn: StoredEntity,
    afterTxn: StoredEntity,
    oldAmount: number
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
      const delta = newAmount - oldAmount;
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
        -oldAmount
      );
    }
    if (newRef && newAmount !== 0) {
      this.adjustEntityBalance(
        partyType,
        {
          listID: newRef.ListID ? String(newRef.ListID) : undefined,
          fullName: newRef.FullName ? String(newRef.FullName) : undefined,
        },
        newAmount
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

    // Sample vendors
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
        EditSequence: now,
        TimeCreated: "2024-02-05T10:00:00",
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

    // Set ID counter beyond seed data
    this.idCounter = 10000;
  }
}
