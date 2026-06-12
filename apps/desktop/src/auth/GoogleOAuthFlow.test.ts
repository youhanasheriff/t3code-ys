import { describe, expect, it } from "vitest";

import { GoogleOAuthError, runGoogleOAuthLoopbackFlow } from "./GoogleOAuthFlow.ts";

const config = { clientId: "test-client.apps.googleusercontent.com", clientSecret: "test-secret" };

/** Simulates Google redirecting the browser back to the loopback server. */
function redirectingOpener(query: (state: string) => string) {
  return async (rawUrl: string): Promise<void> => {
    const authUrl = new URL(rawUrl);
    const redirectUri = authUrl.searchParams.get("redirect_uri");
    const state = authUrl.searchParams.get("state");
    if (!redirectUri || !state) {
      throw new Error("auth url missing redirect_uri/state");
    }
    // @effect-diagnostics-next-line globalFetch:off - this test drives the local loopback listener.
    const response = await fetch(`${redirectUri}/${query(state)}`);
    // Drain the body so the server can finish responding.
    await response.text();
  };
}

describe("runGoogleOAuthLoopbackFlow", () => {
  it("returns the ID token on a successful redirect + exchange", async () => {
    const captured: { body?: URLSearchParams } = {};

    const result = await runGoogleOAuthLoopbackFlow({
      config,
      loopbackPort: 0,
      openExternalUrl: redirectingOpener((state) => `?code=auth-code-123&state=${state}`),
      fetchToken: async (_endpoint, body) => {
        captured.body = body;
        return { id_token: "header.payload.signature" };
      },
    });

    expect(result.idToken).toBe("header.payload.signature");
    // PKCE verifier + the auth code must be forwarded to the token endpoint.
    expect(captured.body?.get("code")).toBe("auth-code-123");
    expect(captured.body?.get("grant_type")).toBe("authorization_code");
    expect(captured.body?.get("code_verifier")).toBeTruthy();
    expect(captured.body?.get("client_id")).toBe(config.clientId);
  });

  it("rejects when the returned state does not match (CSRF protection)", async () => {
    await expect(
      runGoogleOAuthLoopbackFlow({
        config,
        loopbackPort: 0,
        openExternalUrl: redirectingOpener(() => `?code=auth-code-123&state=tampered`),
        fetchToken: async () => ({ id_token: "should-not-be-used" }),
      }),
    ).rejects.toBeInstanceOf(GoogleOAuthError);
  });

  it("rejects when Google returns an error parameter", async () => {
    await expect(
      runGoogleOAuthLoopbackFlow({
        config,
        loopbackPort: 0,
        openExternalUrl: redirectingOpener((state) => `?error=access_denied&state=${state}`),
        fetchToken: async () => ({ id_token: "should-not-be-used" }),
      }),
    ).rejects.toBeInstanceOf(GoogleOAuthError);
  });

  it("rejects when the token exchange omits an ID token", async () => {
    await expect(
      runGoogleOAuthLoopbackFlow({
        config,
        loopbackPort: 0,
        openExternalUrl: redirectingOpener((state) => `?code=auth-code-123&state=${state}`),
        fetchToken: async () => ({ error: "invalid_grant", error_description: "bad code" }),
      }),
    ).rejects.toBeInstanceOf(GoogleOAuthError);
  });

  it("aborts when the provided signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGoogleOAuthLoopbackFlow({
        config,
        loopbackPort: 0,
        signal: controller.signal,
        openExternalUrl: async () => {
          throw new Error("browser should not open when already aborted");
        },
        fetchToken: async () => ({ id_token: "x" }),
      }),
    ).rejects.toBeInstanceOf(GoogleOAuthError);
  });
});
