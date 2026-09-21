// AIO Form Utilities — useForm hook for controlled inputs, validation, field arrays.
// Signal-based, works with the AIO renderer's tracking system.

import { type Signal, signal } from "../state/signal.ts";
import type {
  StandardSchemaIssue,
  StandardSchemaLike,
} from "../state/arg-schema.ts";
import { count } from "../diagnostics/fmt.ts";

// ── Types ───────────────────────────────────────────────────────────

/** Synchronous field validator — returns an error message or `null` when valid. */
export type ValidationRule<T> = (value: T) => string | null;

/** A field rule that has to wait — a uniqueness check, a remote lookup.
 *  Resolves to an error message, or `null` when the value is fine. */
export type AsyncValidationRule<T> = (value: T) => Promise<string | null>;

/** A rule about the form as a whole ("passwords must match"). Returns a map of
 *  field name to message, or `null` when everything agrees. A message lands on
 *  a field only when that field has no error of its own — its own rule is the
 *  more specific statement. */
export type CrossFieldValidator<T extends Record<string, unknown>> = (
  values: T,
) => Record<string, string> | null;

/** The second argument to {@linkcode useForm} — everything that is about the
 *  FORM rather than about one field. */
export interface FormOptions<T extends Record<string, unknown>> {
  validators?: CrossFieldValidator<T>[];
  /** A Standard Schema (Zod 3.24+, Valibot 1.0+, ArkType 2.0+, …) for the
   *  whole form. Its issues are attributed to fields by `path`; anything it
   *  cannot attribute becomes a form-level error, exactly like a
   *  {@linkcode CrossFieldValidator}. `values()` returns what it PARSED.
   *  See {@linkcode runFormSchema}. */
  schema?: StandardSchemaLike;
}

/** Per-field state returned by {@linkcode useForm} — value, validity, and mutators. */
export interface FieldState<T> {
  /** Current field value (signal-tracked). */
  readonly value: T;
  /** Current error message or null. */
  readonly error: string | null;
  /** Whether the field has been modified. */
  readonly dirty: boolean;
  /** Whether the field has been touched (blurred). */
  readonly touched: boolean;
  /** Whether async validation is in progress. */
  readonly validating: boolean;
  /** Set the field value. */
  set(next: T): void;
  /** Mark as touched (call on blur). */
  touch(): void;
  /** Reset to initial value. */
  reset(): void;
}

/** Form-level state returned by {@linkcode useForm} — fields, validity, and helpers. */
export interface FormState<T extends Record<string, unknown>> {
  /** Individual field states. */
  fields: { [K in keyof T]: FieldState<T[K]> };
  /** Whether the entire form is valid. */
  readonly valid: boolean;
  /** The form schema's issue that belongs to no single field (a cross-field
   *  refinement, a missing key), or `null`. Signal-tracked.
   *
   *  OPTIONAL in the type, always present at runtime. `FormState` is public
   *  surface and frozen: a required member would break anyone who CONSTRUCTS
   *  one — a hand-built fake form in somebody's test — and aio's surface
   *  promise has no exceptions. Every form `useForm` returns has it. */
  readonly formError?: string | null;
  /** Whether any field has been modified. */
  readonly dirty: boolean;
  /** Get all current values as a plain object. */
  values(): T;
  /** The values as `options.schema` PARSED them, or `null` when there is no
   *  schema or they do not parse. Returns `unknown` deliberately — see the
   *  implementation. OPTIONAL in the type, always present at runtime:
   *  `FormState` is public surface and frozen, so a required member would
   *  break anyone who constructs one. */
  parsed?(): unknown;
  /** Validate all fields and return whether form is valid. */
  validate(): boolean;
  /** Reset all fields to initial values. */
  reset(): void;
  /** Props helper — returns { value, onInput, onBlur } for binding to input elements. */
  bind(
    name: keyof T,
  ): { value: unknown; onInput: (e: Event) => void; onBlur: () => void };
}

/** Dynamic list-of-fields state returned by {@linkcode useFieldArray}. */
export interface FieldArrayState<T> {
  /** Current items (signal-tracked). */
  readonly items: T[];
  /** Append an item. */
  push(item: T): void;
  /** Remove item at index. */
  remove(index: number): void;
  /** Move item from one index to another. */
  move(from: number, to: number): void;
  /** Replace item at index. */
  set(index: number, item: T): void;
  /** Reset to initial items. */
  reset(): void;
}

