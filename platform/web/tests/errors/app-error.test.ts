import { describe, expect, it } from "vitest";
import { AppError, toAppError } from "@/lib/errors/app-error";

describe("toAppError", () => {
  it("passes an existing AppError through unchanged", () => {
    const original = new AppError({
      code: "TRADE_EXECUTION_ERROR",
      userMessage: "Custom message",
      diagnosticMessage: "diagnostic",
      retryable: false,
    });
    expect(toAppError(original)).toBe(original);
  });

  it("normalises a plain Error with a safe default user message", () => {
    const result = toAppError(new Error("ECONNREFUSED 127.0.0.1:5432"), "PERSISTENCE_ERROR");
    expect(result.code).toBe("PERSISTENCE_ERROR");
    expect(result.diagnosticMessage).toBe("ECONNREFUSED 127.0.0.1:5432");
    expect(result.userMessage).not.toContain("ECONNREFUSED");
  });

  it("normalises a thrown string", () => {
    const result = toAppError("something broke");
    expect(result.code).toBe("UNKNOWN_ERROR");
    expect(result.diagnosticMessage).toBe("something broke");
  });

  it("allows overriding the user message and retryability", () => {
    const result = toAppError(new Error("boom"), "AUTOMATION_ERROR", {
      userMessage: "Custom safe message",
      retryable: false,
    });
    expect(result.userMessage).toBe("Custom safe message");
    expect(result.retryable).toBe(false);
  });
});
