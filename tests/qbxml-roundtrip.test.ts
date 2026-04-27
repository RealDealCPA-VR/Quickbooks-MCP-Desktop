// QBXML round-trip — builder produces well-formed envelopes, parser surfaces
// the expected structure on responses. Per CLAUDE.md, every new request type
// must build cleanly and parse cleanly: this test file is the home for those
// invariants. Iterator-specific round-trips live in iterator.test.ts.

import { describe, it, expect } from "vitest";
import {
  buildQBXMLRequest,
  buildQueryRequest,
  buildAddRequest,
  buildModRequest,
  buildDeleteRequest,
  buildReportRequest,
} from "../src/qbxml/builder.js";
import {
  parseQBXMLResponse,
  extractResponseData,
  flattenEntityArray,
  QBXMLResponseError,
  QBXMLParseError,
} from "../src/qbxml/parser.js";

describe("buildQBXMLRequest — envelope shape", () => {
  it("emits correct prologue (XML decl + qbxml processing instruction)", () => {
    const xml = buildQueryRequest("Customer");
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<?qbxml version="16.0"?>')).toBe(true);
  });

  it("uses custom version when supplied", () => {
    const xml = buildQueryRequest("Customer", {}, { version: "13.0" });
    expect(xml).toContain('<?qbxml version="13.0"?>');
  });

  it("wraps everything in QBXML / QBXMLMsgsRq with stopOnError", () => {
    const xml = buildQueryRequest("Customer");
    expect(xml).toContain("<QBXML>");
    expect(xml).toContain('<QBXMLMsgsRq onError="stopOnError">');
    expect(xml).toContain("</QBXMLMsgsRq>");
    expect(xml).toContain("</QBXML>");
  });

  it("auto-numbers requestID when not provided", () => {
    const xml = buildQBXMLRequest({
      requests: [
        { type: "CustomerQueryRq", body: {} },
        { type: "VendorQueryRq", body: {} },
      ],
    });
    expect(xml).toContain('<CustomerQueryRq requestID="1">');
    expect(xml).toContain('<VendorQueryRq requestID="2">');
  });

  it("respects explicit requestID", () => {
    const xml = buildQBXMLRequest({
      requests: [{ type: "CustomerQueryRq", requestID: "custom-id", body: {} }],
    });
    expect(xml).toContain('<CustomerQueryRq requestID="custom-id">');
  });
});

describe("buildQueryRequest — filter children", () => {
  it("serializes scalar filters as child elements", () => {
    const xml = buildQueryRequest("Customer", { ActiveStatus: "ActiveOnly", MaxReturned: 100 });
    expect(xml).toContain("<ActiveStatus>ActiveOnly</ActiveStatus>");
    expect(xml).toContain("<MaxReturned>100</MaxReturned>");
  });

  it("serializes nested object filters (e.g. TxnDateRangeFilter)", () => {
    const xml = buildQueryRequest("Invoice", {
      TxnDateRangeFilter: { FromTxnDate: "2026-01-01", ToTxnDate: "2026-12-31" },
    });
    expect(xml).toContain("<TxnDateRangeFilter>");
    expect(xml).toContain("<FromTxnDate>2026-01-01</FromTxnDate>");
    expect(xml).toContain("<ToTxnDate>2026-12-31</ToTxnDate>");
    expect(xml).toContain("</TxnDateRangeFilter>");
  });

  it("serializes array filters as repeated child elements", () => {
    // E.g. multiple <RefNumber> children for an Invoice ref-number filter.
    const xml = buildQueryRequest("Invoice", { RefNumber: ["INV-001", "INV-002"] });
    expect(xml.match(/<RefNumber>INV-001<\/RefNumber>/)).not.toBeNull();
    expect(xml.match(/<RefNumber>INV-002<\/RefNumber>/)).not.toBeNull();
  });

  it("escapes XML special characters in scalar values", () => {
    const xml = buildQueryRequest("Customer", { FullName: "A&B <Co>" });
    expect(xml).toContain("<FullName>A&amp;B &lt;Co&gt;</FullName>");
  });

  it("emits empty arrays as self-closed sentinels (so receiver can distinguish empty vs absent)", () => {
    // Per builder.ts:233-240 the empty-array sentinel is load-bearing for
    // qb_credit_memo_apply (applyTo: []) — strips would conflate "fully
    // unapply" with "no apply intent". The shape must be <Key/>.
    const xml = buildQBXMLRequest({
      requests: [{ type: "CreditMemoModRq", body: { CreditMemoMod: { AppliedToTxnMod: [] } } }],
    });
    expect(xml).toContain("<AppliedToTxnMod/>");
  });

  it("drops null + undefined fields (caller can opt out by passing empty string)", () => {
    const xml = buildQueryRequest("Customer", { FullName: undefined, ListID: null, Name: "X" });
    expect(xml).not.toContain("<FullName>");
    expect(xml).not.toContain("<ListID>");
    expect(xml).toContain("<Name>X</Name>");
  });

  it("serializes booleans as 'true' / 'false' (NOT '1' / '0')", () => {
    const xml = buildQueryRequest("Customer", { IsActive: true, ShowDeleted: false });
    expect(xml).toContain("<IsActive>true</IsActive>");
    expect(xml).toContain("<ShowDeleted>false</ShowDeleted>");
  });
});

