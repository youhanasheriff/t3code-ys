import { DesktopGoogleSignInResultSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GoogleOAuthError, runGoogleOAuthLoopbackFlow } from "../../auth/GoogleOAuthFlow.ts";
import { getGoogleOAuthClientConfig } from "../../auth/googleOAuthConfig.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

/**
 * Desktop-only: drive the Google OAuth flow (default browser + loopback PKCE) in
 * the main process and return the Google ID token to the renderer, which exchanges
 * it for a Firebase session. Failures surface as a rejected IPC promise.
 */
export const startGoogleSignIn = makeIpcMethod({
  channel: IpcChannels.START_GOOGLE_SIGN_IN_CHANNEL,
  payload: Schema.Void,
  result: DesktopGoogleSignInResultSchema,
  handler: Effect.fn("desktop.ipc.auth.startGoogleSignIn")(function* () {
    const shell = yield* ElectronShell.ElectronShell;
    const context = yield* Effect.context<ElectronShell.ElectronShell>();
    const runWithContext = Effect.runPromiseWith(context);
    const config = yield* Effect.try({
      try: () => getGoogleOAuthClientConfig(),
      catch: (error) =>
        new GoogleOAuthError(
          error instanceof Error ? error.message : "Google sign-in is not configured.",
          { cause: error },
        ),
    });

    return yield* Effect.tryPromise({
      try: (signal) =>
        runGoogleOAuthLoopbackFlow({
          config,
          openExternalUrl: (url) => runWithContext(shell.openExternal(url)),
          signal,
        }),
      catch: (error) =>
        new GoogleOAuthError(error instanceof Error ? error.message : "Google sign-in failed.", {
          cause: error,
        }),
    });
  }),
});
