// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalFetch:off
/**
 * Desktop Google sign-in via OAuth 2.0 authorization-code + PKCE with a loopback
 * redirect, as recommended by Google for native/desktop apps
 * (https://developers.google.com/identity/protocols/oauth2/native-app).
 *
 * Flow:
 *   1. Start a transient HTTP server bound to 127.0.0.1 on an ephemeral port.
 *   2. Open the Google consent screen in the user's default browser.
 *   3. Google redirects back to http://127.0.0.1:<port>/ with an auth code.
 *   4. Exchange the code (+ PKCE verifier) for tokens; return the ID token.
 *
 * This module is intentionally free of any Electron imports so it can be unit
 * tested in isolation. The caller supplies `openExternalUrl` (wired to
 * Electron's shell) and, optionally, `fetchToken`/`createServer` for testing.
 */
import * as Crypto from "node:crypto";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const OAUTH_SCOPES = ["openid", "email", "profile"];
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Fixed loopback port for the sign-in flow.
 *
 * A Google **"Web application"** OAuth client requires every redirect URI —
 * including the exact port — to be pre-registered under "Authorized redirect
 * URIs", so the listener binds to a fixed port instead of an ephemeral one.
 * (A "Desktop app" client would accept any `127.0.0.1`/`localhost` port without
 * registration, but a fixed port supports either client type.)
 *
 * Register this EXACT value (no trailing slash, no path) on the OAuth client:
 *
 *     http://127.0.0.1:33421
 */
const LOOPBACK_PORT = 33421;

export interface GoogleOAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface GoogleSignInResult {
  readonly idToken: string;
}

export interface RunGoogleOAuthOptions {
  readonly config: GoogleOAuthClientConfig;
  /** Opens the given URL in the user's default browser. */
  readonly openExternalUrl: (url: string) => Promise<unknown>;
  /** How long to wait for the browser redirect before giving up. */
  readonly timeoutMs?: number;
  /** Aborts an in-flight flow (e.g. window closing). */
  readonly signal?: AbortSignal;
  /** Test seam: overrides the fixed loopback port (use 0 for an ephemeral port). */
  readonly loopbackPort?: number;
  /** Test seam: overrides the token-exchange HTTP call. */
  readonly fetchToken?: (
    endpoint: string,
    body: URLSearchParams,
  ) => Promise<{ id_token?: string; error?: string; error_description?: string }>;
}

export class GoogleOAuthError extends Error {
  readonly _tag = "GoogleOAuthError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GoogleOAuthError";
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(Crypto.randomBytes(32));
  const challenge = base64Url(Crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0f;color:#e7e7ea;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}
p{color:#9a9aa3;margin:0}</style></head>
<body><div class="card"><h1>You're signed in.</h1>
<p>You can close this tab and return to T3 Code.</p></div>
<script>window.setTimeout(function(){window.close()},800)</script></body></html>`;

function errorHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body style="font-family:-apple-system,system-ui,sans-serif;padding:2rem">
<h1>Sign-in failed</h1><p>${message}</p>
<p>You can close this tab and try again in T3 Code.</p></body></html>`;
}

interface AuthorizationCodeResult {
  readonly code: string;
  readonly redirectUri: string;
}

/**
 * Starts the loopback server, opens the browser, and resolves with the
 * authorization code once Google redirects back.
 */
function awaitAuthorizationCode(
  options: RunGoogleOAuthOptions,
  params: { challenge: string; state: string },
): Promise<AuthorizationCodeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<AuthorizationCodeResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const server = Http.createServer();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      server.close();
    };

    const settleError = (error: GoogleOAuthError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const settleSuccess = (result: AuthorizationCodeResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    function onAbort() {
      settleError(new GoogleOAuthError("Google sign-in was cancelled."));
    }

    if (options.signal) {
      if (options.signal.aborted) {
        server.close();
        reject(new GoogleOAuthError("Google sign-in was cancelled."));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    server.on("error", (error) => {
      settleError(
        new GoogleOAuthError("Could not start the local sign-in listener.", { cause: error }),
      );
    });

    server.on("request", (req, res) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      // Ignore incidental requests (favicon, etc.) that carry no auth params.
      if (!requestUrl.searchParams.has("code") && !requestUrl.searchParams.has("error")) {
        res.writeHead(204);
        res.end();
        return;
      }

      const returnedState = requestUrl.searchParams.get("state");
      const errorParam = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");

      if (errorParam) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(errorHtml("Access was denied."));
        settleError(new GoogleOAuthError(`Google denied the sign-in request: ${errorParam}`));
        return;
      }

      if (returnedState !== params.state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(errorHtml("The sign-in response could not be verified."));
        settleError(new GoogleOAuthError("OAuth state mismatch; possible CSRF — sign-in aborted."));
        return;
      }

      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(errorHtml("No authorization code was returned."));
        settleError(new GoogleOAuthError("Google did not return an authorization code."));
        return;
      }

      const address = server.address() as AddressInfo | null;
      const redirectUri = `http://127.0.0.1:${address?.port ?? LOOPBACK_PORT}`;

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      settleSuccess({ code, redirectUri });
    });

    const loopbackPort = options.loopbackPort ?? LOOPBACK_PORT;
    server.listen(loopbackPort, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        settleError(new GoogleOAuthError("Could not determine the local sign-in port."));
        return;
      }

      const redirectUri = `http://127.0.0.1:${address.port}`;
      const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
      authUrl.searchParams.set("client_id", options.config.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
      authUrl.searchParams.set("state", params.state);
      authUrl.searchParams.set("code_challenge", params.challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("prompt", "select_account");

      timer = setTimeout(() => {
        settleError(new GoogleOAuthError("Timed out waiting for Google sign-in to complete."));
      }, timeoutMs);
      timer.unref?.();

      Promise.resolve(options.openExternalUrl(authUrl.toString())).catch((error: unknown) => {
        settleError(
          new GoogleOAuthError("Could not open the browser for Google sign-in.", { cause: error }),
        );
      });
    });
  });
}

async function exchangeCodeForTokens(
  options: RunGoogleOAuthOptions,
  params: { code: string; redirectUri: string; verifier: string },
): Promise<GoogleSignInResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: options.config.clientId,
    client_secret: options.config.clientSecret,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  });

  const fetchToken =
    options.fetchToken ??
    (async (endpoint, requestBody) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: requestBody.toString(),
      });
      return (await response.json()) as {
        id_token?: string;
        error?: string;
        error_description?: string;
      };
    });

  let payload: { id_token?: string; error?: string; error_description?: string };
  try {
    payload = await fetchToken(GOOGLE_TOKEN_ENDPOINT, body);
  } catch (error) {
    throw new GoogleOAuthError("Failed to exchange the authorization code for tokens.", {
      cause: error,
    });
  }

  if (payload.error || !payload.id_token) {
    throw new GoogleOAuthError(
      payload.error_description ?? payload.error ?? "Google did not return an ID token.",
    );
  }

  return { idToken: payload.id_token };
}

/**
 * Runs the full desktop Google sign-in flow and resolves with the Google ID
 * token, suitable for Firebase `GoogleAuthProvider.credential(idToken)`.
 */
export async function runGoogleOAuthLoopbackFlow(
  options: RunGoogleOAuthOptions,
): Promise<GoogleSignInResult> {
  const { verifier, challenge } = createPkcePair();
  const state = base64Url(Crypto.randomBytes(16));

  const { code, redirectUri } = await awaitAuthorizationCode(options, { challenge, state });
  return exchangeCodeForTokens(options, { code, redirectUri, verifier });
}
