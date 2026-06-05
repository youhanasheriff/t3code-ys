/**
 * Desktop-only usage analytics recorder.
 *
 * Watches the local app store for token-usage updates on the user's chats (this
 * machine's own sessions) and mirrors them to Firestore under the signed-in
 * user's UID. Usage is computed purely from local chat activity — never from any
 * shared Codex usage/billing API — so each Google account on each laptop tracks
 * only what that person actually ran.
 *
 * Firestore layout (see firestore.rules):
 *   users/{uid}                       → profile + lastSeenAt
 *   users/{uid}/chats/{threadKey}     → per-chat cumulative metadata + tokens
 *   users/{uid}/dailyUsage/{date}     → per-day token totals (incremented by deltas)
 *
 * Token totals (inputTokens/outputTokens/…) are cumulative-monotonic per thread,
 * so per-chat docs store the latest cumulative value and the daily bucket is
 * incremented only by the positive delta since the last recorded value. The
 * last-recorded map is persisted in localStorage so deltas survive reloads and
 * never double-count.
 */
import type { ThreadId } from "@t3tools/contracts";

import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import { useStore, type EnvironmentState } from "../store";
import { getFirebase } from "./firebase";

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface ChatRecord {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly provider: string | null;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly messageCount: number;
  readonly toolUses: number | null;
  readonly createdAt: string | null;
  readonly totals: UsageTotals;
}

const STORAGE_PREFIX = "t3code:desktopUsage:v1:";
const FLUSH_DEBOUNCE_MS = 1500;

function zeroTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function threadKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

function localDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Reads the latest cumulative usage totals for a thread from its activities. */
function deriveThreadTotals(env: EnvironmentState, threadId: ThreadId): UsageTotals {
  const activityIds = env.activityIdsByThreadId[threadId];
  const activityMap = env.activityByThreadId[threadId];
  if (!activityIds || !activityMap) {
    return zeroTotals();
  }
  const activities = activityIds.map((id) => activityMap[id]).filter((a) => a !== undefined);
  const snapshot = deriveLatestContextWindowSnapshot(activities);
  if (!snapshot) {
    return zeroTotals();
  }
  const inputTokens = num(snapshot.inputTokens);
  const outputTokens = num(snapshot.outputTokens);
  const cachedInputTokens = num(snapshot.cachedInputTokens);
  const reasoningOutputTokens = num(snapshot.reasoningOutputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + reasoningOutputTokens,
  };
}

function collectChatRecords(): ChatRecord[] {
  const state = useStore.getState();
  const records: ChatRecord[] = [];

  for (const [environmentId, env] of Object.entries(state.environmentStateById)) {
    for (const threadId of Object.keys(env.activityByThreadId) as ThreadId[]) {
      const totals = deriveThreadTotals(env, threadId);
      const messageCount = env.messageIdsByThreadId[threadId]?.length ?? 0;
      if (totals.totalTokens <= 0 && messageCount <= 0) {
        continue;
      }

      const shell = env.threadShellById[threadId];
      const session = env.threadSessionById[threadId];
      const summaryTitle = env.sidebarThreadSummaryById[threadId]?.title;
      const activitySnapshot = (() => {
        const activityIds = env.activityIdsByThreadId[threadId];
        const activityMap = env.activityByThreadId[threadId];
        if (!activityIds || !activityMap) return null;
        return deriveLatestContextWindowSnapshot(
          activityIds.map((id) => activityMap[id]).filter((a) => a !== undefined),
        );
      })();

      records.push({
        environmentId,
        threadId,
        projectId: shell?.projectId ?? null,
        title: shell?.title ?? summaryTitle ?? "Untitled chat",
        provider: session?.provider ?? null,
        providerInstanceId: session?.providerInstanceId ?? null,
        model: shell?.modelSelection?.model ?? null,
        messageCount,
        toolUses: activitySnapshot?.toolUses ?? null,
        createdAt: shell?.createdAt ?? null,
        totals,
      });
    }
  }

  return records;
}

export interface DesktopAnalyticsRecorder {
  stop: () => void;
}

/**
 * Starts mirroring local chat usage to Firestore for the given user. Returns a
 * handle whose `stop()` tears down the subscription (call on sign-out/unmount).
 */
