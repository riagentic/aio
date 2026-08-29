// Plugins — a reusable piece of app, packaged.
//
// aio is deliberately not a plugin platform: there is no resolver, no
// lifecycle protocol, no capability negotiation, and adding one would buy
// exactly the indirection this framework exists to remove. What was missing is
// smaller and much more useful — a way to hand someone a working piece of an
// app (its cells, its routes, its schedules, the hooks that watch it) as ONE
// value they add to `plugins: [...]` instead of six edits spread across their
// config.
//
// So a plugin contributes exactly what an app config can contribute, nothing
// more:
//
//     const audit = definePlugin({
//       name: "audit",
//       cells: [auditLog],
//       routes: { "/audit.csv": () => new Response(toCsv()) },
//       onAction: (a) => auditLog.record(a.type),
//     })
//
//     await aio.run({ cells: [app], plugins: [audit] })
//
// THE RULES, which are the whole design:
//
//  1. A plugin can only do what the app could have written itself. There is no
//     private API, so a plugin can never be "more powerful" than its host, and
//     reading `aio.run({...})` still tells you everything that is wired.
//  2. The app always wins. An app's own `routes`, hooks and cells are applied
//     over the plugins', so adding a plugin can never take a behaviour away.
//  3. A collision is LOUD, at boot, naming both sides. Two plugins claiming
//     `/health` is a bug in the app's dependency choices, and finding out at
//     runtime — when one silently shadows the other — is the failure mode this
//     whole framework refuses.
//  4. Hooks compose rather than replace. Every `onAction` runs, in plugin
//     order, app last; one throwing never stops the next (lifecycle hooks are
//     observe-only and error-guarded — that contract is unchanged).
//  5. `setup()` is optional and runs ONCE at boot, before cells compose. It is
//     for a plugin that must compute what it contributes; it may return more
//     contributions, and they merge under the same rules.
import type { AioUser } from "./aio-types.ts";
import type { RawRouteHandler } from "./route.ts";
import type { ScheduleDef } from "../state/schedule.ts";
import type { CellDef, Creators } from "../state/cell.ts";

// deno-lint-ignore no-explicit-any
type AnyCell = CellDef<string, Creators, Creators, any>;

/** What a plugin adds to an app. Every field is the same shape, and the same
 *  type, as the `aio.run()` config key of that name. */
export interface PluginContribution {
  /** Cells this plugin owns. Composed alongside the app's own. */
  cells?: AnyCell[];
  /** HTTP routes, exactly as `AioConfig.routes`. */
  routes?: Record<string, RawRouteHandler>;
  /** Scheduled effects started at boot, exactly as `AioConfig.schedules`. */
  schedules?: ScheduleDef[];
  /** Extra origins this plugin needs reachable (a webhook sender, a proxy).
   *  Merged with the app's, deduped — never replaced. */
  allowedOrigins?: string[];
  // ── Observe-only lifecycle, composed rather than replaced ──
  onAction?: (action: unknown, state: unknown, user?: AioUser) => void;
  onEffect?: (effect: unknown, state: unknown, user?: AioUser) => void;
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  // deno-lint-ignore no-explicit-any
  onStart?: (app: any) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
}

/** A plugin: a name, what it contributes, and optionally a `setup` that
 *  computes more of it at boot. */
export interface Plugin extends PluginContribution {
  /** Identifies the plugin in every collision message and boot line. Required,
   *  because "two plugins disagree" is unreadable without both names. */
  name: string;
  /** Runs ONCE at boot, before cells compose. Return more contributions and
   *  they merge exactly as the static ones do. Throwing here refuses the boot,
   *  loudly — a plugin that cannot set itself up must not half-exist. */
  setup?: (
    ctx: PluginSetupContext,
  ) => PluginContribution | void | Promise<PluginContribution | void>;
}

/** What `setup()` is told about the app it is being added to. Read-only: a
 *  plugin that wants to change the app does it by CONTRIBUTING, so the merge
 *  rules above apply to everything. */
export interface PluginSetupContext {
  /** The app's id. */
  appId: string;
  /** True in dev. Observe-only — a plugin may log more, never behave
   *  differently in a way an app could notice. */
  dev: boolean;
  /** The other plugins' names, in order, so a plugin can refuse to run beside
   *  one it conflicts with — loudly, at boot, rather than at 3am. */
  plugins: readonly string[];
}

