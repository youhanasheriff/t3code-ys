import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import {
  buildRoleBrief,
  isPathPermitted,
  matchesGlobPattern,
  parsePlannerAssignments,
  resolveRoleModel,
} from "./workerRoles.ts";

describe("workerRoles", () => {
  describe("matchesGlobPattern and isPathPermitted", () => {
    it("allows any path when targetPaths is empty", () => {
      expect(isPathPermitted("apps/web/src/App.tsx", [])).toBe(true);
      expect(isPathPermitted("packages/contracts/src/settings.ts", [])).toBe(true);
    });

    it("matches globstar patterns correctly", () => {
      const frontendPaths = ["apps/web/**", "apps/desktop/**", "packages/ui/**"];
      expect(isPathPermitted("apps/web/src/components/Button.tsx", frontendPaths)).toBe(true);
      expect(isPathPermitted("apps/desktop/src/main.ts", frontendPaths)).toBe(true);
      expect(isPathPermitted("packages/ui/src/index.ts", frontendPaths)).toBe(true);

      expect(isPathPermitted("apps/server/src/server.ts", frontendPaths)).toBe(false);
      expect(isPathPermitted("packages/contracts/src/settings.ts", frontendPaths)).toBe(false);
    });

    it("matches single wildcards", () => {
      expect(matchesGlobPattern("foo.ts", "*.ts")).toBe(true);
      expect(matchesGlobPattern("bar.js", "*.ts")).toBe(false);
      expect(matchesGlobPattern("sub/foo.ts", "*.ts")).toBe(false);
    });
  });

  describe("resolveRoleModel", () => {
    it("resolves default models for each role", () => {
      const plannerModel = resolveRoleModel(DEFAULT_SERVER_SETTINGS, "planner");
      expect(plannerModel?.model).toBe("glm-5.3-flash");

      const frontendModel = resolveRoleModel(DEFAULT_SERVER_SETTINGS, "frontendWorker");
      expect(frontendModel?.model).toBe("claude-opus-5-5");

      const backendModel = resolveRoleModel(DEFAULT_SERVER_SETTINGS, "backendWorker");
      expect(backendModel?.model).toBe("gpt-6-astra");

      const reviewerModel = resolveRoleModel(DEFAULT_SERVER_SETTINGS, "reviewer");
      expect(reviewerModel?.model).toBe("gpt-6-sol");
    });

    it("returns null when role is disabled", () => {
      const disabledSettings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        workerRoles: {
          frontendWorker: { enabled: false },
        },
      });
      const model = resolveRoleModel(disabledSettings, "frontendWorker");
      expect(model).toBeNull();
    });

    it("falls back to textGenerationModelSelection when modelSelection is null", () => {
      const clearedSettings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        workerRoles: {
          frontendWorker: { modelSelection: null },
        },
      });
      const model = resolveRoleModel(clearedSettings, "frontendWorker");
      expect(model).toEqual(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
    });

    it("falls back when provider instance is unavailable", () => {
      const providers: ReadonlyArray<ServerProvider> = [
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-04-11T00:00:00.000Z",
          availability: "unavailable",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ];
      const model = resolveRoleModel(DEFAULT_SERVER_SETTINGS, "frontendWorker", { providers });
      expect(model).toEqual(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
    });

    it("resolves project overrides for role models", () => {
      const projectId = ProjectId.make("project-custom");
      const customSettings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        projectSettingsOverrides: {
          [projectId]: {
            workerRoles: {
              ...DEFAULT_SERVER_SETTINGS.workerRoles,
              planner: {
                ...DEFAULT_SERVER_SETTINGS.workerRoles.planner,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-6-omni",
                  options: [],
                },
              },
            },
          },
        },
      });

      const overridden = resolveRoleModel(customSettings, "planner", { projectId });
      expect(overridden?.model).toBe("gpt-6-omni");

      const otherProject = resolveRoleModel(customSettings, "planner", {
        projectId: ProjectId.make("other"),
      });
      expect(otherProject?.model).toBe("glm-5.3-flash");
    });
  });

  describe("buildRoleBrief", () => {
    it("asks the planner for an assignment block", () => {
      const brief = buildRoleBrief({
        role: "planner",
        userRequest: "Add user profile settings page",
      });
      expect(brief).toContain("Lead Technical Planner");
      expect(brief).toContain('{"frontend"');
      expect(brief).toContain("## Original request\nAdd user profile settings page");
    });

    it("includes target paths, custom instructions, plan and assignment for workers", () => {
      const brief = buildRoleBrief({
        role: "frontendWorker",
        userRequest: "Create Avatar component",
        branchName: "feature/avatar",
        targetPaths: ["apps/web/**", "packages/ui/**"],
        customInstructions: "Use Tailwind v4 and Lucide icons exclusively.",
        plan: "Build the avatar in the web app.",
        assignment: "Create Avatar.tsx",
      });
      expect(brief).toContain("Frontend Specialist Worker");
      expect(brief).toContain("- apps/web/**");
      expect(brief).toContain("Use Tailwind v4 and Lucide icons exclusively.");
      expect(brief).toContain("Branch: feature/avatar");
      expect(brief).toContain("## Lead planner's plan\nBuild the avatar in the web app.");
      expect(brief).toContain("## Your assignment\nCreate Avatar.tsx");
    });

    it("gives the reviewer every worker report with out-of-scope files", () => {
      const brief = buildRoleBrief({
        role: "reviewer",
        userRequest: "Add avatars",
        reports: [
          {
            role: "frontendWorker",
            summary: "Added Avatar.tsx",
            changedFiles: ["apps/web/src/Avatar.tsx", "apps/server/src/x.ts"],
            outOfScopeFiles: ["apps/server/src/x.ts"],
          },
        ],
      });
      expect(brief).toContain("Do not modify codebase files directly.");
      expect(brief).toContain("### Frontend Specialist\n\nAdded Avatar.tsx");
      expect(brief).toContain("Changed outside its target paths:\n- apps/server/src/x.ts");
    });
  });

  describe("parsePlannerAssignments", () => {
    it("reads the last assignment block", () => {
      const text = [
        "Plan...",
        "```json",
        '{"example": true}',
        "```",
        "```json",
        '{"frontend": "Build the page", "backend": null}',
        "```",
      ].join("\n");
      expect(parsePlannerAssignments(text)).toEqual({ frontend: "Build the page", backend: null });
    });

    it("treats blank assignments as no work", () => {
      const text = '```json\n{"frontend": "  ", "backend": "Add the endpoint"}\n```';
      expect(parsePlannerAssignments(text)).toEqual({
        frontend: null,
        backend: "Add the endpoint",
      });
    });

    it("returns null without a usable block", () => {
      expect(parsePlannerAssignments("No json here")).toBeNull();
      expect(parsePlannerAssignments("```json\n{not json}\n```")).toBeNull();
    });
  });
});
