// A stand-in for Electron's release zip, for the tests that put a runtime in
// the shared store. ONE copy: the e2e update test had its own, without the
// macOS bundle layout, and the store's real `codesign --deep` refused it on a
// Mac ("In subcomponent: …framework") — the update never installed.
import { join } from "@std/path";
import { electronBinIn } from "../src/electron/electron-runtime-fetch.ts";
import {
  electronFuseBinary,
  FUSE_SENTINEL,
} from "../src/electron/electron-fuses.ts";
import { zipTree } from "./zip-helper.ts";

/** Electron's fuse wire as shipped (RunAsNode, NODE_OPTIONS, --inspect on). */
export const FUSE_WIRE = `${FUSE_SENTINEL}\x01\x09101100011`;

/** A runtime zip for this host, with Electron's fuse wire as shipped. */
export async function runtimeZip(tmp: string): Promise<Uint8Array> {
  const stage = join(tmp, "zip-stage");
  const bin = electronBinIn(stage);
  await Deno.mkdir(join(bin, ".."), { recursive: true });
  await Deno.writeTextFile(bin, `#!/bin/sh\n${FUSE_WIRE}`);
  const fuse = electronFuseBinary(stage, Deno.build.os);
  if (fuse !== bin) {
    await Deno.mkdir(join(fuse, ".."), { recursive: true });
    await Deno.writeTextFile(fuse, FUSE_WIRE);
  }
  // macOS: the store's real `codesign --deep` runs on it, so its bundles are as
  // Electron ships them — Info.plists, and the framework's Versions/Current
  // links. A bare file tree is refused ("In subcomponent: …framework").
  if (Deno.build.os === "darwin") {
    const plist = (exe: string, id: string, type: string) =>
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>` +
      `<key>CFBundleExecutable</key><string>${exe}</string>` +
      `<key>CFBundleIdentifier</key><string>${id}</string>` +
      `<key>CFBundlePackageType</key><string>${type}</string></dict></plist>`;
    const contents = join(stage, "Electron.app", "Contents");
    await Deno.writeTextFile(
      join(contents, "Info.plist"),
      plist("Electron", "com.github.Electron", "APPL"),
    );
    const fw = join(contents, "Frameworks", "Electron Framework.framework");
    await Deno.mkdir(join(fw, "Versions", "A", "Resources"));
    await Deno.writeTextFile(
      join(fw, "Versions", "A", "Resources", "Info.plist"),
      plist("Electron Framework", "com.github.Electron.framework", "FMWK"),
    );
    await Deno.symlink("A", join(fw, "Versions", "Current"));
    await Deno.symlink(
      "Versions/Current/Electron Framework",
      join(fw, "Electron Framework"),
    );
    await Deno.symlink("Versions/Current/Resources", join(fw, "Resources"));
  }
  const zip = join(tmp, "runtime.zip");
  await zipTree(stage, zip);
  return await Deno.readFile(zip);
}
