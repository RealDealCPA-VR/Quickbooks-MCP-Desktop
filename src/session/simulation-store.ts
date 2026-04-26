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
      EditSequence: now,
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

    const updated: StoredEntity = {
      ...existing,
      ...modData,
      TimeModified: new Date().toISOString(),
      EditSequence: new Date().toISOString(),
    };

    if (modData.Name && !modData.FullName) {
      updated.FullName = String(modData.Name);
    }

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

    // Set ID counter beyond seed data
    this.idCounter = 10000;
  }
}
