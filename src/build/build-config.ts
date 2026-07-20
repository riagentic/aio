/**
 * @module
 * Build configuration — parses CLI flags, reads deno.json, derives all shared build state.
 */
import { dirname, join, resolve } from "@std/path";
import { slugify } from "./build-helpers.ts";

export interface BuildConfig {
  // Paths
  root: string;
  dist: string;
  out: string;
  frameworkSrcDir: string;

  // Flags
  doElectron: boolean;
  doAndroid: boolean;
  doClient: boolean;
  doCli: boolean;
  doRemote: boolean;
  doCompile: boolean;
  doForce: boolean;
  doRelease: boolean;
  doService: boolean;
  doHeadless: boolean;

  /** dev:android — build a thin APK whose WebView loads this live dev-server URL
   *  (http://localhost:PORT, tunneled via `adb reverse`) instead of bundling
   *  assets. Enables cleartext. */
  androidDevUrl: string | undefined;

  // App identity
  binaryName: string;
  appTitle: string | undefined;
  configEntry: string;
  rendererMode: "aio";

  // Platform
  os: string;
  arch: string;
  archStr: string;

  // Framework resolution
  isRemote: boolean;
  frameworkBase: URL;
}

/** Load and validate build configuration from CLI flags + deno.json */
export async function loadBuildConfig(): Promise<BuildConfig> {
  const root = Deno.cwd();
  const dist = resolve(join(root, "dist"));
  const out = join(dist, "app.js");

  // framework src/ root — this module lives in src/build/, entries live at src/
  const frameworkBase = new URL("..", import.meta.url);
  const isRemote = frameworkBase.protocol !== "file:";
  const frameworkSrcDir = isRemote
    ? ""
    : (import.meta.dirname ? dirname(import.meta.dirname) : ".");

  const doElectron = Deno.args.includes("--electron");
  const doAndroid = Deno.args.includes("--android");
  const doClient = Deno.args.includes("--client");
  const doCli = Deno.args.includes("--cli");
  const doRemote = Deno.args.includes("--remote");
  const doCompile = Deno.args.includes("--compile") || doElectron;
  const doForce = Deno.args.includes("--force");
  const doRelease = Deno.args.includes("--release");
  const doService = Deno.args.includes("--service");
  const doHeadless = Deno.args.includes("--headless");

  // Reject conflicting shell flags
  const shellFlags = [
    doElectron && "--electron",
    doAndroid && "--android",
    doCli && "--cli",
    doClient && "--client",
  ].filter(Boolean);
  if (shellFlags.length > 1) {
    console.error(
      `[build] \u2717 conflicting flags: ${
        shellFlags.join(" + ")
      } — pick one shell target`,
    );
    Deno.exit(1);
  }

  const mainConfig = JSON.parse(
    await Deno.readTextFile(join(root, "deno.json")),
  );
  const rendererMode = "aio" as const;
  const appTitle = mainConfig.title as string | undefined;
  const configEntry = (mainConfig.entry as string | undefined) ?? "src/app.ts";
  const defaultName = appTitle
    ? slugify(appTitle)
    : (root.split("/").pop() || "myapp");
  const rawName = Deno.args.find((a) => a.startsWith("--name="))?.slice(7);
  const binaryName = rawName ? slugify(rawName) : defaultName;

  const androidDevUrl = Deno.args.find((a) =>
    a.startsWith("--android-dev-url=")
  )?.slice("--android-dev-url=".length);

  const os = Deno.build.os;
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  const archStr = arch === "aarch64" ? "arm64" : "x64";

  return {
    root,
    dist,
    out,
    frameworkSrcDir,
    doElectron,
    doAndroid,
    doClient,
    doCli,
    doRemote,
    doCompile,
    doForce,
    doRelease,
    doService,
    doHeadless,
    androidDevUrl,
    binaryName,
    appTitle,
    configEntry,
    rendererMode,
    os,
    arch,
    archStr,
    isRemote,
    frameworkBase,
  };
}
