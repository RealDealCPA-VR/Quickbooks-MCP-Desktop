// Phase 12 #59 — attachments (AttachableAdd / AttachableQuery / AttachableDel).
//
// Coverage layers:
//   1. Sim handler — handleAttachableAdd validates FileReference.FullPath
//      exists on disk, validates ObjectRef target exists across stores,
//      derives FileName / FileSize / FileExtension, propagates Note +
//      ShowAsImage, defaults AttachmentType to "Normal".
//   2. ObjectFilter — handleQuery filters Attachables by ObjectRef.TxnID
//      / ObjectRef.ListID via the new ObjectFilter path.
//   3. Tool surface — qb_attachment_add mutual-exclusivity on txnId/listId,
//      absolute-path enforcement, idempotency replay, read-only gate
//      compose, error wrapping. qb_attachment_list happy paths + mutual-
//      exclusivity. qb_attachment_delete happy path + 500 on unknown ID +
//      read-only gate.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QBSessionManager } from "../src/session/manager.js";
import { registerAttachmentTools } from "../src/tools/attachments.js";

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let session: QBSessionManager;
let handlers: Map<string, Handler>;
let tmpDir: string;
let pdfPath: string;
let pngPath: string;

beforeEach(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-attachments",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  handlers = new Map();
  const fakeServer = {
    tool: (
      name: string,
      _description: string,
      _schema: Record<string, z.ZodTypeAny>,
      handler: Handler,
    ) => {
      handlers.set(name, handler);
    },
  };
  registerAttachmentTools(fakeServer as never, () => session);
  await session.openSession();

  // Create a temp directory + two stub files for attachment tests.
  // mkdtempSync ensures a unique dir per test run so parallel tests don't
  // collide on file names.
  tmpDir = mkdtempSync(join(tmpdir(), "qb-mcp-attach-"));
  pdfPath = join(tmpDir, "receipt.pdf");
  pngPath = join(tmpDir, "deposit-slip.png");
  writeFileSync(pdfPath, "%PDF-1.4 stub content\n");
  writeFileSync(pngPath, "\x89PNG\r\n\x1a\nstub-png-content");
});

afterEach(() => {
  // Best-effort cleanup. Tests may have removed individual files via
  // qb_attachment_delete; ignore ENOENT.
  try { unlinkSync(pdfPath); } catch { /* ignore */ }
  try { unlinkSync(pngPath); } catch { /* ignore */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Layer 1 — Sim handler via session.addEntity("Attachable", ...)
// ---------------------------------------------------------------------------

describe("simulation: handleAttachableAdd", () => {
  it("happy path against an Invoice — derives FileName / FileSize / FileExtension", async () => {
    // Seed an invoice to attach to.
    const invoice = await session.addEntity("Invoice", {
      CustomerRef: { ListID: "80000001-1234567890", FullName: "Acme Corporation" },
      TxnDate: "2024-05-01",
      InvoiceLineAdd: [{ Desc: "Service", Amount: 1000 }],
    });

    const result = await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { TxnID: invoice.TxnID },
      Note: "Vendor receipt",
      ShowAsImage: false,
    });

    expect(result.ListID).toBeDefined();
    expect(result.EditSequence).toBeDefined();
    expect(result.FileName).toBe("receipt.pdf");
    expect(result.FileExtension).toBe("pdf");
    expect(result.FileSize).toBeGreaterThan(0);
    expect(result.Note).toBe("Vendor receipt");
    expect(result.ShowAsImage).toBe(false);
    expect(result.AttachmentType).toBe("Normal"); // defaulted

    const objRef = result.ObjectRef as Record<string, unknown>;
    expect(objRef.TxnID).toBe(invoice.TxnID);
    expect(objRef.ObjectType).toBe("Invoice");
  });

  it("happy path against a Customer (ListID-form ObjectRef)", async () => {
    const result = await session.addEntity("Attachable", {
      FileReference: { FullPath: pngPath },
      ObjectRef: { ListID: "80000001-1234567890" }, // Acme — seeded
      ShowAsImage: true,
    });

    expect(result.FileName).toBe("deposit-slip.png");
    expect(result.FileExtension).toBe("png");
    expect(result.ShowAsImage).toBe(true);

    const objRef = result.ObjectRef as Record<string, unknown>;
    expect(objRef.ListID).toBe("80000001-1234567890");
    expect(objRef.ObjectType).toBe("Customer");
    expect(objRef.FullName).toBe("Acme Corporation");
  });

  it("rejects with 500 when FileReference.FullPath doesn't exist on disk", async () => {
    await expect(
      session.addEntity("Attachable", {
        FileReference: { FullPath: join(tmpDir, "nonexistent.pdf") },
        ObjectRef: { ListID: "80000001-1234567890" },
      })
    ).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("file not found"),
    });
  });

  it("rejects with 3120 when FileReference is missing", async () => {
    await expect(
      session.addEntity("Attachable", {
        ObjectRef: { ListID: "80000001-1234567890" },
      })
    ).rejects.toMatchObject({
      statusCode: 3120,
      message: expect.stringContaining("FileReference.FullPath"),
    });
  });

  it("rejects with 3120 when ObjectRef is missing", async () => {
    await expect(
      session.addEntity("Attachable", {
        FileReference: { FullPath: pdfPath },
      })
    ).rejects.toMatchObject({
      statusCode: 3120,
      message: expect.stringContaining("ObjectRef"),
    });
  });

  it("rejects with 3120 when ObjectRef has neither TxnID nor ListID", async () => {
    await expect(
      session.addEntity("Attachable", {
        FileReference: { FullPath: pdfPath },
        ObjectRef: { FullName: "should be TxnID or ListID" },
      })
    ).rejects.toMatchObject({
      statusCode: 3120,
      message: expect.stringContaining("exactly one of TxnID or ListID"),
    });
  });

  it("rejects with 500 when ObjectRef target doesn't exist in any store", async () => {
    await expect(
      session.addEntity("Attachable", {
        FileReference: { FullPath: pdfPath },
        ObjectRef: { TxnID: "DOES-NOT-EXIST" },
      })
    ).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("not found in any QuickBooks store"),
    });
  });

  it("happy path against a Bill (TxnID form)", async () => {
    const bill = await session.addEntity("Bill", {
      VendorRef: { ListID: "80000010-1234567890" }, // Office Supplies — seeded
      TxnDate: "2024-04-15",
      ExpenseLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 500 }],
    });

    const result = await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { TxnID: bill.TxnID },
    });

    const objRef = result.ObjectRef as Record<string, unknown>;
    expect(objRef.ObjectType).toBe("Bill");
    expect(objRef.TxnID).toBe(bill.TxnID);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — ObjectFilter via session.queryEntity