// ── useForm ─────────────────────────────────────────────────────────

/**
 * Create a form state manager with validation.
 * Call outside the component body (like signal/useLocal).
 *
 * ```ts
 * const form = useForm({
 *   name: { initial: "", rules: [(v) => v ? null: "Required"] },
 *   email: { initial: "", rules: [(v) => v.includes("@") ? null: "Invalid email"] },
 * });
 *
 * const App = () => h("form", null,
 *   h("input", form.bind("name")),
 *   form.fields.name.error && h("span", { className: "error" }, form.fields.name.error),
 * );
 * ```
 */

/** Run the form's Standard Schema over all its values.
 *
 *  WHY A SCHEMA AT ALL, when `rules` already exists. Two reports wrote the same
 *  adapter by hand (report 4 §10.6, report 5 §8.7): the app already has a Zod /
 *  Valibot / ArkType schema for the thing being edited, and restating it as
 *  `rules` is one constraint written twice, in two languages, drifting from the
 *  moment either changes. Standard Schema v1 is one well-known property, so
 *  this costs no dependency — the same reasoning, and the same
 *  `isStandardSchema`, as the cell `validate` hook.
 *
 *  ONE SCHEMA FOR THE FORM, not one per field, because that is the shape apps
 *  actually hold: `z.object({ email: …, age: … })` already exists somewhere in
 *  the codebase. Issues are attributed to fields by their `path`, so a
 *  cross-field refinement lands on the field it names and everything else
 *  lands on the form.
 *
 *  IT COERCES: `values()` returns what the schema PARSED, which is how a
 *  submit handler gets a number for a field the DOM called "42".
 *
 *  ASYNC IS REFUSED BY NAME, exactly as on the dispatch path. `validate()`,
 *  `values()` and `valid` are synchronous — `valid` is read during render — so
 *  there is nowhere here to await, and a schema that silently did not run is
 *  worse than no schema because the form believes the boundary is guarded.
 *  `asyncRules` is the supported way to do work that waits. */
function runFormSchema(
  schema: StandardSchemaLike,
  values: Record<string, unknown>,
):
  | { ok: true; value: unknown }
  | { ok: false; byField: Record<string, string>; form: string[] } {
  const out = schema["~standard"].validate(values);
  if (typeof (out as { then?: unknown })?.then === "function") {
    throw new Error(
      "[aio] useForm: `options.schema` validates ASYNCHRONOUSLY, and a form's " +
        "validate()/values()/valid are synchronous — there is nowhere here to " +
        "await it. Use a synchronous schema, or move the waiting part to a " +
        "field's `asyncRules`.",
    );
  }
  const r = out as
    | { value: unknown; issues?: undefined }
    | { issues: readonly StandardSchemaIssue[] };
  if (!r.issues || r.issues.length === 0) {
    return { ok: true, value: (r as { value: unknown }).value };
  }
  const byField: Record<string, string> = {};
  const form: string[] = [];
  for (const issue of r.issues) {
    const head = issue.path?.[0];
    // The spec allows a bare key OR a `{ key }` wrapper, and both appear in
    // the wild — Zod emits bare keys, Valibot emits wrappers. Reading only one
    // shape would put every issue from the other library on the form instead
    // of on the field, which looks like the schema half-working.
    const key = head === undefined
      ? undefined
      : typeof head === "object" && head !== null && "key" in head
      ? head.key
      : head;
    const name = key === undefined ? undefined : String(key);
    if (name !== undefined && name in values) {
      // FIRST issue wins per field, matching how `rules` already behaves — a
      // field showing three errors at once is three lines of noise for one
      // thing to fix.
      byField[name] ??= issue.message;
    } else {
      form.push(issue.message);
    }
  }
  return { ok: false, byField, form };
}

/** A form: one signal-backed {@linkcode FieldState} per field, plus validity,
 *  dirtiness, values and a `bind()` helper for wiring an `<input>`.
 *
 *  Each field declares its `initial` value and, optionally, `rules` (sync),
 *  `asyncRules` (with `debounceMs`), and the whole form can carry a Standard
 *  Schema — see {@linkcode FormOptions.schema}.
 *  @tier Kit */
