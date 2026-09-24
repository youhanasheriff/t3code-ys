// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
  type WorkerRoleKind,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as TeamRunReactor from "./TeamRunReactor.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-team");
const parentThreadId = ThreadId.make("thread-parent");

const makeProvider = (instanceId: string, driver: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  models: [],
  slashCommands: [],
  skills: [],
});

/** What the fake provider does when a worker turn starts. */
interface WorkerScript {
  readonly reply: string;
  readonly files?: ReadonlyArray<string>;
  readonly outcome?: "completed" | "error" | "hang";
}

describe("TeamRunReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProjectionSnapshotQuery,
    unknown
  > | null = null;

  const scopes: Array<Scope.Closeable> = [];

  afterEach(async () => {
    for (const scope of scopes.splice(0)) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    await runtime?.dispose();
    runtime = null;
  });

  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-run-"));

  async function makeHarness(input: {
    readonly scripts: Partial<Record<WorkerRoleKind, WorkerScript>>;
    readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
    readonly isGitWorkspace?: boolean;
  }) {
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = TeamRunReactor.layer.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(
        makeProviderRegistryLayer([
          makeProvider("claudeAgent", "claudeAgent"),
          makeProvider("codex", "codex"),
        ]),
      ),
      Layer.provideMerge(
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(input.isGitWorkspace ?? true),
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest(input.settings ?? {})),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const managed = ManagedRuntime.make(layer);
    runtime = managed;
    const run = <A, E>(effect: Effect.Effect<A, E, never>) => managed.runPromise(effect);

    const engine = await managed.runPromise(Effect.service(OrchestrationEngineService));
    const snapshots = await managed.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await managed.runPromise(Effect.service(TeamRunReactor.TeamRunReactor));

    // Every domain event, in order, with waiters resolved as matches land.
    const events: Array<OrchestrationEvent> = [];
    const waiters: Array<{
      readonly predicate: (event: OrchestrationEvent) => boolean;
      readonly resolve: (event: OrchestrationEvent) => void;
    }> = [];
    const waitFor = (predicate: (event: OrchestrationEvent) => boolean) => {
      const seen = events.find(predicate);
      return seen
        ? Promise.resolve(seen)
        : new Promise<OrchestrationEvent>((resolve) => waiters.push({ predicate, resolve }));
    };
    const workerRoles = new Map<ThreadId, WorkerRoleKind>();
    const briefs = new Map<WorkerRoleKind, string>();

    // Plays the provider for worker threads: runs the scripted turn and settles it.
    const playWorkerTurn = (threadId: ThreadId, role: WorkerRoleKind) =>
      Effect.gen(function* () {
        const script = input.scripts[role] ?? { reply: `${role} done` };
        const turnId = TurnId.make(`turn-${threadId}`);
        const session = (status: "running" | "ready" | "error", activeTurnId: TurnId | null) =>
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-session-${status}-${threadId}`),
            threadId,
            session: {
              threadId,
              status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId,
              lastError: status === "error" ? "provider crashed" : null,
              updatedAt: now,
            },
            createdAt: now,
          });
        yield* session("running", turnId);
        if (script.outcome === "hang") return;
        if (script.outcome === "error") {
          yield* session("error", null);
          return;
        }
        const messageId = MessageId.make(`assistant-${threadId}`);
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`cmd-delta-${threadId}`),
          threadId,
          messageId,
          delta: script.reply,
          turnId,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(`cmd-complete-${threadId}`),
          threadId,
          messageId,
          turnId,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-diff-${threadId}`),
          threadId,
          turnId,
          completedAt: now,
          checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${threadId}/turn/1`),
          status: "ready",
          files: (script.files ?? []).map((path) => ({
            path,
            kind: "modified",
            additions: 1,
            deletions: 0,
          })),
          assistantMessageId: messageId,
          checkpointTurnCount: 1,
          createdAt: now,
        });
        yield* session("ready", null);
      }).pipe(Effect.orDie);

    const onEvent = (event: OrchestrationEvent) => {
      events.push(event);
      for (const waiter of waiters.filter((entry) => entry.predicate(event))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
      if (event.type === "thread.created" && event.payload.teamWorker) {
        workerRoles.set(event.payload.threadId, event.payload.teamWorker.role);
      }
      if (event.type === "thread.message-sent" && event.payload.role === "user") {
        const role = workerRoles.get(event.payload.threadId);
        if (role) briefs.set(role, event.payload.text);
      }
      if (event.type === "thread.turn-start-requested") {
        const role = workerRoles.get(event.payload.threadId);
        if (role) return Effect.forkDetach(playWorkerTurn(event.payload.threadId, role));
      }
      if (
        event.type === "thread.turn-interrupt-requested" &&
        workerRoles.has(event.payload.threadId)
      ) {
        return Effect.forkDetach(
          engine
            .dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(`cmd-session-interrupted-${event.payload.threadId}`),
              threadId: event.payload.threadId,
              session: {
                threadId: event.payload.threadId,
                status: "interrupted",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: now,
              },
              createdAt: now,
            })
            .pipe(Effect.orDie),
        );
      }
      return Effect.void;
    };

    // Both consumers are subscribed once this resolves: start() subscribes before returning.
    const scope = await run(Scope.make());
    scopes.push(scope);
    await run(
      Effect.gen(function* () {
        const subscription = yield* engine.subscribeDomainEvents;
        yield* Effect.forkIn(Stream.runForEach(subscription, onEvent), scope);
        yield* reactor.start();
      }).pipe(Scope.provide(scope)),
    );

    await run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project"),
        projectId,
        title: "Team Project",
        workspaceRoot: "/tmp/team-project",
        defaultModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        createdAt: now,
      }),
    );
    await run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-parent"),
        threadId: parentThreadId,
        projectId,
        title: "Add avatars",
        modelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    const startTeamRun = (commandId = "cmd-team-turn", options?: { readonly teamRun: false }) =>
      run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId: parentThreadId,
          message: {
            messageId: MessageId.make(`message-${commandId}`),
            role: "user",
            text: "Add avatars to profiles",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          ...(options?.teamRun === false ? {} : { teamRun: true as const }),
          createdAt: now,
        }),
      );

    const parentSessionSettled = () =>
      waitFor(
        (event) =>
          event.type === "thread.session-set" &&
          event.payload.threadId === parentThreadId &&
          event.payload.session.activeTurnId === null &&
          event.payload.session.status !== "running",
      );

    const parentDetail = async () => {
      const detail = await run(snapshots.getThreadDetailById(parentThreadId));
      return Option.getOrThrow(detail);
    };

    return {
      run,
      engine,
      events,
      waitFor,
      workerRoles,
      briefs,
      startTeamRun,
      parentSessionSettled,
      parentDetail,
    };
  }

  const planWith = (assignments: { frontend: string | null; backend: string | null }) =>
    ["Plan: add an avatar.", "```json", JSON.stringify(assignments), "```"].join("\n");

  it("runs the planned roles in order and posts the review on the parent", async () => {
    const harness = await makeHarness({
      scripts: {
        planner: { reply: planWith({ frontend: "Build the Avatar component", backend: null }) },
        frontendWorker: {
          reply: "Added Avatar.tsx",
          files: ["apps/web/src/Avatar.tsx", "apps/server/src/leak.ts"],
        },
        reviewer: { reply: "Approved with one note." },
      },
    });

    await harness.startTeamRun();
    const settled = await harness.parentSessionSettled();

    expect(settled.type === "thread.session-set" && settled.payload.session.status).toBe("ready");
    expect([...harness.workerRoles.values()]).toEqual(["planner", "frontendWorker", "reviewer"]);
    expect(harness.briefs.get("frontendWorker")).toContain(
      "## Your assignment\nBuild the Avatar component",
    );
    expect(harness.briefs.get("reviewer")).toContain(
      "Changed outside its target paths:\n- apps/server/src/leak.ts",
    );

    const parent = await harness.parentDetail();
    expect(parent.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Approved with one note.",
    });
    expect(parent.latestTurn?.state).toBe("completed");
    const roleRows = harness.events.flatMap((event) =>
      event.type === "thread.activity-appended" &&
      event.payload.threadId === parentThreadId &&
      event.payload.activity.kind === "team-run.role"
        ? [event.payload.activity.payload as TeamRunReactor.TeamRunRoleActivityPayload]
        : [],
    );
    expect(roleRows.map((row) => `${row.role}:${row.status}`)).toEqual([
      "planner:running",
      "planner:completed",
      "frontendWorker:running",
      "frontendWorker:completed",
      "backendWorker:skipped",
      "reviewer:running",
      "reviewer:completed",
    ]);
    expect(
      roleRows.find((row) => row.role === "frontendWorker" && row.status === "completed")
        ?.outOfScopeFiles,
    ).toEqual(["apps/server/src/leak.ts"]);
  });

  it("fails the run when a worker fails and skips the remaining roles", async () => {
    const harness = await makeHarness({
      scripts: {
        planner: { reply: planWith({ frontend: "UI", backend: "API" }) },
        frontendWorker: { reply: "", outcome: "error" },
      },
    });

    await harness.startTeamRun();
    const settled = await harness.parentSessionSettled();

    expect(settled.type === "thread.session-set" && settled.payload.session).toMatchObject({
      status: "error",
      lastError: "Frontend Specialist failed: provider crashed",
    });
    expect([...harness.workerRoles.values()]).toEqual(["planner", "frontendWorker"]);
    const parent = await harness.parentDetail();
    expect(parent.activities.some((activity) => activity.kind === "team-run.failed")).toBe(true);
  });

  it("gives every worker the whole request when the planner is disabled", async () => {
    const harness = await makeHarness({
      settings: { workerRoles: { planner: { enabled: false }, reviewer: { enabled: false } } },
      scripts: {},
    });

    await harness.startTeamRun();
    await harness.parentSessionSettled();

    expect([...harness.workerRoles.values()]).toEqual(["frontendWorker", "backendWorker"]);
    expect(harness.briefs.get("backendWorker")).not.toContain("## Your assignment");
    const parent = await harness.parentDetail();
    expect(parent.messages.at(-1)?.text).toBe("backendWorker done");
  });

  it("stops the active worker when the parent turn is interrupted", async () => {
    const harness = await makeHarness({
      scripts: { planner: { reply: "", outcome: "hang" } },
    });

    await harness.startTeamRun();
    const plannerRunning = await harness.waitFor(
      (event) =>
        event.type === "thread.session-set" &&
        harness.workerRoles.get(event.payload.threadId) === "planner" &&
        event.payload.session.status === "running",
    );

    // Neither a second team run nor a normal turn can start while this one is running.
    await expect(harness.startTeamRun("cmd-team-turn-2")).rejects.toThrow("is running a team run");
    await expect(harness.startTeamRun("cmd-normal-turn", { teamRun: false })).rejects.toThrow(
      "is running a team run",
    );

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-interrupt-parent"),
        threadId: parentThreadId,
        createdAt: now,
      }),
    );
    const settled = await harness.parentSessionSettled();

    expect(settled.type === "thread.session-set" && settled.payload.session.status).toBe(
      "interrupted",
    );
    expect(
      harness.events.some(
        (event) =>
          event.type === "thread.turn-interrupt-requested" &&
          event.payload.threadId === plannerRunning.aggregateId,
      ),
    ).toBe(true);
  });
});
