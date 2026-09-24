/**
 * WorkerRoleOrchestrationService - Service interface for configurable multi-agent worker roles.
 *
 * Provides prompt synthesis, model resolution, and file constraint checks for:
 * - planner: Decomposes tasks into frontend/backend assignments and verification criteria.
 * - frontendWorker: Focused on client/UI worktrees and target paths.
 * - backendWorker: Focused on server/API/contracts worktrees and target paths.
 * - reviewer: Read-only verification and code audit of the integrated diff.
 *
 * @module WorkerRoleOrchestrationService
 */
import type {
  ModelSelection,
  ProjectId,
  ServerProvider,
  ServerSettings,
  WorkerRoleConfig,
  WorkerRoleKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface WorkerRolePromptContext {
  readonly role: WorkerRoleKind;
  readonly userRequest: string;
  readonly projectTitle?: string;
  readonly branchName?: string;
  readonly customInstructions?: string;
  readonly targetPaths?: ReadonlyArray<string>;
}

export interface WorkerRolePromptResult {
  readonly role: WorkerRoleKind;
  readonly systemPrompt: string;
  readonly initialUserMessage: string;
}

export interface WorkerRoleOrchestrationShape {
  /** Resolves the effective model selection for a role, checking enablement and provider health. */
  readonly resolveRoleModel: (
    settings: ServerSettings,
    role: WorkerRoleKind,
    options?: {
      readonly providers?: ReadonlyArray<ServerProvider>;
      readonly projectId?: ProjectId | null;
    },
  ) => ModelSelection | null;

  /** Resolves the role configuration (accounting for project overrides). */
  readonly getRoleConfig: (
    settings: ServerSettings,
    role: WorkerRoleKind,
    projectId?: ProjectId | null,
  ) => WorkerRoleConfig;

  /** Synthesizes the specialized prompt and initial turn instructions for a worker role. */
  readonly buildRolePrompt: (
    context: WorkerRolePromptContext,
  ) => WorkerRolePromptResult;

  /** Checks if a file path is permitted within the worker's target paths. */
  readonly isPathPermitted: (
    filePath: string,
    targetPaths: ReadonlyArray<string>,
  ) => boolean;
}

export class WorkerRoleOrchestrationService extends Context.Service<
  WorkerRoleOrchestrationService,
  WorkerRoleOrchestrationShape
>()("t3/orchestration/WorkerRoleOrchestrationService") {}
