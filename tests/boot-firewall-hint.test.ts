// The firewall line of the boot report.
//
// Windows and macOS may ask the person at the screen whether a program that
// listens beyond loopback may be reached. A dismissed question leaves a
// server that answers on its own machine and looks dead from every other one,
// and aio said nothing about it. One line now, only where the question
// exists and only when the app is exposed.
import { assert, assertEquals } from "@std/assert";
import { _firewallHint } from "../src/server/aio-server.ts";

Deno.test("firewall hint: said on Windows and macOS under --expose, naming where to fix it", () => {
  const win = _firewallHint("windows", true, false)!;
  assert(win.startsWith("firewall: "), win);
  assert(win.includes("looks unreachable"), win);
  assert(win.includes("Allow an app through Windows Firewall"), win);
  const mac = _firewallHint("darwin", true, false)!;
  assert(mac.includes("looks unreachable"), mac);
  assert(mac.includes("System Settings → Network → Firewall"), mac);
});

Deno.test("firewall hint: nothing on Linux, without --expose, or on a loopback bind", () => {
  assertEquals(_firewallHint("linux", true, false), null);
  for (const os of ["windows", "darwin"]) {
    assertEquals(_firewallHint(os, false, true), null);
    assertEquals(_firewallHint(os, false, false), null);
    assertEquals(_firewallHint(os, true, true), null); // --expose --host=127.0.0.1
  }
});

// The helper is only worth its tests if the boot report calls it.
Deno.test("firewall hint: the boot report prints it beside the TLS lines", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/aio-server.ts", import.meta.url),
  );
  const tls = src.indexOf("tlsCert = await loadOrCreateCert(");
  const call = src.indexOf("_firewallHint(Deno.build.os, expose,");
  const transport = src.indexOf("const transport = resolveTransport(");
  assert(tls > 0 && call > tls && transport > call, "not wired after TLS");
  assert(
    /const _fw = _firewallHint\([^)]*\);\s*if \(_fw\) log\.info\(_fw\);/.test(
      src,
    ),
    "the hint is computed and not logged",
  );
});
