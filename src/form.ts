// AIO Form Utilities — useForm hook for controlled inputs, validation, field arrays.
// Signal-based, works with the AIO renderer's tracking system.

import { type Signal, signal } from "./signal.ts";

// ── Types ───────────────────────────────────────────────────────────

export type ValidationRule<T> = (value: T) => string | null;

export interface FieldState<T> {
  /** Current field value (signal-tracked). */
  readonly value: T;
  /** Current error message or null. */
  readonly error: string | null;
  /** Whether the field has been modified. */
  readonly dirty: boolean;
  /** Whether the field has been touched (blurred). */
  readonly touched: boolean;
  /** Set the field value. */
  set(next: T): void;
  /** Mark as touched (call on blur). */
  touch(): void;
  /** Reset to initial value. */
  reset(): void;
}

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
 *   name: { initial: "", rules: [(v) => v ? null : "Required"] },
 *   email: { initial: "", rules: [(v) => v.includes("@") ? null : "Invalid email"] },
 * });
 *
 * const App = () => h("form", null,
 *   h("input", form.bind("name")),
 *   form.fields.name.error && h("span", { className: "error" }, form.fields.name.error),
 * );
 * ```
 */
export function useForm<T extends Record<string, unknown>>(
  config: { [K in keyof T]: { initial: T[K]; rules?: ValidationRule<T[K]>[] } },
): FormState<T> {
  // deno-lint-ignore no-explicit-any
  const fieldStates: Record<string, FieldState<any>> = {};

  for (
    const [name, cfg] of Object.entries(config) as [
      string,
      { initial: unknown; rules?: ValidationRule<unknown>[] },
    ][]
  ) {
    const valueSig: Signal<unknown> = signal(cfg.initial);
    const errorSig: Signal<string | null> = signal(null);
    const dirtySig: Signal<boolean> = signal(false);
    const touchedSig: Signal<boolean> = signal(false);
    const initial = cfg.initial;
    const rules = cfg.rules ?? [];

    const validate = (v: unknown): string | null => {
      for (const rule of rules) {
        const err = rule(v);
        if (err) return err;
      }
      return null;
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
      set(next: unknown) {
        valueSig.set(next);
        dirtySig.set(!Object.is(next, initial));
        if (touchedSig.peek()) errorSig.set(validate(next));
      },
      touch() {
        touchedSig.set(true);
        errorSig.set(validate(valueSig.peek()));
      },
      reset() {
        valueSig.set(initial);
        errorSig.set(null);
        dirtySig.set(false);
        touchedSig.set(false);
      },
    };
  }

  return {
    fields: fieldStates as { [K in keyof T]: FieldState<T[K]> },
    get valid() {
      for (const f of Object.values(fieldStates)) {
        if (f.error !== null) return false;
      }
      return true;
    },
    get dirty() {
      for (const f of Object.values(fieldStates)) {
        if (f.dirty) return true;
      }
      return false;
    },
    values(): T {
      const result: Record<string, unknown> = {};
      for (const [name, f] of Object.entries(fieldStates)) {
        result[name] = f.value;
      }
      return result as T;
    },
    validate(): boolean {
      let valid = true;
      for (const f of Object.values(fieldStates)) {
        f.touch();
        if (f.error !== null) valid = false;
      }
      return valid;
    },
    reset() {
      for (const f of Object.values(fieldStates)) f.reset();
    },
    bind(name: keyof T) {
      const f = fieldStates[name as string]!;
      return {
        get value() {
          return f.value;
        },
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

  return {
    get items() {
      return sig.value;
    },
    push(item: T) {
      sig.set([...sig.peek(), item]);
    },
    remove(index: number) {
      const arr = [...sig.peek()];
      if (index < 0 || index >= arr.length) return;
      arr.splice(index, 1);
      sig.set(arr);
    },
    move(from: number, to: number) {
      const arr = [...sig.peek()];
      if (from < 0 || from >= arr.length || to < 0 || to > arr.length) return;
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item!);
      sig.set(arr);
    },
    set(index: number, item: T) {
      const arr = [...sig.peek()];
      if (index < 0 || index >= arr.length) return;
      arr[index] = item;
      sig.set(arr);
    },
    reset() {
      sig.set([...initial]);
    },
  };
}
