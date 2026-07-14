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
 *   users/{uid}/providers/{provider}/dailyUsage/{date}
 *                                      → provider-scoped daily token totals
 *
 * Token totals (inputTokens/outputTokens/…) are cumulative-monotonic per thread.
 * A Firestore transaction compares each snapshot with its server-side chat doc,
 * updates that checkpoint, and increments daily buckets atomically. Firestore is
 * authoritative, so clearing browser storage or reinstalling cannot double-count.
 */
import type { ThreadId } from "@t3tools/contracts";

import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import { useStore, type EnvironmentState } from "../store";
import { getFirebase } from "./firebase";
import { deriveRecoveredDailyTotals } from "./usageRecovery";

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

interface RecoveredUsageRecord {
  readonly id: string;
  readonly threadKey: string;
  readonly date: string;
  readonly provider: string;
  readonly totalTokens: number;
}

const FLUSH_DEBOUNCE_MS = 1500;
const UNKNOWN_PROVIDER = "unknown";
const USAGE_SCHEMA_VERSION = 2;
const RECOVERY_SCHEMA_VERSION = 1;
const RECOVERY_BATCH_SIZE = 400;

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

function providerKey(provider: string | null): string {
  const raw = provider?.trim().toLowerCase() ?? "";
  if (raw.length === 0) return UNKNOWN_PROVIDER;
  return raw.replace(/[^a-z0-9._-]+/g, "_") || UNKNOWN_PROVIDER;
}

function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
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
    // Codex's cumulative total already includes reasoning output. Prefer it
    // when available; input + output is the equivalent fallback.
    totalTokens: num(snapshot.totalProcessedTokens) || inputTokens + outputTokens,
  };
}

