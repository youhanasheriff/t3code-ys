/**
 * WorkerRoleOrchestration - Implementation of worker roles prompt synthesis,
 * model selection resolution, and file constraint verification.
 *
 * @module WorkerRoleOrchestration
 */
import {
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
  type WorkerRoleConfig,
  type WorkerRoleKind,
} from "@t3tools/contracts";
import { resolveWorkerRole } from "@t3tools/shared/projectSettings";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  WorkerRoleOrchestrationService,
  type WorkerRoleOrchestrationShape,
  type WorkerRolePromptContext,
  type WorkerRolePromptResult,
} from "../Services/WorkerRoleOrchestrationService.ts";

export const PLANNER_BASE_PROMPT = `You are the Lead Technical Planner in a multi-agent development orchestration.
Your role:
1. Analyze the user request thoroughly.
2. Break down the implementation into clear, decoupled subtasks for:
   - Frontend Worker: UI, client state, components, styling, routing.
   - Backend Worker: Server APIs, domain services, contracts, databases.
3. Define strict interface contracts and file scopes between the workers.
4. Establish concrete verification and testing steps for the Reviewer agent.
Do not write application code directly; produce a cohesive, actionable plan.`;

export const FRONTEND_BASE_PROMPT = `You are the Frontend Specialist Worker in a multi-agent development orchestration.
Your role:
1. Implement the requested client-side UI, styling, interactions, and frontend logic.
2. Confine all file modifications strictly to frontend directories and assigned target paths.
3. Ensure responsive layout, smooth state updates, accessible markup, and zero client build errors.
4. Coordinate contract expectations with backend endpoints.`;

export const BACKEND_BASE_PROMPT = `You are the Backend Specialist Worker in a multi-agent development orchestration.
Your role:
1. Implement the requested server endpoints, domain logic, schemas, and data persistence.
2. Confine all file modifications strictly to backend directories and contract definitions.
3. Ensure robust error handling, schema validation, and backwards compatibility.
4. Maintain clean service abstractions and type safety.`;

export const REVIEWER_BASE_PROMPT = `You are the Code Reviewer and Quality Auditor in a multi-agent development orchestration.
Your role:
1. Perform a meticulous, read-only audit of the integrated code changes across frontend and backend.
2. Check for architectural adherence, safety, potential regressions, and error handling.
3. Verify that the implementation satisfies the original user request and planner criteria.
4. Provide structured, actionable review feedback (Approval or Specific Revision Items).
Do not modify codebase files directly.`;

const ROLE_PROMPTS: Record<WorkerRoleKind, string> = {
  planner: PLANNER_BASE_PROMPT,
  frontendWorker: FRONTEND_BASE_PROMPT,
  backendWorker: BACKEND_BASE_PROMPT,
  reviewer: REVIEWER_BASE_PROMPT,
};

export function matchesGlobPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/^\/+/, "");
  const normalizedPattern = pattern.replace(/^\/+/, "");

  if (normalizedPattern === "**" || normalizedPattern === "*") return true;

  // Escape special regex characters except *
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___GLOBSTAR___/g, ".*");

  const regex = new RegExp(`^${escaped}$`);
  return regex.test(normalizedPath);
}

export function isPathPermitted(
  filePath: string,
  targetPaths: ReadonlyArray<string>,
): boolean {
  if (targetPaths.length === 0) {
    return true;
  }
  return targetPaths.some((pattern) => matchesGlobPattern(filePath, pattern));
}

export function resolveRoleModel(
  settings: ServerSettings,
  role: WorkerRoleKind,
  options?: {
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly projectId?: ProjectId | null;
  },
): ModelSelection | null {
  const roleConfig = resolveWorkerRole(settings, role, options?.projectId);
  if (!roleConfig.enabled) {
    return null;
  }
  const selection = roleConfig.modelSelection;
  const fallback = settings.defaultModelSelection ?? settings.textGenerationModelSelection;

  if (!selection) {
    return fallback;
  }
  if (!isModelSelectionProviderEnabled(settings, selection)) {
    return fallback;
  }
  if (options?.providers !== undefined) {
    const provider = options.providers.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    if (!provider || !provider.enabled || !isProviderAvailable(provider)) {
      return fallback;
    }
  }
  return selection;
}

export function buildRolePrompt(
  context: WorkerRolePromptContext,
): WorkerRolePromptResult {
  const baseSystem = ROLE_PROMPTS[context.role];
  const parts: string[] = [baseSystem];

  if (context.targetPaths && context.targetPaths.length > 0) {
    parts.push(
      `\nTarget Path Constraints:\nYou are authorized to modify ONLY files matching the following glob patterns:\n${context.targetPaths
        .map((p) => `- ${p}`)
        .join("\n")}\nDo not modify files outside these paths.`,
    );
  }

  if (context.customInstructions && context.customInstructions.trim().length > 0) {
    parts.push(`\nUser Custom Instructions:\n${context.customInstructions.trim()}`);
  }

  const systemPrompt = parts.join("\n\n");

  const initialUserMessage = context.userRequest;

  return {
    role: context.role,
    systemPrompt,
    initialUserMessage,
  };
}

export function makeWorkerRoleOrchestration(): WorkerRoleOrchestrationShape {
  return {
    resolveRoleModel,
    getRoleConfig: (settings, role, projectId) => resolveWorkerRole(settings, role, projectId),
    buildRolePrompt,
    isPathPermitted,
  };
}

export const layer = Layer.succeed(
  WorkerRoleOrchestrationService,
  makeWorkerRoleOrchestration(),
);
