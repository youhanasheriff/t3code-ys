import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScopedSettingsPatch } from "./scopedSettings";
import { WorkerRolesSettingsSection } from "./WorkerRolesSettings";

type WorkerRoles = typeof DEFAULT_UNIFIED_SETTINGS.workerRoles;
const state = vi.hoisted(() => ({
  // Filled in beforeEach: hoisted code runs before imports initialize.
  roles: {} as WorkerRoles,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    workerRoles: state.roles,
  }),
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
    targets: [{ settings: { ...DEFAULT_UNIFIED_SETTINGS, workerRoles: state.roles } }],
  }),
}));
vi.mock("./useScopedModelAvailability", () => ({
  useScopedModelDisabledReason: () => () => null,
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("./settingsSearch", () => ({ searchableSetting: (id: string) => ({ id, title: id }) }));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>{`Reset ${label}`}</button>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/switch", () => ({
  Switch: ({ checked, onCheckedChange, "aria-label": ariaLabel }: any) => (
    <input
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}));
vi.mock("../ui/textarea", () => ({
  Textarea: ({ value, onChange, placeholder }: any) => (
    <textarea value={value} placeholder={placeholder} onChange={onChange} />
  ),
}));
vi.mock("../ui/input", () => ({
  Input: ({ value, onChange, placeholder }: any) => (
    <input type="text" value={value} placeholder={placeholder} onChange={onChange} />
  ),
}));

let renderer: ReactTestRenderer | null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.roles = { ...DEFAULT_UNIFIED_SETTINGS.workerRoles };
  state.updateSettings.mockReset().mockImplementation((patch) => {
    if (patch.workerRoles) {
      state.roles = {
        ...state.roles,
        ...(patch.workerRoles as Partial<WorkerRoles>),
      };
    }
  });

  act(() => {
    renderer = create(
      <StrictMode>
        <WorkerRolesSettingsSection />
      </StrictMode>,
    );
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("WorkerRolesSettingsSection", () => {
  it("renders all 4 worker roles", () => {
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Lead Planner");
    expect(text).toContain("Frontend Specialist");
    expect(text).toContain("Backend Specialist");
    expect(text).toContain("Code Reviewer");
  });

  it("toggles role enabled switch", () => {
    const switches = renderer!.root
      .findAllByType("input")
      .filter((i) => i.props.type === "checkbox");
    expect(switches.length).toBe(4);

    // Toggle frontendWorker switch (index 1)
    act(() => {
      switches[1]!.props.onChange({ target: { checked: false } });
    });

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.updateSettings).toHaveBeenCalledWith({
      workerRoles: {
        frontendWorker: expect.objectContaining({ enabled: false }),
      },
    });
  });

  it("expands a role and allows editing custom instructions and target paths", () => {
    // Buttons inside the component: 4 headers
    const buttons = renderer!.root.findAllByType("button");
    const frontendButton = buttons.find((b) =>
      b.findAllByType("span").some((span) => span.children.includes("Frontend Specialist")),
    );
    expect(frontendButton).toBeDefined();

    // Click to expand frontend worker
    act(() => {
      frontendButton!.props.onClick();
    });

    // Verify textarea rendered
    const textareas = renderer!.root.findAllByType("textarea");
    expect(textareas.length).toBe(1);

    act(() => {
      textareas[0]!.props.onChange({ target: { value: "Tailwind v4 only" } });
    });

    expect(state.updateSettings).toHaveBeenCalledWith({
      workerRoles: {
        frontendWorker: expect.objectContaining({
          customInstructions: "Tailwind v4 only",
        }),
      },
    });

    // Verify target paths input rendered
    const inputs = renderer!.root.findAllByType("input").filter((i) => i.props.type === "text");
    expect(inputs.length).toBe(1);

    act(() => {
      inputs[0]!.props.onChange({ target: { value: "apps/web/**, packages/ui/**" } });
    });

    expect(state.updateSettings).toHaveBeenCalledWith({
      workerRoles: {
        frontendWorker: expect.objectContaining({
          targetPaths: ["apps/web/**", "packages/ui/**"],
        }),
      },
    });
  });

  it("renders reset button when role is modified and resets on click", () => {
    state.roles = {
      ...DEFAULT_UNIFIED_SETTINGS.workerRoles,
      planner: {
        ...DEFAULT_UNIFIED_SETTINGS.workerRoles.planner,
        customInstructions: "Modified custom instructions",
      },
    };

    act(() => {
      renderer!.update(
        <StrictMode>
          <WorkerRolesSettingsSection />
        </StrictMode>,
      );
    });

    const resetButtons = renderer!.root
      .findAllByType("button")
      .filter((b) =>
        b.children.some((c: any) => typeof c === "string" && c.includes("Reset Lead Planner")),
      );
    expect(resetButtons.length).toBe(1);

    act(() => {
      resetButtons[0]!.props.onClick();
    });

    expect(state.updateSettings).toHaveBeenCalledWith({
      workerRoles: {
        planner: DEFAULT_UNIFIED_SETTINGS.workerRoles.planner,
      },
    });
  });
});
