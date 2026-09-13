// A real app entry with a `worker: true` cell that raises `notify()` — for
// tests/worker-notify-per-user-notice.test.ts. A real cell worker spawned by
// `testServer({ workers: "real", workerEntry })` re-imports it and boots into
// cell-host mode, exactly as a compiled binary's worker does.
import { aio, cell, notify } from "aio";

export const wpinger = cell("wpnotice", {
  worker: true,
  state: { n: 0 },
  access: true,
  visible: "all",
  methods: {
    ping(s: { n: number }, body: string) {
      s.n++;
      (s as unknown as { $do: (e: unknown) => void }).$do(
        notify({ title: "Card declined", body }),
      );
    },
  },
});

if ((globalThis as { name?: string }).name?.startsWith("aio-cell:")) {
  await aio.run({
    appId: "worker-notify-user-probe",
    cells: [wpinger],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}
