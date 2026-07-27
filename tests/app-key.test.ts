// app-key + profile — the persistent auth key and the .aioapp export that
// make "one key/one file, use forever" work.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { appKeyPath, resolveAppKey } from "../src/server/app-key.ts";

// Isolate the data dir so tests never touch the real `~/.<appId>`. AIO_APPS_DIR
// is the supported knob for "put every app's data under this root" — the same
// one a developer uses to group their apps.
function withDataDir<T>(fn: () => T): T {
  const tmp = Deno.makeTempDirSync({ prefix: "aio-key-" });
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", tmp);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    Deno.removeSync(tmp, { recursive: true });
  }
}

Deno.test("app-key: default is NO auth (open)", () => {
  withDataDir(() => {
    const r = resolveAppKey("myapp", undefined);
    assertEquals(r.key, undefined);
    assertEquals(r.explicit, false);
  });
});

Deno.test("app-key: key:true = a persisted key, stable across restarts", () => {
  withDataDir(() => {
    const r1 = resolveAppKey("myapp", true);
    assert(r1.key && r1.key.length > 0, "a key is generated");
    assertEquals(r1.persisted, true);
    // second boot → same key (this is "use forever")
    const r2 = resolveAppKey("myapp", true);
    assertEquals(r2.key, r1.key);
    assertEquals(Deno.readTextFileSync(appKeyPath("myapp")).trim(), r1.key);
  });
});

Deno.test("app-key: fixed key is used AND mirrored to disk (for am profile)", () => {
  withDataDir(() => {
    const r = resolveAppKey("myapp", "team-secret");
    assertEquals(r.key, "team-secret");
    assertEquals(r.explicit, true);
    assertEquals(
      Deno.readTextFileSync(appKeyPath("myapp")).trim(),
      "team-secret",
    );
  });
});

Deno.test("app-key: key:false = no auth, and clears any stale key file", () => {
  withDataDir(() => {
    resolveAppKey("myapp", "old-secret"); // writes app.key
    const r = resolveAppKey("myapp", false);
    assertEquals(r.key, undefined);
    assertEquals(r.explicit, true);
    let exists = true;
    try {
      Deno.statSync(appKeyPath("myapp"));
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "stale key file removed");
  });
});

Deno.test("profile: buildLocalProfile assembles a .aioapp from lock + key + cert", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "aio-key-" });
  const prev = Deno.env.get("XDG_DATA_HOME");
  Deno.env.set("XDG_DATA_HOME", tmp);
  try {
    const { buildLocalProfile } = await import("../src/server/profile.ts");
    const { writeLock } = await import(
      "../src/server/single-instance-lock.ts"
    );
    // fake a running exposed app
    writeLock({
      appId: "profapp",
      pid: Deno.pid, // alive
      port: 8000,
      startedAt: Date.now(),
      status: "started",
      cwd: Deno.cwd(),
      discovery: { title: "Prof App", tls: true, needsAuth: true },
    });
    resolveAppKey("profapp", "the-key"); // writes app.key
    // cert in a temp cwd/.aio-tls
    const cwd = Deno.makeTempDirSync({ prefix: "aio-cert-" });
    Deno.mkdirSync(join(cwd, ".aio-tls"));
    Deno.writeTextFileSync(
      join(cwd, ".aio-tls", "tls-cert.pem"),
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    );
    try {
      const p = buildLocalProfile("profapp", cwd)!;
      assert(p, "profile built");
      assertEquals(p.aio, 1);
      assertEquals(p.name, "profapp");
      assertEquals(p.title, "Prof App");
      assertEquals(p.port, 8000);
      assertEquals(p.tls, true);
      assertEquals(p.key, "the-key");
      assert(p.cert!.includes("BEGIN CERTIFICATE"), "cert PEM present");
    } finally {
      const { removeLock } = await import(
        "../src/server/single-instance-lock.ts"
      );
      removeLock("profapp");
      Deno.removeSync(cwd, { recursive: true });
    }
  } finally {
    if (prev === undefined) Deno.env.delete("XDG_DATA_HOME");
    else Deno.env.set("XDG_DATA_HOME", prev);
    Deno.removeSync(tmp, { recursive: true });
  }
});
