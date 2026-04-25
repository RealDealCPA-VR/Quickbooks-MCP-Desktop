/**
 * QuickBooks Desktop QBXML type definitions.
 *
 * These types model the QBXML request/response message format used by the
 * QuickBooks Desktop SDK for application-to-QuickBooks communication.
 */

// ---------------------------------------------------------------------------
// Connection & session
// ---------------------------------------------------------------------------

export interface QBConnectionConfig {
  /** Path to the QuickBooks company file (.qbw). */
  companyFile: string;
  /** Application name registered with QuickBooks. */
  appName: string;
  /** Application ID (assigned during QB app registration). */
  appId?: string;
  /** QBXML version to target (default "16.0"). */
  qbxmlVersion?: string;
  /** Connection mode: localOnly | remoteOnly | optimistic (default). */
  connectionMode?: "localOnly" | "remoteOnly" | "optimistic";
}

export interface QBSession {
  /** Opaque ticket returned by the session manager. */
  ticket: string;
  /** Company file that is open for this session. */
  companyFile: string;
  /** Timestamp when the session was opened. */
  openedAt: Date;
}

// ---------------------------------------------------------------------------
// QBXML envelope types
// ---------------------------------------------------------------------------

export interface QBXMLRequest {
  /** The QBXML version for the <?qbxml version="..."> processing instruction. */
  version: string;
  /** One or more request bodies to embed in <QBXMLMsgsRq>. */
  requests: QBXMLRequestBody[];
}

export interface QBXMLRequestBody {
  /** The request type, e.g. "CustomerQueryRq", "InvoiceAddRq". */
  type: string;
  /** Request ID for correlating responses (auto-incremented if omitted). */
  requestID?: string;
  /** Key-value body of the request (nested XML elements). */
  body: Record<string, unknown>;
}

export interface QBXMLResponse {
  /** Parsed response sets keyed by response type. */
  responses: QBXMLResponseBody[];
}

export interface QBXMLResponseBody {
  /** The response type, e.g. "CustomerQueryRs". */
  type: string;
  /** Status code: 0 = success, >0 = warning/info, <0 = error. */
  statusCode: number;
  /** Status severity: "Info" | "Warning" | "Error". */
  statusSeverity: string;
  /** Human-readable status message. */
  statusMessage: string;
  /** Parsed response data. */
  data: Record<string, unknown> | Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// QuickBooks entity types (subset covering common book management)
// ---------------------------------------------------------------------------

export interface QBCustomer {
  ListID?: string;
  EditSequence?: string;
  Name: string;
  FullName?: string;
  IsActive?: boolean;
  CompanyName?: string;
  FirstName?: string;
  LastName?: string;
  BillAddress?: QBAddress;
  ShipAddress?: QBAddress;
  Phone?: string;
  AltPhone?: string;
  Fax?: string;
  Email?: string;
  Contact?: string;
  AccountNumber?: string;
  Balance?: number;
  TotalBalance?: number;
  Notes?: string;
  CustomerTypeRef?: QBRef;
  TermsRef?: QBRef;
  SalesRepRef?: QBRef;
  SalesTaxCodeRef?: QBRef;
}

export interface QBVendor {
  ListID?: string;
  EditSequence?: string;
  Name: string;
  IsActive?: boolean;
  CompanyName?: string;
  FirstName?: string;
  LastName?: string;
  VendorAddress?: QBAddress;
  Phone?: string;
  AltPhone?: string;
  Fax?: string;
  Email?: string;
  Contact?: string;
  AccountNumber?: string;
  Balance?: number;
  Notes?: string;
  TermsRef?: QBRef;
  VendorTypeRef?: QBRef;
}

export interface QBAccount {
  ListID?: string;
  EditSequence?: string;
  Name: string;
  FullName?: string;
  IsActive?: boolean;
  AccountType: string;
  AccountNumber?: string;
  Description?: string;
  Balance?: number;
  TotalBalance?: number;
  ParentRef?: QBRef;
  CurrencyRef?: QBRef;
}

export interface QBItem {
  ListID?: string;
  EditSequence?: string;
  Name: string;
  FullName?: string;
  IsActive?: boolean;
  ItemType?: string;
  Description?: string;
  Price?: number;
  Cost?: number;
  IncomeAccountRef?: QBRef;
  COGSAccountRef?: QBRef;
  AssetAccountRef?: QBRef;
  SalesTaxCodeRef?: QBRef;
}

export interface QBInvoice {
  TxnID?: string;
  EditSequence?: string;
  TxnNumber?: string;
  CustomerRef: QBRef;
  TxnDate?: string;
  DueDate?: string;
  RefNumber?: string;
  Subtotal?: number;
  SalesTaxTotal?: number;
  AppliedAmount?: number;
  BalanceRemaining?: number;
  IsPaid?: boolean;
  Memo?: string;
  TermsRef?: QBRef;
  InvoiceLineRet?: QBInvoiceLine[];
}

export interface QBInvoiceLine {
  TxnLineID?: string;
  ItemRef?: QBRef;
  Description?: string;
  Quantity?: number;
  Rate?: number;
  Amount?: number;
  SalesTaxCodeRef?: QBRef;
}

export interface QBBill {
  TxnID?: string;
  EditSequence?: string;
  VendorRef: QBRef;
  TxnDate?: string;
  DueDate?: string;
  RefNumber?: string;
  AmountDue?: number;
  IsPaid?: boolean;
  Memo?: string;
  TermsRef?: QBRef;
}

export interface QBPayment {
  TxnID?: string;
  EditSequence?: string;
  CustomerRef: QBRef;
  TxnDate?: string;
  RefNumber?: string;
  TotalAmount?: number;
  PaymentMethodRef?: QBRef;
  Memo?: string;
  DepositToAccountRef?: QBRef;
}

export interface QBEstimate {
  TxnID?: string;
  EditSequence?: string;
  CustomerRef: QBRef;
  TxnDate?: string;
  RefNumber?: string;
  Subtotal?: number;
  Memo?: string;
  IsActive?: boolean;
}

export interface QBEmployee {
  ListID?: string;
  EditSequence?: string;
  Name: string;
  IsActive?: boolean;
  FirstName?: string;
  LastName?: string;
  SSN?: string;
  Phone?: string;
  Email?: string;
  HiredDate?: string;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface QBAddress {
  Addr1?: string;
  Addr2?: string;
  Addr3?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
  Country?: string;
}

export interface QBRef {
  ListID?: string;
  FullName?: string;
}

export interface QBDateRange {
  FromDate?: string; // YYYY-MM-DD
  ToDate?: string;   // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface QBReportRequest {
  reportType: string;
  dateRange?: QBDateRange;
  accountType?: string;
  summarizeColumnsBy?: string;
}

export interface QBReportResponse {
  reportTitle: string;
  reportBasis?: string;
  rows: Record<string, unknown>[];
}
