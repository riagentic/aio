// browser-auth-ui: useUser() + <SignIn/> — the drop-in auth UI (AUTH-2).
//
//   import { SignIn, useUser } from "aio/air";
//
//   export default function App() {
//     const user = useUser();
//     if (user === undefined) return <p>…</p>;   // still resolving
//     if (user === null) return <SignIn />;      // anonymous → login/signup
//     return <Dashboard me={user} />;
//   }
//
// Air-idiomatic: `authUser` is a signal (auto-tracked reads re-render), the
// form is uncontrolled DOM, and a successful login reloads the page — the
// HttpOnly session cookie then authenticates the WS handshake, so the app
// boots straight into authenticated state. Handles the TOTP second-factor
// step and signup (with optional email) out of the box.

import { h, type VNode } from "../air/vdom.ts";
import { type Signal, signal } from "../state/signal.ts";
import { authClient } from "./auth-client.ts";
import type { AioUser } from "../protocol/protocol-types.ts";

/** Current identity — undefined: not yet resolved, null: anonymous. */
export const authUser: Signal<AioUser | null | undefined> = signal<
  AioUser | null | undefined
>(undefined);

/** Server auth features (from /me) — <SignIn/> adapts to them automatically:
 *  no signup toggle when signup is off, an SSO button when OIDC is on. */
const _features: Signal<
  { signup: boolean; oidc: boolean; totp: boolean; mail: boolean } | null
> = signal<
  { signup: boolean; oidc: boolean; totp: boolean; mail: boolean } | null
>(null);

let _fetched = false;

const _fetchMe = (): void => {
  if (_fetched) return;
  _fetched = true;
  fetch("/__aio/auth/me", { credentials: "same-origin" })
    .then((r) => r.json())
    .then(({ user, features }) => {
      authUser.set(user ?? null);
      if (features) _features.set(features);
    })
    .catch(() => authUser.set(null));
};

/** Reactive current user (auto-tracked): kicks off one /me fetch, then keeps
 *  components in sync with login/logout. */
export function useUser(): AioUser | null | undefined {
  _fetchMe();
  return authUser.value;
}

/** Sign the current session out and reload into the anonymous shell. */
export async function signOut(): Promise<void> {
  try {
    await authClient.logout();
  } finally {
    authUser.set(null);
    if (typeof location !== "undefined") location.reload();
  }
}

/** Test hook — reset module state between renders. */
export function _resetAuthUi(): void {
  _fetched = false;
  authUser.set(undefined);
  _features.set(null);
  _mode.set("login");
  _error.set(null);
  _pendingTotp.set(null);
  _notice.set(null);
}

/** Test hook — inject server features without a fetch. */
export function _setAuthFeatures(
  f: { signup: boolean; oidc: boolean; totp: boolean; mail: boolean },
): void {
  _features.set(f);
}

// ── SignIn component state (module signals — one auth form per page) ────────
const _mode: Signal<"login" | "signup"> = signal<"login" | "signup">("login");
const _error: Signal<string | null> = signal<string | null>(null);
const _notice: Signal<string | null> = signal<string | null>(null);
const _pendingTotp: Signal<string | null> = signal<string | null>(null);

const ERROR_TEXT: Record<string, string> = {
  invalid_credentials: "Wrong id or password.",
  account_locked:
    "Account locked after too many attempts — try again in 15 minutes.",
  too_many_attempts: "Too many attempts — wait a few minutes.",
  user_exists: "That id is already taken.",
  password_too_short: "Password must be at least 8 characters.",
  signup_disabled: "Signup is disabled — ask an administrator for an account.",
  email_required: "An email address is required.",
  email_unverified: "Check your inbox — the account email is not verified yet.",
  invalid_code: "Wrong code — sign in again.",
  pending_expired: "The code expired — sign in again.",
};
const friendly = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  return ERROR_TEXT[msg] ?? msg;
};

const done = (): void => {
  if (typeof location !== "undefined") location.reload();
};

async function submitCredentials(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const id = String(data.get("id") ?? "");
  const password = String(data.get("password") ?? "");
  const email = String(data.get("email") ?? "");
  _error.set(null);
  _notice.set(null);
  try {
    if (_mode.value === "signup") {
      const r = await authClient.signup(id, password, email || undefined);
      if ("verificationSent" in r) {
        _notice.set(
          "Account created — check your inbox to verify, then sign in.",
        );
        _mode.set("login");
        return;
      }
      authUser.set(r.user);
      done();
      return;
    }
    const r = await authClient.login(id, password);
    if ("totpRequired" in r) {
      _pendingTotp.set(r.pending);
      return;
    }
    authUser.set(r.user);
    done();
  } catch (e) {
    _error.set(friendly(e));
  }
}

async function submitTotp(form: HTMLFormElement): Promise<void> {
  const code = String(new FormData(form).get("code") ?? "");
  const pending = _pendingTotp.value;
  if (!pending) return;
  _error.set(null);
  try {
    const r = await authClient.totp(pending, code);
    authUser.set(r.user);
    done();
  } catch (e) {
    _pendingTotp.set(null); // one-shot pending burned — back to login
    _error.set(friendly(e));
  }
}

