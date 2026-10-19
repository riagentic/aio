// The dead-boot refusal carries a stable `code` — `errorCode(e) === "DEAD_BOOT"`
// — so an agent or a CI gate branches on it instead of matching prose
// (feedback cc §5). The prose is unchanged.
import { assert, assertEquals } from "@std/assert";
import { cell, errorCode } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

type S = { rows: string[] };
let release: () => void = () => {};
const gate = new Promise<void>((r) => release = r);
let caught: unknown;

const c = cell("deadBootCode", {
  state: { rows: [] as string[] },
  methods: {
    add(s: S, row: string) {
      s.rows.push(row);
    },
    async late(_s: S) {
      await gate; // still running when its boot is disposed
      try {
        await (c as unknown as { add(r: string): Promise<void> }).add("late");
      } catch (e) {
        caught = e;
      }
    },
  },
});

Deno.test("dead boot: the refusal carries code DEAD_BOOT", async () => {
  const h1 = await bootCells([c]);
  const running = (c as unknown as { late(): Promise<void> }).late();
  running.catch(() => {});
  const warn = console.warn;
  console.warn = () => {};
  try {
    h1.dispose();
  } finally {
    console.warn = warn;
  }
  const err = console.error;
  console.error = () => {};
  try {
    await using h2 = await bootCells([c]);
    release();
    for (let i = 0; i < 5 && !caught; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await h2.settle();
  } finally {
    console.error = err;
  }
  assert(caught instanceof Error, `the late call was not refused: ${caught}`);
  assert(caught.message.includes("torn-down runtime"), caught.message);
  assertEquals(errorCode(caught), "DEAD_BOOT");
});
