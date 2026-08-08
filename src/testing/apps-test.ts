/**
 * @module
 * `testApps()` — the SECOND architecture shape, made testable.
 *
 * aio documents two shapes. One app serving many surfaces is covered by
 * `testMultiClient()`: one server, N clients over it. The other shape — a
 * service plus rich clients, where the client is *itself an aio app* with its
 * own cells, its own store and its own identity, and merely *connects to*
 * someone else's service — had no harness at all. Its properties can only be
 * observed with more than one app in play:
 *
 *   • two apps do not share an appId, a lock, a port or a data directory
 *   • a cell bound to app A cannot be bound to app B (D2 exclusivity)
 *   • a client of app A, running inside app B, sees A's state — not B's
 *   • closing B leaves A running
 *
 * Every one of those is a cross-app property, so a harness that boots one app
 * cannot express any of them. Testing it by hand meant hand-rolling ports,
 * temp dirs and teardown per app — which is how the shape ended up untested.
 *
 * ```ts
 * await using world = await testApps({
 *   service: { cells: [ledger], persist: true },
 *   desk: { cells: [prefs] },
 * });
 *
 * // The client-of-another-app path, over a real socket. The client binds its
 * // OWN instance of the definition — in production that is just the client
 * // process's copy of the module; in one process it has to be said out loud,
 * // because a def binds to exactly one app (D2) and the service holds the
 * // other instance. Write cells a client will bind as a factory:
 * //   const makeLedger = () => cell("ledger", { … });
 * const link = world.connect("service");
 * link.bind(makeLedger());
 * await link.ready;
 * await remoteLedger.credit(5);
 * assertEquals(world.get<S>("service").state().ledger.balance, 5);
 * ```
 *
 * Everything is real: N `aio.run()` instances, real WebSockets, real broadcast.
 * A harness that simulated the second app would report success for the one
 * thing it exists to check.
 */

import { connectCli } from "../server/cli-client.ts";
import type { CliApp } from "../server/cli-client.ts";
import type { CellsConfig } from "../server/aio-types.ts";
import { _armTestStrict } from "./test-strict.ts";
import { type TestServer, testServer } from "./server-test.ts";

/** N independent apps, plus the one thing you cannot do with one app: connect
 *  to another. `await using` closes every app and every link, in reverse order
 *  of creation. */
export interface TestApps {
  /** Booted apps in declaration order. */
  apps: TestServer[];
  /** One app by the name it was declared with. Throws naming the known apps —
   *  a typo'd name must not read as "app not booted". */
  get<S = unknown>(name: string): TestServer<S>;
  /** Open a client connection TO one of these apps, as another app's client
   *  would. Bind cells on it and call their methods; every link is closed by
   *  the harness. */
  connect<S = Record<string, unknown>>(
    name: string,
    opts?: { token?: string },
  ): CliApp<S>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Boot several independent aio apps for one test.
 *
 *  Each gets its own free port, its own throwaway data directory and its own
 *  appId — the isolation an app author would otherwise hand-roll, and get
 *  subtly wrong (a shared port is a flake; a shared appId is a shared lock and
 *  a shared store, which fails only under load).
 *
 *  Cells must be DISJOINT across apps: `cell()` binds exclusively to one app
 *  (perfect-aio D2), so handing the same cell to two apps throws — deliberately,
 *  and this harness does not soften it. A client that wants to *read* another
 *  app's cell binds it on a `connect()` link instead, which is exactly what a
 *  rich client does in production. */
export async function testApps(
  specs: Record<string, CellsConfig>,
): Promise<TestApps> {
  _armTestStrict(); // tests are the strictest environment, never the most permissive

  const names = Object.keys(specs);
  if (names.length === 0) {
    throw new Error("testApps() needs at least one app — got an empty object");
  }
  const byName = new Map<string, TestServer>();
  const apps: TestServer[] = [];
  const links: CliApp<unknown>[] = [];

  // Boot in order, and unwind on failure: a half-booted world leaks ports and
  // temp directories into every test that runs after it.
  try {
    for (const name of names) {
      const srv = await testServer({
        // A distinguishable id — an assertion about "which app wrote this" is
        // unreadable when both are `test-4f2a`. Still unique per run, because
        // two test files may boot the same name at the same moment.
        appId: `test-${name}-${crypto.randomUUID().slice(0, 8)}`,
        ...specs[name],
      });
      byName.set(name, srv);
      apps.push(srv);
    }
  } catch (e) {
    for (const srv of apps.reverse()) await srv.close().catch(() => {});
    throw e;
  }

  const get = <S = unknown>(name: string): TestServer<S> => {
    const srv = byName.get(name);
    if (!srv) {
      throw new Error(
        `testApps: no app named "${name}" — booted: ${names.join(", ")}`,
      );
    }
    return srv as TestServer<S>;
  };

  const close = async () => {
    // Links first: a client whose server vanished mid-test reconnects on a
    // backoff timer, and that timer outlives the test as a leaked op.
    for (const l of links.reverse()) {
      try {
        l.close();
      } catch { /* already closed */ }
    }
    links.length = 0;
    for (const srv of [...apps].reverse()) await srv.close().catch(() => {});
  };

  return {
    apps,
    get,
    connect<S = Record<string, unknown>>(
      name: string,
      opts?: { token?: string },
    ): CliApp<S> {
      const srv = get(name);
      const link = connectCli<S>(`${srv.url}/ws`, opts);
      links.push(link as CliApp<unknown>);
      return link;
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
