import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveRecoveredDailyTotals } from "./usageRecovery";

function usage(id: string, createdAt: string, totalProcessedTokens: number) {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "context-window.updated",
    summary: "usage",
    payload: { usedTokens: totalProcessedTokens, totalProcessedTokens },
    turnId: TurnId.make("turn-1"),
    createdAt,
  } satisfies OrchestrationThreadActivity;
}

describe("deriveRecoveredDailyTotals", () => {
  it("assigns cumulative deltas to the day when they occurred", () => {
    expect(
      deriveRecoveredDailyTotals([
        usage("usage-1", "2026-06-12T12:00:00.000Z", 100),
        usage("usage-2", "2026-06-12T13:00:00.000Z", 250),
        usage("usage-3", "2026-06-13T12:00:00.000Z", 425),
      ]),
    ).toEqual([
      { date: "2026-06-12", totalTokens: 250 },
      { date: "2026-06-13", totalTokens: 175 },
    ]);
  });

  it("sorts events and handles a cumulative counter reset", () => {
    expect(
      deriveRecoveredDailyTotals([
        usage("usage-3", "2026-06-14T14:00:00.000Z", 80),
        usage("usage-1", "2026-06-14T12:00:00.000Z", 300),
        usage("usage-2", "2026-06-14T13:00:00.000Z", 20),
      ]),
    ).toEqual([{ date: "2026-06-14", totalTokens: 380 }]);
  });

  it("ignores unrelated and malformed activities", () => {
    const unrelated = {
      ...usage("usage-1", "2026-06-12T12:00:00.000Z", 100),
      kind: "tool.started",
    } satisfies OrchestrationThreadActivity;
    expect(deriveRecoveredDailyTotals([unrelated])).toEqual([]);
  });
});
