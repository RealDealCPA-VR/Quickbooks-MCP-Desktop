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
import { SimulationStore } from "./simulation-store.js";

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

    // LIVE MODE: Would use QBXMLRP2 COM automation here
    // const rp = new ActiveXObject("QBXMLRP2.RequestProcessor");
    // rp.OpenConnection2(this.config.appId, this.config.appName, connectionMode);
    // const ticket = rp.BeginSession(this.config.companyFile, qbFileMode);
    throw new Error(
      "Live QuickBooks connection requires Windows with QuickBooks Desktop installed. " +
      "Set QB_SIMULATION=true to use simulation mode."
    );
  }

  async closeSession(): Promise<void> {
    if (!this.session) return;

    if (this.simulationMode) {
      console.error(`[QB Session] Simulation session closed: ${this.session.ticket}`);
      this.session = null;
      return;
    }

    // LIVE MODE: rp.EndSession(ticket); rp.CloseConnection();
    this.session = null;
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

    // LIVE MODE:
    // const responseXml = rp.ProcessRequest(this.session.ticket, qbxmlRequest);
    // return parseQBXMLResponse(responseXml);
    throw new Error("Live mode not available");
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

  async addEntity(
    entityType: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
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

  async deleteEntity(
    entityType: string,
    listIdOrTxnId: string
  ): Promise<Record<string, unknown>> {
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
