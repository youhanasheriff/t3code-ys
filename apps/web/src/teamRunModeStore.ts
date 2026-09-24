import { create } from "zustand";

/**
 * Threads whose composer sends through the team run (worker roles) instead of
 * a single provider turn. Kept in memory: a reload returns every thread to
 * normal sends.
 */
interface TeamRunModeState {
  readonly enabledThreadKeys: ReadonlySet<string>;
  readonly setTeamRunMode: (threadKey: string, enabled: boolean) => void;
}

export const useTeamRunModeStore = create<TeamRunModeState>()((set) => ({
  enabledThreadKeys: new Set(),
  setTeamRunMode: (threadKey, enabled) =>
    set((state) => {
      if (state.enabledThreadKeys.has(threadKey) === enabled) return state;
      const enabledThreadKeys = new Set(state.enabledThreadKeys);
      if (enabled) enabledThreadKeys.add(threadKey);
      else enabledThreadKeys.delete(threadKey);
      return { enabledThreadKeys };
    }),
}));
