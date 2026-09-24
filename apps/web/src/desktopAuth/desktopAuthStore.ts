/**
 * Desktop-only authentication state (Firebase Google login).
 *
 * Holds a small, serializable view of the signed-in user and orchestrates the
 * sign-in flow: the Electron main process runs the Google OAuth flow in the
 * user's default browser (`window.desktopBridge.startGoogleSignIn`) and returns
 * an ID token, which we exchange for a Firebase session.
 *
 * Everything here is guarded by `isElectron`; in the hosted web build the store
 * stays in its initial "loading" → no-op state and Firebase is never loaded.
 */
import { create } from "zustand";

import { isElectron } from "../env";
import { observeAuthState, signInWithGoogleIdToken, signOutDesktop } from "./firebase";

export interface DesktopAuthUser {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly photoURL: string | null;
}

export type DesktopAuthStatus = "loading" | "signed-out" | "signed-in";

interface DesktopAuthState {
  readonly status: DesktopAuthStatus;
  readonly user: DesktopAuthUser | null;
  readonly signingIn: boolean;
  readonly error: string | null;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly clearError: () => void;
}

function toAuthUser(user: {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}): DesktopAuthUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Sign-in failed. Please try again.";
}

export const useDesktopAuthStore = create<DesktopAuthState>((set, get) => ({
  status: "loading",
  user: null,
  signingIn: false,
  error: null,

  signIn: async () => {
    if (!isElectron || !window.desktopBridge) {
      set({ error: "Sign-in is only available in the desktop app." });
      return;
    }
    if (get().signingIn) {
      return;
    }

    set({ signingIn: true, error: null });
    try {
      const { idToken } = await window.desktopBridge.startGoogleSignIn();
      await signInWithGoogleIdToken(idToken);
      // The auth-state observer flips status to "signed-in".
    } catch (error) {
      set({ error: errorMessage(error) });
    } finally {
      set({ signingIn: false });
    }
  },

  signOut: async () => {
    try {
      await signOutDesktop();
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  clearError: () => set({ error: null }),
}));

let initialized = false;

/**
 * Begins observing Firebase auth state for the desktop build. Safe to call more
 * than once; only the first call wires up the observer. No-op outside Electron.
 */
export function initializeDesktopAuth(): void {
  if (initialized || !isElectron) {
    return;
  }
  initialized = true;

  void observeAuthState((user) => {
    useDesktopAuthStore.setState({
      status: user ? "signed-in" : "signed-out",
      user: user ? toAuthUser(user) : null,
    });
  }).catch((error: unknown) => {
    useDesktopAuthStore.setState({
      status: "signed-out",
      error: errorMessage(error),
    });
  });
}
