import { useNavigate } from "@tanstack/react-router";
import { useCallback, useId, useState } from "react";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderInstanceId,
  type WorkerRoleConfig,
  type WorkerRoleKind,
  WORKER_ROLE_KINDS,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LayoutIcon,
  ServerIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";

import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

interface RoleMetadata {
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly hasTargetPaths: boolean;
  readonly pathPlaceholder: string;
}

export const WORKER_ROLE_METADATA: Record<WorkerRoleKind, RoleMetadata> = {
  planner: {
    title: "Lead Planner",
    description:
      "Decomposes requests into coordinated frontend and backend subtasks with verification criteria.",
    icon: BrainIcon,
    hasTargetPaths: false,
    pathPlaceholder: "",
  },
  frontendWorker: {
    title: "Frontend Specialist",
    description:
      "Executes UI client components, state management, interactions, styling, and design polish.",
    icon: LayoutIcon,
    hasTargetPaths: true,
    pathPlaceholder: "apps/web/**, apps/desktop/**, packages/ui/**",
  },
  backendWorker: {
    title: "Backend Specialist",
    description: "Executes server APIs, services, data persistence, and shared schema contracts.",
    icon: ServerIcon,
    hasTargetPaths: true,
    pathPlaceholder: "apps/server/**, packages/contracts/**, packages/shared/**",
  },
  reviewer: {
    title: "Code Reviewer",
    description:
      "Audits integrated changes against planner criteria and provides structured review feedback.",
    icon: ShieldCheckIcon,
    hasTargetPaths: false,
    pathPlaceholder: "",
  },
};

export function WorkerRolesSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment } = useSettingsScope();

  const [expandedRoles, setExpandedRoles] = useState<Record<WorkerRoleKind, boolean>>({
    planner: false,
    frontendWorker: false,
    backendWorker: false,
    reviewer: false,
  });

  const toggleExpand = useCallback((role: WorkerRoleKind) => {
    setExpandedRoles((prev) => ({ ...prev, [role]: !prev[role] }));
  }, []);

  const environmentId = environment?.environmentId ?? null;
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const getModelDisabledReason = useScopedModelDisabledReason(settings, entries);

  const updateRole = useCallback(
    (role: WorkerRoleKind, patch: Partial<WorkerRoleConfig>) => {
      const currentRole = settings.workerRoles[role];
      updateSettings({
        workerRoles: {
          [role]: {
            ...currentRole,
            ...patch,
          },
        },
      });
    },
    [settings.workerRoles, updateSettings],
  );

  const resetRole = useCallback(
    (role: WorkerRoleKind) => {
      const defaultRole = DEFAULT_SERVER_SETTINGS.workerRoles[role];
      updateSettings({
        workerRoles: {
          [role]: defaultRole,
        },
      });
    },
    [updateSettings],
  );

  const isRoleModified = useCallback(
    (role: WorkerRoleKind) => {
      const current = settings.workerRoles[role];
      const defaults = DEFAULT_SERVER_SETTINGS.workerRoles[role];
      return (
        current.enabled !== defaults.enabled ||
        current.customInstructions !== defaults.customInstructions ||
        current.modelSelection?.model !== defaults.modelSelection?.model ||
        current.modelSelection?.instanceId !== defaults.modelSelection?.instanceId ||
        JSON.stringify(current.targetPaths) !== JSON.stringify(defaults.targetPaths)
      );
    },
    [settings.workerRoles],
  );

  return (
    <SettingsSection id="worker-roles" title="Worker roles (multi-agent)">
      <div className="flex flex-col gap-3 py-1">
        {WORKER_ROLE_KINDS.map((roleKey) => {
          const meta = WORKER_ROLE_METADATA[roleKey];
          const roleConfig = settings.workerRoles[roleKey];
          const isExpanded = expandedRoles[roleKey];
          const modified = isRoleModified(roleKey);
          const Icon = meta.icon;

          const selection = roleConfig.modelSelection ?? settings.defaultModelSelection;
          const activeEntry = entries.find((e) => e.instanceId === selection?.instanceId);
          const modelOptions = getCustomModelOptionsByInstance(
            settings,
            serverProviders,
            selection?.instanceId,
            selection?.model,
          );

          return (
            <div
              key={roleKey}
              className="rounded-lg border border-border bg-card p-3 shadow-xs transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => toggleExpand(roleKey)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left cursor-pointer select-none"
                >
                  {isExpanded ? (
                    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary/80 text-foreground">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium leading-none text-foreground">
                        {meta.title}
                      </span>
                      {!roleConfig.enabled && (
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          Disabled
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {meta.description}
                    </p>
                  </div>
                </button>

                <div className="flex items-center gap-2 shrink-0">
                  {modified && (
                    <SettingResetButton label={meta.title} onClick={() => resetRole(roleKey)} />
                  )}
                  <Switch
                    checked={roleConfig.enabled}
                    onCheckedChange={(enabled) => updateRole(roleKey, { enabled })}
                    aria-label={`Enable ${meta.title}`}
                  />
                </div>
              </div>

              {isExpanded && (
                <div className="mt-4 flex flex-col gap-4 border-t border-border/60 pt-3">
                  {/* Model Selection */}
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <span className="text-xs font-medium text-foreground">Model</span>
                      <p className="text-xs text-muted-foreground">
                        Specialized model for this worker role.
                      </p>
                    </div>
                    {selection && activeEntry ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ProviderModelPicker
                          activeInstanceId={selection.instanceId}
                          model={selection.model}
                          lockedProvider={null}
                          instanceEntries={entries}
                          modelOptionsByInstance={modelOptions}
                          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                          getModelDisabledReason={getModelDisabledReason}
                          onOpenProviderSetup={(instanceId) => {
                            if (environmentId) {
                              void navigate({
                                to: "/settings/providers",
                                search: { environmentId, instanceId },
                              });
                            }
                          }}
                          onInstanceModelChange={(instanceId, model) =>
                            updateRole(roleKey, {
                              modelSelection: createModelSelection(instanceId, model),
                            })
                          }
                        />
                        <TraitsPicker
                          provider={activeEntry.driverKind}
                          models={activeEntry.models}
                          model={selection.model}
                          prompt=""
                          onPromptChange={() => {}}
                          modelOptions={selection.options ?? []}
                          allowPromptInjectedEffort={false}
                          planModeEnabled={settings.planModeEnabled}
                          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                          onModelOptionsChange={(options) =>
                            updateRole(roleKey, {
                              modelSelection: createModelSelection(
                                selection.instanceId,
                                selection.model,
                                options,
                              ),
                            })
                          }
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Default model</span>
                    )}
                  </div>

                  {/* Target Paths */}
                  {meta.hasTargetPaths && (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-foreground">Target paths</span>
                        <span className="text-xs text-muted-foreground">
                          Comma-separated glob patterns
                        </span>
                      </div>
                      <Input
                        value={roleConfig.targetPaths.join(", ")}
                        placeholder={meta.pathPlaceholder}
                        onChange={(e) => {
                          const paths = e.target.value
                            .split(",")
                            .map((p) => p.trim())
                            .filter(Boolean);
                          updateRole(roleKey, { targetPaths: paths });
                        }}
                        className="font-mono text-xs"
                      />
                    </div>
                  )}

                  {/* Custom Instructions */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-foreground">Custom instructions</span>
                    <Textarea
                      value={roleConfig.customInstructions}
                      placeholder={`Enter tailored instructions for the ${meta.title.toLowerCase()}...`}
                      onChange={(e) => updateRole(roleKey, { customInstructions: e.target.value })}
                      className="min-h-20 text-xs font-mono"
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}
