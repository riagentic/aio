/**
 * @module
 * Which attached device `dev:android` runs on. Kept out of src/dev-android.ts,
 * whose exports are a public entry point.
 */
import type { Device } from "../android-install.ts";

/** The device dev:android runs on, from `adb devices -l` — or null when none
 *  is ready yet (the caller boots an AVD and asks again). `ANDROID_SERIAL`
 *  (adb's own variable) names one; else a ready emulator wins over a phone
 *  (this is the emulator flow), and a lone phone is used as before. Every adb
 *  call then names it with `-s`: unnamed, a phone plus an emulator made each
 *  `adb shell` fail "more than one device/emulator", so dev:android never saw
 *  the emulator as booted, started a SECOND one and timed out after 180 s.
 *  Pure. @internal */
export function devTarget(
  devices: readonly Device[],
  serial?: string,
): { device: Device } | { error: string; hint: string } | null {
  const ready = devices.filter((d) =>
    d.state === "device" && (!serial || d.serial === serial)
  );
  const emulators = ready.filter((d) => d.emulator);
  const pool = emulators.length ? emulators : ready;
  if (pool.length === 1) return { device: pool[0]! };
  if (pool.length === 0) return null;
  return {
    error: `${pool.length} ${
      emulators.length ? "emulators" : "devices"
    } are attached — name the one to use`,
    hint: pool.map((d) =>
      `ANDROID_SERIAL=${d.serial}${d.model ? ` (${d.model})` : ""}`
    ).join("\n  "),
  };
}