// ---------------------------------------------------------------------------

describe("simulation: AttachableQueryRq with ObjectFilter", () => {
  it("filters by ObjectRef.TxnID", async () => {
    // Seed two invoices, attach one file each, then verify ObjectFilter
    // returns only the matching attachable.
    const invoice1 = await session.addEntity("Invoice", {
      CustomerRef: { ListID: "80000001-1234567890" },
      TxnDate: "2024-05-01",
      InvoiceLineAdd: [{ Desc: "Service A", Amount: 100 }],
    });
    const invoice2 = await session.addEntity("Invoice", {
      CustomerRef: { ListID: "80000002-1234567890" },
      TxnDate: "2024-05-02",
      InvoiceLineAdd: [{ Desc: "Service B", Amount: 200 }],
    });

    await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { TxnID: invoice1.TxnID },
    });
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pngPath },
      ObjectRef: { TxnID: invoice2.TxnID },
    });

    const filtered = await session.queryEntity("Attachable", {
      ObjectFilter: { TxnID: invoice1.TxnID },
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0].FileName).toBe("receipt.pdf");
    const ref = filtered[0].ObjectRef as Record<string, unknown>;
    expect(ref.TxnID).toBe(invoice1.TxnID);
  });

  it("filters by ObjectRef.ListID", async () => {
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { ListID: "80000001-1234567890" }, // Acme
    });
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pngPath },
      ObjectRef: { ListID: "80000002-1234567890" }, // Global Industries
    });

    const filtered = await session.queryEntity("Attachable", {
      ObjectFilter: { ListID: "80000001-1234567890" },
    });
    expect(filtered.length).toBe(1);
    const ref = filtered[0].ObjectRef as Record<string, unknown>;
    expect(ref.ListID).toBe("80000001-1234567890");
  });

  it("returns nothing for ObjectFilter that matches no attachments", async () => {
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { ListID: "80000001-1234567890" },
    });

    const filtered = await session.queryEntity("Attachable", {
      ObjectFilter: { TxnID: "SOME-OTHER-TXN" },
    });
    expect(filtered.length).toBe(0);
  });

  it("unfiltered query returns every attachable", async () => {
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { ListID: "80000001-1234567890" },
    });
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pngPath },
      ObjectRef: { ListID: "80000002-1234567890" },
    });

    const all = await session.queryEntity("Attachable", {});
    expect(all.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Delete via session.deleteEntity("Attachable", listID)
// ---------------------------------------------------------------------------

describe("simulation: AttachableDelRq via session.deleteEntity", () => {
  it("removes the attachable from the store on happy path", async () => {
    const created = await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { ListID: "80000001-1234567890" },
    });
    expect((await session.queryEntity("Attachable", {})).length).toBe(1);

    await session.deleteEntity("Attachable", String(created.ListID));
    expect((await session.queryEntity("Attachable", {})).length).toBe(0);
  });

  it("returns 500 for an unknown ListID", async () => {
    await expect(
      session.deleteEntity("Attachable", "DOES-NOT-EXIST")
    ).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — Tool surface: qb_attachment_add
// ---------------------------------------------------------------------------

describe("qb_attachment_add tool", () => {
  it("happy path with txnId returns the synthesized Attachable", async () => {
    const invoice = await session.addEntity("Invoice", {
      CustomerRef: { ListID: "80000001-1234567890" },
      TxnDate: "2024-05-01",
      InvoiceLineAdd: [{ Desc: "Service", Amount: 100 }],
    });

    const handler = handlers.get("qb_attachment_add")!;
    const result = await handler({
      txnId: invoice.TxnID,
      filePath: pdfPath,
      note: "Vendor receipt for Acme job",
      showAsImage: false,
    });

    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBeFalsy();
    expect(body.success).toBe(true);
    expect(body.attachment.FileName).toBe("receipt.pdf");
    expect(body.attachment.Note).toBe("Vendor receipt for Acme job");
    expect(body.attachment.ObjectRef.TxnID).toBe(invoice.TxnID);
    expect(body.attachment.ObjectRef.ObjectType).toBe("Invoice");
  });

  it("happy path with listId for a Customer", async () => {
    const handler = handlers.get("qb_attachment_add")!;
    const result = await handler({
      listId: "80000001-1234567890",
      filePath: pngPath,
      showAsImage: true,
    });

    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.attachment.ObjectRef.ListID).toBe("80000001-1234567890");
    expect(body.attachment.ObjectRef.ObjectType).toBe("Customer");
    expect(body.attachment.ShowAsImage).toBe(true);
  });

  it("rejects with 3120 when both txnId and listId are supplied", async () => {
    const handler = handlers.get("qb_attachment_add")!;
    const result = await handler({
      txnId: "T-1",
      listId: "L-1",
      filePath: pdfPath,
    });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(3120);
    expect(body.statusMessage).toContain("Pass exactly one");
    expect(body.statusMessage).toContain("both were supplied");
  });

  it("rejects with 3120 when neither txnId nor listId is supplied", async () => {
    const handler = handlers.get("qb_attachment_add")!;
    const result = await handler({ filePath: pdfPath });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(3120);
    expect(body.statusMessage).toContain("neither was supplied");
  });

  it("rejects relative paths upfront with 3120", async () => {
    const handler = handlers.get("qb_attachment_add")!;
    const result = await handler({
      listId: "80000001-1234567890",
      filePath: "relative/path/file.pdf",
    });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(3120);
    expect(body.statusMessage).toContain("must be an absolute path");
  });

  it("idempotency: same key + same payload returns the original Attachable", async () => {
    const handler = handlers.get("qb_attachment_add")!;
    const args = {
      listId: "80000001-1234567890",
      filePath: pdfPath,
      note: "Idempotent test",
      idempotencyKey: "test-key-001",
    };
    const first = JSON.parse((await handler(args)).content[0].text);
    const second = JSON.parse((await handler(args)).content[0].text);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    expect(second.attachment.ListID).toBe(first.attachment.ListID);
  });

  it("idempotency: same key + different payload returns 9002", async () => {
    const handler = handlers.get("qb_attachment_add")!;
    const firstResult = await handler({
      listId: "80000001-1234567890",
      filePath: pdfPath,
      note: "First",
      idempotencyKey: "test-key-002",
    });
    expect(JSON.parse(firstResult.content[0].text).success).toBe(true);

    const second = await handler({
      listId: "80000001-1234567890",
      filePath: pdfPath,
      note: "DIFFERENT NOTE — collides on the same key",
      idempotencyKey: "test-key-002",
    });
    const body = JSON.parse(second.content[0].text);
    expect(second.isError).toBe(true);
    expect(body.statusCode).toBe(9002);
    expect(body.humanReadable).toContain("Idempotency key conflict");
  });

  it("read-only gate: rejects with 9001 when session is read-only", async () => {
    session.setReadOnly(true);
    const handler = handlers.get("qb_attachment_add")!;
    const result = await handler({
      listId: "80000001-1234567890",
      filePath: pdfPath,
    });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(9001);
    expect(body.humanReadable).toContain("Read-only session");
  });

  it("error wrapping: file-not-found surfaces statusCode 500 + humanReadable", async () => {
    const handler = handlers.get("qb_attachment_add")!;
    const result = await handler({
      listId: "80000001-1234567890",
      filePath: join(tmpDir, "missing.pdf"),
    });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(500);
    expect(body.statusMessage).toContain("file not found");
    expect(body.humanReadable).toBe("Object not found in QuickBooks");
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — Tool surface: qb_attachment_list
// ---------------------------------------------------------------------------

describe("qb_attachment_list tool", () => {
  it("returns all attachments when no filter is supplied", async () => {
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { ListID: "80000001-1234567890" },
    });
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pngPath },
      ObjectRef: { ListID: "80000002-1234567890" },
    });

    const handler = handlers.get("qb_attachment_list")!;
    const result = await handler({});
    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(2);
    expect(body.attachments).toHaveLength(2);
  });

  it("scopes by txnId via ObjectFilter.TxnID", async () => {
    const invoice = await session.addEntity("Invoice", {
      CustomerRef: { ListID: "80000001-1234567890" },
      TxnDate: "2024-05-01",
      InvoiceLineAdd: [{ Desc: "x", Amount: 1 }],
    });
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { TxnID: invoice.TxnID },
    });
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pngPath },
      ObjectRef: { ListID: "80000001-1234567890" },
    });

    const handler = handlers.get("qb_attachment_list")!;
    const result = await handler({ txnId: invoice.TxnID });
    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(1);
    expect(body.attachments[0].FileName).toBe("receipt.pdf");
  });

  it("scopes by targetListId via ObjectFilter.ListID", async () => {
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { ListID: "80000001-1234567890" },
    });
    await session.addEntity("Attachable", {
      FileReference: { FullPath: pngPath },
      ObjectRef: { ListID: "80000002-1234567890" },
    });

    const handler = handlers.get("qb_attachment_list")!;
    const result = await handler({ targetListId: "80000002-1234567890" });
    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(1);
    const ref = body.attachments[0].ObjectRef;
    expect(ref.ListID).toBe("80000002-1234567890");
  });

  it("fetches a single attachment by attachableListId", async () => {
    const created = await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { ListID: "80000001-1234567890" },
    });

    const handler = handlers.get("qb_attachment_list")!;
    const result = await handler({ attachableListId: created.ListID });
    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(1);
    expect(body.attachments[0].ListID).toBe(created.ListID);
  });

  it("rejects with 3120 when multiple filters are supplied", async () => {
    const handler = handlers.get("qb_attachment_list")!;
    const result = await handler({
      txnId: "T-1",
      targetListId: "L-1",
    });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(3120);
    expect(body.statusMessage).toContain("at most one");
  });
});

