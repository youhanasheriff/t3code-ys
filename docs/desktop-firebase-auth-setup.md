# Desktop Firebase login + usage analytics — setup

This guide covers the one-time setup for the **desktop-only** Google sign-in and
Firestore usage-analytics feature. It is an internal tool: each teammate signs in
with their own Google account on their own laptop, and the token usage from *their*
local chats is recorded to Firestore under their account.

> The feature is gated by `isElectron` — it only activates in the Electron desktop
> build. The hosted web build is unaffected and never loads Firebase.

## What it does

- On desktop launch, the app requires **Sign in with Google** before it can be used.
- Sign-in opens in the user's **default browser** (Google blocks sign-in inside
  embedded app windows) and deep-links back via a loopback redirect.
- As the user chats (driving their local Codex/Claude CLI), token usage is written
  to **Firestore** under their UID. Usage is computed from local chat activity, not
  from any shared Codex usage/billing API.

## Firestore data model

```
users/{uid}                       → { uid, email, displayName, photoURL, lastSeenAt }
users/{uid}/chats/{envId:threadId}→ { title, provider, model, messageCount,
                                      inputTokens, outputTokens, cachedInputTokens,
                                      reasoningOutputTokens, totalTokens, updatedAt, … }
users/{uid}/dailyUsage/{YYYY-MM-DD}→ { date, inputTokens, outputTokens,
                                      cachedInputTokens, reasoningOutputTokens,
                                      totalTokens, updatedAt }
```

Per-chat docs store the **latest cumulative** token totals; the daily doc is
incremented by the **delta** since the last recorded value (so daily totals are
true per-day consumption, resilient to missed events).

To review usage, open **Firebase Console → Firestore Database** and browse
`users/<uid>/dailyUsage` and `users/<uid>/chats`.

## One-time setup

### 1. Firebase Authentication — enable Google

Firebase Console → **Authentication** → **Sign-in method** → enable **Google**.

### 2. Firestore — create the database

Firebase Console → **Firestore Database** → **Create database** → **Native mode**.

### 3. Deploy the security rules

The rules in [`firestore.rules`](../firestore.rules) ensure each user can only
read/write their own data.

```bash
# from the repo root, with the Firebase CLI installed and logged in
firebase deploy --only firestore:rules
```

…or paste the file contents into Firebase Console → Firestore Database → **Rules**.

### 4. Create a Google OAuth "Desktop app" client

The browser sign-in flow uses an OAuth 2.0 client of type **Desktop app** (it
allows loopback redirects on any port, which is what the flow uses).

1. Google Cloud Console → **APIs & Services → Credentials** (same project as Firebase).
2. **Create credentials → OAuth client ID → Application type: _Desktop app_**.
3. Export the **Client ID** and **Client secret** in the desktop process
   environment before building or running the app:

   ```bash
   export T3CODE_GOOGLE_OAUTH_CLIENT_ID="…apps.googleusercontent.com"
   export T3CODE_GOOGLE_OAUTH_CLIENT_SECRET="…"
   ```

   > For installed/desktop apps Google does **not** treat the client secret as
   > confidential, but GitHub push protection treats OAuth client values as
   > sensitive, so keep them out of git.

### 5. (Already done) Firebase Web config

The non-secret Firebase Web config is committed in
[`apps/web/src/desktopAuth/firebaseConfig.ts`](../apps/web/src/desktopAuth/firebaseConfig.ts)
for project `t3code-ys`. The Web config is designed to be public; security comes
from Auth + the Firestore rules above.

## How sign-in works (under the hood)

1. Renderer calls `window.desktopBridge.startGoogleSignIn()`.
2. Electron main starts a transient `127.0.0.1` listener, opens the Google consent
   screen in the default browser (authorization-code + PKCE).
3. Google redirects to the loopback URL; main exchanges the code for a Google ID
   token and returns it to the renderer.
4. Renderer calls Firebase `signInWithCredential(GoogleAuthProvider.credential(idToken))`.
   The session is persisted, so users don't sign in on every launch.

## Troubleshooting

- **"Google sign-in is not configured"** — fill in the client ID/secret in
  `googleOAuthConfig.ts` (step 4).
- **`auth/invalid-credential` after the browser step** — make sure the Desktop OAuth
  client is in the **same Google Cloud project** as Firebase, and that the Google
  provider is enabled in Firebase Auth (step 1).
- **Permission denied writing to Firestore** — confirm the rules from step 3 are
  deployed and the user is signed in.
- **Browser opens but nothing happens** — the flow times out after 5 minutes; just
  click **Sign in with Google** again.
