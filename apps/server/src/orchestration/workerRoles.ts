/**
 * Worker roles - model resolution, role briefs, and target path checks for
 * team runs. Pure helpers; `TeamRunReactor` drives the run itself.
 *
 * @module workerRoles
 */
import {
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
  TurnId,
  type WorkerRoleKind,
} from "@t3tools/contracts";
import { resolveWorkerRole } from "@t3tools/shared/projectSettings";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";

const TEAM_RUN_TURN_ID_PREFIX = "team-run:";

/**
 * A team run holds its thread's session "running" under a synthetic turn id so
 * the thread reads as working while its worker threads run. The prefix lets
 * provider-facing reactors recognize that no provider turn backs it.
 */
export const makeTeamRunTurnId = (runId: string): TurnId =>
  TurnId.make(`${TEAM_RUN_TURN_ID_PREFIX}${runId}`);

export const isTeamRunTurnId = (turnId: string | null | undefined): boolean =>
  turnId?.startsWith(TEAM_RUN_TURN_ID_PREFIX) === true;

export const WORKER_ROLE_LABELS: Record<WorkerRoleKind, string> = {
  planner: "Lead Planner",
  frontendWorker: "Frontend Specialist",
  backendWorker: "Backend Specialist",
  reviewer: "Code Reviewer",
};

export const PLANNER_BASE_PROMPT = `You are the Lead Technical Planner in a multi-agent development team.
Your role:
1. Analyze the user request thoroughly.
2. Break down the implementation into clear, decoupled subtasks for:
   - Frontend Worker: UI, client state, components, styling, routing.
   - Backend Worker: Server APIs, domain services, contracts, databases.
3. Define strict interface contracts and file scopes between the workers.
4. Establish concrete verification and testing steps for the Reviewer agent.
Do not write application code directly; produce a cohesive, actionable plan.

End your reply with a fenced \`\`\`json block that assigns the work:
{"frontend": "<frontend task, or null>", "backend": "<backend task, or null>"}
Use null for a worker that has nothing to do.`;

export const FRONTEND_BASE_PROMPT = `You are the Frontend Specialist Worker in a multi-agent development team.
Your role:
1. Implement the requested client-side UI, styling, interactions, and frontend logic.
2. Confine all file modifications strictly to frontend directories and assigned target paths.
3. Ensure responsive layout, smooth state updates, accessible markup, and zero client build errors.
4. Coordinate contract expectations with backend endpoints.
Finish with a short report of what you changed and anything the reviewer should check.`;

export const BACKEND_BASE_PROMPT = `You are the Backend Specialist Worker in a multi-agent development team.
Your role:
1. Implement the requested server endpoints, domain logic, schemas, and data persistence.
2. Confine all file modifications strictly to backend directories and contract definitions.
3. Ensure robust error handling, schema validation, and backwards compatibility.
4. Maintain clean service abstractions and type safety.
Finish with a short report of what you changed and anything the reviewer should check.`;

export const REVIEWER_BASE_PROMPT = `You are the Code Reviewer and Quality Auditor in a multi-agent development team.
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

export function isPathPermitted(filePath: string, targetPaths: ReadonlyArray<string>): boolean {
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

export interface WorkerRoleReport {
  readonly role: WorkerRoleKind;
  readonly summary: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly outOfScopeFiles: ReadonlyArray<string>;
}

export interface WorkerRoleBriefContext {
  readonly role: WorkerRoleKind;
  readonly userRequest: string;
  readonly projectTitle?: string;
  readonly branchName?: string | null;
  readonly customInstructions?: string;
  readonly targetPaths?: ReadonlyArray<string>;
  /** The planner's full reply, for every role after the planner. */
  readonly plan?: string;
  /** The planner's assignment for this worker. */
  readonly assignment?: string;
  /** Earlier workers' reports, for the reviewer. */
  readonly reports?: ReadonlyArray<WorkerRoleReport>;
}

/**
 * The first message a worker thread receives. The role instructions travel in
 * the message rather than a provider system prompt so every provider gets the
 * same brief and the user can read exactly what the worker was told.
 */
export function buildRoleBrief(context: WorkerRoleBriefContext): string {
  const sections: string[] = [ROLE_PROMPTS[context.role]];

  if (context.targetPaths && context.targetPaths.length > 0) {
    sections.push(
      `Target Path Constraints:\nYou are authorized to modify ONLY files matching the following glob patterns:\n${context.targetPaths
        .map((pattern) => `- ${pattern}`)
        .join("\n")}\nDo not modify files outside these paths.`,
    );
  }

  const customInstructions = context.customInstructions?.trim();
  if (customInstructions) {
    sections.push(`User Custom Instructions:\n${customInstructions}`);
  }

  const workspace = [
    context.projectTitle ? `Project: ${context.projectTitle}` : null,
    context.branchName ? `Branch: ${context.branchName}` : null,
  ].filter((line) => line !== null);
  if (workspace.length > 0) {
    sections.push(`## Workspace\n${workspace.join("\n")}`);
  }

  sections.push(`## Original request\n${context.userRequest}`);

  if (context.plan) {
    sections.push(`## Lead planner's plan\n${context.plan}`);
  }
  if (context.assignment) {
    sections.push(`## Your assignment\n${context.assignment}`);
  }
  if (context.reports && context.reports.length > 0) {
    sections.push(`## Worker reports\n${context.reports.map(formatWorkerRoleReport).join("\n\n")}`);
  }

  return sections.join("\n\n");
}

function formatWorkerRoleReport(report: WorkerRoleReport): string {
  const lines = [`### ${WORKER_ROLE_LABELS[report.role]}`, report.summary || "(no report)"];
  if (report.changedFiles.length > 0) {
    lines.push(`Files changed:\n${report.changedFiles.map((file) => `- ${file}`).join("\n")}`);
  }
  if (report.outOfScopeFiles.length > 0) {
    lines.push(
      `Changed outside its target paths:\n${report.outOfScopeFiles.map((file) => `- ${file}`).join("\n")}`,
    );
  }
  return lines.join("\n\n");
}

export interface PlannerAssignments {
  readonly frontend: string | null;
  readonly backend: string | null;
}

/**
 * Reads the assignment block the planner prompt asks for: the last fenced
 * json block with `frontend` / `backend` keys. Returns null when the planner
 * did not produce a usable block.
 */
export function parsePlannerAssignments(text: string): PlannerAssignments | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (const block of blocks.toReversed()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1] ?? "");
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (!("frontend" in record) && !("backend" in record)) continue;
    return {
      frontend: readAssignment(record.frontend),
      backend: readAssignment(record.backend),
    };
  }
  return null;
}

function readAssignment(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