// ---------------------------------------------------------------------------
// Layer 6 — Tool surface: qb_attachment_delete
// ---------------------------------------------------------------------------

describe("qb_attachment_delete tool", () => {
  it("happy path removes the attachment", async () => {
    const created = await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { ListID: "80000001-1234567890" },
    });

    const handler = handlers.get("qb_attachment_delete")!;
    const result = await handler({ attachableListId: created.ListID });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBeFalsy();
    expect(body.success).toBe(true);
    expect(body.attachableListId).toBe(created.ListID);

    // Verify removal.
    expect((await session.queryEntity("Attachable", {})).length).toBe(0);
  });

  it("returns 500 for an unknown attachableListId", async () => {
    const handler = handlers.get("qb_attachment_delete")!;
    const result = await handler({ attachableListId: "NOT-A-REAL-ID" });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(500);
    expect(body.humanReadable).toBe("Object not found in QuickBooks");
  });

  it("read-only gate: rejects with 9001", async () => {
    const created = await session.addEntity("Attachable", {
      FileReference: { FullPath: pdfPath },
      ObjectRef: { ListID: "80000001-1234567890" },
    });
    session.setReadOnly(true);

    const handler = handlers.get("qb_attachment_delete")!;
    const result = await handler({ attachableListId: created.ListID });
    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.statusCode).toBe(9001);
  });
});
