// For tests/crash-line-reaches-log.test.ts: an app that boots, then dies of
// an uncaught error ("throw") or an unguarded unhandled rejection
// ("rej-noguard") — the two deaths Deno 2.9 ends WITHOUT firing `unload`.
import { aio, cell } from "../../mod.ts";

const mode = Deno.args.find((a) => !a.startsWith("--"));
const crashy = cell("crashy", {
  state: { n: 0 },
  methods: {
    bump(s) {
      s.n++;
    },
  },
});
await aio.run({
  appId: "crash-after-boot",
  cells: [crashy],
  persist: false,
  client: "server-only",
  ...(mode === "rej-noguard" ? { guardDispatches: false } : {}),
  watch: false,
});
setTimeout(() => {
  if (mode === "throw") throw new Error("sync boom after boot");
  void Promise.reject(new Error("rejection boom after boot"));
}, 300);
