/**
 * Desktop-only "Usage" settings tab.
 *
 * Reads the signed-in user's token-usage analytics back from Firestore (written
 * by `analyticsRecorder.ts`) and presents all-time totals, a per-day breakdown,
 * and the chats that consumed the most tokens. Everything here is read-only and
 * guarded by `isElectron` + a signed-in user; the hosted web build never loads
 * Firebase and renders a short notice instead.
 */
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { isElectron } from "../../env";
import { getFirebase } from "../../desktopAuth/firebase";
import { useDesktopAuthStore } from "../../desktopAuth/desktopAuthStore";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const NUMBER_FORMAT = new Intl.NumberFormat();
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const DAILY_ROWS_LIMIT = 30;
const TOP_CHATS_LIMIT = 50;

interface DailyUsage {
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

interface ChatUsage {
  readonly key: string;
  readonly title: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly messageCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

interface UsageData {
  readonly daily: ReadonlyArray<DailyUsage>;
  readonly chats: ReadonlyArray<ChatUsage>;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatTokens(value: number): string {
  return NUMBER_FORMAT.format(Math.round(value));
}

/** Formats a "YYYY-MM-DD" local date key without UTC drift. */
function formatDateKey(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return date;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(parsed.getTime())) return date;
  return DATE_FORMAT.format(parsed);
}

async function fetchUsage(uid: string): Promise<UsageData> {
  const { db } = await getFirebase();
  const { collection, getDocs, query, orderBy, limit } = await import("firebase/firestore");

  const [dailySnap, chatsSnap] = await Promise.all([
    getDocs(query(collection(db, "users", uid, "dailyUsage"), orderBy("date", "desc"))),
    getDocs(
      query(
        collection(db, "users", uid, "chats"),
        orderBy("totalTokens", "desc"),
        limit(TOP_CHATS_LIMIT),
      ),
    ),
  ]);

  const daily = dailySnap.docs.map((snapshot): DailyUsage => {
    const data = snapshot.data();
    return {
      date: str(data.date) ?? snapshot.id,
      inputTokens: num(data.inputTokens),
      outputTokens: num(data.outputTokens),
      cachedInputTokens: num(data.cachedInputTokens),
      reasoningOutputTokens: num(data.reasoningOutputTokens),
      totalTokens: num(data.totalTokens),
    };
  });

  const chats = chatsSnap.docs
    .map((snapshot): ChatUsage => {
      const data = snapshot.data();
      return {
        key: snapshot.id,
        title: str(data.title) ?? "Untitled chat",
        model: str(data.model),
        provider: str(data.provider),
        messageCount: num(data.messageCount),
        inputTokens: num(data.inputTokens),
        outputTokens: num(data.outputTokens),
        cachedInputTokens: num(data.cachedInputTokens),
        reasoningOutputTokens: num(data.reasoningOutputTokens),
        totalTokens: num(data.totalTokens),
      };
    })
    .filter((chat) => chat.totalTokens > 0 || chat.messageCount > 0);

  return { daily, chats };
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-border/60 px-4 py-3 sm:px-5">
      <div className="min-w-0 truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

function StatsGrid({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid grid-cols-2 sm:grid-cols-4">
      <span
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-border/60"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-border/60 sm:hidden"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-y-0 left-1/4 hidden w-px bg-border/60 sm:block"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-y-0 left-3/4 hidden w-px bg-border/60 sm:block"
        aria-hidden
      />
      {children}
    </div>
  );
}

function UsageRefreshButton({ isPending, onClick }: { isPending: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            disabled={isPending}
            onClick={onClick}
            aria-label="Refresh usage"
          >
            <RefreshCwIcon className={cn("size-3", isPending && "animate-spin")} />
          </Button>
        }
      />
      <TooltipPopup side="top">Refresh usage</TooltipPopup>
    </Tooltip>
  );
}

function NoticeCard({ children }: { children: ReactNode }) {
  return (
    <SettingsSection title="Usage">
      <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">{children}</div>
    </SettingsSection>
  );
}

function UsageDataView({ data, isPending }: { data: UsageData | null; isPending: boolean }) {
  const totals = (data?.daily ?? []).reduce(
    (acc, day) => ({
      inputTokens: acc.inputTokens + day.inputTokens,
      outputTokens: acc.outputTokens + day.outputTokens,
      cachedInputTokens: acc.cachedInputTokens + day.cachedInputTokens,
      reasoningOutputTokens: acc.reasoningOutputTokens + day.reasoningOutputTokens,
      totalTokens: acc.totalTokens + day.totalTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
  );

  const daily = data?.daily ?? [];
  const visibleDaily = daily.slice(0, DAILY_ROWS_LIMIT);
  const chats = data?.chats ?? [];
  const placeholder = isPending ? "..." : "0";

  return (
    <>
      <StatsGrid>
        <StatBlock
          label="Total Tokens"
          value={data ? formatTokens(totals.totalTokens) : placeholder}
        />
        <StatBlock label="Input" value={data ? formatTokens(totals.inputTokens) : placeholder} />
        <StatBlock label="Output" value={data ? formatTokens(totals.outputTokens) : placeholder} />
        <StatBlock
          label="Cached"
          value={data ? formatTokens(totals.cachedInputTokens) : placeholder}
        />
      </StatsGrid>

      <SettingsSection title="Usage by day">
        {visibleDaily.length > 0 ? (
          <ScrollArea
            chainVerticalScroll
            scrollFade
            hideScrollbars
            className="w-full max-w-full rounded-none"
          >
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pl-5">Date</th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">Input</th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">Output</th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">Cached</th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">
                    Reasoning
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold sm:pr-5">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {visibleDaily.map((day) => (
                  <tr key={day.date} className="hover:bg-muted/15">
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground sm:pl-5">
                      {formatDateKey(day.date)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                      {formatTokens(day.inputTokens)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                      {formatTokens(day.outputTokens)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                      {formatTokens(day.cachedInputTokens)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                      {formatTokens(day.reasoningOutputTokens)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium tabular-nums text-foreground sm:pr-5">
                      {formatTokens(day.totalTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        ) : (
          <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
            {isPending ? "Loading usage..." : "No usage recorded yet."}
          </div>
        )}
        {daily.length > visibleDaily.length ? (
          <div className="border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground/60 sm:px-5">
            Showing the {DAILY_ROWS_LIMIT} most recent days. Totals above include all {daily.length}{" "}
            recorded days.
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Top chats">
        {chats.length > 0 ? (
          <ScrollArea
            chainVerticalScroll
            scrollFade
            hideScrollbars
            className="w-full max-w-full rounded-none"
          >
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pl-5">Chat</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Model</th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">
                    Messages
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold sm:pr-5">
                    Total Tokens
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {chats.map((chat) => (
                  <tr key={chat.key} className="hover:bg-muted/15">
                    <td className="max-w-[280px] px-4 py-3 sm:pl-5">
                      <span
                        className="block truncate font-medium text-foreground"
                        title={chat.title}
                      >
                        {chat.title}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="block truncate" title={chat.model ?? undefined}>
                        {chat.model ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                      {NUMBER_FORMAT.format(chat.messageCount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium tabular-nums text-foreground sm:pr-5">
                      {formatTokens(chat.totalTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        ) : (
          <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
            {isPending ? "Loading chats..." : "No chat usage recorded yet."}
          </div>
        )}
      </SettingsSection>
    </>
  );
}

export function UsageSettingsPanel() {
  const user = useDesktopAuthStore((state) => state.user);
  const signIn = useDesktopAuthStore((state) => state.signIn);
  const signingIn = useDesktopAuthStore((state) => state.signingIn);
  const uid = user?.uid ?? null;

  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const load = useCallback((targetUid: string) => {
    setIsPending(true);
    setError(null);
    fetchUsage(targetUid)
      .then((result) => setData(result))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Failed to load usage.");
      })
      .finally(() => setIsPending(false));
  }, []);

  useEffect(() => {
    if (!uid) {
      setData(null);
      return;
    }
    load(uid);
  }, [uid, load]);

  if (!isElectron) {
    return (
      <SettingsPageContainer>
        <NoticeCard>Usage analytics are only available in the desktop app.</NoticeCard>
      </SettingsPageContainer>
    );
  }

  if (!uid) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Usage">
          <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <p className="text-xs text-muted-foreground">
              Sign in with Google to see your token usage.
            </p>
            <Button size="xs" variant="outline" disabled={signingIn} onClick={() => void signIn()}>
              {signingIn ? "Signing in…" : "Sign in"}
            </Button>
          </div>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Token Usage"
        headerAction={<UsageRefreshButton isPending={isPending} onClick={() => load(uid)} />}
      >
        <div className="px-4 py-3 text-xs text-muted-foreground/80 sm:px-5">
          Token usage recorded on this account across your signed-in devices.
        </div>
        {error ? (
          <div className="flex items-start gap-2 border-t border-border/60 px-4 py-3 text-xs text-destructive sm:px-5">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
      </SettingsSection>

      <UsageDataView data={data} isPending={isPending} />
    </SettingsPageContainer>
  );
}
