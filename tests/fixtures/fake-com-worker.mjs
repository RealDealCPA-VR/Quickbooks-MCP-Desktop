// Stand-in for src/session/com-worker.ts in tests: same IPC protocol, no winax.
// Behaviour is driven by the request XML:
//   contains "CRASH"       → exit like a native access violation (the real
//                            failure seen when QuickBooks was killed mid-session)
//   contains "CRASH_ONCE"  → crash only the first time across processes
//                            (marker file in FAKE_COM_STATE_DIR), then answer
//   contains "HANG"        → never answer (frozen QuickBooks)
//   otherwise              → answer with a minimal CustomerQueryRs
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const OK_XML =
  '<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK">' +
  "<CustomerRet><ListID>80000001-1</ListID><Name>Acme</Name></CustomerRet></CustomerQueryRs></QBXMLMsgsRs></QBXML>";

process.send({ ready: true });
process.on("message", (m) => {
  const reply = (result) => process.send({ id: m.id, ok: true, result });
  switch (m.op) {
    case "open": return reply(null);
    case "begin": return reply(`FAKE-TICKET-${process.pid}`);
    case "end":
    case "close": return reply(null);
    case "process": {
      const xml = String(m.xml);
      if (xml.includes("HANG")) return;
      if (xml.includes("CRASH_ONCE")) {
        const marker = path.join(process.env.FAKE_COM_STATE_DIR ?? ".", "crashed-once");
        if (!existsSync(marker)) { writeFileSync(marker, "1"); process.exit(3221225477); }
        return reply(OK_XML);
      }
      if (xml.includes("CRASH")) process.exit(3221225477);
      return reply(OK_XML);
    }
    default:
      return process.send({ id: m.id, ok: false, error: `unknown op ${m.op}` });
  }
});
process.on("disconnect", () => process.exit(0));
