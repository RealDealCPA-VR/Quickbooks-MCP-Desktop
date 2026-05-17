/**
 * Deposit (banking) management tools for QuickBooks Desktop MCP.
 *
 * Phase 17 #75 — banking primitives. A Deposit records funds arriving in a
 * bank account, typically from one or more customers paying for goods or
 * services. Each Deposit has a single DepositToAccountRef (the bank account
 * where funds land) and N DepositLineAdd lines — each line names an EntityRef
 * (Customer/Vendor/Employee/OtherName) + AccountRef (the income/equity/etc.
 * account the deposit posts against on the GL side) + Amount.
 *
 * Distinct from ReceivePayment: ReceivePayment closes AR (reduces a customer's
 * open invoice balance); a Deposit moves funds from "Undeposited Funds" or a
 * holding account into the bank. The two-step workflow is "Receive Payment"
 * (closes invoice, posts to Undeposited Funds) → "Make Deposit" (moves from
 * Undeposited Funds to Checking). For ad-hoc cash arriving outside AR (e.g.
 * a tax refund, an owner contribution), a Deposit may post directly to an
 * income or equity account.
 *
 * For this server's first cut, the tool exposes the manual-line shape only
 * (EntityRef + AccountRef + Amount + Memo + PaymentMethodRef + ClassRef).
 * The PaymentTxnLineID shape (depositing a previously-received payment from
 * Undeposited Funds via line.PaymentTxnLineID) is rarely useful through an
 * MCP tool because the operator would need to know the line ID; defer until
 * a workflow needs it.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";

const depositLineSchema = z
  .object({
    entityName: z.string().optional()
      .describe("Customer / Vendor / Employee / OtherName full name the deposit line is recorded against (optional — manual deposits often have no entity, e.g. a refund or owner contribution)"),
    entityListId: z.string().optional()
      .describe("Entity ListID (alternative to entityName)"),
    accountName: z.string().optional()
      .describe("GL account full name the line posts against (income, equity, refund liability, etc.)"),
    accountListId: z.string().optional()
      .describe("Account ListID (alternative to accountName)"),
    amount: z.number().describe("Line amount in dollars (positive — funds flowing INTO the deposit-to account)"),
    memo: z.string().optional().describe("Per-line memo"),
    chequeNumber: z.string().optional().describe("Check / reference number on the incoming payment (printed on the deposit slip)"),
    paymentMethodName: z.string().optional().describe("PaymentMethod full name (Cash / Check / Visa / etc.) — discoverable via qb_payment_method_list"),
    className: z.string().optional().describe("Class full name (optional, for class tracking)"),
  })
  .refine((line) => Boolean(line.accountName || line.accountListId), {
    message: "Each deposit line requires accountName or accountListId",
  });

const depositLineModSchema = z
  .object({
    txnLineID: z.string().optional()
      .describe("TxnLineID of the existing line to modify; omit (or pass '-1') to add a new line"),
    entityName: z.string().optional(),
    entityListId: z.string().optional(),
    accountName: z.string().optional(),
    accountListId: z.string().optional(),
    amount: z.number().optional(),
    memo: z.string().optional(),
    chequeNumber: z.string().optional(),
    paymentMethodName: z.string().optional(),
    className: z.string().optional(),
  })
  .refine(
    (line) => {
      const isNew = !line.txnLineID || line.txnLineID === "-1";
      if (!isNew) return true;
      return Boolean(line.accountName || line.accountListId) && line.amount !== undefined;
    },
    { message: "New deposit lines (no txnLineID) require accountName/accountListId and amount" }
  );

function buildDepositLineAdd(line: z.infer<typeof depositLineSchema>): Record<string, unknown> {
  const lineData: Record<string, unknown> = {};
  if (line.entityListId) {
    lineData.EntityRef = { ListID: line.entityListId };
  } else if (line.entityName) {
    lineData.EntityRef = { FullName: line.entityName };
  }
  if (line.accountListId) {
    lineData.AccountRef = { ListID: line.accountListId };
  } else {
    lineData.AccountRef = { FullName: line.accountName };
  }
  lineData.Amount = line.amount;
  if (line.memo) lineData.Memo = line.memo;
  if (line.chequeNumber) lineData.CheckNumber = line.chequeNumber;
  if (line.paymentMethodName) lineData.PaymentMethodRef = { FullName: line.paymentMethodName };
  if (line.className) lineData.ClassRef = { FullName: line.className };
  return lineData;
}

export function registerDepositTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  server.tool(
    "qb_deposit_list",
    "List or search bank deposits (Deposit transactions) in QuickBooks Desktop. Each Deposit moves funds INTO a bank account (the DepositToAccountRef) from one or more sources (DepositLineRet). Set paginate:true for iterator-based pagination (real QB caps each *QueryRq response at ~500 rows) — maxReturned defaults to 500 when paginate is enabled. By default each row carries header totals only; pass includeLineItems:true to also surface DepositLineRet. Filter by TxnID, date range, or memo refNumber.",
    {
      txnId: z.string().optional().describe("Fetch a specific deposit by TxnID"),
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start date filter (YYYY-MM-DD)"),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End date filter (YYYY-MM-DD)"),
      includeLineItems: z.boolean().optional().describe("When true, each deposit row carries its DepositLineRet array. Default false — header totals only, matching real QB's *QueryRq default behavior."),
      maxReturned: z.number().optional().describe("Maximum results. Defaults to 500 when paginate is enabled (QB's per-batch cap); otherwise QB-driven."),
      paginate: z.boolean().optional().describe("Enable iterator-based pagination. Response surfaces iteratorRemainingCount + iteratorID. Auto-defaults maxReturned to 500 if unset."),
      iteratorID: z.string().optional().describe("Continue an existing iterator by passing the iteratorID from a prior paginated response. Implies paginate."),
    },
    async (args) => {
      const session = getSession();
      const filters: Record<string, unknown> = {};

      const effectiveMaxReturned =
        args.maxReturned ?? (args.paginate || args.iteratorID ? 500 : undefined);

      if (args.txnId) filters.TxnID = args.txnId;
      if (effectiveMaxReturned) filters.MaxReturned = effectiveMaxReturned;
      if (args.fromDate || args.toDate) {
        filters.TxnDateRangeFilter = { FromTxnDate: args.fromDate, ToTxnDate: args.toDate };
      }
      if (args.includeLineItems) filters.IncludeLineItems = true;

      try {
        if (args.paginate || args.iteratorID) {
          const result = await session.queryEntityPaginated("Deposit", filters, {
            iterator: args.iteratorID ? "Continue" : "Start",
            iteratorID: args.iteratorID,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                count: result.entities.length,
                deposits: result.entities,
                ...(result.iteratorRemainingCount !== undefined
                  ? { iteratorRemainingCount: result.iteratorRemainingCount }
                  : {}),
                ...(result.iteratorID !== undefined
                  ? { iteratorID: result.iteratorID }
                  : {}),
              }, null, 2),
            }],
          };
        }

        const deposits = await session.queryEntity("Deposit", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: deposits.length, deposits }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "DepositQueryRq failed" });
      }
    }
  );

  server.tool(
    "qb_deposit_create",
    "Create a new bank deposit in QuickBooks Desktop. Records funds arriving in depositToAccount (a Bank account by FullName or ListID) from one or more sources (lines). Each line names the income / equity / refund-liability account that funds came from + the Amount. At least one line is required. Use qb_payment_method_list to discover valid paymentMethodName values. The deposit posts NotCleared by default (ClearedStatus flips to Cleared via the qb_cleared_status_update reconciliation flow). Read-only sessions reject with statusCode 9001.",
    {
      depositToAccountName: z.string().optional().describe("Bank account full name where the funds land (e.g. 'Checking')"),
      depositToAccountListId: z.string().optional().describe("Bank account ListID (alternative to depositToAccountName)"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("Deposit date (YYYY-MM-DD). Default: today (when omitted, QB uses today)."),
      memo: z.string().optional().describe("Memo on the deposit (printed at top of deposit slip)"),
      lines: z.array(depositLineSchema).min(1).describe("Deposit lines — each names an AccountRef + Amount, optionally an EntityRef + PaymentMethodRef + CheckNumber. At least one line required."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original result without creating a duplicate deposit (response carries idempotentReplay: true). Same key + different payload returns statusCode 9002. Cache is per company file and clears on qb_company_open."),
    },
    async (args) => {
      const session = getSession();

      if (!args.depositToAccountName && !args.depositToAccountListId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Either depositToAccountName or depositToAccountListId is required",
            }),
          }],
          isError: true,
        };
      }

      const data: Record<string, unknown> = {};
      if (args.depositToAccountListId) {
        data.DepositToAccountRef = { ListID: args.depositToAccountListId };
      } else {
        data.DepositToAccountRef = { FullName: args.depositToAccountName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.memo) data.Memo = args.memo;
      data.DepositLineAdd = args.lines.map(buildDepositLineAdd);

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Deposit", data, args.idempotencyKey)
          : { entity: await session.addEntity("Deposit", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              deposit: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "DepositAddRq failed" });
      }
    }
  );

  server.tool(
    "qb_deposit_update",
    "Modify an existing deposit in QuickBooks Desktop. Pass txnId + editSequence (from a prior qb_deposit_list) plus any header fields and/or a replacement lines array. When lines is provided it REPLACES the deposit's existing line set wholesale — list every line you want the deposit to keep. A line with a txnLineID matching an existing line preserves that TxnLineID and merges any fields you pass; a line without txnLineID (or with '-1') is added as new. DepositTotal recomputes from the post-mod line sum. A stale editSequence rejects with statusCode 3170.",
    {
      txnId: z.string().describe("TxnID of the deposit to update"),
      editSequence: z.string().describe("EditSequence from a prior query — must match the stored value or the mod is rejected with statusCode 3170"),
      depositToAccountName: z.string().optional().describe("New deposit-to bank account full name"),
      depositToAccountListId: z.string().optional().describe("New deposit-to bank account ListID"),
      txnDate: z.string().regex(ISO_DATE_RE).optional().describe("New deposit date (YYYY-MM-DD)"),
      memo: z.string().optional().describe("New memo"),
      lines: z.array(depositLineModSchema).optional()
        .describe("Replacement deposit-line set. Existing lines whose TxnLineID is not listed will be dropped."),
    },
    async (args) => {
      const session = getSession();

      const data: Record<string, unknown> = {
        TxnID: args.txnId,
        EditSequence: args.editSequence,
      };

      if (args.depositToAccountListId) {
        data.DepositToAccountRef = { ListID: args.depositToAccountListId };
      } else if (args.depositToAccountName) {
        data.DepositToAccountRef = { FullName: args.depositToAccountName };
      }
      if (args.txnDate) data.TxnDate = args.txnDate;
      if (args.memo) data.Memo = args.memo;

      if (args.lines) {
        data.DepositLineMod = args.lines.map((line) => {
          const lineData: Record<string, unknown> = {};
          if (line.txnLineID) lineData.TxnLineID = line.txnLineID;
          if (line.entityListId) {
            lineData.EntityRef = { ListID: line.entityListId };
          } else if (line.entityName) {
            lineData.EntityRef = { FullName: line.entityName };
          }
          if (line.accountListId) {
            lineData.AccountRef = { ListID: line.accountListId };
          } else if (line.accountName) {
            lineData.AccountRef = { FullName: line.accountName };
          }
          if (line.amount !== undefined) lineData.Amount = line.amount;
          if (line.memo) lineData.Memo = line.memo;
          if (line.chequeNumber) lineData.CheckNumber = line.chequeNumber;
          if (line.paymentMethodName) lineData.PaymentMethodRef = { FullName: line.paymentMethodName };
          if (line.className) lineData.ClassRef = { FullName: line.className };
          return lineData;
        });
      }

      try {
        const result = await session.modifyEntity("Deposit", data);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deposit: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "DepositModRq failed" });
      }
    }
  );

  server.tool(
    "qb_deposit_delete",
    "Delete a deposit from QuickBooks Desktop. WARNING: Irreversible. If the deposit included payment lines that closed AR invoices (PaymentTxnLineID), real QB un-deposits those funds back to Undeposited Funds — sim does not currently model that path.",
    {
      txnId: z.string().describe("TxnID of the deposit to delete"),
    },
    async ({ txnId }) => {
      const session = getSession();
      try {
        const result = await session.deleteEntity("Deposit", txnId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, deleted: result }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "TxnDelRq (Deposit) failed" });
      }
    }
  );
}
