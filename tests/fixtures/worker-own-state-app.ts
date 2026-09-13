// A real app entry whose worker cell reads ITS OWN state through the cell
// object (the everyday helper-function shape) and throws errors carrying a
// `name` and a `code`.
//
// The test imports it for the defs; a real cell worker spawned by
// `testServer({ workers: "real", workerEntry })` re-imports it and boots into
// cell-host mode.
import { aio, cell, isCellWorker } from "aio";

type S = { n: number; label: string };
const own = (): S => ownState as unknown as S;

/** The error an app throws to let callers branch on `name`/`code`. */
class WalletLockedError extends Error {
  code = "E_LOCKED";
  constructor() {
    super("wallet is locked");
    this.name = "WalletLockedError";
  }
}

export const ownState = cell("ownState", {
  worker: true,
  state: { n: 0, label: "declared" },
  methods: {
    set(s: S, n: number) {
      s.n = n;
      s.label = "live";
    },
    /** The same field two ways: the draft, and the cell object. */
    readBoth(s: S): { viaDraft: number; viaCell: number; label: string } {
      return { viaDraft: s.n, viaCell: own().n, label: own().label };
    },
    async readAfterAwait(_s: S): Promise<{ n: number; label: string }> {
      await Promise.resolve();
      return { n: own().n, label: own().label };
    },
    fail(_s: S) {
      throw new WalletLockedError();
    },
    async failAsync(_s: S) {
      await Promise.resolve();
      throw new WalletLockedError();
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    appId: "worker-own-state-probe",
    cells: [ownState],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}
