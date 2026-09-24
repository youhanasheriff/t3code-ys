import { useEffect, type ReactNode } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { startDesktopAnalyticsRecorder } from "../../desktopAuth/analyticsRecorder";
import {
  initializeDesktopAuth,
  useDesktopAuthStore,
  type DesktopAuthUser,
} from "../../desktopAuth/desktopAuthStore";
import { isElectron } from "../../env";
import { Button } from "../ui/button";

/**
 * Desktop-only required-login gate. In the Electron build, blocks the app behind
 * a Google sign-in screen until the user is authenticated, then renders the app
 * and starts the usage-analytics recorder. In the hosted web build this is a
 * transparent pass-through (no Firebase, no gate).
 */
export function DesktopAuthGate({ children }: { children: ReactNode }) {
  if (!isElectron) {
    return <>{children}</>;
  }
  return <DesktopAuthGateInner>{children}</DesktopAuthGateInner>;
}

function DesktopAuthGateInner({ children }: { children: ReactNode }) {
  const status = useDesktopAuthStore((state) => state.status);
  const user = useDesktopAuthStore((state) => state.user);

  useEffect(() => {
    initializeDesktopAuth();
  }, []);

  if (status === "loading") {
    return <DesktopAuthSplash />;
  }

  if (status !== "signed-in" || !user) {
    return <DesktopLoginScreen />;
  }

  return (
    <>
      {children}
      <DesktopAnalyticsMount user={user} />
    </>
  );
}

function DesktopAnalyticsMount({ user }: { user: DesktopAuthUser }) {
  useEffect(() => {
    const recorder = startDesktopAnalyticsRecorder(user);
    return () => recorder.stop();
    // Restart only when the signed-in account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.uid]);

  return null;
}

function DesktopAuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-blue-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>
      <section className="relative w-full max-w-md rounded-2xl border border-border/80 bg-card/90 p-8 text-center shadow-2xl shadow-black/20 backdrop-blur-md">
        {children}
      </section>
    </div>
  );
}

function DesktopAuthSplash() {
  return (
    <DesktopAuthShell>
      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {APP_DISPLAY_NAME}
      </p>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">Loading…</h1>
    </DesktopAuthShell>
  );
}

function DesktopLoginScreen() {
  const signingIn = useDesktopAuthStore((state) => state.signingIn);
  const error = useDesktopAuthStore((state) => state.error);
  const signIn = useDesktopAuthStore((state) => state.signIn);

  return (
    <DesktopAuthShell>
      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {APP_DISPLAY_NAME}
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Sign in to continue</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Sign in with your Google account to use {APP_DISPLAY_NAME}. Your sign-in opens in your
        default browser.
      </p>

      <div className="mt-6">
        <Button
          size="xl"
          variant="default"
          className="w-full"
          disabled={signingIn}
          onClick={() => {
            void signIn();
          }}
        >
          <GoogleGlyph />
          {signingIn ? "Waiting for browser…" : "Sign in with Google"}
        </Button>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-red-500" role="alert">
          {error}
        </p>
      ) : null}

      {signingIn ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Complete the sign-in in your browser, then return here.
        </p>
      ) : null}
    </DesktopAuthShell>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 opacity-100!">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.87Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.95-2.91l-3.88-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}