/** Define a plugin. Identity at runtime; the value is having the type checked
 *  at the definition site rather than at the `plugins: [...]` array. */
export function definePlugin(p: Plugin): Plugin {
  if (!p.name || typeof p.name !== "string") {
    throw new Error(
      `definePlugin: every plugin needs a \`name\` — it is what a collision ` +
        `message, a boot line and \`am plugins\` call it. Got ${
          JSON.stringify(p.name)
        }.`,
    );
  }
  return p;
}

/** The result of merging every plugin into one contribution. */
export interface ResolvedPlugins {
  names: string[];
  cells: AnyCell[];
  routes: Record<string, RawRouteHandler>;
  schedules: ScheduleDef[];
  allowedOrigins: string[];
  onAction: ((action: unknown, state: unknown, user?: AioUser) => void)[];
  onEffect: ((effect: unknown, state: unknown, user?: AioUser) => void)[];
  onConnect: ((user?: AioUser) => void)[];
  onDisconnect: ((user?: AioUser) => void)[];
  // deno-lint-ignore no-explicit-any
  onStart: ((app: any) => void | Promise<void>)[];
  onStop: (() => void | Promise<void>)[];
}

/** Who claimed a name first — so a collision message can name both sides. */
type Claim = { by: string; what: string };

function collide(
  kind: string,
  key: string,
  first: Claim,
  second: string,
): never {
  throw new Error(
    `plugin collision: ${kind} "${key}" is claimed by both "${first.by}" and ` +
      `"${second}".\n` +
      `  Two plugins cannot own the same ${kind} — whichever loaded second ` +
      `would silently shadow the other, and you would find out from a ` +
      `behaviour, not an error.\n` +
      `  Fix: drop one of the plugins, or wrap the one you control so it ` +
      `contributes a different ${kind}.`,
  );
}

/**
 * Resolve `plugins` into one contribution, running every `setup()` in order.
 *
 * The app's OWN config is not merged here — `aio.run()` applies it over this
 * result, so an app always wins over a plugin (rule 2).
 */
