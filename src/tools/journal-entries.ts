/**
 * JournalEntry management tools for QuickBooks Desktop MCP.
 *
 * JournalEntry is the structural outlier of the transaction family. Every
 * other transaction type derives its line set from a single side (invoice
 * lines bill the customer, bill lines charge the vendor, etc.) and posts
 * to AR/AP from a single header total. A journal entry is fundamentally
 * two-sided: every entry is a set of debit lines AND a set of credit lines
 * against named GL accounts, and the hard invariant is sum(debits) ===
 * sum(credits) to the cent. The simulation enforces that invariant on add
 * and after every line mod (statusCode 3030 if violated, before persist).
 *
 * Per-line EntityRef (Customer/Vendor on a JE line) is recorded faithfully
 * but does NOT move that entity's open balance in this server's first cut.
 * Real QB moves AR/AP by the per-line debit/credit amount when the line
 * carries a Customer or Vendor EntityRef; that bookkeeping is meaningfully
 * more involved than a single adjustPartyBalanceForTxn call (each line is
 * its own posting, the sign depends on debit/credit + AR/AP, and a single
 * JE can touch many entities). Surface this clearly in tool descriptions
 * so operators don't expect entity balances to update.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";

// Add-side line schema. Each side's array is independent; the sum-balance
// invariant is enforced at the simulation layer (statusCode 3030).
const journalLineSchema = z.object({
  accountName: z.string().describe("GL account full name to debit/credit"),
  amount: z.number().describe("Line amount (always positive — sign comes from debit-vs-credit array placement)"),
  memo: z.string().optional().describe("Per-line memo"),
  entityName: z.string().optional()
    .describe("Optional Customer/Vendor/Employee/OtherName to associate with this line. Recorded but does NOT move that entity's balance in this server."),
  className: z.string().optional().describe("Optional Class name for line classification"),
});

// Mod-side line schema. txnLineID identifies an existing line to merge over;
// omit (or pass '-1') to add a new line. New lines require accountName + amount.
const journalLineModSchema = z
  .object({
    txnLineID: z.string().optional()
      .describe("TxnLineID of the existing line to modify; omit (or pass '-1') to add a new line"),
    accountName: z.string().optional().describe("GL account full name"),
    amount: z.number().optional().describe("Line amount (always positive)"),
    memo: z.string().optional().describe("Per-line memo"),
    entityName: z.string().optional().describe("Optional Customer/Vendor/Employee/OtherName"),
    className: z.string().optional().describe("Optional Class name"),
  })
  .refine(
    (line) => {
      const isNew = !line.txnLineID || line.txnLineID === "-1";
      if (!isNew) return true;
      return Boolean(line.accountName && line.amount !== undefined);
    },
    { message: "New JE lines (no txnLineID) require accountName and amount" }
  );

function buildJELineAdd(line: z.infer<typeof journalLineSchema>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    AccountRef: { FullName: line.accountName },
    Amount: line.amount,
  };
  if (line.memo) out.Memo = line.memo;
  if (line.entityName) out.EntityRef = { FullName: line.entityName };
  if (line.className) out.ClassRef = { FullName: line.className };
  return out;
}

function buildJELineMod(line: z.infer<typeof journalLineModSchema>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (line.txnLineID) out.TxnLineID = line.txnLineID;
  if (line.accountName) out.AccountRef = { FullName: line.accountName };
  if (line.amount !== undefined) out.Amount = line.amount;
  if (line.memo) out.Memo = line.memo;
  if (line.entityName) out.EntityRef = { FullName: line.entityName };
  if (line.className) out.ClassRef = { FullName: line.className };
  return out;
}

export function registerJournalEntryTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_journal_entry_list",
    "List or search journal entries in QuickBooks Desktop. Each entry carries JournalDebitLineRet + JournalCreditLineRet arrays plus TotalDebit / TotalCredit (always equal — the balance invariant is enforced at write time).",
    {
      txnId: z.string().optional().describe("Fetch a specific JE by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference/entry number"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start TxnDate (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End TxnDate (YYYY-MM-DD)"),
      modifiedFrom: z.string().optional().describe("Modified date lower bound (ISO timestamp)"),
      modifiedTo: z.string().optional().describe("Modified date upper bound (ISO timestamp)"),
      maxReturned: z.number().optional().describe("Maximum results"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};
      if (args.txnId) filters.TxnID = args.txnId;
      if (args.refNumber) filters.RefNumber = args.refNumber;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = {
          FromTxnDate: args.fromDate,
          ToTxnDate: args.toDate,
        };
      }
      if (args.modifiedFrom || args.modifiedTo) {
        filters.ModifiedDateRangeFilter = {
          FromModifiedDate: args.modifiedFrom,
          ToModifiedDate: args.modifiedTo,
        };
      }
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;

      try {
        const journalEntries = await session.queryEntity("JournalEntry", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: journalEntries.length, journalEntries }, null, 2),
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
              statusMessage: e.message ?? "JournalEntryQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_journal_entry_create",
    "Create a journal entry in QuickBooks Desktop. Pass a `debits` array AND a `credits` array; sum(debits.amount) MUST equal sum(credits.amount) to the cent or the entry is rejected with statusCode 3030. Both sides require at least one line. Each line names a GL account by full name; an optional entityName attaches a Customer/Vendor reference (recorded but does NOT move that entity's balance in this server). isAdjustment marks the entry as an adjusting entry (real QB shows it differently in the entries list).",
    {
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Entry date (YYYY-MM-DD, default today)"),
      refNumber: z.string().optional().describe("Reference / entry number"),
      memo: z.string().optional().describe("Header memo"),
      isAdjustment: z.boolean().optional().describe("Mark as an adjusting journal entry"),
      debits: z.array(journalLineSchema).min(1)
        .describe("Debit-side lines. At least one required. sum(debits.amount) must equal sum(credits.amount)."),
      credits: z.array(journalLineSchema).min(1)
        .describe("Credit-side lines. At least one required. sum(credits.amount) must equal sum(debits.amount)."),
    },
    async (args) => {
      const session = getSession();

      const data: Record<string, unknown> = {};
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;
      if (args.isAdjustment !== undefined) data.IsAdjustment = args.isAdjustment;

      data.JournalDebitLineAdd = args.debits.map(buildJELineAdd);
      data.JournalCreditLineAdd = args.credits.map(buildJELineAdd);

      try {
        const result = await session.addEntity("JournalEntry", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, journalEntry: result }, null, 2),
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
              statusMessage: e.message ?? "JournalEntryAddRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_journal_entry_update",
    "Modify an existing journal entry. Pass txnId + editSequence (from a prior qb_journal_entry_list) plus any header fields and/or replacement `debits` / `credits` arrays. When debits or credits is provided it REPLACES that side wholesale — list every line you want kept on that side. A line with a txnLineID matching an existing line preserves that TxnLineID and merges any fields you pass over the existing values; a line without txnLineID (or with '-1') is added as new. The post-mod sum(debits) must still equal sum(credits) or the mod is rejected with statusCode 3030 and nothing is persisted. A stale editSequence rejects with statusCode 3170. Note: passing only debits (or only credits) is allowed but the unmodified side must still balance against the new side.",
    {
      txnId: z.string().describe("TxnID of the JE to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New entry date (YYYY-MM-DD)"),
      refNumber: z.string().optional().describe("New reference number"),
      memo: z.string().optional().describe("New header memo"),
      isAdjustment: z.boolean().optional().describe("Mark/unmark as adjusting entry"),
      debits: z.array(journalLineModSchema).optional()
        .describe("Replacement debit-side line set. Existing debit lines whose TxnLineID is not listed will be dropped."),
      credits: z.array(journalLineModSchema).optional()
        .describe("Replacement credit-side line set. Existing credit lines whose TxnLineID is not listed will be dropped."),
    },
    async (args) => {
      const session = getSession();
      const data: Record<string, unknown> = {
        TxnID: args.txnId,
        EditSequence: args.editSequence,
      };

      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.refNumber) data.RefNumber = args.refNumber;
      if (args.memo) data.Memo = args.memo;
      if (args.isAdjustment !== undefined) data.IsAdjustment = args.isAdjustment;

      if (args.debits) data.JournalDebitLineMod = args.debits.map(buildJELineMod);
      if (args.credits) data.JournalCreditLineMod = args.credits.map(buildJELineMod);

      try {
        const result = await session.modifyEntity("JournalEntry", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, journalEntry: result }, null, 2),
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
              statusMessage: e.message ?? "JournalEntryModRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "qb_journal_entry_delete",
    "Delete a journal entry from QuickBooks Desktop. JEs aren't tracked against AR/AP balances in this server, so there's no balance reversal — this is purely a record removal. WARNING: Irreversible.",
    {
      txnId: z.string().describe("TxnID of the JE to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("JournalEntry", txnId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
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
              statusMessage: e.message ?? "TxnDelRq (JournalEntry) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
