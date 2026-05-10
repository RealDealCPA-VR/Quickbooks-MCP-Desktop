/**
 * QuickBooks Desktop Session Manager.
 *
 * Manages the connection lifecycle with QuickBooks Desktop, including:
 * - Opening/closing sessions via the QBXML session manager
 * - Sending QBXML request messages and receiving responses
 * - Connection state tracking and error recovery
 *
 * In a production Windows environment, this would use the QBXMLRP2 COM
 * component (or the QBFC library) to communicate with QuickBooks Desktop.
 * This implementation provides the full interface and can operate in two modes:
 *   1. Live mode — communicates with a real QuickBooks Desktop instance via
 *      the QBXMLRP2 request processor (requires Windows + QB Desktop installed)
 *   2. Simulation mode — returns realistic mock responses for development,
 *      testing, and non-Windows environments
 */

import {
  buildQBXMLRequest,
  buildQueryRequest,
  buildAddRequest,
  buildModRequest,
  buildDeleteRequest,
  buildReportRequest,
} from "../qbxml/builder.js";
import {
  parseQBXMLResponse,
  extractResponseData,
  extractReportData,
  flattenEntityArray,
} from "../qbxml/parser.js";
import type {
  QBConnectionConfig,
  QBSession,
  QBXMLRequest,
  QBXMLResponse,
} from "../types/qbxml.js";
import type { ComDispatchObject } from "winax";
import { SimulationStore } from "./simulation-store.js";

// ---------------------------------------------------------------------------
// QBXMLRP2 SDK constants (Intuit QuickBooks SDK 16.0)
// ---------------------------------------------------------------------------

/**
 * `OpenConnection2` connectionType. localQBD (1) requires QuickBooks Desktop
 * to be running on this machine and have a company file open. The setup
 * script's COM probe uses the same value, so the cert that the operator
 * approved on first run is bound to (appName, localQBD) tuples.
 */
const RP2_CONNECTION_TYPE_LOCAL_QBD = 1;

/**
 * `BeginSession` qbFileMode. omDontCare (2) inherits whatever
 * single/multi-user mode the operator already has the file in. Real QB
 * rejects single-user-only requests when the file is opened multi-user; we
 * sidestep that by deferring to the operator's existing choice.
 */
