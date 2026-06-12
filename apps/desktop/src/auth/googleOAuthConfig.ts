/**
 * Google OAuth client used by the desktop-only sign-in flow.
 *
 * This is the OAuth 2.0 client of type **"Desktop app"** created in the Google
 * Cloud Console for the same project as Firebase (`t3code-ys`). For installed /
 * desktop apps, Google explicitly does NOT treat the client secret as
 * confidential, but GitHub push protection still treats OAuth client values as
 * sensitive. Keep the values outside git and provide them via environment
 * variables when building/running the desktop app.
 *
 * The flow (see {@link ../auth/GoogleOAuthFlow.ts}) uses authorization-code +
 * PKCE with a loopback (`http://127.0.0.1:<port>`) redirect, which "Desktop app"
 * clients allow on any port without pre-registration.
 *
 * SETUP (one-time, see docs/desktop-firebase-auth-setup.md):
 *   1. Google Cloud Console → APIs & Services → Credentials → Create credentials
 *      → OAuth client ID → Application type: "Desktop app".
 *   2. Export T3CODE_GOOGLE_OAUTH_CLIENT_ID and
 *      T3CODE_GOOGLE_OAUTH_CLIENT_SECRET before building/running desktop.
 *   3. Ensure the Google provider is enabled in Firebase Authentication and that
 *      Firestore exists (Native mode).
 */

const PLACEHOLDER = "REPLACE_ME";

/** OAuth 2.0 "Desktop app" client ID, e.g. "1234-abcd.apps.googleusercontent.com". */
export const GOOGLE_OAUTH_CLIENT_ID =
  process.env.T3CODE_GOOGLE_OAUTH_CLIENT_ID ?? PLACEHOLDER;

/** OAuth 2.0 "Desktop app" client secret. */
export const GOOGLE_OAUTH_CLIENT_SECRET =
  process.env.T3CODE_GOOGLE_OAUTH_CLIENT_SECRET ?? PLACEHOLDER;

export interface GoogleOAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export class GoogleOAuthNotConfiguredError extends Error {
  readonly _tag = "GoogleOAuthNotConfiguredError";
  constructor() {
    super(
      "Google sign-in is not configured. Set GOOGLE_OAUTH_CLIENT_ID and " +
        "GOOGLE_OAUTH_CLIENT_SECRET in the desktop process environment " +
        "(see docs/desktop-firebase-auth-setup.md).",
    );
    this.name = "GoogleOAuthNotConfiguredError";
  }
}

export function isGoogleOAuthConfigured(): boolean {
  return (
    GOOGLE_OAUTH_CLIENT_ID.length > 0 &&
    GOOGLE_OAUTH_CLIENT_ID !== PLACEHOLDER &&
    GOOGLE_OAUTH_CLIENT_SECRET.length > 0 &&
    GOOGLE_OAUTH_CLIENT_SECRET !== PLACEHOLDER
  );
}

/**
 * Returns the configured Google OAuth client, throwing a descriptive error if
 * the placeholder values have not yet been filled in.
 */
export function getGoogleOAuthClientConfig(): GoogleOAuthClientConfig {
  if (!isGoogleOAuthConfigured()) {
    throw new GoogleOAuthNotConfiguredError();
  }
  return {
    clientId: GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
  };
}
