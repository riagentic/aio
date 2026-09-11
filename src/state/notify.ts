// notify.ts — a desktop notification is an EFFECT a method emits, not a DOM
// call a component makes.
//
// The thing an app wants to say — "the export finished", "a message arrived
// while you were away" — is decided where the state changes: in a method, on
// the server, with no window in reach. So it is spelled the way `schedule`
// and `own` are: `s.$do(notify({ title, body }))`, routed by the same
// `routeEffect` the other two framework effects use, and shown by the client
// runtime through the one Notification API every renderer has (a browser, the
// Electron renderer, which grants it without asking). A server with no UI
// client connected says so instead of dropping it.
//
// `route` is the whole click story: the app is focused, and if a route is
// given the router goes there. An action-on-click would be a second dispatch
// path from outside the page; the page is where dispatch lives.

/** What `notify()` takes. */
export type NotifyOptions = {
  /** The headline. Required, non-empty. */
  title: string;
  body?: string;
  /** Notifications with the same tag replace each other — a progress
   *  counter is one notification, not twenty. */
  tag?: string;
  /** No sound. */
  silent?: boolean;
  /** Where the router goes when the notification is clicked. */
  route?: string;
};

/** What `notify()` returns — the options under the framework effect tag,
 *  routed like `schedule` and `own`. */
export type NotifyEffect = { type: "__notify" } & NotifyOptions;

/** Build the effect. Refuses an empty title at the call site — the OS would
 *  show a blank card, and a blank card is a bug nobody can trace back. */
export function notify(n: NotifyOptions): NotifyEffect {
  if (typeof n?.title !== "string" || n.title.trim() === "") {
    throw new Error(
      "notify(): `title` must be a non-empty string — the OS shows it as the " +
        "headline, and an empty one is a card nobody can read.",
    );
  }
  const out: NotifyEffect = { type: "__notify", title: n.title };
  if (n.body !== undefined) out.body = n.body;
  if (n.tag !== undefined) out.tag = n.tag;
  if (n.silent !== undefined) out.silent = n.silent;
  if (n.route !== undefined) out.route = n.route;
  return out;
}

/** Type guard — `type === "__notify"`. */
export function isNotifyEffect(e: unknown): e is NotifyEffect {
  return typeof e === "object" && e !== null &&
    (e as { type?: unknown }).type === "__notify";
}

/** The wire payload: everything but the effect tag. */
export function notifyPayload(e: NotifyEffect): NotifyOptions {
  const { type: _type, ...rest } = e;
  return rest;
}
