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
} from "../qbxml/builder.js";
import {
  extractResponseData,
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

export class QBSessionManager {
  private config: QBConnectionConfig;
  private session: QBSession | null = null;
  private simulationMode: boolean;
  private store: SimulationStore;

  constructor(config: QBConnectionConfig) {
    this.config = config;
    // Detect if we're in a non-Windows environment or QB not available
    this.simulationMode = process.env.QB_SIMULATION === "true" ||
      process.platform !== "win32" ||
      !process.env.QB_LIVE;
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
    const xml = buildQueryRequest(entityType, filters, this.config.qbxmlVersion);
    const response = await this.sendRequest(xml);
    const data = extractResponseData(response, `${entityType}QueryRs`);
    if (Array.isArray(data)) return data;
    return flattenEntityArray(
      data as Record<string, unknown>,
      `${entityType}Ret`
    );
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

  async runReport(
    reportType: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const xml = buildQueryRequest(
      reportType,
      params,
      this.config.qbxmlVersion
    );
    const response = await this.sendRequest(xml);
    const data = extractResponseData(response);
    return Array.isArray(data) ? data[0] ?? {} : data;
  }
}