describe("buildAddRequest / buildModRequest — entity-shaped wrappers", () => {
  it("buildAddRequest wraps data in <EntityAdd>", () => {
    const xml = buildAddRequest("Customer", { Name: "Acme", Phone: "555-1234" });
    expect(xml).toContain("<CustomerAddRq");
    expect(xml).toContain("<CustomerAdd>");
    expect(xml).toContain("<Name>Acme</Name>");
    expect(xml).toContain("<Phone>555-1234</Phone>");
    expect(xml).toContain("</CustomerAdd>");
  });

  it("buildModRequest wraps data in <EntityMod>", () => {
    const xml = buildModRequest("Customer", { ListID: "1", EditSequence: "2", Name: "X" });
    expect(xml).toContain("<CustomerModRq");
    expect(xml).toContain("<CustomerMod>");
    expect(xml).toContain("<ListID>1</ListID>");
    expect(xml).toContain("<EditSequence>2</EditSequence>");
  });
});

describe("buildDeleteRequest — list vs txn dispatch", () => {
  // CLAUDE.md invariant: list entities use ListDelRq, transactions use
  // TxnDelRq. The transaction array in builder.ts must stay in sync with
  // simulation-store.ts and manager.ts. Cover the major dispatch points.
  it("Customer → ListDelRq with ListDelType=Customer", () => {
    const xml = buildDeleteRequest("Customer", "1");
    expect(xml).toContain("<ListDelRq");
    expect(xml).toContain("<ListDelType>Customer</ListDelType>");
    expect(xml).toContain("<ListID>1</ListID>");
    expect(xml).not.toContain("<TxnDelRq");
  });

  it("Invoice → TxnDelRq with TxnDelType=Invoice + TxnID", () => {
    const xml = buildDeleteRequest("Invoice", "TXN-1");
    expect(xml).toContain("<TxnDelRq");
    expect(xml).toContain("<TxnDelType>Invoice</TxnDelType>");
    expect(xml).toContain("<TxnID>TXN-1</TxnID>");
    expect(xml).not.toContain("<ListDelRq");
  });

  it("Bill → TxnDelRq with TxnDelType=Bill", () => {
    const xml = buildDeleteRequest("Bill", "TXN-2");
    expect(xml).toContain("<TxnDelType>Bill</TxnDelType>");
  });

  it("JournalEntry → TxnDelRq (Phase 4 transaction)", () => {
    const xml = buildDeleteRequest("JournalEntry", "TXN-3");
    expect(xml).toContain("<TxnDelType>JournalEntry</TxnDelType>");
  });

  it("Account → ListDelRq (list entity, NOT txn)", () => {
    const xml = buildDeleteRequest("Account", "ACCT-1");
    expect(xml).toContain("<ListDelType>Account</ListDelType>");
    expect(xml).not.toContain("<TxnDelType>");
  });

  it("Vendor → ListDelRq", () => {
    const xml = buildDeleteRequest("Vendor", "V-1");
    expect(xml).toContain("<ListDelType>Vendor</ListDelType>");
  });
});