function collectChatRecords(): ChatRecord[] {
  const state = useStore.getState();
  const records: ChatRecord[] = [];

  for (const [environmentId, env] of Object.entries(state.environmentStateById)) {
    for (const threadId of Object.keys(env.activityByThreadId) as ThreadId[]) {
      const session = env.threadSessionById[threadId];

      const totals = deriveThreadTotals(env, threadId);
      const messageCount = env.messageIdsByThreadId[threadId]?.length ?? 0;
      if (totals.totalTokens <= 0 && messageCount <= 0) {
        continue;
      }

      const shell = env.threadShellById[threadId];
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

function collectRecoveredUsageRecords(): RecoveredUsageRecord[] {
  const state = useStore.getState();
  const records: RecoveredUsageRecord[] = [];

  for (const [environmentId, env] of Object.entries(state.environmentStateById)) {
    for (const threadId of Object.keys(env.activityByThreadId) as ThreadId[]) {
      const provider = providerKey(env.threadSessionById[threadId]?.provider ?? null);
      if (provider !== "codex") continue;
      const activityIds = env.activityIdsByThreadId[threadId] ?? [];
      const activityMap = env.activityByThreadId[threadId] ?? {};
      const activities = activityIds
        .map((id) => activityMap[id])
        .filter((activity) => activity !== undefined);
      const key = threadKey(environmentId, threadId);

      for (const daily of deriveRecoveredDailyTotals(activities)) {
        records.push({
          id: `${encodeURIComponent(key)}:${daily.date}`,
          threadKey: key,
          date: daily.date,
          provider,
          totalTokens: daily.totalTokens,
        });
      }
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
  let stopped = false;
  let flushing = false;
  let rerun = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const recoveredFingerprints = new Map<string, number>();

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
      const recoveredRecords = collectRecoveredUsageRecords();

      const { db } = await getFirebase();
      const { doc, setDoc, serverTimestamp, increment, runTransaction, writeBatch } =
        await import("firebase/firestore");

      const dateKey = localDateKey(new Date());
      await runTransaction(db, async (transaction) => {
        const chatEntries = records.map((record) => {
          const key = threadKey(record.environmentId, record.threadId);
          return { record, key, ref: doc(db, "users", user.uid, "chats", key) };
        });
        const snapshots = await Promise.all(chatEntries.map(({ ref }) => transaction.get(ref)));
        const dailyDelta = zeroTotals();
        const providerDailyDeltas = new Map<
          string,
          { readonly provider: string | null; readonly totals: UsageTotals }
        >();

        chatEntries.forEach(({ record, ref }, index) => {
          const snapshot = snapshots[index];
          const stored = snapshot?.data();
          const previous: UsageTotals = {
            inputTokens: num(stored?.inputTokens),
            outputTokens: num(stored?.outputTokens),
            cachedInputTokens: num(stored?.cachedInputTokens),
            reasoningOutputTokens: num(stored?.reasoningOutputTokens),
            totalTokens: num(stored?.totalTokens),
          };
          const totals = record.totals;
          const isSchemaMigration =
            snapshot?.exists() && stored?.usageSchemaVersion !== USAGE_SCHEMA_VERSION;
          const delta: UsageTotals = {
            inputTokens: isSchemaMigration
              ? 0
              : Math.max(0, totals.inputTokens - previous.inputTokens),
            outputTokens: isSchemaMigration
              ? 0
              : Math.max(0, totals.outputTokens - previous.outputTokens),
            cachedInputTokens: isSchemaMigration
              ? 0
              : Math.max(0, totals.cachedInputTokens - previous.cachedInputTokens),
            reasoningOutputTokens: isSchemaMigration
              ? 0
              : Math.max(0, totals.reasoningOutputTokens - previous.reasoningOutputTokens),
            totalTokens: isSchemaMigration
              ? 0
              : Math.max(0, totals.totalTokens - previous.totalTokens),
          };
          const hasTokenDelta =
            delta.totalTokens > 0 ||
            delta.inputTokens > 0 ||
            delta.outputTokens > 0 ||
            delta.reasoningOutputTokens > 0 ||
            delta.cachedInputTokens > 0;
          const metadataChanged =
            !snapshot?.exists() ||
            stored?.title !== record.title ||
            stored?.model !== record.model ||
            stored?.provider !== record.provider ||
            stored?.messageCount !== record.messageCount ||
            isSchemaMigration;
          const provider = providerKey(record.provider);

          if (!hasTokenDelta && !metadataChanged) return;

          transaction.set(
            ref,
            {
              environmentId: record.environmentId,
              threadId: record.threadId,
              projectId: record.projectId,
              title: record.title,
              provider: record.provider,
              providerKey: provider,
              providerInstanceId: record.providerInstanceId,
              model: record.model,
              messageCount: record.messageCount,
              toolUses: record.toolUses,
              usageSchemaVersion: USAGE_SCHEMA_VERSION,
              inputTokens: totals.inputTokens,
              outputTokens: totals.outputTokens,
              cachedInputTokens: totals.cachedInputTokens,
              reasoningOutputTokens: totals.reasoningOutputTokens,
              totalTokens: totals.totalTokens,
              chatCreatedAt: record.createdAt,
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );

          if (!hasTokenDelta) return;
          addTotals(dailyDelta, delta);
          const providerDaily = providerDailyDeltas.get(provider) ?? {
            provider: record.provider,
            totals: zeroTotals(),
          };
          addTotals(providerDaily.totals, delta);
          providerDailyDeltas.set(provider, providerDaily);
        });

        if (dailyDelta.totalTokens > 0) {
          const dailyRef = doc(db, "users", user.uid, "dailyUsage", dateKey);
          transaction.set(
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
          );
        }

        for (const [provider, daily] of providerDailyDeltas) {
          if (daily.totals.totalTokens <= 0) continue;
          const providerDailyRef = doc(
            db,
            "users",
            user.uid,
            "providers",
            provider,
            "dailyUsage",
            dateKey,
          );
          transaction.set(
            providerDailyRef,
            {
              date: dateKey,
              provider: daily.provider,
              providerKey: provider,
              inputTokens: increment(daily.totals.inputTokens),
              outputTokens: increment(daily.totals.outputTokens),
              cachedInputTokens: increment(daily.totals.cachedInputTokens),
              reasoningOutputTokens: increment(daily.totals.reasoningOutputTokens),
              totalTokens: increment(daily.totals.totalTokens),
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        }
      });

      const pendingRecovery = recoveredRecords.filter(
        (record) => recoveredFingerprints.get(record.id) !== record.totalTokens,
      );
      for (let offset = 0; offset < pendingRecovery.length; offset += RECOVERY_BATCH_SIZE) {
        const batchRecords = pendingRecovery.slice(offset, offset + RECOVERY_BATCH_SIZE);
        const batch = writeBatch(db);
        for (const record of batchRecords) {
          batch.set(
            doc(db, "users", user.uid, "recoveredDailyUsage", record.id),
            {
              date: record.date,
              provider: record.provider,
              threadKey: record.threadKey,
              totalTokens: record.totalTokens,
              recoverySchemaVersion: RECOVERY_SCHEMA_VERSION,
              recoveredAt: serverTimestamp(),
            },
            { merge: true },
          );
        }
        await batch.commit();
        for (const record of batchRecords) {
          recoveredFingerprints.set(record.id, record.totalTokens);
        }
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
