/**
 * Lazy Firebase initialization for the desktop-only auth + analytics feature.
 *
 * Firebase is imported dynamically so it is code-split into its own chunk that is
 * only fetched when these helpers run (i.e. in the Electron desktop build). The
 * hosted web build never calls them, so it never pays the bundle cost.
 *
 * All exports here are desktop-only and must be guarded by `isElectron` at the
 * call site.
 */
import type { FirebaseApp } from "firebase/app";
import type { Auth, User } from "firebase/auth";
import type { Firestore } from "firebase/firestore";

import { firebaseConfig } from "./firebaseConfig";

export interface FirebaseHandles {
  readonly app: FirebaseApp;
  readonly auth: Auth;
  readonly db: Firestore;
}

let handlesPromise: Promise<FirebaseHandles> | null = null;

export function getFirebase(): Promise<FirebaseHandles> {
  if (!handlesPromise) {
    handlesPromise = (async () => {
      const { initializeApp, getApps } = await import("firebase/app");
      const { getAuth, setPersistence, indexedDBLocalPersistence, browserLocalPersistence } =
        await import("firebase/auth");
      const { getFirestore } = await import("firebase/firestore");

      const existing = getApps();
      const app = existing.length > 0 ? existing[0]! : initializeApp(firebaseConfig);
      const auth = getAuth(app);

      // Keep the user signed in across app restarts.
      try {
        await setPersistence(auth, indexedDBLocalPersistence);
      } catch {
        await setPersistence(auth, browserLocalPersistence);
      }

      const db = getFirestore(app);
      return { app, auth, db };
    })().catch((error) => {
      // Reset so a later attempt can retry initialization.
      handlesPromise = null;
      throw error;
    });
  }
  return handlesPromise;
}

/** Exchanges a Google ID token (from the desktop OAuth flow) for a Firebase session. */
export async function signInWithGoogleIdToken(idToken: string): Promise<User> {
  const { auth } = await getFirebase();
  const { GoogleAuthProvider, signInWithCredential } = await import("firebase/auth");
  const credential = GoogleAuthProvider.credential(idToken);
  const result = await signInWithCredential(auth, credential);
  return result.user;
}

export async function signOutDesktop(): Promise<void> {
  const { auth } = await getFirebase();
  const { signOut } = await import("firebase/auth");
  await signOut(auth);
}

/** Subscribes to Firebase auth state. Returns an unsubscribe function. */
export async function observeAuthState(onChange: (user: User | null) => void): Promise<() => void> {
  const { auth } = await getFirebase();
  const { onAuthStateChanged } = await import("firebase/auth");
  return onAuthStateChanged(auth, onChange);
}