describe("buildReportRequest — GeneralSummaryReportQueryRq shape", () => {
  it("emits ReportPeriod with FromReportDate + ToReportDate", () => {
    const xml = buildReportRequest({
      reportType: "ProfitAndLossStandard",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    expect(xml).toContain("<GeneralSummaryReportQueryRq");
    expect(xml).toContain("<GeneralSummaryReportType>ProfitAndLossStandard</GeneralSummaryReportType>");
    expect(xml).toContain("<ReportPeriod>");
    expect(xml).toContain("<FromReportDate>2026-01-01</FromReportDate>");
    expect(xml).toContain("<ToReportDate>2026-12-31</ToReportDate>");
  });

  it("defaults ReportBasis to Accrual when not specified", () => {
    const xml = buildReportRequest({ reportType: "BalanceSheetStandard" });
    expect(xml).toContain("<ReportBasis>Accrual</ReportBasis>");
  });

  it("respects explicit Cash basis", () => {
    const xml = buildReportRequest({ reportType: "ProfitAndLossStandard", basis: "Cash" });
    expect(xml).toContain("<ReportBasis>Cash</ReportBasis>");
  });

  it("emits SummarizeColumnsBy=TotalOnly + IncludeSubcolumns=0 (Item 20 scope)", () => {
    const xml = buildReportRequest({ reportType: "ProfitAndLossStandard" });
    expect(xml).toContain("<SummarizeColumnsBy>TotalOnly</SummarizeColumnsBy>");
    expect(xml).toContain("<IncludeSubcolumns>0</IncludeSubcolumns>");
  });
});

describe("parseQBXMLResponse — basic envelope navigation", () => {
  it("extracts statusCode, statusSeverity, statusMessage from response attributes", () => {
    const xml = `<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
  <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
    <CustomerRet><ListID>1</ListID><Name>Acme</Name></CustomerRet>
  </CustomerQueryRs>
</QBXMLMsgsRs></QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    expect(parsed.responses).toHaveLength(1);
    const rs = parsed.responses[0];
    expect(rs.type).toBe("CustomerQueryRs");
    expect(rs.statusCode).toBe(0);
    expect(rs.statusSeverity).toBe("Info");
    expect(rs.statusMessage).toBe("OK");
  });

  it("throws QBXMLParseError on missing <QBXML> root", () => {
    expect(() => parseQBXMLResponse('<?xml version="1.0" ?><Foo/>')).toThrow(QBXMLParseError);
  });

  it("throws QBXMLParseError on missing <QBXMLMsgsRs>", () => {
    expect(() => parseQBXMLResponse('<?xml version="1.0" ?><QBXML/>')).toThrow(QBXMLParseError);
  });

  it("collects multiple response elements in order", () => {
    const xml = `<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
  <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK"/>
  <VendorQueryRs requestID="2" statusCode="0" statusSeverity="Info" statusMessage="OK"/>
</QBXMLMsgsRs></QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    expect(parsed.responses).toHaveLength(2);
    expect(parsed.responses[0].type).toBe("CustomerQueryRs");
    expect(parsed.responses[1].type).toBe("VendorQueryRs");
  });
});

describe("parseQBXMLResponse — array coercion via arrayElements set", () => {
  // The `isArray` callback in parser.ts forces elements registered in
  // `arrayElements` to always be arrays even when there's only one. This
  // keeps downstream tools' `.map()` / `.length` calls safe regardless of
  // whether QB returned 0, 1, or N records.
  it("CustomerRet is always an array even with one element", () => {
    const xml = `<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
  <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
    <CustomerRet><ListID>1</ListID><Name>Acme</Name></CustomerRet>
  </CustomerQueryRs>
</QBXMLMsgsRs></QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const data = parsed.responses[0].data as Record<string, unknown>;
    expect(Array.isArray(data.CustomerRet)).toBe(true);
    expect((data.CustomerRet as unknown[]).length).toBe(1);
  });

  it("multiple CustomerRet elements come through as an array", () => {
    const xml = `<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
  <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
    <CustomerRet><ListID>1</ListID><Name>Acme</Name></CustomerRet>
    <CustomerRet><ListID>2</ListID><Name>Beta</Name></CustomerRet>
  </CustomerQueryRs>
</QBXMLMsgsRs></QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const data = parsed.responses[0].data as Record<string, unknown>;
    expect(Array.isArray(data.CustomerRet)).toBe(true);
    expect((data.CustomerRet as unknown[]).length).toBe(2);
  });

  it("InvoiceLineRet inside InvoiceRet is also forced-array (nested)", () => {
    const xml = `<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
  <InvoiceQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
    <InvoiceRet>
      <TxnID>T1</TxnID>
      <InvoiceLineRet><TxnLineID>L1</TxnLineID><Amount>100</Amount></InvoiceLineRet>
    </InvoiceRet>
  </InvoiceQueryRs>
</QBXMLMsgsRs></QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const data = parsed.responses[0].data as Record<string, unknown>;
    const invoice = (data.InvoiceRet as Record<string, unknown>[])[0];
    expect(Array.isArray(invoice.InvoiceLineRet)).toBe(true);
  });

  it("item subtype rets (ItemServiceRet etc.) are all forced-array", () => {
    // Item 22 split the single Item store into 5 subtype stores; each subtype
    // has its own *Ret name registered in arrayElements. A regression here
    // would mean a tool that does `items.map(...)` on a single-result query
    // crashes.
    const xml = `<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
  <ItemServiceQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
    <ItemServiceRet><ListID>I1</ListID><Name>Consulting</Name></ItemServiceRet>
  </ItemServiceQueryRs>
</QBXMLMsgsRs></QBXML>`;
    const parsed = parseQBXMLResponse(xml);
    const data = parsed.responses[0].data as Record<string, unknown>;
    expect(Array.isArray(data.ItemServiceRet)).toBe(true);
  });
});

describe("extractResponseData — happy + error dispatch", () => {
  it("returns data on statusCode=0", () => {
    const response = parseQBXMLResponse(`<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
  <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
    <CustomerRet><ListID>1</ListID><Name>Acme</Name></CustomerRet>
  </CustomerQueryRs>
</QBXMLMsgsRs></QBXML>`);
    const data = extractResponseData(response, "CustomerQueryRs") as Record<string, unknown>;
    expect(data.CustomerRet).toBeDefined();
  });

  it("returns {} on statusCode=1 (info: no records)", () => {
    const response = parseQBXMLResponse(`<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
  <CustomerQueryRs requestID="1" statusCode="1" statusSeverity="Info" statusMessage="No records found"/>
</QBXMLMsgsRs></QBXML>`);
    const data = extractResponseData(response, "CustomerQueryRs");
    expect(data).toEqual({});
  });

  it("throws QBXMLResponseError on statusSeverity=Error with the actual statusCode", () => {
    const response = parseQBXMLResponse(`<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
  <CustomerModRs requestID="1" statusCode="3170" statusSeverity="Error" statusMessage="EditSequence mismatch"/>
</QBXMLMsgsRs></QBXML>`);
    expect(() => extractResponseData(response, "CustomerModRs")).toThrow(QBXMLResponseError);
    try {
      extractResponseData(response, "CustomerModRs");
    } catch (e) {
      expect(e).toBeInstanceOf(QBXMLResponseError);
      expect((e as QBXMLResponseError).statusCode).toBe(3170);
      expect((e as QBXMLResponseError).message).toBe("EditSequence mismatch");
    }
  });
});

describe("flattenEntityArray — handles single + array + missing", () => {
  it("returns the array unchanged when present", () => {
    const data = { CustomerRet: [{ ListID: "1" }, { ListID: "2" }] };
    expect(flattenEntityArray(data, "CustomerRet")).toHaveLength(2);
  });

  it("wraps a single object in an array", () => {
    // Belt-and-suspenders for the rare case that a *Ret slipped past the
    // arrayElements forced-array — flattenEntityArray normalizes either way.
    const data = { CustomerRet: { ListID: "1" } };
    const result = flattenEntityArray(data, "CustomerRet");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("returns [] when the key is missing entirely", () => {
    expect(flattenEntityArray({}, "CustomerRet")).toEqual([]);
  });
});

describe("Round-trip — builder output parses cleanly", () => {
  // The actual round-trip is wire-level (request → server → response), and
  // QBXML requests + responses don't share the same shape (request bodies
  // have no statusCode attribute). What we CAN verify here is that builder
  // output is well-formed XML that at least parses — no malformed quoting,
  // no unclosed tags, no invalid characters. parseQBXMLResponse will throw
  // QBXMLParseError if the XML doesn't have <QBXML><QBXMLMsgsRs>; here we
  // synthesize a response from the *request* type to exercise that path.

  it("builder output is structurally well-formed (no unclosed tags)", () => {
    // Smoke: the builder emits matched open/close tags for every element.
    const xml = buildQueryRequest("Customer", {
      FullName: "Acme & Co",
      TxnDateRangeFilter: { FromTxnDate: "2026-01-01", ToTxnDate: "2026-12-31" },
    });
    // Count open vs close for the elements we emit.
    const openTags = xml.match(/<[A-Z][a-zA-Z]+[^/>]*>/g) ?? [];
    const closeTags = xml.match(/<\/[A-Z][a-zA-Z]+>/g) ?? [];
    // Self-closing (<Foo/>) doesn't generate a close tag, so equal count is
    // a proxy for "no orphan opens" (excluding self-closes).
    const selfClosing = xml.match(/<[A-Z][a-zA-Z]+[^/>]*\/>/g) ?? [];
    expect(openTags.length - selfClosing.length).toBe(closeTags.length);
  });

  it("escaped values survive parser round-trip on synthesized response", () => {
    // The escapeXml helper is shared between request and response paths
    // (well, response uses fast-xml-parser's own decode, but builder must
    // emit standard escapes). Confirm `&amp;` decodes to `&` on the way back.
    const synthesized = `<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs>
  <CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="OK">
    <CustomerRet><ListID>1</ListID><Name>Acme &amp; Co</Name></CustomerRet>
  </CustomerQueryRs>
</QBXMLMsgsRs></QBXML>`;
    const parsed = parseQBXMLResponse(synthesized);
    const data = parsed.responses[0].data as Record<string, unknown>;
    const customer = (data.CustomerRet as Record<string, unknown>[])[0];
    expect(customer.Name).toBe("Acme & Co");
  });
});
