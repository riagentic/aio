import { assertEquals } from "@std/assert";
import { createSelector, createSliceSelector } from "../src/selector.ts";

type TestState = {
  todos: { id: number; text: string; done: boolean }[];
  filter: "all" | "active" | "done";
  user: { name: string; age: number };
};

const state: TestState = {
  todos: [
    { id: 1, text: "a", done: false },
    { id: 2, text: "b", done: true },
    { id: 3, text: "c", done: false },
  ],
  filter: "active",
  user: { name: "Alice", age: 30 },
};

Deno.test("selector: single input selector caches result", () => {
  let callCount = 0;
  const selectCount = createSelector(
    (s: TestState) => s.todos,
    (todos) => {
      callCount++;
      return todos.length;
    },
  );

  const result1 = selectCount(state);
  assertEquals(result1, 3);
  assertEquals(callCount, 1);

  const result2 = selectCount(state);
  assertEquals(result2, 3);
  assertEquals(callCount, 1); // cached, not recomputed
});

Deno.test("selector: two input selectors cache correctly", () => {
  let callCount = 0;
  const selectFiltered = createSelector(
    (s: TestState) => s.todos,
    (s: TestState) => s.filter,
    (todos, filter) => {
      callCount++;
      if (filter === "active") return todos.filter((t) => !t.done);
      if (filter === "done") return todos.filter((t) => t.done);
      return todos;
    },
  );

  assertEquals(selectFiltered(state).length, 2);
  assertEquals(callCount, 1);

  assertEquals(selectFiltered(state).length, 2);
  assertEquals(callCount, 1); // cached
});

Deno.test("selector: recomputes when input changes", () => {
  let callCount = 0;
  const selectDone = createSelector(
    (s: TestState) => s.todos,
    (todos) => {
      callCount++;
      return todos.filter((t) => t.done);
    },
  );

  assertEquals(selectDone(state).length, 1);
  assertEquals(callCount, 1);

  const state2 = {
    ...state,
    todos: [...state.todos, { id: 4, text: "d", done: true }],
  };
  assertEquals(selectDone(state2).length, 2);
  assertEquals(callCount, 2); // recomputed
});

Deno.test("selector: three input selectors", () => {
  let callCount = 0;
  const selectSummary = createSelector(
    (s: TestState) => s.todos,
    (s: TestState) => s.filter,
    (s: TestState) => s.user.name,
    (todos, filter, name) => {
      callCount++;
      return `${name}: ${todos.length} todos, filter=${filter}`;
    },
  );

  assertEquals(selectSummary(state), "Alice: 3 todos, filter=active");
  assertEquals(callCount, 1);

  assertEquals(selectSummary(state), "Alice: 3 todos, filter=active");
  assertEquals(callCount, 1);
});

Deno.test("selector: five input selectors", () => {
  const selectAll = createSelector(
    (s: TestState) => s.todos,
    (s: TestState) => s.filter,
    (s: TestState) => s.user.name,
    (s: TestState) => s.user.age,
    (s: TestState) => s.todos.filter((t) => t.done).length,
    (todos, filter, name, age, doneCount) => ({
      total: todos.length,
      done: doneCount,
      name,
      age,
    }),
  );

  const result = selectAll(state);
  assertEquals(result.total, 3);
  assertEquals(result.done, 1);
  assertEquals(result.name, "Alice");
  assertEquals(result.age, 30);
});

Deno.test("selector: slice selector factory", () => {
  const selectTodosSlice = createSliceSelector((s: TestState) => s.todos);

  const selectActive = selectTodosSlice.derive((todos) =>
    todos.filter((t) => !t.done)
  );
  const selectDone = selectTodosSlice.derive((todos) =>
    todos.filter((t) => t.done)
  );

  assertEquals(selectActive(state).length, 2);
  assertEquals(selectDone(state).length, 1);

  // get returns the slice directly
  assertEquals(selectTodosSlice.get(state).length, 3);
});