export function useForm<T extends Record<string, unknown>>(
  config: {
    [K in keyof T]: {
      initial: T[K];
      rules?: ValidationRule<T[K]>[];
      asyncRules?: AsyncValidationRule<T[K]>[];
      debounceMs?: number;
    };
  },
  options?: FormOptions<T>,
): FormState<T> {
  const fieldStates: Record<
    string,
    // deno-lint-ignore no-explicit-any
    FieldState<any> & { _setError(err: string): void }
  > = {};

  for (
    const [name, cfg] of Object.entries(config) as [
      string,
      {
        initial: unknown;
        rules?: ValidationRule<unknown>[];
        // deno-lint-ignore no-explicit-any
        asyncRules?: AsyncValidationRule<any>[];
        debounceMs?: number;
      },
    ][]
  ) {
    const valueSig: Signal<unknown> = signal<unknown>(cfg.initial);
    const errorSig: Signal<string | null> = signal<string | null>(null);
    const dirtySig: Signal<boolean> = signal<boolean>(false);
    const touchedSig: Signal<boolean> = signal<boolean>(false);
    const initial = cfg.initial;
    const rules = cfg.rules ?? [];

    const validate = (v: unknown): string | null => {
      for (const rule of rules) {
        const err = rule(v);
        if (err) return err;
      }
      return null;
    };

    const validatingSig: Signal<boolean> = signal<boolean>(false);
    const asyncRules = cfg.asyncRules ?? [];
    const debounceMs = cfg.debounceMs ?? 0;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let asyncVersion = 0;
    /** The value whose async verdict is already SETTLED, and whether one is.
     *
     *  `validate()` calls `touch()` on every field and then, on the very next
     *  line, treats `f.validating` as invalid — so it failed on the flag it
     *  had just set, and `form.validate()` returned false for a form whose
     *  rules all pass. It stayed false: the second call after everything had
     *  settled restarted the same rules on the same unchanged value and
     *  failed again. `docs/ui/air-forms.md` documents submit as
     *  `if (form.validate()) …`, so a form with ANY async rule could never be
     *  submitted through the documented path, while `form.valid` said true.
     *
     *  So a re-run for a value whose verdict is already in is not a re-run.
     *  A CHANGED value still re-validates, an in-flight run is still
     *  superseded by a newer one, and `reset()` clears the memo. */
    let settledFor: { v: unknown; err: string | null } | null = null;

    const runAsyncValidation = (v: unknown) => {
      if (asyncRules.length === 0) return;
      const syncErr = validate(v);
      if (syncErr) {
        settledFor = null;
        validatingSig.set(false);
        return;
      }
      // Already answered for exactly this value — RESTORE the answer. Not
      // merely "return": `touch()` re-runs the SYNC rules first and writes
      // their verdict, which is `null` for a field whose only rules are
      // async — so an early return here would have cleared a real async error
      // and reported the form valid.
      if (settledFor && Object.is(settledFor.v, v)) {
        errorSig.set(settledFor.err);
        validatingSig.set(false);
        return;
      }
      const version = ++asyncVersion;
      validatingSig.set(true);

      const run = async () => {
        try {
          for (const rule of asyncRules) {
            const err = await rule(v);
            if (version !== asyncVersion) return;
            if (err) {
              errorSig.set(err);
              settledFor = { v, err };
              validatingSig.set(false);
              return;
            }
          }
          if (version !== asyncVersion) return;
          errorSig.set(null);
          settledFor = { v, err: null };
          validatingSig.set(false);
        } catch (e) {
          if (version !== asyncVersion) return;
          errorSig.set(e instanceof Error ? e.message : "Validation failed");
          validatingSig.set(false);
        }
      };

      if (debounceMs > 0) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(run, debounceMs);
      } else {
        run();
      }
    };

    fieldStates[name] = {
      get value() {
        return valueSig.value;
      },
      get error() {
        return errorSig.value;
      },
      get dirty() {
        return dirtySig.value;
      },
      get touched() {
        return touchedSig.value;
      },
      get validating() {
        return validatingSig.value;
      },
      set(next: unknown) {
        valueSig.set(next);
        dirtySig.set(!Object.is(next, initial));
        if (touchedSig.peek()) {
          errorSig.set(validate(next));
          runAsyncValidation(next);
        }
      },
      touch() {
        touchedSig.set(true);
        errorSig.set(validate(valueSig.peek()));
        runAsyncValidation(valueSig.peek());
      },
      reset() {
        valueSig.set(initial);
        errorSig.set(null);
        dirtySig.set(false);
        touchedSig.set(false);
        validatingSig.set(false);
        settledFor = null;
        asyncVersion++;
        if (debounceTimer) clearTimeout(debounceTimer);
      },
      _setError(err: string) {
        errorSig.set(err);
      },
    };
  }

  /** The current values, as a free function.
   *
   *  `validate()` used to reach them through `this.values()`, which made the
   *  whole method depend on HOW it was called: `form.validate()` worked, and
   *  `const { validate } = form; validate()` — the idiomatic way to take a
   *  handler out of an API object, and the way a submit button gets one — threw
   *  `Cannot read properties of undefined (reading 'values')`, naming neither
   *  the form nor the cause. Worse, it only did so when `options.validators`
   *  was set, because that is the only branch that dereferenced `this`: the
   *  same call site worked until the day someone added a cross-field rule.
   *  Nothing here needs a receiver, so nothing here has one. */
  /** An issue the form schema could not attribute to any field. Held in a
   *  signal so a component that renders it re-renders when it changes. */
  const formErrorSig: Signal<string | null> = signal<string | null>(null);

  const values = (): T => {
    const result: Record<string, unknown> = {};
    for (const [name, f] of Object.entries(fieldStates)) {
      result[name] = f.value;
    }
    return result as T;
  };

  /** The form's values as the schema PARSED them — a number for the field the
   *  DOM called "42", the dozen hand-written `Number(v)` calls deleted.
   *
   *  SEPARATE FROM `values()` ON PURPOSE, and the reason is a type. `values()`
   *  returns `T`, and `T` is inferred from each field's `initial` — so a form
   *  whose `initial` is `""` and whose schema coerces to a number has a
   *  `values()` that says `string` and holds a number. Coercing there would
   *  make the signature a lie, which costs more than the convenience is worth.
   *  This one returns `unknown` and says so: `const { age } = form.parsed() as
   *  z.infer<typeof schema>` is one cast, in the one place the author already
   *  knows the answer.
   *
   *  `null` when there is no schema, or when the values do not parse — the
   *  form is `valid === false` then, and inventing a value would be worse. */
  const parsed = (): unknown => {
    const schema = options?.schema;
    if (!schema) return null;
    const raw: Record<string, unknown> = {};
    for (const [name, f] of Object.entries(fieldStates)) raw[name] = f.value;
    const r = runFormSchema(schema, raw);
    return r.ok ? r.value : null;
  };

  return {
    fields: fieldStates as { [K in keyof T]: FieldState<T[K]> },
    get valid() {
      if (formErrorSig.value !== null) return false;
      for (const f of Object.values(fieldStates)) {
        if (f.error !== null) return false;
        if (f.validating) return false;
      }
      return true;
    },
    get formError() {
      return formErrorSig.value;
    },
    get dirty() {
      for (const f of Object.values(fieldStates)) {
        if (f.dirty) return true;
      }
      return false;
    },
    values,
    parsed,
    validate(): boolean {
      let valid = true;
      for (const f of Object.values(fieldStates)) {
        f.touch();
        if (f.error !== null || f.validating) valid = false;
      }
      // The FORM SCHEMA, before the cross-field validators and after the
      // per-field rules — a field's own rule is the more specific statement
      // and keeps its message, exactly as a cross-field error already defers
      // to one.
      if (options?.schema) {
        const raw: Record<string, unknown> = {};
        for (const [n, f] of Object.entries(fieldStates)) raw[n] = f.value;
        const r = runFormSchema(options.schema, raw);
        if (!r.ok) {
          valid = false;
          for (const [fieldName, message] of Object.entries(r.byField)) {
            const f = fieldStates[fieldName];
            if (f && !f.error) f._setError(message);
          }
          // An issue the schema could not attribute to a field still has to
          // be SEEN. Dropping it is how a form refuses to submit while every
          // field looks fine — the failure people cannot debug.
          if (r.form.length > 0) {
            formErrorSig.set(r.form.join("; "));
          }
        } else {
          formErrorSig.set(null);
        }
      }
      // Cross-field validators
      if (options?.validators) {
        const vals = values();
        for (const validator of options.validators) {
          const result = validator(vals);
          if (result) {
            for (const [fieldName, err] of Object.entries(result)) {
              if (fieldStates[fieldName]) {
                // Only set cross-field error if field doesn't already have a per-field error
                if (!fieldStates[fieldName].error) {
                  fieldStates[fieldName]._setError(err);
                }
                valid = false;
              }
            }
          }
        }
      }
      return valid;
    },
    reset() {
      formErrorSig.set(null);
      for (const f of Object.values(fieldStates)) f.reset();
    },
    bind(name: keyof T) {
      const f = fieldStates[name as string]!;
      return {
        // A plain VALUE, read HERE — not a live getter.
        //
        // `bind()` is called in the component body and its result is handed
        // straight to `h()` as props (`h("input", form.bind("name"))`, the
        // shape this file's own docstring shows). A getter moved the read out
        // of the render pass and into `applyProps`, and cost two things:
        //
        //  * the component never SUBSCRIBED to the field — the read happened
        //    after the render's tracking window closed;
        //  * `prev.value === next.value` was unconditionally true, because both
        //    getters read the same live field. The DOM value was therefore
        //    never rewritten, so `form.reset()` left the typed text on screen.
        //
        // Read eagerly and both go away: the body subscribes, and the props
        // carry the snapshot the render actually described.
        value: f.value,
        onInput: (e: Event) => f.set((e.target as HTMLInputElement).value),
        onBlur: () => f.touch(),
      };
    },
  };
}