const RP2_FILE_MODE_DONT_CARE = 2;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by the session manager when a mutation is attempted against a session
 * that was opened with `readOnly: true`. Carries `statusCode 9001` (synthetic
 * sentinel — outside the QB SDK's 0/1/3xxx/5xx range) so the existing tool-side
 * error wrapper (the Item 25 catch) surfaces it as a structured `isError: true`
 * response with a humanReadable message via qb-status-codes.ts. Caught and
 * re-thrown unchanged by the typed mutation helpers (addEntity, modifyEntity,
 * deleteEntity, executeBatchAdd) — they don't unwrap it.
 *
 * Statuscode is deliberately distinct from QB-server-side `3260` ("insufficient
 * permission"); the latter is a real wire response, this is a CLIENT-SIDE gate
 * that never reaches QB. Distinguishing them in the surface lets agents tell
 * "I'm in read-only mode" apart from "QB rejected my user role".
 */
export class QBReadOnlyError extends Error {
  statusCode: number;
  constructor(operation: string) {
    super(
      `Read-only session: ${operation} rejected. The session was opened with ` +
      `readOnly: true. Reconnect with qb_session_connect({ readOnly: false }) ` +
      `to re-enable mutations.`
    );
    this.name = "QBReadOnlyError";
    this.statusCode = 9001;
  }
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

/**
 * Resolve simulation mode from the environment. Pure function so the matrix is
 * testable without spinning up sessions.
 *
 * Rule:
 *  - QB_SIMULATION="true"  → always simulate (forced-on override).
 *  - QB_SIMULATION="false" → never simulate; openSession will throw if the
 *    platform can't actually do live (non-Windows, or live not implemented).
 *  - QB_SIMULATION unset   → simulate by default unless on win32 with QB_LIVE=1.
 *
 * Any QB_SIMULATION value other than "true"/"false" (e.g. "1", "yes") is
 * treated as unset to keep the contract narrow — the env var is documented as
 * accepting only those two literal strings.
 */
export function resolveSimulationMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.QB_SIMULATION === "true") return true;
  if (env.QB_SIMULATION === "false") return false;
  return platform !== "win32" || env.QB_LIVE !== "1";
}

export class QBSessionManager {
  private config: QBConnectionConfig;
  private session: QBSession | null = null;
  private simulationMode: boolean;
  private store: SimulationStore;
  /**
   * Live-mode `QBXMLRP2.RequestProcessor` dispatch object. Held between
   * `openSession` and `closeSession` so the same connection processes every
   * request in a session. Null in simulation mode and after `closeSession`.
   */
  private rp: ComDispatchObject | null = null;
  /**
   * Read-only flag (Phase 10 #42). Set via `setReadOnly(true)` (typically on
   * `qb_session_connect({ readOnly: true })`); when true, every mutation
   * helper (`addEntity`, `modifyEntity`, `deleteEntity`, `executeBatchAdd`)
   * throws `QBReadOnlyError` BEFORE building XML or hitting the wire.
   * Persists across `openSession`/`closeSession` so the flag survives an
   * auto-reconnect; only `setReadOnly(false)` (or restarting the process)
   * clears it.
   */
  private readOnly: boolean = false;

  constructor(config: QBConnectionConfig) {
    this.config = config;
    this.simulationMode = resolveSimulationMode(process.env, process.platform);
    this.store = new SimulationStore();

    if (this.simulationMode) {
      console.error(
        "[QB Session] Running in simulation mode — " +
        "set QB_LIVE=1 on a Windows machine with QuickBooks Desktop to use live mode"
      );
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async openSession(): Promise<QBSession> {
    if (this.session) return this.session;

    if (this.simulationMode) {
      this.session = {
        ticket: `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        companyFile: this.config.companyFile,
        openedAt: new Date(),
      };
      console.error(`[QB Session] Simulation session opened: ${this.session.ticket}`);
      return this.session;
    }

    // LIVE MODE — QBXMLRP2 COM automation via winax.
    let winax: typeof import("winax");
    try {
      winax = await import("winax");
    } catch (err) {
      throw new Error(
        "winax module not available. Run scripts/setup-qb-pc.ps1 from an elevated PowerShell " +
        "to install Visual Studio Build Tools + Python and rebuild it, or set QB_SIMULATION=true. " +
        `Underlying error: ${(err as Error).message}`
      );
    }
    const ActiveXObject =
      (winax as { Object?: typeof winax.Object }).Object ??
      (winax as { default?: { Object?: typeof winax.Object } }).default?.Object;
    if (!ActiveXObject) {
      throw new Error(
        "winax loaded but does not expose an `Object` constructor — incompatible winax version installed."
      );
    }

    const rp = new ActiveXObject("QBXMLRP2.RequestProcessor");

    try {
      rp.OpenConnection2(
        this.config.appId ?? "",
        this.config.appName,
        RP2_CONNECTION_TYPE_LOCAL_QBD
      );
    } catch (err) {
      this.rp = null;
      throw new Error(
        `QBXMLRP2.OpenConnection2 failed: ${(err as Error).message}. ` +
        "Verify QuickBooks Desktop is installed and the QuickBooks SDK is registered " +
        "(scripts/setup-qb-pc.ps1 step 4 probes this)."
      );
    }

    let ticket: string;
    try {
      // companyFile === "" tells QBXMLRP2 to use whatever file is currently
      // open in QuickBooks Desktop. That's the better UX for an interactive
      // tool — operators usually have the file open already.
      ticket = rp.BeginSession(this.config.companyFile ?? "", RP2_FILE_MODE_DONT_CARE);
    } catch (err) {
      try { rp.CloseConnection(); } catch { /* swallow — we're already in error path */ }
      throw new Error(
        `QBXMLRP2.BeginSession failed: ${(err as Error).message}. ` +
        "First connection? QuickBooks should have shown an Application Certificate dialog — " +
        "approve 'Yes, always' for app name '" + this.config.appName + "'. Otherwise verify " +
        "the company file path matches what QB has open and the logged-in user has Admin rights."
      );
    }
    if (!ticket) {
      try { rp.CloseConnection(); } catch { /* swallow */ }
      throw new Error("QBXMLRP2.BeginSession returned an empty ticket — connection refused without an error.");
    }

    this.rp = rp;
    this.session = {
      ticket,
      companyFile: this.config.companyFile,
      openedAt: new Date(),
    };
    console.error(`[QB Session] Live session opened: ticket=${ticket}`);
    return this.session;
  }

  async closeSession(): Promise<void> {
    if (!this.session) return;

    if (this.simulationMode) {
      console.error(`[QB Session] Simulation session closed: ${this.session.ticket}`);
      this.session = null;
      return;
    }

    // LIVE MODE — pair EndSession + CloseConnection, swallow shutdown errors.
    // We never want to crash the process during cleanup; better to log and
    // proceed than to leave the operator with a half-closed session that
    // blocks the next process from connecting.
    const ticket = this.session.ticket;
    if (this.rp) {
      try {
        this.rp.EndSession(ticket);
      } catch (err) {
        console.error(
          `[QB Session] EndSession failed (continuing anyway): ${(err as Error).message}`
        );
      }
      try {
        this.rp.CloseConnection();
      } catch (err) {
        console.error(
          `[QB Session] CloseConnection failed (continuing anyway): ${(err as Error).message}`
        );
      }
    }
    this.rp = null;
    this.session = null;
    console.error(`[QB Session] Live session closed: ticket=${ticket}`);
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  getSession(): QBSession | null {
    return this.session;
  }

  isSimulation(): boolean {
    return this.simulationMode;
  }

  /**
   * Whether the session is currently gated against mutations. Surfaced by
   * `qb_session_connect` / `qb_company_info` so agents can probe before
   * attempting a write.
   */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Toggle the read-only gate. Takes effect immediately for the next mutation
   * call — does NOT require a re-connect. Idempotent. The gate runs in BOTH
   * live and simulation mode (the value is intercepted at the typed-mutation
   * helpers, before any envelope is built or wire I/O happens).
   */
  setReadOnly(value: boolean): void {
    this.readOnly = value;
  }

  /**
   * Internal: throw QBReadOnlyError if the session is read-only. Called at
   * the entry of every mutation helper — keeps the gate in one place rather
   * than at each tool's `session.{add,modify,delete}Entity` call site (47
   * callers, see grep). The thrown error carries `statusCode 9001` which
   * the existing `qb-status-codes.ts` table maps to a human-readable
   * message; the existing tool error wrappers (Item 25 catch) surface it as
   * `isError: true` without modification.
   */
  private assertWritable(operation: string): void {
    if (this.readOnly) throw new QBReadOnlyError(operation);
  }

  /**
   * Path of the company file currently registered on the session config (the
   * one that openSession will pass to BeginSession). Empty string means
   * "use whatever file QB Desktop has open right now". Reads the live config
   * value, not a stale cached copy from a prior open session — switchCompanyFile
   * mutates this.
   */
  getCompanyFile(): string {
    return this.config.companyFile;
  }

  /**
   * Swap the active company file. Closes any in-flight session, mutates the
   * config path, resets the simulation store (sim mode only — real QB persists
   * per-file, sim doesn't), and opens a fresh session against the new file.
   *
   * Live mode: the close path runs EndSession + CloseConnection on the old
   * file; the open path runs OpenConnection2 + BeginSession on the new one.
   * QBXMLRP2 only supports one file open per process at a time, so this is
   * sequential by construction.
   *
   * Sim mode: the new SimulationStore reseeds; entities created against the
   * prior path are gone. This is the deliberate sim-fidelity tradeoff
   * documented in DECISIONS.md (2026-05-09).
   */
  async switchCompanyFile(companyFile: string): Promise<QBSession> {
    await this.closeSession();
    this.config.companyFile = companyFile;
    if (this.simulationMode) {
      this.store = new SimulationStore();
    }
    return this.openSession();
  }

  // -------------------------------------------------------------------------
  // QBXML request execution
  // -------------------------------------------------------------------------

  /**
   * Send a raw QBXML request string and return the parsed response.
   */
  async sendRequest(qbxmlRequest: string): Promise<QBXMLResponse> {
    if (!this.session) {
      await this.openSession();
    }

    if (this.simulationMode) {
      return this.store.processRequest(qbxmlRequest);
    }

    // LIVE MODE — round-trip the QBXML string through QBXMLRP2 and parse the
    // response with the same parser the simulation results would have flowed
    // through. Errors from ProcessRequest bubble out so the existing tool-side
    // error machinery (Item 25 path) can translate them into structured tool
    // responses.
    if (!this.rp || !this.session) {
      throw new Error(
        "Live mode is active but no session is open — openSession was expected to be called first."
      );
    }
    const responseXml: string = this.rp.ProcessRequest(this.session.ticket, qbxmlRequest);
    return parseQBXMLResponse(responseXml);
  }

  /**
   * Execute a structured QBXML request and return the parsed response.
   */
  async executeRequest(request: QBXMLRequest): Promise<QBXMLResponse> {
    const xml = buildQBXMLRequest(request);
    return this.sendRequest(xml);
  }

  // -------------------------------------------------------------------------
  // High-level query/CRUD operations
  // -------------------------------------------------------------------------

  async queryEntity(
    entityType: string,
    filters: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>[]> {
    const xml = buildQueryRequest(entityType, filters, {
      version: this.config.qbxmlVersion,
    });
    const response = await this.sendRequest(xml);
    const data = extractResponseData(response, `${entityType}QueryRs`);
    if (Array.isArray(data)) return data;
    return flattenEntityArray(
      data as Record<string, unknown>,
      `${entityType}Ret`
    );
  }

  /**
   * Paginated variant of queryEntity (Item 27). Real QB caps each *QueryRq
   * response at ~500 rows; subsequent pages are driven by passing the
   * iteratorID returned on the prior response back as the `iteratorID` arg
   * with iterator="Continue". When iteratorRemainingCount === 0 the iterator
   * is exhausted.
   *
   * Simulation behavior:
   *   - iterator="Start" (or omitted iteratorID with paginate intent) →
   *     returns the full result set in one shot, with iteratorRemainingCount=0
   *     and a synthesized iteratorID. The simulation does not actually page —
   *     real-world dev seed data fits well under 500 rows.
   *   - iterator="Continue"/"Stop" → returns empty (statusCode 1) with no
   *     iterator metadata, mirroring how real QB behaves once the iterator is
   *     drained.
   */
  async queryEntityPaginated(
    entityType: string,
    filters: Record<string, unknown> = {},
    options: {
      iterator?: "Start" | "Continue" | "Stop";
      iteratorID?: string;
    } = {}
  ): Promise<{
    entities: Record<string, unknown>[];
    iteratorRemainingCount?: number;
    iteratorID?: string;
  }> {
    const xml = buildQueryRequest(entityType, filters, {
      version: this.config.qbxmlVersion,
      iterator: options.iterator,
      iteratorID: options.iteratorID,
    });
    const response = await this.sendRequest(xml);
    const rsType = `${entityType}QueryRs`;

    let entities: Record<string, unknown>[] = [];
    try {
      const data = extractResponseData(response, rsType);
      entities = Array.isArray(data)
        ? data
        : flattenEntityArray(
            data as Record<string, unknown>,
            `${entityType}Ret`
          );
    } catch (err) {
      // extractResponseData throws QBXMLResponseError on hard failure; that
      // bubbles out so tool wrappers translate it (Item 25 path).
      throw err;
    }

    const rs = response.responses.find((r) => r.type === rsType);
    return {
      entities,
      ...(rs?.iteratorRemainingCount !== undefined
        ? { iteratorRemainingCount: rs.iteratorRemainingCount }
        : {}),
      ...(rs?.iteratorID !== undefined ? { iteratorID: rs.iteratorID } : {}),
    };
  }

  /**
   * Cross-type transaction query (TransactionQueryRq). Distinct from queryEntity
   * because TransactionQueryRq is NOT a per-type query — one envelope returns
   * postings from any transaction type (Invoice, Bill, Check, JournalEntry, …)
   * filtered primarily by AccountFilter. Real QB returns one TransactionRet per
   * posting line, with TxnType discriminating which underlying transaction
   * shape produced it.
   *
   * Schema-required filter sequence per QBXML 16.0 SDK:
   *   TxnID? → MaxReturned? → ModifiedDateRangeFilter? → TxnDateRangeFilter? →
   *   EntityFilter? → AccountFilter → RefNumberFilter? → TransactionTypeFilter? →
   *   PostedFilter? → DetailLevel? → IncludeRetElement? → OwnerID?
   * Callers MUST populate the filter dict in this order — buildQueryRequest
   * preserves insertion order (pinned by tests/builder-emit-order.test.ts), so
   * out-of-order keys would surface as the live "found an error when parsing"
   * statusCode -1 class of bug.
   */
  async queryTransactions(
    filters: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>[]> {
    return this.queryEntity("Transaction", filters);
  }

  async addEntity(
    entityType: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    this.assertWritable(`addEntity(${entityType})`);
    const xml = buildAddRequest(entityType, data, this.config.qbxmlVersion);
    const response = await this.sendRequest(xml);
    const respData = extractResponseData(response, `${entityType}AddRs`);
    if (Array.isArray(respData)) return respData[0] ?? {};
    const entities = flattenEntityArray(
      respData as Record<string, unknown>,
      `${entityType}Ret`
    );
    return entities[0] ?? respData;
  }

  async modifyEntity(
    entityType: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    this.assertWritable(`modifyEntity(${entityType})`);
    const xml = buildModRequest(entityType, data, this.config.qbxmlVersion);
    const response = await this.sendRequest(xml);
    const respData = extractResponseData(response, `${entityType}ModRs`);
    if (Array.isArray(respData)) return respData[0] ?? {};
    const entities = flattenEntityArray(
      respData as Record<string, unknown>,
      `${entityType}Ret`
    );
    return entities[0] ?? respData;
  }

  /**
   * Batch-add N entities of the same type in a single QBXML envelope under
   * <QBXMLMsgsRq onError="stopOnError">. The envelope carries N <{Type}AddRq>
   * blocks each with a sequential requestID="1".."N"; the response carries
   * one <{Type}AddRs> per request that actually ran (stopOnError halts after
   * the first error, so failures past the first never produce response blocks).
   *
   * Returns positionally-aligned results by mapping the requestID attribute
   * each response carries back to the input index. Indices with no
   * corresponding response are reported as "skipped" (post-stopOnError).
   *
   * Caller is responsible for upfront input validation (per-entry shape) and
   * compensating-rollback semantics. This method just runs the wire I/O and
   * partitions the output by status. Used by Phase 10 #43 (batch JE create);
   * the same pattern reused by #58 (batch invoice/SR) when wired.
   */
  async executeBatchAdd(
    entityType: string,
    entries: Record<string, unknown>[]
  ): Promise<
    Array<
      | {
          requestID: string;
          status: "posted";
          entity: Record<string, unknown>;
        }
      | {
          requestID: string;
          status: "failed";
          statusCode: number;
          statusMessage: string;
        }
      | { requestID: string; status: "skipped" }
    >
  > {
    if (entries.length === 0) return [];
    this.assertWritable(`executeBatchAdd(${entityType}, n=${entries.length})`);

    const rqType = `${entityType}AddRq`;
    const rsType = `${entityType}AddRs`;
    const retName = `${entityType}Ret`;
    const addKey = `${entityType}Add`;

    // Build N request bodies, each with an explicit sequential requestID.
    // Builder would auto-assign these if omitted, but we set them explicitly
    // so the contract between input index and response requestID is unambiguous.
    const requests = entries.map((data, i) => ({
      type: rqType,
      requestID: String(i + 1),
      body: { [addKey]: data },
    }));

    const xml = buildQBXMLRequest({
      version: this.config.qbxmlVersion ?? "16.0",
      requests,
    });
    const response = await this.sendRequest(xml);

    // Initialize positionally-aligned result slots as "skipped". Every input
    // entry gets a slot; responses fill in posted/failed by requestID match.
    type Result =
      | {
          requestID: string;
          status: "posted";
          entity: Record<string, unknown>;
        }
      | {
          requestID: string;
          status: "failed";
          statusCode: number;
          statusMessage: string;
        }
      | { requestID: string; status: "skipped" };
    const results: Result[] = entries.map((_, i) => ({
      requestID: String(i + 1),
      status: "skipped" as const,
    }));

    for (const rs of response.responses) {
      if (rs.type !== rsType) continue;
      const rid = rs.requestID;
      if (rid === undefined) continue;
      const idx = Number(rid) - 1;
      if (idx < 0 || idx >= results.length) continue;

      if (rs.statusCode === 0) {
        // Pull the entity out of the response data block. AddRs returns
        // { {entityType}Ret: <entity> } (single object, not array).
        const data = rs.data as Record<string, unknown>;
        const ret = data[retName];
        const entity = (Array.isArray(ret) ? ret[0] : ret) as
          | Record<string, unknown>
          | undefined;
        results[idx] = {
          requestID: rid,
          status: "posted",
          entity: entity ?? {},
        };
      } else {
        results[idx] = {
          requestID: rid,
          status: "failed",
          statusCode: rs.statusCode,
          statusMessage: rs.statusMessage,
        };
      }
    }

    return results;
  }

  async deleteEntity(
    entityType: string,
    listIdOrTxnId: string
  ): Promise<Record<string, unknown>> {
    this.assertWritable(`deleteEntity(${entityType})`);
    const xml = buildDeleteRequest(entityType, listIdOrTxnId, this.config.qbxmlVersion);
    const response = await this.sendRequest(xml);
    const isTransaction = [
      "Invoice", "Bill", "Payment", "Estimate", "SalesReceipt",
      "CreditMemo", "PurchaseOrder", "JournalEntry",
    ].includes(entityType);
    const rsType = isTransaction ? "TxnDelRs" : "ListDelRs";
    const data = extractResponseData(response, rsType);
    return Array.isArray(data) ? data[0] ?? {} : data;
  }

  // -------------------------------------------------------------------------
  // Report queries
  // -------------------------------------------------------------------------

  /**
   * Run a GeneralSummaryReportQueryRq (P&L / Balance Sheet) and return the
   * extracted ReportRet block. In simulation the store emits the simplified
   * shape (Sections / Totals); live mode (Phase 7) will need a row-tree
   * adapter — see extractReportData jsdoc.
   */
  async runReport(
    reportType: string,
    params: { fromDate?: string; toDate?: string; basis?: "Accrual" | "Cash" } = {}
  ): Promise<Record<string, unknown>> {
    const xml = buildReportRequest(
      { reportType, ...params },
      this.config.qbxmlVersion
    );
    const response = await this.sendRequest(xml);
    return extractReportData(response, "GeneralSummaryReportQueryRs");
  }
}
