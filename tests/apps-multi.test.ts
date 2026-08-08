// The second architecture shape — service + rich clients — with more than one
// app actually booted.
//
// Everything here is a CROSS-app property, which is why none of it was covered:
// `testServer()` boots one app and `testMultiClient()` boots one app with N
// clients over it, so neither can observe two apps at once. The shape is
// documented and shipped; until now the suite said nothing about it.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";
import { testApps } from "../src/cell-test.ts";

/** A factory, not a singleton: the service binds one instance and a client
 *  binds another, which is what two processes importing the same module get. */
const makeLedger = () =>
  cell("ledger", {
    state: { balance: 0 },
    methods: {
      credit(s: { balance: number }, n: number) {
        s.balance += n;
      },
    },
  });
const ledger = makeLedger();

const prefs = cell("prefs", {
  state: { theme: "light" },
  methods: {
    setTheme(s: { theme: string }, t: string) {
      s.theme = t;
    },
  },
});

Deno.test("testApps: two apps, two identities, two stores", async () => {
  await using world = await testApps({
    service: { cells: [ledger] },
    desk: { cells: [prefs] },
  });

  const service = world.get("service");
  const desk = world.get("desk");

  assert(service.port !== desk.port, "two apps must not share a port");
  assert(
    service.url !== desk.url,
    "each app is reachable at its own address",
  );

  // Each app serves ITS cells and knows nothing of the other's — the isolation
  // that makes "a client of the service" a meaningful phrase at all.
  const sState = world.get<Record<string, unknown>>("service").state();
  const dState = world.get<Record<string, unknown>>("desk").state();
  assert(
    "ledger" in sState,
    `service must hold ledger: ${Object.keys(sState)}`,
  );
  assert(!("prefs" in sState), "the service must not hold the desk's cells");
  assert("prefs" in dState, `desk must hold prefs: ${Object.keys(dState)}`);
  assert(!("ledger" in dState), "the desk must not hold the service's cells");
});

Deno.test("testApps: a client of app A, running beside app B, sees A", async () => {
  // The production shape in one test: the desk app is up with its own local
  // state, and it reaches the service over a real socket rather than by
  // importing it.
  await using world = await testApps({
    service: { cells: [ledger] },
    desk: { cells: [prefs] },
  });

  // A client binds its OWN instance of the definition — in production that is
  // simply the client process's copy of the module. In one process it has to be
  // said out loud: a def binds to exactly one app (D2), so the service's
  // `ledger` object is already spoken for.
  const remoteLedger = makeLedger();
  const link = world.connect("service");
  link.bind(remoteLedger);
  await link.ready;

  await remoteLedger.credit(5);

  // The SERVICE moved…
  assertEquals(
    world.get<{ ledger: { balance: number } }>("service").state().ledger
      .balance,
    5,
  );
  // …and the desk, which never saw the action, did not.
  const desk = world.get<Record<string, unknown>>("desk").state();
  assert(
    !("ledger" in desk),
    "the desk must not have grown the service's cell",
  );
});

Deno.test("testApps: closing one app leaves the other serving", async () => {
  await using world = await testApps({
    service: { cells: [ledger] },
    desk: { cells: [prefs] },
  });
  const service = world.get("service");
  await world.get("desk").close();

  const res = await service.fetch("/__aio/health");
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("testApps: an unknown name says which apps exist", async () => {
  await using world = await testApps({ service: { cells: [ledger] } });
  const e = assertThrows(() => world.get("srevice"), Error, "srevice");
  assert(
    (e as Error).message.includes("service"),
    "a typo must name the apps that DO exist, not read as 'not booted'",
  );
});

Deno.test("testApps: an empty world is a mistake, said out loud", async () => {
  await assertRejects(
    () => testApps({}),
    Error,
    "at least one app",
  );
});
