// `am link` (alias `am fix`) — make a cloned aio app buildable.
//
// Source-layout apps import the framework through a `dep/aio` SYMLINK that is
// gitignored (machine-specific), so a fresh `git clone` has no `dep/aio` and
// `deno task dev` / `compile` fail. This re-creates that symlink → the aio
// checkout `am` runs from (installed by install.sh at ~/.local/lib/aio), so the
// app builds without needing `am create` or a manual JSR switch.
import { join, resolve } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { repoRoot } from "./am-cmd-create.ts";

/** Resolve the framework checkout to link against: --aio flag › $AIO_HOME ›
 *  the checkout am itself runs from › the default install location. Verified to
 *  actually be an aio checkout (has mod.ts) before use. */
export function resolveAioRoot(args: string[]): string | null {
  const flag = args.find((a) => a.startsWith("--aio="))?.slice(6);
  const home = Deno.env.get("AIO_HOME");
  const candidates = [
    flag ? resolve(Deno.cwd(), flag) : undefined,
    home,
    repoRoot(),
    `${Deno.env.get("HOME") ?? ""}/.local/lib/aio`,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      Deno.statSync(join(c, "mod.ts"));
      return c;
    } catch { /* not an aio checkout — try next */ }
  }
  return null;
}

/** True when the app's deno.json actually uses the `dep/aio` source layout. */
export async function usesDepAio(dir: string): Promise<boolean> {
  for (const f of ["deno.json", "deno.jsonc"]) {
    try {
      const raw = await Deno.readTextFile(join(dir, f));
      if (raw.includes("dep/aio")) return true;
    } catch { /* next */ }
  }
  return false;
}

const hasMod = (p: string) =>
  Deno.stat(join(p, "mod.ts")).then(() => true).catch(() => false);

/** Read-only: what `linkDepAio` WOULD do (for --dry-run), no changes. */
export async function probeDepAio(
  dir: string,
): Promise<"ok" | "vendored" | "blocked" | "would-link"> {
  const link = join(dir, "dep", "aio");
  const st = await Deno.lstat(link).catch(() => null);
  if (st && !st.isSymlink) return (await hasMod(link)) ? "vendored" : "blocked";
  if (st?.isSymlink) {
    const target = resolve(dir, "dep", await Deno.readLink(link));
    return (await hasMod(target)) ? "ok" : "would-link"; // broken → relink
  }
  return "would-link"; // missing
}

/** Safely reconcile `dep/aio`:
 *  - "vendored"  — a real DIRECTORY with mod.ts (a committed framework copy): we
 *    NEVER touch it (deleting deliberately-vendored code would be destructive).
 *  - "blocked"   — a real dir/file that ISN'T a usable aio: left in place, the
 *    caller flags it for manual attention.
 *  - "ok"        — a working symlink (points at an aio with mod.ts). Left as-is
 *    unless `force` and it points somewhere other than `root` (then re-linked).
 *  - "linked"    — was missing or a BROKEN symlink; (re)created → `root`.
 *  Only ever removes a SYMLINK, never a real directory. */
export async function linkDepAio(
  dir: string,
  root: string,
  force = false,
): Promise<"ok" | "linked" | "vendored" | "blocked"> {
  const link = join(dir, "dep", "aio");
  const st = await Deno.lstat(link).catch(() => null);
  if (st && !st.isSymlink) {
    return (await hasMod(link)) ? "vendored" : "blocked";
  }
  if (st?.isSymlink) {
    const target = resolve(dir, "dep", await Deno.readLink(link));
    const works = await hasMod(target);
    // Normalize root too — an unnormalized AIO_HOME (trailing slash, …) would
    // otherwise compare unequal to the resolved target and force a needless
    // remove+recreate of an already-correct link.
    if (works && (!force || target === resolve(root))) return "ok";
    // broken link, or force-relink to a different root: replace the SYMLINK.
    await Deno.remove(link);
  }
  await Deno.mkdir(join(dir, "dep"), { recursive: true });
  await Deno.symlink(root, link);
  return "linked";
}

export async function cmdLink(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const dir = Deno.cwd();

  // Must be an app dir.
  const hasDenoJson = await Deno.stat(join(dir, "deno.json"))
    .then(() => true).catch(() => false) ||
    await Deno.stat(join(dir, "deno.jsonc")).then(() => true).catch(() =>
      false
    );
  if (!hasDenoJson) {
    outError(
      "no deno.json here — run `am link` from the root of a cloned aio app.",
      mode,
    );
    Deno.exit(1);
  }

  // Nothing to do for JSR-pinned apps.
  if (!(await usesDepAio(dir))) {
    out(
      mode === "pretty"
        ? "this app doesn't use the dep/aio layout (JSR-pinned) — nothing to link."
        : { linked: false, reason: "not a dep/aio app" },
      mode,
    );
    return;
  }

  const root = resolveAioRoot(args);
  if (!root) {
    outError(
      "can't find the aio framework to link against. Install it with\n" +
        "  curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh\n" +
        "then re-run `am link`, or pass --aio=<path-to-aio-checkout>.",
      mode,
    );
    Deno.exit(1);
  }

  // `am link` is explicit intent — force a re-link of a stale symlink to the
  // installed framework (but still never deletes a real vendored dir).
  const r = await linkDepAio(dir, root, true);
  if (r === "vendored") {
    out(
      mode === "pretty"
        ? "· dep/aio is a real vendored copy (not a symlink) — left untouched."
        : { linked: false, reason: "vendored copy" },
      mode,
    );
    return;
  }
  if (r === "blocked") {
    outError(
      "dep/aio exists but isn't a usable aio (no mod.ts) and isn't a symlink — " +
        "inspect/remove it by hand, then re-run `am link`.",
      mode,
    );
    Deno.exit(1);
  }
  out(
    mode === "pretty"
      ? (r === "ok"
        ? `✓ already linked: dep/aio → ${root}`
        : `✓ linked dep/aio → ${root}\n  now run: deno task dev`)
      : { linked: true, target: root, changed: r === "linked" },
    mode,
  );
}
