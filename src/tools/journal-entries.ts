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
import { formatToolError } from "../util/format-tool-error.js";
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
    "List or search journal entries in QuickBooks Desktop. By default each row carries header totals only (TotalDebit / TotalCredit, always equal); pass includeLineItems:true to also surface JournalDebitLineRet + JournalCreditLineRet (per-line account, amount, optional Customer/Vendor entity, ClassRef).",
    {
      txnId: z.string().optional().describe("Fetch a specific JE by TxnID"),
      refNumber: z.string().optional().describe("Filter by reference/entry number"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start TxnDate (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End TxnDate (YYYY-MM-DD)"),
      modifiedFrom: z.string().optional().describe("Modified date lower bound (ISO timestamp)"),
      modifiedTo: z.string().optional().describe("Modified date upper bound (ISO timestamp)"),
      includeLineItems: z.boolean().optional().describe("When true, each JE row carries its JournalDebitLineRet + JournalCreditLineRet arrays. Default false — header totals only, matching real QB's JournalEntryQueryRq default behavior."),
      maxReturned: z.number().optional().describe("Maximum results"),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};
      // JournalEntryQueryRq schema-required child order (see invoices.ts):
      // selectors → MaxReturned → ModifiedDateRangeFilter → TxnDateRangeFilter
      // → (entity/account/ref filters) → IncludeLineItems → IncludeLinkedTxns.
      if (args.txnId) filters.TxnID = args.txnId;
      if (args.refNumber) filters.RefNumber = args.refNumber;
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;
      if (args.modifiedFrom || args.modifiedTo) {
        filters.ModifiedDateRangeFilter = {
          FromModifiedDate: args.modifiedFrom,
          ToModifiedDate: args.modifiedTo,
        };
      }
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = {
          FromTxnDate: args.fromDate,
          ToTxnDate: args.toDate,
        };
      }
      if (args.includeLineItems) filters.IncludeLineItems = true;

      try {
        const journalEntries = await session.queryEntity("JournalEntry", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: journalEntries.length, journalEntries }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "JournalEntryQueryRq failed" });
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
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate journal entry (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
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

      if (args.dryRun) {
        try {
          const preview = await session.addEntityDryRun("JournalEntry", data, args.idempotencyKey);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { journalEntry: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "JournalEntryAddRq dry-run failed" });
        }
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("JournalEntry", data, args.idempotencyKey)
          : { entity: await session.addEntity("JournalEntry", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              journalEntry: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "JournalEntryAddRq failed" });
      }
    }
  );

  server.tool(
    "qb_journal_entry_batch_create",
    "Create multiple journal entries atomically in a single QBXML envelope (onError=stopOnError). Each entry follows the same shape as qb_journal_entry_create — a balanced debits + credits set. Validation runs upfront (per-entry sum(debits) === sum(credits) within $0.005, ≥1 debit + ≥1 credit, ≤100 entries per batch); a single bad entry rejects the whole batch BEFORE any wire I/O so no posting happens. ATOMICITY: the QBXML wire itself does NOT roll back — stopOnError halts the envelope on the first wire-side failure but leaves prior-posted JEs in place. This tool covers that gap by automatically deleting any already-posted JEs when a later one fails (TxnDelRq per posted TxnID). The response carries per-entry status: 'posted' (committed), 'rolled-back' (was posted then auto-deleted), 'orphaned' (was posted but rollback delete itself failed — operator must clean up manually using qb_journal_entry_delete with the surfaced TxnID), 'failed' (rejected on wire), 'skipped' (never ran post-stopOnError). On full success the response carries success=true plus the array of posted TxnIDs. Use this for monthly credit-card batches, payroll splits, accruals, etc. — anywhere you need ALL OR NONE semantics across multiple entries.",
    {
      entries: z
        .array(
          z.object({
            txnDate: z.string().regex(ISO_DATE_RE).optional()
              .describe("Entry date (YYYY-MM-DD, default today)"),
            refNumber: z.string().optional().describe("Reference / entry number"),
            memo: z.string().optional().describe("Header memo"),
            isAdjustment: z.boolean().optional().describe("Mark as an adjusting entry"),
            debits: z.array(journalLineSchema).min(1)
              .describe("Debit-side lines for this entry. At least one required."),
            credits: z.array(journalLineSchema).min(1)
              .describe("Credit-side lines for this entry. At least one required."),
          })
        )
        .min(1)
        .max(100)
        .describe("Array of journal entries to post atomically (1–100). Each entry's debits must equal credits to the cent."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key for the WHOLE BATCH. Retrying with the same key + identical entries list returns the original batch outcome without re-running the wire envelope (response carries idempotentReplay: true). Reordering, adding, or removing entries makes the request a different request — that returns statusCode 9002 (use a fresh key). Cache is per company file and clears on qb_company_open. CAVEAT: only fully-successful batches are cached. The upfront balance-validation gate runs before the idempotency check (unbalanced batches are rejected and not cached regardless of key); partial-failure batches are also not cached — fresh retry is the correct recovery (rollback already cleaned up the originally-posted entries; orphans, if any, are surfaced to the operator on the failing call)."),
      dryRun: z.boolean().optional().describe("If true, preview the batch without committing. See qb_invoice_batch_create's dryRun docs for the full composition matrix. Balance validation still runs upfront on dry-run (an unbalanced entry never reaches the preview). The compensating-rollback path is NOT previewed — if the sim oracle reports any `failed` slot, the real call would auto-delete every earlier `posted` slot before that index."),
    },
    async (args) => {
      // Upfront per-entry balance validation. Bailing here keeps the envelope
      // off the wire entirely on obvious caller errors so no compensating
      // delete is needed and no QB session state is touched.
      const balanceErrors: Array<{ index: number; error: string }> = [];
      for (let i = 0; i < args.entries.length; i++) {
        const e = args.entries[i];
        const debitSum = e.debits.reduce((a, l) => a + l.amount, 0);
        const creditSum = e.credits.reduce((a, l) => a + l.amount, 0);
        if (Math.abs(debitSum - creditSum) > 0.005) {
          balanceErrors.push({
            index: i,
            error: `Entry ${i + 1}: debits (${debitSum.toFixed(2)}) must equal credits (${creditSum.toFixed(2)})`,
          });
        }
      }
      if (balanceErrors.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3030,
              statusMessage: "One or more entries are unbalanced",
              humanReadable: qbStatusCodeMessage(3030),
              balanceErrors,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const session = getSession();

      const dataList = args.entries.map((e) => {
        const data: Record<string, unknown> = {};
        if (e.txnDate) data.TxnDate = e.txnDate;
        if (e.refNumber) data.RefNumber = e.refNumber;
        if (e.memo) data.Memo = e.memo;
        if (e.isAdjustment !== undefined) data.IsAdjustment = e.isAdjustment;
        data.JournalDebitLineAdd = e.debits.map(buildJELineAdd);
        data.JournalCreditLineAdd = e.credits.map(buildJELineAdd);
        return data;
      });

      if (args.dryRun) {
        try {
          const preview = await session.executeBatchAddDryRun(
            "JournalEntry",
            dataList,
            args.idempotencyKey,
          );
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...preview,
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "Batch JournalEntryAddRq dry-run failed" });
        }
      }

      let results;
      let batchReplayed = false;
      try {
        if (args.idempotencyKey) {
          const out = await session.executeBatchAddIdempotent(
            "JournalEntry",
            dataList,
            args.idempotencyKey,
          );
          results = out.results;
          batchReplayed = out.replayed;
        } else {
          results = await session.executeBatchAdd("JournalEntry", dataList);
        }
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "Batch JournalEntryAddRq envelope failed" });
      }

      const allPosted = results.every((r) => r.status === "posted");
      if (allPosted) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(batchReplayed ? { idempotentReplay: true } : {}),
              count: results.length,
              entries: results.map((r, i) => {
                const ret = (r as { entity: Record<string, unknown> }).entity;
                return {
                  index: i,
                  requestID: r.requestID,
                  status: "posted",
                  txnId: String(ret.TxnID ?? ""),
                  refNumber: args.entries[i].refNumber,
                };
              }),
            }, null, 2),
          }],
        };
      }

      // Partial-failure path — find the first wire-side failure, identify
      // earlier posted entries, attempt a compensating delete on each.
      const failedIdx = results.findIndex((r) => r.status === "failed");
      const failedResult = failedIdx >= 0
        ? results[failedIdx] as { statusCode: number; statusMessage: string }
        : undefined;

      const postedTxnIds: { index: number; txnId: string }[] = [];
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "posted") {
          const entity = (results[i] as { entity: Record<string, unknown> }).entity;
          const txnId = String(entity.TxnID ?? "");
          if (txnId) postedTxnIds.push({ index: i, txnId });
        }
      }

      // Best-effort compensating delete. Delete in REVERSE post order so the
      // most-recent JE goes first — minimizes the chance that any cascading
      // bookkeeping QB performs invalidates an earlier delete.
      const rollbackOutcomes = new Map<
        string,
        { ok: true } | { ok: false; error: string }
      >();
      for (const { txnId } of [...postedTxnIds].reverse()) {
        try {
          await session.deleteEntity("JournalEntry", txnId);
          rollbackOutcomes.set(txnId, { ok: true });
        } catch (err) {
          const e = err as { message?: string };
          rollbackOutcomes.set(txnId, {
            ok: false,
            error: e.message ?? "Compensating TxnDelRq failed",
          });
        }
      }

      const rolledBackTxnIds: string[] = [];
      const orphanedEntries: Array<{ txnId: string; reason: string }> = [];
      for (const { txnId } of postedTxnIds) {
        const outcome = rollbackOutcomes.get(txnId);
        if (outcome?.ok) rolledBackTxnIds.push(txnId);
        else orphanedEntries.push({
          txnId,
          reason: outcome?.ok === false ? outcome.error : "Unknown rollback failure",
        });
      }

      const entriesPayload = results.map((r, i) => {
        const refNumber = args.entries[i].refNumber;
        if (r.status === "posted") {
          const entity = (r as { entity: Record<string, unknown> }).entity;
          const txnId = String(entity.TxnID ?? "");
          const outcome = rollbackOutcomes.get(txnId);
          if (outcome?.ok) {
            return {
              index: i,
              requestID: r.requestID,
              status: "rolled-back" as const,
              originalTxnId: txnId,
              refNumber,
            };
          }
          return {
            index: i,
            requestID: r.requestID,
            status: "orphaned" as const,
            txnId,
            refNumber,
            rollbackError: outcome?.ok === false ? outcome.error : "Unknown rollback failure",
          };
        }
        if (r.status === "failed") {
          return {
            index: i,
            requestID: r.requestID,
            status: "failed" as const,
            refNumber,
            statusCode: r.statusCode,
            statusMessage: r.statusMessage,
            ...(qbStatusCodeMessage(r.statusCode)
              ? { humanReadable: qbStatusCodeMessage(r.statusCode) }
              : {}),
          };
        }
        return {
          index: i,
          requestID: r.requestID,
          status: "skipped" as const,
          refNumber,
        };
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            atomic: true,
            rolledBack: orphanedEntries.length === 0,
            failedAt: failedIdx >= 0 ? failedIdx : undefined,
            failedReason: failedResult ? {
              statusCode: failedResult.statusCode,
              statusMessage: failedResult.statusMessage,
              humanReadable: qbStatusCodeMessage(failedResult.statusCode) || undefined,
            } : undefined,
            summary: {
              posted: 0,
              failed: results.filter((r) => r.status === "failed").length,
              skipped: results.filter((r) => r.status === "skipped").length,
              rolledBack: rolledBackTxnIds.length,
              rolledBackTxnIds,
              ...(orphanedEntries.length > 0 ? { orphaned: orphanedEntries } : {}),
            },
            entries: entriesPayload,
          }, null, 2),
        }],
        isError: true,
      };
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
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
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

      if (args.dryRun) {
        try {
          const preview = await session.modifyEntityDryRun("JournalEntry", data);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { journalEntry: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "JournalEntryModRq dry-run failed" });
        }
      }

      try {
        const result = await session.modifyEntity("JournalEntry", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, journalEntry: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "JournalEntryModRq failed" });
      }
    }
  );

  // Phase 12 #57a mirror — JE-side equivalent of qb_invoice_duplicate. Same
  // shape: read source JE with IncludeLineItems opt-in (Phase 10 #41 strip),
  // submit a fresh JournalEntryAddRq with both line sides carried + operator
  // overrides applied. No new wire types. No entity-retarget arg (re-pointing
  // per-line EntityRef is qb_journal_entry_update territory — a duplicate
  // wholesale-carries the source's entity refs).
  server.tool(
    "qb_journal_entry_duplicate",
    "Duplicate an existing journal entry in QuickBooks Desktop. Reads the source JE's JournalDebitLineRet + JournalCreditLineRet (with per-line AccountRef / Amount / Memo / EntityRef / ClassRef) and submits a fresh JournalEntryAddRq with both line sides carried plus operator-supplied header overrides. Carries by default: debit lines, credit lines, IsAdjustment. Does NOT carry: TxnDate (default = today), RefNumber (a duplicate needs a fresh number — supply it via refNumber or let QB autonumber), Memo (defaults to 'Duplicate of <source ref or TxnID>'). The sum(debits) === sum(credits) invariant is preserved by construction since both sides are carried verbatim from the source. Use this to mirror recurring monthly accruals, prepaid amortization, or any standing journal entry. Composite tool — uses existing JE query + add primitives, no new wire request types. Read-only sessions reject with statusCode 9001 (the JournalEntryAddRq half is gated). Source JE not found returns statusCode 500.",
    {
      sourceTxnId: z.string().describe("TxnID of the journal entry to duplicate"),
      txnDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Date for the new journal entry (YYYY-MM-DD). Default: today. The source JE's TxnDate is NOT carried — duplicating to the same date is rarely what you want."),
      refNumber: z.string().optional()
        .describe("Reference/entry number for the new JE. The source JE's RefNumber is NOT carried — duplicates need fresh numbers to avoid collisions. Leave blank to let QB autonumber (when enabled in QB preferences)."),
      memo: z.string().optional()
        .describe("Memo for the new journal entry. Default: 'Duplicate of <source ref or TxnID>'."),
      isAdjustment: z.boolean().optional()
        .describe("Override the adjusting-entry flag. Default: source JE's IsAdjustment value (carried)."),
      idempotencyKey: z.string().min(1).optional()
        .describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original duplicate without creating a second one (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
      dryRun: z.boolean().optional().describe("If true, preview the duplicate journal entry without committing. Pre-flight (source read) runs as normal; the JournalEntryAdd half is previewed via addEntityDryRun against a snapshot that rolls back. See qb_customer_add's dryRun docs for the full composition matrix."),
    },
    async (args) => {
      const session = getSession();

      let matches: Record<string, unknown>[];
      try {
        matches = await session.queryEntity("JournalEntry", {
          TxnID: args.sourceTxnId,
          IncludeLineItems: true,
        });
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "JournalEntryQueryRq (duplicate source read) failed" });
      }

      const source = matches[0];
      if (!source) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 500,
              statusMessage: `Source journal entry "${args.sourceTxnId}" not found`,
              humanReadable: qbStatusCodeMessage(500),
            }),
          }],
          isError: true,
        };
      }

      const jeData: Record<string, unknown> = {};
      if (args.txnDate) jeData.TxnDate = args.txnDate;
      if (args.refNumber) jeData.RefNumber = args.refNumber;

      const sourceLabel = source.RefNumber
        ? String(source.RefNumber)
        : String(source.TxnID ?? args.sourceTxnId);
      jeData.Memo = args.memo ?? `Duplicate of ${sourceLabel}`;

      if (args.isAdjustment !== undefined) {
        jeData.IsAdjustment = args.isAdjustment;
      } else if (source.IsAdjustment !== undefined) {
        jeData.IsAdjustment = source.IsAdjustment;
      }

      // Map JournalDebitLineRet → JournalDebitLineAdd and JournalCreditLineRet
      // → JournalCreditLineAdd. TxnLineID is not carried (new JE gets its
      // own). AccountRef / Amount / Memo / EntityRef / ClassRef pass through.
      // The Ret/Add field shape is identical, so we copy field-for-field
      // rather than rebuild via buildJELineAdd (which would round-trip via
      // accountName/entityName strings and lose AccountRef.ListID if the
      // source carried only a ListID).
      const mapLineRet = (line: Record<string, unknown>): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        if (line.AccountRef) out.AccountRef = line.AccountRef;
        if (line.Amount !== undefined) out.Amount = line.Amount;
        if (line.Memo !== undefined) out.Memo = line.Memo;
        if (line.EntityRef) out.EntityRef = line.EntityRef;
        if (line.ClassRef) out.ClassRef = line.ClassRef;
        return out;
      };

      const sourceDebits = Array.isArray(source.JournalDebitLineRet)
        ? (source.JournalDebitLineRet as Record<string, unknown>[])
        : source.JournalDebitLineRet
          ? [source.JournalDebitLineRet as Record<string, unknown>]
          : [];
      if (sourceDebits.length > 0) {
        jeData.JournalDebitLineAdd = sourceDebits.map(mapLineRet);
      }

      const sourceCredits = Array.isArray(source.JournalCreditLineRet)
        ? (source.JournalCreditLineRet as Record<string, unknown>[])
        : source.JournalCreditLineRet
          ? [source.JournalCreditLineRet as Record<string, unknown>]
          : [];
      if (sourceCredits.length > 0) {
        jeData.JournalCreditLineAdd = sourceCredits.map(mapLineRet);
      }

      if (args.dryRun) {
        try {
          const preview = await session.addEntityDryRun(
            "JournalEntry",
            jeData,
            args.idempotencyKey,
          );
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                sourceTxnId: args.sourceTxnId,
                ...(entity ? { journalEntry: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "JournalEntryAddRq (duplicate) dry-run failed" });
        }
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("JournalEntry", jeData, args.idempotencyKey)
          : { entity: await session.addEntity("JournalEntry", jeData), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              sourceTxnId: args.sourceTxnId,
              journalEntry: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "JournalEntryAddRq (duplicate) failed" });
      }
    }
  );

  server.tool(
    "qb_journal_entry_delete",
    "Delete a journal entry from QuickBooks Desktop. JEs aren't tracked against AR/AP balances in this server, so there's no balance reversal — this is purely a record removal. WARNING: Irreversible. Pass `dryRun: true` to preview without committing.",
    {
      txnId: z.string().describe("TxnID of the JE to delete"),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_invoice_delete's dryRun docs for the full composition matrix."),
    },
    async ({ txnId, dryRun }) => {
      const session = getSession();
      if (dryRun) {
        try {
          const preview = await session.deleteEntityDryRun("JournalEntry", txnId);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { deleted: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "TxnDelRq (JournalEntry) dry-run failed" });
        }
      }

      try {
        const result = await session.deleteEntity("JournalEntry", txnId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TxnDelRq (JournalEntry) failed" });
      }
    }
  );
}