export function startDesktopAnalyticsRecorder(user: {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}): DesktopAnalyticsRecorder {
  const storageKey = `${STORAGE_PREFIX}${user.uid}`;
  const lastRecorded = loadLastRecorded(storageKey);

  let stopped = false;
  let flushing = false;
  let rerun = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const persist = () => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(lastRecorded));
    } catch {
      // Non-fatal: deltas may be recomputed conservatively after a reload.
    }
  };

  const flush = async () => {
    if (stopped) return;
    if (flushing) {
      rerun = true;
      return;
    }
    flushing = true;
    try {
      const records = collectChatRecords();
      if (records.length === 0) return;

      const { db } = await getFirebase();
      const { doc, setDoc, serverTimestamp, increment } = await import("firebase/firestore");

      const dateKey = localDateKey(new Date());
      const dailyDelta = zeroTotals();
      const writes: Promise<unknown>[] = [];

      for (const record of records) {
        const key = threadKey(record.environmentId, record.threadId);
        const previous = lastRecorded[key] ?? zeroTotals();
        const totals = record.totals;

        const delta = {
          inputTokens: Math.max(0, totals.inputTokens - previous.inputTokens),
          outputTokens: Math.max(0, totals.outputTokens - previous.outputTokens),
          cachedInputTokens: Math.max(0, totals.cachedInputTokens - previous.cachedInputTokens),
          reasoningOutputTokens: Math.max(
            0,
            totals.reasoningOutputTokens - previous.reasoningOutputTokens,
          ),
          totalTokens: Math.max(0, totals.totalTokens - previous.totalTokens),
        };

        const changed =
          delta.totalTokens > 0 ||
          delta.inputTokens > 0 ||
          delta.outputTokens > 0 ||
          delta.reasoningOutputTokens > 0 ||
          delta.cachedInputTokens > 0 ||
          lastRecorded[key] === undefined;

        if (!changed) continue;

        dailyDelta.inputTokens += delta.inputTokens;
        dailyDelta.outputTokens += delta.outputTokens;
        dailyDelta.cachedInputTokens += delta.cachedInputTokens;
        dailyDelta.reasoningOutputTokens += delta.reasoningOutputTokens;
        dailyDelta.totalTokens += delta.totalTokens;

        const chatRef = doc(db, "users", user.uid, "chats", key);
        writes.push(
          setDoc(
            chatRef,
            {
              environmentId: record.environmentId,
              threadId: record.threadId,
              projectId: record.projectId,
              title: record.title,
              provider: record.provider,
              providerInstanceId: record.providerInstanceId,
              model: record.model,
              messageCount: record.messageCount,
              toolUses: record.toolUses,
              inputTokens: totals.inputTokens,
              outputTokens: totals.outputTokens,
              cachedInputTokens: totals.cachedInputTokens,
              reasoningOutputTokens: totals.reasoningOutputTokens,
              totalTokens: totals.totalTokens,
              chatCreatedAt: record.createdAt,
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          ),
        );

        lastRecorded[key] = totals;
      }

      const hasDailyDelta = dailyDelta.totalTokens > 0;
      if (hasDailyDelta) {
        const dailyRef = doc(db, "users", user.uid, "dailyUsage", dateKey);
        writes.push(
          setDoc(
            dailyRef,
            {
              date: dateKey,
              inputTokens: increment(dailyDelta.inputTokens),
              outputTokens: increment(dailyDelta.outputTokens),
              cachedInputTokens: increment(dailyDelta.cachedInputTokens),
              reasoningOutputTokens: increment(dailyDelta.reasoningOutputTokens),
              totalTokens: increment(dailyDelta.totalTokens),
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          ),
        );
      }

      if (writes.length > 0) {
        await Promise.all(writes);
        persist();
      }
    } catch (error) {
      // Analytics must never break the app; log and retry on the next change.
      console.warn("[desktop-analytics] failed to record usage", error);
    } finally {
      flushing = false;
      if (rerun && !stopped) {
        rerun = false;
        scheduleFlush();
      }
    }
  };

  function scheduleFlush() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  // Record the user profile once on start (best-effort).
  void (async () => {
    try {
      const { db } = await getFirebase();
      const { doc, setDoc, serverTimestamp } = await import("firebase/firestore");
      await setDoc(
        doc(db, "users", user.uid),
        {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
          lastSeenAt: serverTimestamp(),
        },
        { merge: true },
      );
    } catch (error) {
      console.warn("[desktop-analytics] failed to record profile", error);
    }
  })();

  const unsubscribe = useStore.subscribe(scheduleFlush);
  scheduleFlush();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    },
  };
}

function loadLastRecorded(storageKey: string): Record<string, UsageTotals> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, UsageTotals>;
    }
  } catch {
    // Corrupt/missing — start fresh.
  }
  return {};
}
