// AIO Form Utilities — useForm hook for controlled inputs, validation, field arrays.
// Signal-based, works with the AIO renderer's tracking system.

import { type Signal, signal } from "../state/signal.ts";

// ── Types ───────────────────────────────────────────────────────────

/** Synchronous field validator — returns an error message or `null` when valid. */
export type ValidationRule<T> = (value: T) => string | null;

export type AsyncValidationRule<T> = (value: T) => Promise<string | null>;

export type CrossFieldValidator<T extends Record<string, unknown>> = (
  values: T,
) => Record<string, string> | null;

export interface FormOptions<T extends Record<string, unknown>> {
  validators?: CrossFieldValidator<T>[];
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
  /** Whether any field has been modified. */
  readonly dirty: boolean;
  /** Get all current values as a plain object. */
  values(): T;
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

    const runAsyncValidation = (v: unknown) => {
      if (asyncRules.length === 0) return;
      const syncErr = validate(v);
      if (syncErr) {
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
              validatingSig.set(false);
              return;
            }
          }
          if (version !== asyncVersion) return;
          errorSig.set(null);
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
  const values = (): T => {
    const result: Record<string, unknown> = {};
    for (const [name, f] of Object.entries(fieldStates)) {
      result[name] = f.value;
    }
    return result as T;
  };

  return {
    fields: fieldStates as { [K in keyof T]: FieldState<T[K]> },
    get valid() {
      for (const f of Object.values(fieldStates)) {
        if (f.error !== null) return false;
        if (f.validating) return false;
      }
      return true;
    },
    get dirty() {
      for (const f of Object.values(fieldStates)) {
        if (f.dirty) return true;
      }
      return false;
    },
    values,
    validate(): boolean {
      let valid = true;
      for (const f of Object.values(fieldStates)) {
        f.touch();
        if (f.error !== null || f.validating) valid = false;
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
 */
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
          `${len} item(s), so nothing changed. The index is stale or came ` +
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