Deno.test("selector: primitive value changes trigger recomputation", () => {
  let callCount = 0;
  const selectFilterUpper = createSelector(
    (s: TestState) => s.filter,
    (filter) => {
      callCount++;
      return filter.toUpperCase();
    },
  );

  assertEquals(selectFilterUpper(state), "ACTIVE");
  assertEquals(callCount, 1);

  const state2 = { ...state, filter: "done" as const };
  assertEquals(selectFilterUpper(state2), "DONE");
  assertEquals(callCount, 2);
});

Deno.test("selector: object reference unchanged uses cache", () => {
  let callCount = 0;
  const selectUser = createSelector(
    (s: TestState) => s.user,
    (user) => {
      callCount++;
      return `${user.name} (${user.age})`;
    },
  );

  assertEquals(selectUser(state), "Alice (30)");
  assertEquals(callCount, 1);

  // Same object reference
  const state2 = { ...state, user: state.user };
  assertEquals(selectUser(state2), "Alice (30)");
  assertEquals(callCount, 1); // cached
});

Deno.test("selector: nested object reference change recomputes", () => {
  let callCount = 0;
  const selectUser = createSelector(
    (s: TestState) => s.user,
    (user) => {
      callCount++;
      return `${user.name} (${user.age})`;
    },
  );

  assertEquals(selectUser(state), "Alice (30)");
  assertEquals(callCount, 1);

  // New object reference
  const state2 = { ...state, user: { name: "Bob", age: 25 } };
  assertEquals(selectUser(state2), "Bob (25)");
  assertEquals(callCount, 2);
});

Deno.test("selector: array mutation detected", () => {
  let callCount = 0;
  const selectIds = createSelector(
    (s: TestState) => s.todos,
    (todos) => {
      callCount++;
      return todos.map((t) => t.id);
    },
  );

  assertEquals(selectIds(state), [1, 2, 3]);
  assertEquals(callCount, 1);

  // New array reference
  const state2 = { ...state, todos: [...state.todos] };
  assertEquals(selectIds(state2), [1, 2, 3]);
  assertEquals(callCount, 2); // different reference, recomputed
});

Deno.test("createSelector: 3-input selector", () => {
  const select = createSelector(
    (s: { a: number; b: number; c: number }) => s.a,
    (s: { a: number; b: number; c: number }) => s.b,
    (s: { a: number; b: number; c: number }) => s.c,
    (a, b, c) => a + b + c,
  );
  assertEquals(select({ a: 1, b: 2, c: 3 }), 6);
});

Deno.test("createSelector: returns same reference when inputs unchanged", () => {
  const select = createSelector(
    (s: { items: number[] }) => s.items,
    (items) => items.filter((x) => x > 0),
  );
  const state = { items: [1, 2, -1] };
  const r1 = select(state);
  const r2 = select(state);
  assertEquals(r1 === r2, true); // same reference — memoized
});

Deno.test("createSelector: recomputes when input changes", () => {
  let computeCount = 0;
  const select = createSelector(
    (s: { x: number }) => s.x,
    (x) => {
      computeCount++;
      return x * 2;
    },
  );
  select({ x: 1 });
  select({ x: 1 });
  assertEquals(computeCount, 1); // memoized
  select({ x: 2 });
  assertEquals(computeCount, 2); // recomputed
});

Deno.test("createSliceSelector: derive creates memoized selector", () => {
  const slice = createSliceSelector((s: { items: number[] }) => s.items);
  const selectPositive = slice.derive((items) => items.filter((x) => x > 0));
  const state = { items: [1, -1, 2, -2] };
  assertEquals(selectPositive(state), [1, 2]);
  // Memoized
  const r1 = selectPositive(state);
  const r2 = selectPositive(state);
  assertEquals(r1 === r2, true);
});

Deno.test("createSliceSelector: get returns raw slice", () => {
  const slice = createSliceSelector((s: { count: number }) => s.count);
  assertEquals(slice.get({ count: 42 }), 42);
});