// ── Styles — minimal, theme-neutral, overridable via props.style ────────────
const S = {
  wrap: {
    maxWidth: "20rem",
    margin: "10vh auto",
    padding: "2rem",
    fontFamily: "system-ui, sans-serif",
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  input: {
    padding: "0.6rem 0.8rem",
    fontSize: "1rem",
    border: "1px solid #8884",
    borderRadius: "6px",
  },
  button: {
    padding: "0.6rem 0.8rem",
    fontSize: "1rem",
    cursor: "pointer",
    borderRadius: "6px",
    border: "1px solid #8886",
  },
  minor: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: "0.85rem",
    textDecoration: "underline",
    color: "inherit",
    opacity: 0.7,
  },
  error: { color: "#e5484d", fontSize: "0.9rem", margin: 0 },
  notice: { color: "#30a46c", fontSize: "0.9rem", margin: 0 },
} as const;

/** Props for the drop-in `<SignIn/>` — labels, which fields to show, and the
 *  hooks to run after a successful sign-in. */
export interface SignInProps {
  /** Heading above the form (default: app-neutral labels). */
  title?: string;
  /** Show the email field on signup (default true — verify/reset need it). */
  email?: boolean;
  /** Force-hide the signup toggle (auto-hidden when the server disables signup). */
  signup?: boolean;
  /** Force-hide the SSO button (auto-shown when the server has OIDC). */
  sso?: boolean;
  /** SSO button label (default "Continue with SSO"). */
  ssoLabel?: string;
  style?: Record<string, string | number>;
}

/** Drop-in login/signup form (+ TOTP step). Renders nothing extra when the
 *  user is already signed in — pair with useUser() to branch the app. */
export function SignIn(props: SignInProps = {}): VNode {
  _fetchMe(); // ensures the features/identity fetch even without useUser()
  const mode = _mode.value;
  const error = _error.value;
  const notice = _notice.value;
  const pendingTotp = _pendingTotp.value;
  const feats = _features.value;
  const showEmail = props.email !== false && mode === "signup";
  // The form adapts to the server: signup toggle only when signup is open,
  // SSO button only when an OIDC provider is configured.
  const showSignup = props.signup !== false && feats?.signup !== false;
  const showSso = props.sso !== false && feats?.oidc === true;

  if (pendingTotp !== null) {
    return h(
      "form",
      {
        style: { ...S.wrap, ...props.style },
        onSubmit: (e: Event) => {
          e.preventDefault();
          submitTotp(e.currentTarget as HTMLFormElement);
        },
      },
      h("h2", { style: { margin: 0 } }, props.title ?? "Two-factor code"),
      h("input", {
        style: S.input,
        name: "code",
        inputMode: "numeric",
        autoComplete: "one-time-code",
        placeholder: "6-digit code",
        required: true,
        // deno-lint-ignore no-explicit-any
        autoFocus: true as any,
      }),
      error && h("p", { style: S.error }, error),
      h("button", { style: S.button, type: "submit" }, "Verify"),
    );
  }

  return h(
    "form",
    {
      style: { ...S.wrap, ...props.style },
      onSubmit: (e: Event) => {
        e.preventDefault();
        submitCredentials(e.currentTarget as HTMLFormElement);
      },
    },
    h(
      "h2",
      { style: { margin: 0 } },
      props.title ?? (mode === "signup" ? "Create account" : "Sign in"),
    ),
    h("input", {
      style: S.input,
      name: "id",
      autoComplete: "username",
      placeholder: "user id",
      required: true,
    }),
    showEmail &&
      h("input", {
        style: S.input,
        name: "email",
        type: "email",
        autoComplete: "email",
        placeholder: "email",
      }),
    h("input", {
      style: S.input,
      name: "password",
      type: "password",
      autoComplete: mode === "signup" ? "new-password" : "current-password",
      placeholder: "password",
      required: true,
    }),
    error && h("p", { style: S.error }, error),
    notice && h("p", { style: S.notice }, notice),
    h(
      "button",
      { style: S.button, type: "submit" },
      mode === "signup" ? "Create account" : "Sign in",
    ),
    showSso &&
      h(
        "a",
        {
          style: { ...S.button, textAlign: "center", textDecoration: "none" },
          href: "/__aio/auth/oidc/start",
          onClick: (e: Event) => {
            // Carry the current page along so the user lands back here.
            e.preventDefault();
            const r = encodeURIComponent(location.pathname + location.search);
            location.href = `/__aio/auth/oidc/start?redirect=${r}`;
          },
        },
        props.ssoLabel ?? "Continue with SSO",
      ),
    showSignup &&
      h(
        "button",
        {
          style: S.minor,
          type: "button",
          onClick: () => {
            _mode.set(mode === "signup" ? "login" : "signup");
            _error.set(null);
          },
        },
        mode === "signup"
          ? "Have an account? Sign in"
          : "New here? Create an account",
      ),
  );
}
