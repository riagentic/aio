/**
 * @module
 * Generation-stamped ownership of OS handle VALUES.
 *
 * A Windows HANDLE is a small integer the kernel recycles the moment it is
 * closed: close one and the very next `CreateFileW`, `CreateNamedPipeW` or
 * socket in the process can be handed the same number. A value therefore
 * identifies an object only for as long as the holder still owns it, and any
 * code that captured a value and acts on it LATER — a timer, a resumed
 * `await`, a completion callback — is acting on a number, not on a thing.
 *
 * `win-pipe.ts` has three such deferred paths: `PipeConn#drain`'s timeout,
 * and the `GetOverlappedResult` that both `#read` and `#write` run after
 * awaiting a completion packet. Each can resume after `close()` has already
 * run `CloseHandle` on that value, and then act on a number the kernel has
 * since given to someone else.
 *
 * HOW BAD, MEASURED — because the first version of this comment claimed worse
 * than is true, and a justification a measurement contradicts is exactly what
 * this repo refuses. Run on real Windows 11 (Deno 2.9.6), four probes against
 * one live OVERLAPPED:
 *
 *     GetOverlappedResult(hA,       ovlA)  ok=true  bytes=11111   (the owner)
 *     GetOverlappedResult(hB,       ovlA)  ok=true  bytes=11111   (other handle)
 *     GetOverlappedResult(<closed>, ovlA)  ok=true  bytes=11111   (closed value)
 *     GetOverlappedResult(0xDEAD,   ovlA)  ok=true  bytes=11111   (nonsense)
 *
 * With `bWait=FALSE` the call IGNORES its handle argument: the byte count
 * comes from the OVERLAPPED's own `InternalHigh`, and each `PipeConn` owns
 * its `#rovl`/`#wovl`, kept alive by the frame awaiting it. So the read/write
 * paths CANNOT return a stranger's byte count, and the pre-existing `#closed`
 * flag already prevented a double close. The residue this table actually
 * removes is narrower: a deferred `CancelIoEx`/`CloseHandle` acting on a
 * recycled value, and any FUTURE deferred path that does read through its
 * handle (`bWait=TRUE`, `ReadFile`, `WriteFile`) — where the hazard is real
 * and the guard has to already exist.
 *
 * A 400-connection storm on real Windows, with the FFI pool measured at
 * exactly 32 so ~368 flushes were genuinely queued when their timers fired,
 * produced 0 corruption and 0 ownership warnings both WITH this table and
 * against pre-fix HEAD. It is kept because it is correct, cheap and makes the
 * ownership rule explicit — not because it was observed to fix a live bug.
 *
 * A handle table makes the identity explicit. `claim` stamps a value with a
 * generation; a `HandleSlot` is (value, generation); `isLive` answers "is
 * this still the same object" for any deferred path, and `release` closes at
 * most once and never closes a value the table has since given to someone
 * else.
 *
 * Deliberately PURE and OS-free — no FFI, no `Deno.build.os` — so the
 * ownership rules are unit-testable on every platform, which is the half of
 * a Windows-only defect that does not have to stay unverifiable.
 */

/** A claim on one handle value. Compare by generation, never by value. */
export type HandleSlot = {
  /** The raw OS handle value. Meaningful only while `isLive(slot)`. */
  readonly value: bigint;
  /** Process-unique and monotonic: no two claims ever share one. */
  readonly gen: number;
  /** What the value is for — used in the warning when ownership is lost. */
  readonly label: string;
};

/** Ownership of the handle values a process holds.
 *
 *  Not a global: one table per transport keeps tests independent, and the
 *  values of two different handle spaces (say a pipe and a file) never need
 *  to share one map. `win-pipe.ts` has exactly one. */
export class HandleTable {
  #gen = 0;
  /** value → the slot that owns it RIGHT NOW. A value absent from here is
   *  owned by nobody in this table, which is the only safe assumption about
   *  a value the kernel may already have handed to someone else. */
  #live = new Map<bigint, HandleSlot>();
  readonly #warn: (msg: string) => void;

  constructor(warn: (msg: string) => void = () => {}) {
    this.#warn = warn;
  }

  /** How many values this table currently owns. */
  get size(): number {
    return this.#live.size;
  }

  /** Take ownership of a freshly opened handle value.
   *
   *  A value that is ALREADY live is not something the kernel can do: it
   *  hands out a number only after the previous owner closed it. So a
   *  collision means aio lost a handle — closed it without releasing, or
   *  released twice — and the table says so out loud rather than letting two
   *  slots believe they own one object. The new claim wins, because it is the
   *  one the kernel just confirmed; the stale slot's later release is then
   *  refused, which is exactly the outcome that keeps the new owner safe. */
  claim(value: bigint, label: string): HandleSlot {
    const prev = this.#live.get(value);
    if (prev !== undefined) {
      this.#warn(
        `handle ${value} was handed out again while aio still believed it ` +
          `owned it as "${prev.label}" (gen ${prev.gen}) — a handle was ` +
          `closed without being released, or released twice. The new claim ` +
          `("${label}") takes it; the old one can no longer close anything.`,
      );
    }
    const slot: HandleSlot = { value, gen: ++this.#gen, label };
    this.#live.set(value, slot);
    return slot;
  }

  /** Is this slot still the owner of its value? The question every deferred
   *  path must ask before it touches the value it captured. */
  isLive(slot: HandleSlot): boolean {
    return this.#live.get(slot.value)?.gen === slot.gen;
  }

  /** Give up this slot's claim. `true` when this call is the one that
   *  released it — i.e. the ONLY call that may now close the handle.
   *
   *  Idempotent, and refuses a stale slot: a second release, or a release
   *  from a slot whose value has since been re-claimed, returns `false` and
   *  closes nothing. That is the whole point — a close of a recycled value
   *  would take down an unrelated object. */
  release(slot: HandleSlot): boolean {
    if (!this.isLive(slot)) return false;
    this.#live.delete(slot.value);
    return true;
  }

  /** Run `use` only while `slot` still owns its value, and return
   *  `ifStale` otherwise. The shape every deferred path wants: the liveness
   *  check and the use cannot drift apart, because JS runs both without an
   *  await between them. */
  with<T>(slot: HandleSlot, use: (value: bigint) => T, ifStale: T): T {
    if (!this.isLive(slot)) return ifStale;
    return use(slot.value);
  }
}