// ── useFieldArray ───────────────────────────────────────────────────

/**
 * Create a dynamic array field. Call outside the component body.
 *
 * ```ts
 * const items = useFieldArray([{ name: "Item 1" }]);
 * const App = () => h("ul", null,
 *   ...items.items.map((item, i) => h("li", { key: i }, item.name)),
 * );
 * ```
 *  @tier Kit */
export function useFieldArray<T>(initial: T[] = []): FieldArrayState<T> {
  const sig = signal<T[]>([...initial]);

  /** An index outside the list is a no-op — and used to be a SILENT one. The
   *  three mutators all guarded their bounds and returned, so `remove(i)` with
   *  a stale `i` (the row was already gone, the index came from a filtered
   *  view, the list re-sorted between render and click) changed nothing and
   *  said nothing: the row stayed on screen and there was no thread to pull.
   *
   *  Observe-only, so dev and prod behave identically — prod still no-ops,
   *  dev additionally says which call it was. Not a throw: an index that went
   *  stale between a render and a click is a real race in correct code, and
   *  breaking the handler over it would be the worse trade. */
  const outOfRange = (op: string, index: number, len: number): true => {
    if ((globalThis as Record<string, unknown>).__aioDev === true) {
      console.warn(
        `[aio] useFieldArray.${op}(${index}) is out of range — the list holds ` +
          `${
            count(len, "item")
          }, so nothing changed. The index is stale or came ` +
          `from a different list.`,
      );
    }
    return true;
  };

  return {
    get items() {
      return sig.value;
    },
    push(item: T) {
      sig.set([...sig.peek(), item]);
    },
    remove(index: number) {
      const arr = [...sig.peek()];
      if (index < 0 || index >= arr.length) {
        outOfRange("remove", index, arr.length);
        return;
      }
      arr.splice(index, 1);
      sig.set(arr);
    },
    move(from: number, to: number) {
      const arr = [...sig.peek()];
      if (from < 0 || from >= arr.length) {
        outOfRange("move", from, arr.length);
        return;
      }
      // `to === length` is the append position, so it is in range.
      if (to < 0 || to > arr.length) {
        outOfRange("move", to, arr.length);
        return;
      }
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item!);
      sig.set(arr);
    },
    set(index: number, item: T) {
      const arr = [...sig.peek()];
      if (index < 0 || index >= arr.length) {
        outOfRange("set", index, arr.length);
        return;
      }
      arr[index] = item;
      sig.set(arr);
    },
    reset() {
      sig.set([...initial]);
    },
  };
}
