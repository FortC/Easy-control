import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isTerminal,
  TASK_STATES,
  TASK_TRANSITIONS,
} from "./task-states.js";

describe("任务状态机", () => {
  it("主链路迁移全部合法", () => {
    const happyPath = [
      "SCHEDULED",
      "PREFLIGHT",
      "WAITING_RUNNER",
      "RUNNING",
      "SUBMITTED",
      "UNDER_REVIEW",
      "PUBLISHED",
    ] as const;
    for (let i = 0; i < happyPath.length - 1; i++) {
      expect(canTransition(happyPath[i]!, happyPath[i + 1]!), `${happyPath[i]}→${happyPath[i + 1]}`).toBe(true);
    }
  });

  it("异常分支迁移合法", () => {
    expect(canTransition("RUNNING", "UNKNOWN")).toBe(true);
    expect(canTransition("RUNNING", "NEEDS_HUMAN")).toBe(true);
    expect(canTransition("SUBMITTED", "REJECTED")).toBe(true);
    expect(canTransition("UNKNOWN", "NEEDS_HUMAN")).toBe(true);
    expect(canTransition("NEEDS_HUMAN", "SCHEDULED")).toBe(true);
    expect(canTransition("WAITING_RUNNER", "MISSED")).toBe(true);
    expect(canTransition("SCHEDULED", "CANCELLED")).toBe(true);
  });

  it("非法迁移抛错", () => {
    expect(() => assertTransition("PUBLISHED", "RUNNING")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("DRAFT" as never, "RUNNING")).toThrow();
    expect(canTransition("MISSED", "RUNNING")).toBe(false);
    expect(canTransition("FAILED", "SUBMITTED")).toBe(false);
    expect(canTransition("CANCELLED", "SCHEDULED")).toBe(false);
    expect(canTransition("PUBLISHED", "PUBLISHED")).toBe(false);
  });

  it("终态定义完整且无出边", () => {
    for (const state of TASK_STATES) {
      if (isTerminal(state)) {
        expect(TASK_TRANSITIONS[state], state).toHaveLength(0);
      }
    }
    expect(isTerminal("PUBLISHED")).toBe(true);
    expect(isTerminal("NEEDS_HUMAN")).toBe(false);
  });

  it("所有状态都在迁移表中", () => {
    for (const state of TASK_STATES) {
      expect(TASK_TRANSITIONS[state]).toBeDefined();
    }
  });
});
