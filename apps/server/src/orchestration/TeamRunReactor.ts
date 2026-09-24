/**
 * TeamRunReactor - drives team runs: a user message sent with `teamRun` is
 * worked by the configured worker roles one after another, each in its own
 * worker thread that shares the parent thread's workspace.
 *
 * The parent thread never starts a provider turn. Its session is held
 * "running" under a synthetic turn id (see `makeTeamRunTurnId`) while the
 * workers run, each role's progress lands as a `team-run.role` activity, and
 * the last role's reply becomes the parent's assistant message.
 *
 * @module TeamRunReactor
 */
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadActivityTone,
  type OrchestrationThreadShell,
  ThreadId,
  type TurnId,
  type WorkerRoleKind,
} from "@t3tools/contracts";
import { resolveWorkerRole } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  buildRoleBrief,
  isPathPermitted,
  isTeamRunTurnId,
  makeTeamRunTurnId,
  parsePlannerAssignments,
  resolveRoleModel,
  WORKER_ROLE_LABELS,
  type WorkerRoleReport,
} from "./workerRoles.ts";

export class TeamRunReactor extends Context.Service<
  TeamRunReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration/TeamRunReactor") {}

/** How long a finished worker turn may wait for its checkpoint diff. */
const WORKER_DIFF_GRACE = "30 seconds";

type WorkerOutcome = "completed" | "failed" | "interrupted";

interface WorkerSettlement {
  readonly outcome: WorkerOutcome;
  readonly turnId: TurnId | null;
  readonly error: string | null;
}

type TeamRunRoleStatus = "running" | WorkerOutcome | "skipped";

/** Payload of `team-run.role` activities; clients render it as a role row. */
export interface TeamRunRoleActivityPayload {
  readonly role: WorkerRoleKind;
  readonly status: TeamRunRoleStatus;
  readonly childThreadId?: ThreadId;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly outOfScopeFiles?: ReadonlyArray<string>;
}

class TeamRunFailure extends Data.TaggedError("TeamRunFailure")<{
  readonly message: string;
}> {}

type TeamRunRequestedEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const crypto = yield* Crypto.Crypto;

  /** Run fibers keyed by the parent thread that owns them. */
  const activeRuns = new Map<ThreadId, Fiber.Fiber<unknown, unknown>>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:team-run-${tag}:${uuid}`)),
    );

  const requireShell = Effect.fn("TeamRunReactor.requireShell")(function* (threadId: ThreadId) {
    const shell = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(shell)) {
      return yield* Effect.fail(
        new TeamRunFailure({ message: `Thread '${threadId}' no longer exists.` }),
      );
    }
    return shell.value;
  });

  const setParentSession = Effect.fn("TeamRunReactor.setParentSession")(function* (
    parent: OrchestrationThreadShell,
    patch: Pick<OrchestrationSession, "status" | "activeTurnId" | "lastError">,
  ) {
    const updatedAt = yield* nowIso;
    // Keep any provider binding from earlier turns: the next normal turn reuses it.
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: yield* commandId("session"),
      threadId: parent.id,
      session: {
        threadId: parent.id,
        providerName: parent.session?.providerName ?? null,
        ...(parent.session?.providerInstanceId !== undefined
          ? { providerInstanceId: parent.session.providerInstanceId }
          : {}),
        runtimeMode: parent.runtimeMode,
        ...patch,
        updatedAt,
      },
      createdAt: updatedAt,
    });
  });

  const appendParentActivity = Effect.fn("TeamRunReactor.appendParentActivity")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly tone: OrchestrationThreadActivityTone;
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
  }) {
    const createdAt = yield* nowIso;
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: yield* commandId("activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: input.turnId,
        createdAt,
      },
      createdAt,
    });
  });

  const appendRoleActivity = (
    parentThreadId: ThreadId,
    turnId: TurnId,
    summary: string,
    payload: TeamRunRoleActivityPayload,
  ) =>
    appendParentActivity({
      threadId: parentThreadId,
      turnId,
      tone:
        payload.status === "failed" || (payload.outOfScopeFiles?.length ?? 0) > 0
          ? "error"
          : "info",
      kind: "team-run.role",
      summary,
      payload,
    });

  /**
   * Runs one role in a new worker thread and waits for its turn to finish.
   * The domain-event subscription is acquired before the turn starts so no
   * lifecycle event can slip past it.
   */
  const runWorker = Effect.fn("TeamRunReactor.runWorker")(function* (input: {
    readonly parentThreadId: ThreadId;
    readonly turnId: TurnId;
    readonly role: WorkerRoleKind;
    readonly modelSelection: ModelSelection;
    readonly brief: string;
    readonly isGitWorkspace: boolean;
  }) {
    const label = WORKER_ROLE_LABELS[input.role];
    const parent = yield* requireShell(input.parentThreadId);
    const childThreadId = ThreadId.make(yield* crypto.randomUUIDv4);
    const createdAt = yield* nowIso;
    yield* engine.dispatch({
      type: "thread.create",
      commandId: yield* commandId("worker-create"),
      threadId: childThreadId,
      projectId: parent.projectId,
      title: `${label} · ${parent.title}`,
      modelSelection: input.modelSelection,
      runtimeMode: parent.runtimeMode,
      interactionMode: "default",
      branch: parent.branch,
      worktreePath: parent.worktreePath,
      teamWorker: { parentThreadId: parent.id, role: input.role },
      createdAt,
    });
    yield* appendRoleActivity(input.parentThreadId, input.turnId, `${label} is working`, {
      role: input.role,
      status: "running",
      childThreadId,
    });

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        const settled = yield* Deferred.make<WorkerSettlement>();
        const diffFiles = yield* Deferred.make<ReadonlyArray<string>>();
        let workerTurnId: TurnId | null = null;
        const announcedRequests = new Set<string>();
        const settle = (outcome: WorkerOutcome, error: string | null) =>
          Deferred.succeed(settled, { outcome, turnId: workerTurnId, error }).pipe(Effect.asVoid);

        const observe = (event: OrchestrationEvent): Effect.Effect<void> => {
          switch (event.type) {
            case "thread.session-set": {
              if (event.payload.threadId !== childThreadId) return Effect.void;
              const session = event.payload.session;
              if (session.status === "running" && session.activeTurnId !== null) {
                workerTurnId = session.activeTurnId;
                return Effect.void;
              }
              // A session binds "ready" before its first turn runs; only a
              // turn that was seen running can complete.
              if ((session.status === "ready" || session.status === "idle") && workerTurnId) {
                return settle("completed", null);
              }
              if (session.status === "error") {
                return settle("failed", session.lastError);
              }
              if (session.status === "stopped" || session.status === "interrupted") {
                return settle("interrupted", session.lastError);
              }
              return Effect.void;
            }
            case "thread.turn-diff-completed":
              // Provider-reported placeholders carry no files; wait for the real capture.
              if (
                event.payload.threadId !== childThreadId ||
                event.payload.checkpointRef.startsWith("provider-diff:")
              ) {
                return Effect.void;
              }
              return Deferred.succeed(
                diffFiles,
                event.payload.files.map((file) => file.path),
              ).pipe(Effect.asVoid);
            case "thread.meta-updated":
              // The first worker turn may rename a temporary worktree branch;
              // keep the parent (and later workers) on the renamed branch.
              if (event.payload.threadId !== childThreadId || event.payload.branch === undefined) {
                return Effect.void;
              }
              return syncParentBranch(input.parentThreadId, event.payload.branch);
            case "thread.activity-appended": {
              const activity = event.payload.activity;
              if (
                event.payload.threadId !== childThreadId ||
                (activity.kind !== "approval.requested" &&
                  activity.kind !== "user-input.requested") ||
                announcedRequests.has(activity.id)
              ) {
                return Effect.void;
              }
              announcedRequests.add(activity.id);
              return appendParentActivity({
                threadId: input.parentThreadId,
                turnId: input.turnId,
                tone: "approval",
                kind: "team-run.attention",
                summary: `${label} is waiting for you`,
                payload: { role: input.role, childThreadId },
              }).pipe(Effect.ignoreCause({ log: true }));
            }
            default:
              return Effect.void;
          }
        };
        yield* Effect.forkScoped(Stream.runForEach(events, observe));

        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("worker-turn"),
          threadId: childThreadId,
          message: {
            messageId: MessageId.make(yield* crypto.randomUUIDv4),
            role: "user",
            text: input.brief,
            attachments: [],
          },
          modelSelection: input.modelSelection,
          runtimeMode: parent.runtimeMode,
          interactionMode: "default",
          createdAt: yield* nowIso,
        });

        const result = yield* Deferred.await(settled).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              yield* engine.dispatch({
                type: "thread.turn.interrupt",
                commandId: yield* commandId("worker-interrupt"),
                threadId: childThreadId,
                createdAt: yield* nowIso,
              });
            }).pipe(Effect.ignoreCause({ log: true })),
          ),
        );
        const changedFiles =
          result.outcome === "completed" && input.isGitWorkspace
            ? Option.getOrElse(
                yield* Deferred.await(diffFiles).pipe(Effect.timeoutOption(WORKER_DIFF_GRACE)),
                () => [] as ReadonlyArray<string>,
              )
            : [];

        const detail = yield* snapshots.getThreadDetailById(childThreadId);
        const assistantMessages = Option.isSome(detail)
          ? detail.value.messages.filter((message) => message.role === "assistant")
          : [];
        const reply =
          (result.turnId !== null
            ? assistantMessages.findLast((message) => message.turnId === result.turnId)
            : undefined) ?? assistantMessages.at(-1);

        // A worker's session is not needed once its role is done; opening the
        // worker thread and sending a message resumes it.
        yield* engine
          .dispatch({
            type: "thread.session.stop",
            commandId: yield* commandId("worker-stop"),
            threadId: childThreadId,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.ignoreCause({ log: true }));

        return {
          childThreadId,
          outcome: result.outcome,
          error: result.error,
          reply: reply?.text.trim() ?? "",
          changedFiles,
        };
      }),
    );
  });

  const syncParentBranch = (parentThreadId: ThreadId, branch: string | null) =>
    Effect.gen(function* () {
      const parent = yield* requireShell(parentThreadId);
      if (parent.branch === branch) return;
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: yield* commandId("branch-sync"),
        threadId: parentThreadId,
        branch,
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  const runTeam = Effect.fn("TeamRunReactor.runTeam")(function* (
    event: TeamRunRequestedEvent,
    turnId: TurnId,
  ) {
    const parentThreadId = event.payload.threadId;
    const parent = yield* requireShell(parentThreadId);
    yield* setParentSession(parent, { status: "running", activeTurnId: turnId, lastError: null });

    const turnStart = yield* snapshots.getTurnStartMessage({
      threadId: parentThreadId,
      messageId: event.payload.messageId,
    });
    if (Option.isNone(turnStart)) {
      return yield* Effect.fail(
        new TeamRunFailure({ message: "The team run message was not found." }),
      );
    }
    const attachmentCount = turnStart.value.message.attachments?.length ?? 0;
    const userRequest =
      attachmentCount > 0
        ? `${turnStart.value.message.text}\n\n(The request included ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"} that workers cannot see.)`
        : turnStart.value.message.text;

    const settings = yield* settingsService.getSettings;
    const providers = yield* providerRegistry.getProviders;
    const project = yield* snapshots.getProjectShellById(parent.projectId);
    const projectTitle = Option.isSome(project) ? project.value.title : undefined;
    const cwd = resolveThreadWorkspaceCwd({
      thread: parent,
      projects: Option.isSome(project) ? [project.value] : [],
    });
    const isGitWorkspace = cwd
      ? yield* checkpointStore.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false))
      : false;

    const modelFor = (role: WorkerRoleKind) =>
      resolveRoleModel(settings, role, { providers, projectId: parent.projectId });
    const configFor = (role: WorkerRoleKind) => resolveWorkerRole(settings, role, parent.projectId);
    const roles: ReadonlyArray<WorkerRoleKind> = [
      "planner",
      "frontendWorker",
      "backendWorker",
      "reviewer",
    ];
    if (roles.every((role) => modelFor(role) === null)) {
      return yield* Effect.fail(
        new TeamRunFailure({
          message: "No worker roles are enabled. Enable one in Settings → Worker roles.",
        }),
      );
    }

    const briefFor = (
      role: WorkerRoleKind,
      extra: Pick<Parameters<typeof buildRoleBrief>[0], "plan" | "assignment" | "reports">,
    ) =>
      Effect.map(requireShell(parentThreadId), (latest) =>
        buildRoleBrief({
          role,
          userRequest,
          ...(projectTitle !== undefined ? { projectTitle } : {}),
          branchName: latest.branch,
          customInstructions: configFor(role).customInstructions,
          targetPaths: configFor(role).targetPaths,
          ...extra,
        }),
      );

    const runRole = Effect.fn("TeamRunReactor.runRole")(function* (
      role: WorkerRoleKind,
      modelSelection: ModelSelection,
      brief: string,
    ) {
      const label = WORKER_ROLE_LABELS[role];
      const result = yield* runWorker({
        parentThreadId,
        turnId,
        role,
        modelSelection,
        brief,
        isGitWorkspace,
      });
      const targetPaths = configFor(role).targetPaths;
      const outOfScopeFiles = result.changedFiles.filter(
        (file) => !isPathPermitted(file, targetPaths),
      );
      const summary =
        result.outcome === "completed"
          ? outOfScopeFiles.length > 0
            ? `${label} changed ${outOfScopeFiles.length} file${outOfScopeFiles.length === 1 ? "" : "s"} outside its target paths`
            : `${label} finished`
          : result.outcome === "failed"
            ? `${label} failed`
            : `${label} was stopped`;
      yield* appendRoleActivity(parentThreadId, turnId, summary, {
        role,
        status: result.outcome,
        childThreadId: result.childThreadId,
        changedFiles: result.changedFiles,
        outOfScopeFiles,
      });
      if (result.outcome !== "completed") {
        return yield* Effect.fail(
          new TeamRunFailure({
            message: result.error
              ? `${label} ${result.outcome}: ${result.error}`
              : `${label} ${result.outcome}.`,
          }),
        );
      }
      return {
        role,
        summary: result.reply,
        changedFiles: result.changedFiles,
        outOfScopeFiles,
      } satisfies WorkerRoleReport;
    });

    let plan: string | undefined;
    let assignments: ReturnType<typeof parsePlannerAssignments> = null;
    const plannerModel = modelFor("planner");
    if (plannerModel !== null) {
      const report = yield* runRole("planner", plannerModel, yield* briefFor("planner", {}));
      plan = report.summary || undefined;
      assignments = parsePlannerAssignments(report.summary);
    }

    const reports: Array<WorkerRoleReport> = [];
    for (const role of ["frontendWorker", "backendWorker"] as const) {
      const modelSelection = modelFor(role);
      if (modelSelection === null) continue;
      // Without a readable plan every worker gets the whole request.
      const assignment =
        assignments === null
          ? undefined
          : role === "frontendWorker"
            ? assignments.frontend
            : assignments.backend;
      if (assignment === null) {
        yield* appendRoleActivity(
          parentThreadId,
          turnId,
          `${WORKER_ROLE_LABELS[role]} skipped: nothing assigned in the plan`,
          { role, status: "skipped" },
        );
        continue;
      }
      reports.push(
        yield* runRole(
          role,
          modelSelection,
          yield* briefFor(role, {
            ...(plan !== undefined ? { plan } : {}),
            ...(assignment !== undefined ? { assignment } : {}),
          }),
        ),
      );
    }

    let finalReply = reports.at(-1)?.summary ?? plan ?? "";
    const reviewerModel = modelFor("reviewer");
    if (reviewerModel !== null) {
      const review = yield* runRole(
        "reviewer",
        reviewerModel,
        yield* briefFor("reviewer", { ...(plan !== undefined ? { plan } : {}), reports }),
      );
      finalReply = review.summary;
    }

    const messageId = MessageId.make(`assistant:${turnId}`);
    const createdAt = yield* nowIso;
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: yield* commandId("reply-delta"),
      threadId: parentThreadId,
      messageId,
      delta: finalReply || "The team run finished without a summary.",
      turnId,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: yield* commandId("reply-complete"),
      threadId: parentThreadId,
      messageId,
      turnId,
      createdAt,
    });
  });

  /** Settles the parent thread's synthetic turn however the run ended. */
  const finishRun = (parentThreadId: ThreadId, turnId: TurnId, exit: Exit.Exit<void, unknown>) =>
    Effect.gen(function* () {
      const parent = yield* snapshots.getThreadShellById(parentThreadId);
      if (Option.isNone(parent) || parent.value.session?.activeTurnId !== turnId) return;
      if (Exit.isSuccess(exit)) {
        yield* setParentSession(parent.value, {
          status: "ready",
          activeTurnId: null,
          lastError: null,
        });
        return;
      }
      if (Cause.hasInterruptsOnly(exit.cause)) {
        yield* setParentSession(parent.value, {
          status: "interrupted",
          activeTurnId: null,
          lastError: null,
        });
        return;
      }
      const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
      const detail =
        failure instanceof TeamRunFailure ? failure.message : "The team run failed unexpectedly.";
      if (!(failure instanceof TeamRunFailure)) {
        yield* Effect.logWarning("team run failed", {
          threadId: parentThreadId,
          cause: Cause.pretty(exit.cause),
        });
      }
      yield* appendParentActivity({
        threadId: parentThreadId,
        turnId,
        tone: "error",
        kind: "team-run.failed",
        summary: "Team run failed",
        payload: { detail },
      });
      yield* setParentSession(parent.value, {
        status: "error",
        activeTurnId: null,
        lastError: detail,
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  const startRun = Effect.fn("TeamRunReactor.startRun")(function* (
    event: TeamRunRequestedEvent,
    scope: Scope.Scope,
  ) {
    const parentThreadId = event.payload.threadId;
    if (activeRuns.has(parentThreadId)) return;
    const turnId = makeTeamRunTurnId(yield* crypto.randomUUIDv4);
    const fiber = yield* runTeam(event, turnId).pipe(
      Effect.onExit((exit) =>
        finishRun(parentThreadId, turnId, exit).pipe(
          Effect.ensuring(Effect.sync(() => activeRuns.delete(parentThreadId))),
        ),
      ),
      Effect.forkIn(scope),
    );
    activeRuns.set(parentThreadId, fiber);
  });

  const stopRun = (threadId: ThreadId, scope: Scope.Scope) => {
    const fiber = activeRuns.get(threadId);
    return fiber ? Effect.asVoid(Effect.forkIn(Fiber.interrupt(fiber), scope)) : Effect.void;
  };

  /** Deleting a parent deletes its worker threads with it. */
  const deleteWorkers = (parentThreadId: ThreadId) =>
    Effect.gen(function* () {
      const snapshot = yield* snapshots.getShellSnapshot();
      yield* Effect.forEach(
        snapshot.threads.filter((thread) => thread.teamWorker?.parentThreadId === parentThreadId),
        (worker) =>
          Effect.gen(function* () {
            yield* engine.dispatch({
              type: "thread.delete",
              commandId: yield* commandId("worker-delete"),
              threadId: worker.id,
            });
          }),
        { discard: true },
      );
    }).pipe(Effect.ignoreCause({ log: true }));

  /**
   * A restart kills every worker session, so a parent left "running" under a
   * team-run turn can never finish. Settle it as interrupted.
   */
  const settleOrphanedRuns = Effect.gen(function* () {
    const readModel = yield* snapshots.getCommandReadModel();
    yield* Effect.forEach(
      readModel.threads.filter(
        (thread) =>
          thread.deletedAt === null &&
          thread.session?.status === "running" &&
          isTeamRunTurnId(thread.session.activeTurnId),
      ),
      (thread) =>
        Effect.gen(function* () {
          const shell = yield* snapshots.getThreadShellById(thread.id);
          if (Option.isNone(shell)) return;
          yield* setParentSession(shell.value, {
            status: "interrupted",
            activeTurnId: null,
            lastError: "The team run stopped when the server restarted.",
          });
        }),
      { discard: true },
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  const processEvent = (event: OrchestrationEvent, scope: Scope.Scope) => {
    switch (event.type) {
      case "thread.turn-start-requested":
        return event.payload.teamRun === true
          ? startRun(event, scope).pipe(Effect.ignoreCause({ log: true }))
          : Effect.void;
      case "thread.turn-interrupt-requested":
      case "thread.session-stop-requested":
      case "thread.archived":
        return stopRun(event.payload.threadId, scope);
      case "thread.deleted":
        return stopRun(event.payload.threadId, scope).pipe(
          Effect.andThen(deleteWorkers(event.payload.threadId)),
        );
      default:
        return Effect.void;
    }
  };

  const start: TeamRunReactor["Service"]["start"] = Effect.fn("TeamRunReactor.start")(function* () {
    const scope = yield* Effect.scope;
    // Subscribed before settling orphans so no new run request is missed meanwhile.
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      settleOrphanedRuns.pipe(
        Effect.andThen(Stream.runForEach(events, (event) => processEvent(event, scope))),
      ),
    );
  });

  return { start } satisfies TeamRunReactor["Service"];
});

export const layer = Layer.effect(TeamRunReactor, make);
