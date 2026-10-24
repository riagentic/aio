// The `web` target's sw.js install order (src/build/build-web.ts): the page's
// own files first, all at once (as 1.0.20 precached everything), THEN the
// asset mounts' files, at most 2 at a time — a first visit's page, not yet
// controlled, shares the bandwidth with 2 downloads, not with every asset at
// once (field report: 28 parallel pack downloads starved the first view).
// Any file that fails still fails the install, as before.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { serviceWorker } from "../src/build/build-web.ts";

type Install = { waitUntil: (p: Promise<unknown>) => void };

/** Runs the generated worker's install against a fake global: every fetch
 *  takes a few ms, and `fail` names files the host answers 404. */
async function install(sw: string, fail: Set<string> = new Set()) {
  const started: string[] = [];
  let assetsInFlight = 0;
  let maxAssetsInFlight = 0;
  const isAsset = (u: string) => u.startsWith("./packs/");
  const fetch = async (r: { url: string }) => {
    started.push(r.url);
    if (isAsset(r.url)) {
      maxAssetsInFlight = Math.max(maxAssetsInFlight, ++assetsInFlight);
    }
    await new Promise((res) => setTimeout(res, 5));
    if (isAsset(r.url)) assetsInFlight--;
    return { ok: !fail.has(r.url), status: fail.has(r.url) ? 404 : 200 };
  };
  const put = async (r: { url: string }) => {
    const res = await fetch(r);
    if (!res.ok) throw new TypeError(`${r.url}: ${res.status}`);
  };
  const cache = {
    add: put,
    addAll: (rs: { url: string }[]) => Promise.all(rs.map(put)),
  };
  const handlers = new Map<string, (e: Install) => void>();
  const self = {
    addEventListener: (t: string, h: (e: Install) => void) =>
      handlers.set(t, h),
    skipWaiting: () => Promise.resolve(),
    registration: { scope: "https://host/app/" },
  };
  class Request {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
  }
  new Function("self", "caches", "Request", sw)(
    self,
    { open: () => Promise.resolve(cache), keys: () => Promise.resolve([]) },
    Request,
  );
  let done: Promise<unknown> = Promise.resolve();
  handlers.get("install")!({ waitUntil: (p) => done = p });
  return {
    done,
    started,
    max: () => maxAssetsInFlight,
    isAsset,
  };
}

const shellFiles = ["app.js", "index.html", "style.css"];
const packs = Array.from({ length: 9 }, (_, i) => `packs/${i}.bin`);
const sw = serviceWorker(
  "t",
  "v1",
  [...shellFiles, ...packs].sort(),
  {},
  packs,
);

Deno.test("web sw: install fetches every page file before any asset, then the assets at most 2 at a time", async () => {
  const run = await install(sw);
  await run.done;
  const firstAsset = run.started.findIndex(run.isAsset);
  assertEquals(
    run.started.slice(0, firstAsset).sort(),
    ["./", "./app.js", "./index.html", "./style.css"],
  );
  assertEquals(
    run.started.slice(firstAsset).sort(),
    packs.map((f) => `./${f}`).sort(),
    "every asset precached, once",
  );
  assertEquals(run.max(), 2);
});

Deno.test("web sw: an asset that fails still fails the install — and no further asset is fetched", async () => {
  const run = await install(sw, new Set(["./packs/2.bin"]));
  await assertRejects(() => run.done as Promise<unknown>, TypeError);
  await new Promise((res) => setTimeout(res, 50));
  assert(
    run.started.filter(run.isAsset).length < packs.length,
    String(run.started),
  );
});

Deno.test("web sw: a page file that fails fails the install before any asset is fetched", async () => {
  const run = await install(sw, new Set(["./app.js"]));
  await assertRejects(() => run.done as Promise<unknown>, TypeError);
  await new Promise((res) => setTimeout(res, 50));
  assertEquals(run.started.filter(run.isAsset), []);
});

Deno.test("web sw: no assets — the page files precached as in 1.0.20", async () => {
  const plain = serviceWorker("t", "v1", shellFiles);
  const run = await install(plain);
  await run.done;
  assertEquals(run.started.sort(), [
    "./",
    "./app.js",
    "./index.html",
    "./style.css",
  ]);
});
