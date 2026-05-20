/**
 * Attachment management tools for QuickBooks Desktop MCP (Phase 12 #59).
 *
 * Surfaces qb_attachment_add / _list / _delete for QuickBooks' "Attached
 * Documents" feature — attaches local files (vendor receipts, deposit
 * slips, signed invoices, etc.) to existing transactions or list entities
 * for audit-trail use cases.
 *
 * Wire surface: AttachableAddRq / AttachableQueryRq / ListDelRq with
 * ListDelType="Attachable". Each Attachable carries:
 *   - Its OWN ListID + EditSequence (the Attachable record itself)
 *   - FileName / FileSize / FileExtension (derived from disk in sim;
 *     supplied by QB after the file copy in live mode)
 *   - ObjectRef pointing at the target entity (TxnID for transactions,
 *     ListID for list entities like Customer/Vendor/Item)
 *   - Optional Note + ShowAsImage flag
 *
 * File copy semantics (live mode):
 *   QBXMLRP2 doesn't transfer file BYTES — the AttachableAdd request
 *   passes a path string and QB Desktop reads the file from disk during
 *   ProcessRequest. The file MUST be readable by the QB Desktop process
 *   (i.e. on the same machine, with appropriate permissions). For the
 *   typical localQBD deployment this is a non-issue; for hypothetical
 *   remote-mode setups the file would need to be UNC-accessible.
 *
 * QB Desktop also stores attachments in its "Attached Documents" folder
 * (typically a sibling of the .qbw file). Attached Documents is a
 * subscription feature in some editions; if the operator's edition
 * doesn't support it, AttachableAdd will fail at the wire layer with a
 * QB-side error — surfaces through the existing tool error wrapper.
 *
 * Sim mode:
 *   Validates the file path exists via fs.statSync, derives metadata,
 *   verifies the ObjectRef target exists in some store (walks every
 *   non-Attachable store looking for the TxnID/ListID). No actual file
 *   copy — sim is for testing tool wiring, not for testing QB's file
 *   storage.
 *
 * Read-only gate (Phase 10 #42): qb_attachment_add and qb_attachment_delete
 * are mutations and inherit the assertWritable gate at the session
 * manager. qb_attachment_list is a read and ungated.
 *
 * Idempotency (Phase 10 #47): qb_attachment_add accepts an optional
 * idempotencyKey via session.addEntityIdempotent. Replaying the same key
 * with the same payload returns the original Attachable's ListID
 * (carrying idempotentReplay: true); same key + different payload
 * returns 9002.
 */

