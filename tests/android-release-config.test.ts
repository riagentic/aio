// deno.json `build.android.keystore` / `keyAlias` / `aab`: a release key named
// once in the app's config instead of on every command line. The environment
// still wins, and a password is never read from deno.json (a file you commit).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  _androidRelease,
  _signingForBuild,
  androidSigning,
} from "../src/build/build-android.ts";

const APP = resolve("/app");
const JKS = join(APP, "keys", "release.jks");
const isFile = (p: string) => p === JKS;
const PW = { AIO_ANDROID_KEYSTORE_PASSWORD: "p" };
const cfg = (android: unknown) => ({ build: { android } });

Deno.test("build.android release keys: validated, passwords never read (warned), absent is the old default", () => {
  assertEquals(_androidRelease({}), { aab: false });
  assertEquals(_androidRelease(cfg({ strict: true })), { aab: false });
  assertEquals(
    _androidRelease(
      cfg({ keystore: "keys/release.jks", keyAlias: "up", aab: true }),
    ),
    { keystore: "keys/release.jks", keyAlias: "up", aab: true },
  );
  for (const bad of [{ keystore: "" }, { keyAlias: 3 }, { aab: "yes" }]) {
    const r = _androidRelease(cfg(bad));
    assert("problem" in r, JSON.stringify(bad));
  }
  const pw = _androidRelease(
    cfg({ keystore: "k.jks", keyPassword: "hunter2" }),
  );
  // Never read, warned about, and the build goes on: the key did nothing
  // before these keys existed, so a build that passed still passes.
  assert(!("problem" in pw) && pw.secretWarning);
  assertEquals(pw.keystore, "k.jks");
  assertStringIncludes(pw.secretWarning, "build.android.keyPassword");
  assertStringIncludes(pw.secretWarning, "AIO_ANDROID_KEY_PASSWORD");
  assert(
    !pw.secretWarning.includes("hunter2"),
    "a warning never repeats a secret",
  );
});

Deno.test("android signing: deno.json names the keystore and alias, the environment wins", () => {
  const declared = { keystore: "keys/release.jks", keyAlias: "up", aab: false };
  // deno.json alone (the password from the environment).
  assertEquals(androidSigning(PW, APP, isFile, declared), {
    keystore: JKS,
    keyAlias: "up",
  });
  // The environment wins, key by key.
  assertEquals(
    androidSigning(
      { ...PW, AIO_ANDROID_KEY_ALIAS: "ci" },
      APP,
      isFile,
      declared,
    ),
    { keystore: JKS, keyAlias: "ci" },
  );
  const other = androidSigning(
    { ...PW, AIO_ANDROID_KEYSTORE: "other.jks" },
    APP,
    isFile,
    declared,
  );
  assert(other && "refused" in other);
  assertStringIncludes(other.refused, "AIO_ANDROID_KEYSTORE=other.jks");
  // A deno.json keystore that is not there: named as deno.json's.
  const gone = androidSigning(PW, APP, isFile, {
    ...declared,
    keystore: "no.jks",
  });
  assert(gone && "refused" in gone);
  assertStringIncludes(gone.refused, "build.android.keystore");
  // No password in the environment: refused, naming it.
  const half = androidSigning({}, APP, isFile, declared);
  assert(half && "refused" in half);
  assertStringIncludes(half.refused, "AIO_ANDROID_KEYSTORE_PASSWORD");
  // Nothing declared anywhere: unsigned, as before.
  assertEquals(androidSigning(PW, APP, isFile, { aab: true }), null);
});

Deno.test("android signing: a keystore that cannot be used refuses only a --release build", () => {
  const key = { keystore: JKS, keyAlias: "up" };
  const refused = { refused: "no password" };
  // A release: signed with the key, or refused by name.
  assertEquals(_signingForBuild(key, true, false), { signed: key });
  assertEquals(_signingForBuild(refused, true, false), {
    signed: null,
    refused: "no password",
  });
  // A debug build (and dev:android) on a teammate's/CI machine with the
  // keystore committed to deno.json but no password or file: it goes on,
  // debug-signed, without a word.
  assertEquals(_signingForBuild(refused, false, false), { signed: null });
  assertEquals(_signingForBuild(key, false, false), { signed: null });
  assertEquals(_signingForBuild(null, false, true), { signed: null });
  assertEquals(_signingForBuild(null, true, false), { signed: null });
  // Named by the environment for THIS run: warned, never refused.
  for (const s of [key, refused]) {
    const r = _signingForBuild(s, false, true);
    assertEquals(r.signed, null);
    assert(!r.refused);
    assertStringIncludes(r.warn ?? "", "--release");
  }
});
