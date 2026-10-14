// The app the browser-worker tests build and run: one page that starts every
// kind of worker aio carries, and reports what each one answered.
//
//   module   new Worker(new URL("./w.ts", import.meta.url), { type: "module" })
//            — a relative import AND a bare one (`immer`): a worker has no
//            import map, so served module by module the bare one never loaded
//   classic  no `{ type }`: its import only works bundled, and it starts a
//            worker of its own
//   shared   a SharedWorker, same spelling
//   mount    a file the app built itself, in an `assets` mount declared in
//            deno.json ONLY — started by plain path, as before
//
// Every answer goes to the `probe` cell (the server prints `PROBE k=v`) and
// into the page (`#r`), for a target that has no server.
import { join } from "@std/path";

export const WORKER_APP: Record<string, string> = {
  "src/cells.ts": `import { cell } from "aio";
export const probe = cell("probe", {
  state: { r: {} as Record<string, string> },
  methods: {
    report(s, k: string, v: string) {
      s.r[k] = v;
      console.log("PROBE " + k + "=" + v);
    },
  },
});`,
  "src/dep.ts": `export const tag: string = "dep";`,
  "src/w.ts": `import { produce } from "immer";
import { tag } from "./dep.ts";
self.onmessage = () =>
  (self as unknown as Worker).postMessage(
    "ran:" + tag + ":" + produce({ n: 1 }, (d) => { d.n++; }).n,
  );`,
  "src/sub/classic.ts": `import { tag } from "../dep.ts";
const inner = new Worker(new URL("../w.ts", import.meta.url), { type: "module" });
inner.onmessage = (e) =>
  (self as unknown as Worker).postMessage("classic:" + tag + ">" + e.data);
inner.onerror = () => (self as unknown as Worker).postMessage("classic:inner-error");
self.onmessage = () => inner.postMessage(1);`,
  "src/shared.ts": `import { tag } from "./dep.ts";
(self as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = (e) =>
  e.ports[0]!.postMessage("shared:" + tag);`,
  // What \`deno bundle --platform browser -o workers/w.js <source>\` writes.
  "workers/w.js": `self.onmessage = () => self.postMessage("ran:mount");`,
  "src/App.tsx": `import { probe } from "./cells.ts";
const run = (k: string, w: Worker) => {
  w.onmessage = (e) => probe.report(k, String(e.data));
  w.onerror = () => probe.report(k, "error");
  w.postMessage(1);
};
let started = false;
export default function App() {
  if (!started) {
    started = true;
    run("module", new Worker(new URL("./w.ts", import.meta.url), { type: "module" }));
    run("classic", new Worker(new URL("./sub/classic.ts", import.meta.url)));
    run("mount", new Worker("workers/w.js"));
    if (typeof SharedWorker === "undefined") probe.report("shared", "unsupported");
    else {
      const sw = new SharedWorker(new URL("./shared.ts", import.meta.url), { type: "module" });
      sw.port.onmessage = (e) => probe.report("shared", String(e.data));
      sw.onerror = () => probe.report("shared", "error");
    }
  }
  return <p id="r">{JSON.stringify(probe.r)}</p>;
}`,
};

/** What every target must answer. */
export const WORKER_ANSWERS: Record<string, string> = {
  module: "ran:dep:2",
  classic: "classic:dep>ran:dep:2",
  shared: "shared:dep",
  mount: "ran:mount",
};

/** Write the app's files into `dir` (its deno.json is the caller's). */
export async function writeWorkerApp(dir: string): Promise<void> {
  for (const [f, body] of Object.entries(WORKER_APP)) {
    await Deno.mkdir(join(dir, f, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, f), body);
  }
}