import { z } from "zod";
import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { formatToolError } from "../util/format-tool-error.js";
export function registerAttachmentTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  // -----------------------------------------------------------------------
  // Add attachment
  // -----------------------------------------------------------------------
  server.tool(
    "qb_attachment_add",
    "Attach a local file to an existing QuickBooks transaction or list entity (vendor bill receipt, deposit slip, signed invoice, customer W-9). Wraps AttachableAddRq. Pass exactly one of txnId (for transactions) or listId (for list entities — Customer / Vendor / Item / etc.) plus an absolute filePath. The file must exist on disk and be readable by the QB Desktop process; QB copies it into its 'Attached Documents' folder during the wire call (live mode). Sim mode validates the path + ObjectRef target, derives FileName / FileSize / FileExtension from disk, but does not copy any bytes. Optional note (description shown in QB's attachment UI) and showAsImage:true (display inline preview vs default icon — appropriate for image / PDF attachments). Returns the new Attachable's ListID + the derived metadata. Read-only sessions reject with 9001. Subject to QB's edition-level support for the Attached Documents feature — wire failures surface with the original QB statusCode + humanReadable.",
    {
      txnId: z.string().optional().describe("Target transaction's TxnID (for Invoice / Bill / Check / Deposit / etc.). Mutually exclusive with listId — pass exactly one."),
      listId: z.string().optional().describe("Target list entity's ListID (for Customer / Vendor / Item / Employee / etc.). Mutually exclusive with txnId."),
      filePath: z.string().min(1).describe("Absolute path to the source file on the QB Desktop host's disk. Sim mode validates the path exists via fs.statSync; live mode passes the path to QB which reads + copies it during the wire call. Relative paths are rejected — a relative path resolved against the QB process's CWD is rarely what the operator intended."),
      note: z.string().optional().describe("Optional description shown in QB's attachment UI. Defaults to no note."),
      showAsImage: z.boolean().optional().describe("When true, QB displays the attachment inline (image/PDF preview). When false (default), displays as a clickable icon. Set true for image attachments where the operator wants to see thumbnails in the txn detail view."),
      attachmentType: z.string().optional().describe("Optional AttachmentType enum (Normal | ...). Defaults to 'Normal' which fits PDFs / images / documents. Other values are SDK-version-dependent — most operators don't need to set this."),
      idempotencyKey: z.string().min(1).optional().describe("Optional client-supplied idempotency key. Retrying with the same key + same payload returns the original Attachable without creating a duplicate (response carries idempotentReplay: true). Same key + different payload returns 9002."),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_customer_add's dryRun docs for the full composition matrix."),
    },
    async (args) => {
      const session = getSession();

      // Mutually-exclusive txnId / listId enforcement. Surfaced as 3120
      // (required field missing/invalid) to match QB's wire-side response
      // for the same shape error.
      const haveTxn = !!args.txnId;
      const haveList = !!args.listId;
      if (haveTxn === haveList) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: haveTxn
                ? "Pass exactly one of txnId or listId — both were supplied"
                : "Pass exactly one of txnId or listId — neither was supplied",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      // Reject relative paths upfront. A relative path silently resolves
      // against the QB Desktop process's CWD (which the operator can't
      // predict and is almost never what they meant). This produces a
      // clearer error than letting fs.statSync resolve it to whichever
      // file happens to be in the QB process's working directory.
      if (!isAbsolute(args.filePath)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: `filePath must be an absolute path (got: '${args.filePath}'). Relative paths resolve against the QB Desktop process's working directory which is rarely what's intended.`,
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      const data: Record<string, unknown> = {
        FileReference: { FullPath: args.filePath },
        ObjectRef: haveTxn
          ? { TxnID: args.txnId }
          : { ListID: args.listId },
      };
      if (args.note) data.Note = args.note;
      if (args.attachmentType) data.AttachmentType = args.attachmentType;
      if (args.showAsImage !== undefined) data.ShowAsImage = args.showAsImage;

      if (args.dryRun) {
        try {
          const preview = await session.addEntityDryRun("Attachable", data, args.idempotencyKey);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                ...rest,
                ...(entity ? { attachment: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "AttachableAddRq dry-run failed" });
        }
      }

      try {
        const { entity: result, replayed } = args.idempotencyKey
          ? await session.addEntityIdempotent("Attachable", data, args.idempotencyKey)
          : { entity: await session.addEntity("Attachable", data), replayed: false };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...(replayed ? { idempotentReplay: true } : {}),
              attachment: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "AttachableAddRq failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // List attachments
  // -----------------------------------------------------------------------
  server.tool(
    "qb_attachment_list",
    "List attachments stored in QuickBooks. Wraps AttachableQueryRq. Three filter modes: (1) txnId — every attachment whose ObjectRef points at the named transaction; (2) targetListId — every attachment whose ObjectRef points at the named list entity (Customer / Vendor / etc.); (3) attachableListId — fetch a single attachment by its OWN ListID (the ID returned from qb_attachment_add). Pass at most one. Returns the count + array of AttachableRet records (each carries FileName / FileSize / FileExtension / Note / ShowAsImage / ObjectRef / TimeCreated / TimeModified). Note: this lists attachment METADATA only — actual file bytes live in QB's Attached Documents folder and are not surfaced through the SDK.",
    {
      txnId: z.string().optional().describe("Filter by ObjectRef.TxnID — every attachment on the named transaction."),
      targetListId: z.string().optional().describe("Filter by ObjectRef.ListID — every attachment on the named list entity."),
      attachableListId: z.string().optional().describe("Fetch a single attachment by its own ListID (the ID returned from qb_attachment_add)."),
      maxReturned: z.number().int().positive().optional().describe("Cap the number of returned rows. Defaults to QB's per-batch limit when unset."),
    },
    async (args) => {
      const session = getSession();

      // Filters are pairwise-exclusive. Two or more set is almost always a
      // caller bug (different filters narrow vs combine in confusing ways).
      const filterCount =
        (args.txnId ? 1 : 0) +
        (args.targetListId ? 1 : 0) +
        (args.attachableListId ? 1 : 0);
      if (filterCount > 1) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: 3120,
              statusMessage: "Pass at most one of txnId, targetListId, attachableListId — multiple filters are not supported",
              humanReadable: qbStatusCodeMessage(3120),
            }),
          }],
          isError: true,
        };
      }

      const filters: Record<string, unknown> = {};
      if (args.attachableListId) {
        filters.ListID = args.attachableListId;
      } else if (args.txnId) {
        filters.ObjectFilter = { TxnID: args.txnId };
      } else if (args.targetListId) {
        filters.ObjectFilter = { ListID: args.targetListId };
      }
      if (args.maxReturned) filters.MaxReturned = args.maxReturned;

      try {
        const attachments = await session.queryEntity("Attachable", filters);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: attachments.length,
              attachments,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "AttachableQueryRq failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // Delete attachment
  // -----------------------------------------------------------------------
  server.tool(
    "qb_attachment_delete",
    "Delete an attachment by its own ListID. Wraps ListDelRq with ListDelType='Attachable'. The file in QB's Attached Documents folder is also removed by real QB (sim mode just removes the metadata record). Use qb_attachment_list to find the attachableListId before deleting. Read-only sessions reject with statusCode 9001. Unknown attachableListId returns statusCode 500. Pass `dryRun: true` to preview without committing.",
    {
      attachableListId: z.string().min(1).describe("ListID of the Attachable record to delete (the ID returned from qb_attachment_add or qb_attachment_list)."),
      dryRun: z.boolean().optional().describe("If true, preview what this call WOULD do without committing. See qb_invoice_delete's dryRun docs for the full composition matrix."),
    },
    async ({ attachableListId, dryRun }) => {
      const session = getSession();
      if (dryRun) {
        try {
          const preview = await session.deleteEntityDryRun("Attachable", attachableListId);
          const { entity, ...rest } = preview;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                dryRun: true,
                attachableListId,
                ...rest,
                ...(entity ? { deleted: entity } : {}),
              }, null, 2),
            }],
          };
        } catch (err) {
          return formatToolError(err, { fallbackMessage: "AttachableDelRq dry-run failed" });
        }
      }

      try {
        const result = await session.deleteEntity("Attachable", attachableListId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              attachableListId,
              result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "AttachableDelRq failed" });
      }
    }
  );
}
