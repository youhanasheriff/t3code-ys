import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import {
  buildRolePrompt,
  isPathPermitted,
  matchesGlobPattern,
  resolveRoleModel,
} from "./WorkerRoleOrchestration.ts";

describe("WorkerRoleOrchestration", () => {
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
          driver: "claudeAgent",
          displayName: "Claude",
          enabled: false,
          available: false,
          configured: false,
          customModels: [],
          models: [],
          defaultModel: "claude-opus-5-5",
          diagnostics: [],
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

  describe("buildRolePrompt", () => {
    it("builds prompt for planner", () => {
      const result = buildRolePrompt({
        role: "planner",
        userRequest: "Add user profile settings page",
      });
      expect(result.systemPrompt).toContain("Lead Technical Planner");
      expect(result.systemPrompt).toContain("Frontend Worker");
      expect(result.systemPrompt).toContain("Backend Worker");
      expect(result.initialUserMessage).toBe("Add user profile settings page");
    });

    it("includes target paths and custom instructions in frontend worker prompt", () => {
      const result = buildRolePrompt({
        role: "frontendWorker",
        userRequest: "Create Avatar component",
        targetPaths: ["apps/web/**", "packages/ui/**"],
        customInstructions: "Use Tailwind v4 and Lucide icons exclusively.",
      });
      expect(result.systemPrompt).toContain("Frontend Specialist Worker");
      expect(result.systemPrompt).toContain("Target Path Constraints:");
      expect(result.systemPrompt).toContain("- apps/web/**");
      expect(result.systemPrompt).toContain("Use Tailwind v4 and Lucide icons exclusively.");
    });

    it("includes reviewer instructions without direct edit access", () => {
      const result = buildRolePrompt({
        role: "reviewer",
        userRequest: "Review PR #42",
      });
      expect(result.systemPrompt).toContain("Code Reviewer and Quality Auditor");
      expect(result.systemPrompt).toContain("Do not modify codebase files directly.");
    });
  });
});
