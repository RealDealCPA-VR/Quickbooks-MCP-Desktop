// Phase 18 #86 — MCP prompts (workflow bundles).
//
// Coverage layers:
//   1. Pure date helpers — todayISO / lastCompletedYear / priorCalendarMonth
//      for default-arg behavior (so a bare "/month_end_close" produces a
//      useful prompt instead of an empty-window one).
//   2. Registration plumbing — registerWorkflowPrompts calls
//      server.registerPrompt once per entry with matching name/title/desc/schema.
//   3. Per-prompt callback output — each PROMPT_REGISTRATIONS entry, when
//      invoked, returns a GetPromptResult with one user-role text message
//      whose body contains the right tool references and substitutes the
//      operator's args into the message.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  PROMPT_REGISTRATIONS,
  registerWorkflowPrompts,
  todayISO,
  lastCompletedYear,
  priorCalendarMonth,
  monthEndClosePrompt,
  creditCardBatchPrompt,
  trialBalanceWorkupPrompt,
  ccStatementValidatorPrompt,
  w2PrepPrompt,
} from "../src/prompts/workflows.js";

// ---------------------------------------------------------------------------
// Layer 1 — Pure date helpers
// ---------------------------------------------------------------------------

describe("todayISO", () => {
  it("formats Date as YYYY-MM-DD (UTC)", () => {
    expect(todayISO(new Date("2026-05-12T14:30:00Z"))).toBe("2026-05-12");
    expect(todayISO(new Date("2024-01-01T00:00:00Z"))).toBe("2024-01-01");
  });

  it("returns today when called with no arg", () => {
    const out = todayISO();
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("lastCompletedYear", () => {
  it("returns the prior calendar year as string", () => {
    expect(lastCompletedYear(new Date("2026-05-12T00:00:00Z"))).toBe("2025");
    expect(lastCompletedYear(new Date("2024-01-01T00:00:00Z"))).toBe("2023");
    // Year boundary — December 31 still belongs to its own year, so the
    // last completed year is YYYY-1, not YYYY.
    expect(lastCompletedYear(new Date("2025-12-31T23:59:59Z"))).toBe("2024");
  });
});

describe("priorCalendarMonth", () => {
  it("returns first/last day of the month before `now`", () => {
    expect(priorCalendarMonth(new Date("2026-05-12T00:00:00Z"))).toEqual({
      fromDate: "2026-04-01",
      toDate: "2026-04-30",
    });
    expect(priorCalendarMonth(new Date("2026-03-15T00:00:00Z"))).toEqual({
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
    });
  });

  it("handles January → previous December (year rollover)", () => {
    expect(priorCalendarMonth(new Date("2026-01-15T00:00:00Z"))).toEqual({
      fromDate: "2025-12-01",
      toDate: "2025-12-31",
    });
  });

  it("handles leap February", () => {
    expect(priorCalendarMonth(new Date("2024-03-01T00:00:00Z"))).toEqual({
      fromDate: "2024-02-01",
      toDate: "2024-02-29",
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Registration plumbing
// ---------------------------------------------------------------------------

type RegisteredPromptCall = {
  name: string;
  config: { title?: string; description?: string; argsSchema?: Record<string, z.ZodTypeAny> };
  callback: (args: Record<string, unknown>) => unknown;
};

describe("registerWorkflowPrompts", () => {
  it("registers every entry in PROMPT_REGISTRATIONS exactly once", () => {
    const calls: RegisteredPromptCall[] = [];
    const fakeServer = {
      registerPrompt: (
        name: string,
        config: RegisteredPromptCall["config"],
        callback: RegisteredPromptCall["callback"],
      ) => {
        calls.push({ name, config, callback });
        return { name, ...config, callback, enabled: true } as unknown;
      },
    };

    registerWorkflowPrompts(fakeServer as never);

    expect(calls.length).toBe(PROMPT_REGISTRATIONS.length);
    expect(calls.length).toBe(5);

    for (const entry of PROMPT_REGISTRATIONS) {
      const match = calls.find((c) => c.name === entry.name);
      expect(match, `prompt "${entry.name}" should be registered`).toBeDefined();
      expect(match!.config.title).toBe(entry.title);
      expect(match!.config.description).toBe(entry.description);
      expect(match!.config.argsSchema).toBe(entry.argsSchema);
      expect(typeof match!.callback).toBe("function");
    }
  });

  it("registers exactly the five expected prompt names", () => {
    const names = PROMPT_REGISTRATIONS.map((p) => p.name).sort();
    expect(names).toEqual([
      "cc_statement_validator",
      "credit_card_qb_batch",
      "month_end_close",
      "trial_balance_workup",
      "w2_prep",
    ]);
  });

  it("every prompt argsSchema is a Zod raw shape (record of ZodType)", () => {
    for (const entry of PROMPT_REGISTRATIONS) {
      expect(typeof entry.argsSchema).toBe("object");
      for (const [field, schema] of Object.entries(entry.argsSchema)) {
        // Zod types expose _def — duck-type check.
        expect(
          (schema as { _def?: unknown })._def,
          `${entry.name}.${field} should be a Zod type`,
        ).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Per-prompt callback output
// ---------------------------------------------------------------------------

// Helper — every prompt returns { description, messages: [{role: "user", content: {type: "text", text}}] }.
// Extract the body text so the contains-checks read cleanly below.
function callPrompt(
  cb: (args: any) => any,
  args: Record<string, unknown> = {},
): { description?: string; text: string } {
  const result = cb(args);
  expect(result.messages.length).toBe(1);
  const msg = result.messages[0];
  expect(msg.role).toBe("user");
  expect(msg.content.type).toBe("text");
  return { description: result.description, text: msg.content.text };
}

describe("monthEndClosePrompt", () => {
  it("defaults to prior calendar month when fromDate/toDate are unset", () => {
    const { fromDate, toDate } = priorCalendarMonth();
    const { text, description } = callPrompt(monthEndClosePrompt, {});
    expect(text).toContain(fromDate);
    expect(text).toContain(toDate);
    expect(description).toMatch(/Month-end close/i);
  });

  it("substitutes explicit fromDate/toDate args", () => {
    const { text } = callPrompt(monthEndClosePrompt, {
      fromDate: "2026-04-01",
      toDate: "2026-04-30",
    });
    expect(text).toContain("2026-04-01");
    expect(text).toContain("2026-04-30");
  });

  it("substitutes bankAccountName into the bank-rec section", () => {
    const { text } = callPrompt(monthEndClosePrompt, {
      bankAccountName: "Chase Operating",
    });
    expect(text).toContain('"Chase Operating"');
  });

  it("falls back to generic instructions when bankAccountName is unset", () => {
    const { text } = callPrompt(monthEndClosePrompt, {});
    expect(text).toMatch(/qb_account_list.*Bank/);
  });

  it("references the right tool set", () => {
    const { text } = callPrompt(monthEndClosePrompt, {});
    for (const tool of [
      "qb_company_info",
      "qb_host_query",
      "qb_closing_date_get",
      "qb_uncleared_transactions",
      "qb_reconciliation_discrepancy",
      "qb_cleared_status_update",
      "qb_pnl_report",
      "qb_general_ledger",
      "qb_ar_aging",
      "qb_ap_aging",
      "qb_balance_sheet_report",
      "qb_statement_of_cash_flows",
    ]) {
      expect(text, `should reference ${tool}`).toContain(tool);
    }
  });

  it("warns not to call qb_closing_date_set (no SDK write path)", () => {
    const { text } = callPrompt(monthEndClosePrompt, {});
    expect(text).toMatch(/Do NOT call .qb_closing_date_set/i);
  });
});

describe("creditCardBatchPrompt", () => {
  it("references qb_journal_entry_batch_create and the supporting list tools", () => {
    const { text } = callPrompt(creditCardBatchPrompt, {});
    expect(text).toContain("qb_journal_entry_batch_create");
    expect(text).toContain("qb_account_list");
    expect(text).toContain("qb_class_list");
  });

  it("substitutes creditCardAccountName into the prompt", () => {
    const { text } = callPrompt(creditCardBatchPrompt, {
      creditCardAccountName: "Chase Business Visa",
    });
    expect(text).toContain('"Chase Business Visa"');
  });

  it("substitutes statementMonth + source into the prompt", () => {
    const { text } = callPrompt(creditCardBatchPrompt, {
      statementMonth: "2026-04",
      source: "Chase CSV",
    });
    expect(text).toContain("2026-04");
    expect(text).toContain("Chase CSV");
  });

  it("calls out idempotencyKey for safe retries", () => {
    const { text } = callPrompt(creditCardBatchPrompt, {});
    expect(text).toContain("idempotencyKey");
    expect(text).toMatch(/9002/);
  });

  it("describes refund/credit reversal mechanics", () => {
    const { text } = callPrompt(creditCardBatchPrompt, {});
    expect(text).toMatch(/refund/i);
    expect(text).toMatch(/credit/i);
  });
});

describe("trialBalanceWorkupPrompt", () => {
  it("defaults asOfDate to today and basis to Accrual", () => {
    const today = todayISO();
    const { text } = callPrompt(trialBalanceWorkupPrompt, {});
    expect(text).toContain(today);
    expect(text).toContain("Accrual");
  });

  it("substitutes explicit asOfDate + basis", () => {
    const { text } = callPrompt(trialBalanceWorkupPrompt, {
      asOfDate: "2025-12-31",
      basis: "Cash",
    });
    expect(text).toContain("2025-12-31");
    expect(text).toContain("Cash");
  });

  it("calls the one-shot qb_trial_balance_export tool and names the drill-down tools", () => {
    // Post-#68 the prompt bundles TB + four cross-checks into qb_trial_balance_export
    // (one call instead of the prior 8-tool recipe). The drill-down tools stay
    // referenced so an agent can dig deeper when a cross-check fires.
    const { text } = callPrompt(trialBalanceWorkupPrompt, {});
    expect(text).toContain("qb_trial_balance_export");
    expect(text).toContain("qb_transaction_list_by_account");
    expect(text).toContain("qb_general_ledger");
    expect(text).toContain("qb_customer_balance_detail");
    expect(text).toContain("qb_vendor_balance_detail");
  });

  it("specifies the workpaper output table shape", () => {
    const { text } = callPrompt(trialBalanceWorkupPrompt, {});
    expect(text).toMatch(/AccountName.*AccountType/);
    expect(text).toMatch(/Debit.*Credit/);
  });
});

describe("ccStatementValidatorPrompt", () => {
  it("defaults statementEndingDate to today", () => {
    const today = todayISO();
    const { text } = callPrompt(ccStatementValidatorPrompt, {});
    expect(text).toContain(today);
  });

  it("substitutes balance + account into the prompt when supplied", () => {
    const { text } = callPrompt(ccStatementValidatorPrompt, {
      creditCardAccountName: "Amex Platinum",
      statementEndingBalance: "1342.07",
      statementEndingDate: "2026-04-30",
    });
    expect(text).toContain('"Amex Platinum"');
    expect(text).toContain("1342.07");
    expect(text).toContain("2026-04-30");
  });

  it("prompts for the ending balance when none is given", () => {
    const { text } = callPrompt(ccStatementValidatorPrompt, {});
    expect(text).toMatch(/Ask the operator for the statement's ending balance/i);
  });

  it("references three-way reconciliation tools", () => {
    const { text } = callPrompt(ccStatementValidatorPrompt, {});
    expect(text).toContain("qb_transaction_list_by_account");
    expect(text).toContain("qb_uncleared_transactions");
    expect(text).toContain("qb_reconciliation_discrepancy");
    expect(text).toContain("qb_cleared_status_update");
  });
});

describe("w2PrepPrompt", () => {
  it("defaults taxYear to last completed year", () => {
    const ly = lastCompletedYear();
    const { text } = callPrompt(w2PrepPrompt, {});
    expect(text).toContain(ly);
  });

  it("substitutes employeeFullName into the qb_w2_summary call", () => {
    const { text } = callPrompt(w2PrepPrompt, {
      taxYear: "2024",
      employeeFullName: "Alice Smith",
    });
    expect(text).toContain("2024");
    expect(text).toContain('"Alice Smith"');
    expect(text).toContain('employeeFullName: "Alice Smith"');
  });

  it("references payroll-edition probes and 9003/9004 status codes", () => {
    const { text } = callPrompt(w2PrepPrompt, {});
    expect(text).toContain("qb_host_query");
    expect(text).toContain("qb_w2_summary");
    expect(text).toContain("qb_employee_list");
    expect(text).toMatch(/9003/);
    expect(text).toMatch(/9004/);
  });

  it("explains the SSN-masking contract", () => {
    const { text } = callPrompt(w2PrepPrompt, {});
    expect(text).toMatch(/SSN/);
    expect(text).toMatch(/last 4|XXX-XX/i);
  });
});

// ---------------------------------------------------------------------------
// GetPromptResult shape — every prompt produces a structurally-valid result.
// ---------------------------------------------------------------------------

describe("GetPromptResult shape", () => {
  it("every prompt callback produces { description, messages: [{role:'user', content:{type:'text', text}}] }", () => {
    for (const entry of PROMPT_REGISTRATIONS) {
      // Call with empty args — all schemas are optional, so this is valid.
      const result = (entry.callback as (args: any) => any)({});
      expect(result).toHaveProperty("description");
      expect(typeof result.description).toBe("string");
      expect((result.description as string).length).toBeGreaterThan(0);
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.messages.length).toBe(1);
      const msg = result.messages[0];
      expect(msg.role).toBe("user");
      expect(msg.content.type).toBe("text");
      expect(typeof msg.content.text).toBe("string");
      // Body should be substantial (not an empty placeholder).
      expect((msg.content.text as string).length).toBeGreaterThan(200);
    }
  });
});
