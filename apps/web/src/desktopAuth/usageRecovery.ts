import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { deriveContextWindowSnapshot } from "../lib/contextWindow";

export interface RecoveredDailyTotal {
  readonly date: string;
  readonly totalTokens: number;
}

function localDateKey(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Rebuild per-day totals from a thread's cumulative token snapshots.
 *
 * Each context-window event carries the cumulative total processed by that
 * thread. Taking adjacent positive deltas recovers usage without relying on
 * the former localStorage checkpoint. Counter decreases are treated as a
 * provider reset and begin a new cumulative segment.
 */
export function deriveRecoveredDailyTotals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): RecoveredDailyTotal[] {
  const ordered = activities
    .map((activity, index) => ({ activity, index }))
    .sort(
      (left, right) =>
        left.activity.createdAt.localeCompare(right.activity.createdAt) || left.index - right.index,
    );
  const byDate = new Map<string, number>();
  let previousTotal = 0;

  for (const { activity } of ordered) {
    const snapshot = deriveContextWindowSnapshot(activity);
    if (!snapshot) continue;
    const date = localDateKey(snapshot.updatedAt);
    if (!date) continue;

    const cumulative = Math.max(
      0,
      Math.round(snapshot.totalProcessedTokens ?? snapshot.usedTokens),
    );
    const delta = cumulative >= previousTotal ? cumulative - previousTotal : cumulative;
    previousTotal = cumulative;
    if (delta <= 0) continue;
    byDate.set(date, (byDate.get(date) ?? 0) + delta);
  }

  return [...byDate.entries()]
    .map(([date, totalTokens]) => ({ date, totalTokens }))
    .sort((left, right) => left.date.localeCompare(right.date));
}