export async function resolvePlugins(
  plugins: readonly Plugin[] | undefined,
  ctx: Omit<PluginSetupContext, "plugins">,
): Promise<ResolvedPlugins> {
  const out: ResolvedPlugins = {
    names: [],
    cells: [],
    routes: {},
    schedules: [],
    allowedOrigins: [],
    onAction: [],
    onEffect: [],
    onConnect: [],
    onDisconnect: [],
    onStart: [],
    onStop: [],
  };
  if (!plugins?.length) return out;

  const seenName = new Set<string>();
  for (const p of plugins) {
    if (!p || typeof p !== "object" || typeof p.name !== "string") {
      throw new Error(
        `plugins: every entry must be a plugin object with a \`name\` (see ` +
          `\`definePlugin\`). Got ${
            p === null ? "null" : typeof p
          } at position ${plugins.indexOf(p as Plugin)}.`,
      );
    }
    if (seenName.has(p.name)) {
      throw new Error(
        `plugins: "${p.name}" is listed twice. A plugin is applied once; ` +
          `listing it again would double every hook it registers.\n` +
          `  Fix: remove the duplicate entry from \`plugins: [...]\` — one ` +
          `entry already gives you everything it contributes.`,
      );
    }
    seenName.add(p.name);
  }
  const names = plugins.map((p) => p.name);

  const routeOwner = new Map<string, Claim>();
  const cellOwner = new Map<string, Claim>();
  const scheduleOwner = new Map<string, Claim>();

  // A duplicate inside ONE plugin's own list is a duplicate, not a collision.
  //
  // `cells: [...core, ...extra]` with an overlap, or a `setup()` that returns
  // something the static list already had, produced
  // `claimed by both "audit" and "audit"` — a message that names one plugin
  // twice and tells its author nothing. Only a claim by a DIFFERENT plugin is
  // a collision; the same plugin claiming the same thing twice just means
  // once. Found by `scripts/audit-round.ts 6`.
  const absorb = (p: Plugin, c: PluginContribution): void => {
    for (const cell of c.cells ?? []) {
      const id = cell.__aio.id;
      const prev = cellOwner.get(id);
      if (prev?.by === p.name) continue; // already this plugin's
      if (prev) collide("cell", id, prev, p.name);
      cellOwner.set(id, { by: p.name, what: id });
      out.cells.push(cell);
    }
    for (const [pattern, handler] of Object.entries(c.routes ?? {})) {
      const prev = routeOwner.get(pattern);
      if (prev && prev.by !== p.name) collide("route", pattern, prev, p.name);
      routeOwner.set(pattern, { by: p.name, what: pattern });
      out.routes[pattern] = handler;
    }
    for (const s of c.schedules ?? []) {
      const id = (s as { id?: string }).id ?? "";
      if (id) {
        const prev = scheduleOwner.get(id);
        if (prev?.by === p.name) continue;
        if (prev) collide("schedule", id, prev, p.name);
        scheduleOwner.set(id, { by: p.name, what: id });
      }
      out.schedules.push(s);
    }
    for (const o of c.allowedOrigins ?? []) {
      if (!out.allowedOrigins.includes(o)) out.allowedOrigins.push(o);
    }
    if (c.onAction) out.onAction.push(c.onAction);
    if (c.onEffect) out.onEffect.push(c.onEffect);
    if (c.onConnect) out.onConnect.push(c.onConnect);
    if (c.onDisconnect) out.onDisconnect.push(c.onDisconnect);
    if (c.onStart) out.onStart.push(c.onStart);
    if (c.onStop) out.onStop.push(c.onStop);
  };

  for (const p of plugins) {
    out.names.push(p.name);
    absorb(p, p);
    if (!p.setup) continue;
    let extra: PluginContribution | void;
    try {
      extra = await p.setup({ ...ctx, plugins: names });
    } catch (e) {
      // A plugin that cannot set itself up must not half-exist: its cells
      // would be composed and its routes absent, or the reverse. Refuse the
      // boot and name the plugin — the app author has to know WHICH one.
      throw new Error(
        `plugin "${p.name}" failed to set up: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { cause: e },
      );
    }
    if (extra) absorb(p, extra);
  }
  return out;
}

/** Run every hook in a composed list, guarding each.
 *
 *  Lifecycle hooks are observe-only and never break dispatch — that contract
 *  predates plugins and plugins do not get to weaken it. One plugin's bad
 *  `onAction` must not stop the next plugin's, or the app's. */
export function composeHooks<A extends unknown[]>(
  hooks: readonly ((...a: A) => void)[],
  own: ((...a: A) => void) | undefined,
  onError: (e: unknown) => void,
): ((...a: A) => void) | undefined {
  const all = own ? [...hooks, own] : [...hooks];
  if (all.length === 0) return undefined;
  // The identity passthrough is only safe when the ONE function is the app's
  // own: an app hook keeps whatever error handling it had before plugins
  // existed. A single PLUGIN hook must still be guarded, or installing a
  // second plugin would silently change the first one's error behaviour —
  // guarded at two, unguarded at one. Found by `scripts/audit-round.ts 7`.
  if (all.length === 1 && hooks.length === 0) return all[0];
  return (...args: A) => {
    for (const h of all) {
      try {
        h(...args);
      } catch (e) {
        onError(e);
      }
    }
  };
}

/** The async twin, for `onStart` / `onStop`. Awaited in order: a plugin that
 *  opens something in `onStart` closes it in `onStop`, and the app's own hook
 *  runs last on start and FIRST on stop, so it unwinds in the right order. */
export function composeAsyncHooks<A extends unknown[]>(
  hooks: readonly ((...a: A) => void | Promise<void>)[],
  own: ((...a: A) => void | Promise<void>) | undefined,
  order: "start" | "stop",
  onError: (e: unknown) => void,
): ((...a: A) => Promise<void>) | undefined {
  const all = order === "start"
    ? (own ? [...hooks, own] : [...hooks])
    : (own ? [own, ...hooks.slice().reverse()] : hooks.slice().reverse());
  if (all.length === 0) return undefined;
  return async (...args: A) => {
    for (const h of all) {
      try {
        await h(...args);
      } catch (e) {
        onError(e);
      }
    }
  };
}
