// `am dispatch counter:increment 1 --port=<the dev profile's port>` landed on
// the DEFAULT instance. Two instances of one app (the default home and a
// `--profile=dev` one), both on UDS: `controlEndpoint` read the default lock
// (`liveLock(appId)`) and "the socket wins whenever the lock names one", so a
// port that named the OTHER instance was ignored — the write went into the
// wrong instance's state.db, and `am state --port=…` answered with the wrong
// app's state. amui makes the same call with the lock's port for every
// instance it lists, so a profile instance's State tab showed its sibling.
//
// A port that belongs to one of this app's live instances picks THAT
// instance's wire.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { controlEndpoint, resolveControlPort } from "../src/am/am-http.ts";
import { _resetHomePin } from "../src/am/am-utils.ts";
import {
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { appHome, profileHome } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("controlEndpoint: a port that names a sibling instance reaches THAT instance", async () => {
  const apps = await tempDir("aio-am-port-inst-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", apps);
  const appId = `pi-${crypto.randomUUID().slice(0, 8)}`;
  const dflt = appHome(appId);
  const dev = profileHome(appId, "dev");
  const base = {
    appId,
    pid: Deno.pid,
    startedAt: Date.now(),
    status: "started" as const,
    cwd: join(apps, "proj"),
  };
  try {
    writeLock({
      ...base,
      port: 4801,
      home: dflt,
      socketPath: "/nowhere/d.sock",
    });
    writeLock({
      ...base,
      port: 4802,
      home: dev,
      profile: "dev",
      socketPath: "/nowhere/dev.sock",
    });
    assertEquals(controlEndpoint(appId, 4802), {
      kind: "uds",
      socketPath: "/nowhere/dev.sock",
      pid: Deno.pid,
      port: 4802,
    });
    // The default instance is still the default.
    assertEquals(controlEndpoint(appId, 4801), {
      kind: "uds",
      socketPath: "/nowhere/d.sock",
      pid: Deno.pid,
      port: 4801,
    });
    // TCP-only sibling with a TLS main port: its OWN plain control port.
    removeLock(lockKey(appId, dev));
    writeLock({
      ...base,
      port: 4803,
      trojanPort: 4804,
      home: dev,
      profile: "dev",
    });
    assertEquals(resolveControlPort(4803, appId), 4804);
    assertEquals(controlEndpoint(appId, 4803), { kind: "tcp", port: 4804 });
  } finally {
    removeLock(lockKey(appId, dflt));
    removeLock(lockKey(appId, dev));
    _resetHomePin();
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(apps);
  }
});
