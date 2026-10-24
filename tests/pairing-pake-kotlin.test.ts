// The Android client's CPace port (android-template Cpace.kt) on a JVM: the
// draft-irtf-cfrg-cpace-21 Appendix B.1 vectors and aio's golden vector —
// the same ones the server and the Electron client are held to
// (tests/cpace-vectors.ts). It compiles the file the APK SHIPS (the generated
// ANDROID_TEMPLATE entry) with the Kotlin compiler Gradle already fetched,
// on the JDK `findJdk` picks for Android builds.
//
// Gate: a JDK and Gradle's Kotlin compiler jars in ~/.gradle (any machine
// that has built an aio APK).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";
import { findJdk } from "../src/build/build-helpers.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { AIO, DRAFT } from "./cpace-vectors.ts";

const CACHE = join(
  Deno.env.get("HOME") ?? "",
  ".gradle",
  "caches",
  "modules-2",
  "files-2.1",
);

/** The newest jar of group/artifact in Gradle's cache, or null. */
function jar(group: string, artifact: string): string | null {
  const dir = join(CACHE, group, artifact);
  const found: string[] = [];
  try {
    for (const v of Deno.readDirSync(dir)) {
      for (const h of Deno.readDirSync(join(dir, v.name))) {
        for (const f of Deno.readDirSync(join(dir, v.name, h.name))) {
          if (f.name === `${artifact}-${v.name}.jar`) {
            found.push(join(dir, v.name, h.name, f.name));
          }
        }
      }
    }
  } catch {
    return null; // aio-ok: not in the cache — the gate below says so
  }
  return found.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .at(-1) ?? null;
}

const COMPILER = [
  ["org.jetbrains.kotlin", "kotlin-compiler-embeddable"],
  ["org.jetbrains.kotlin", "kotlin-stdlib"],
  ["org.jetbrains.kotlin", "kotlin-script-runtime"],
  ["org.jetbrains.kotlin", "kotlin-reflect"],
  ["org.jetbrains.kotlin", "kotlin-daemon-embeddable"],
  ["org.jetbrains.intellij.deps", "trove4j"],
  ["org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm"],
  ["org.jetbrains", "annotations"],
].map(([g, a]) => jar(g!, a!));
const JDK = findJdk().home;
const skip = !JDK
  ? "no JDK"
  : COMPILER.some((j) => !j)
  ? "Gradle's Kotlin compiler jars are not in ~/.gradle (build an APK once)"
  : null;

const VEC_KT = `package aio.app
fun hx(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
fun q(s: String) = "\\"" + s + "\\""
fun main(args: Array<String>) {
  val a = args.toList().iterator()
  fun n() = a.next()
  val prs = n(); val ci = hx(n()); val sid = hx(n()); val ya = hx(n()); val ada = n(); val yb = hx(n()); val adb = n()
  val lowS = hx(n()); val lows = n().split(",").map { hx(it) }
  val pin = n(); val leaf = n(); val iv = hx(n()); val profile = n()
  val g = Cpace.calculateGenerator(prs.toByteArray(), ci, sid)
  val Ya = Cpace.scalarMultVfy(ya, g); val Yb = Cpace.scalarMultVfy(yb, g)
  val K = Cpace.scalarMultVfy(ya, Yb)
  val isk = Cpace.isk(sid, K, Ya, ada.toByteArray(), Yb, adb.toByteArray())
  val low = lows.map { q(hex(Cpace.scalarMultVfy(lowS, it))) }
  val fp = Cpace.fingerprint(leaf.toByteArray())
  val st = Cpace.start(pin, fp, ya, sid)
  val r = Cpace.respond(pin, fp, sid, st.ya, yb)!!
  val f = Cpace.finish(st, r.first, fp)!!
  val box = Cpace.seal(r.second.isk, sid, profile, iv)
  val opened = Cpace.open(f.isk, sid, box)
  val bad = box.copyOf(); bad[bad.size - 1] = (bad[bad.size - 1].toInt() xor 1).toByte()
  val lenVec = listOf(
    hex(Cpace.prependLen(ByteArray(0))), hex(Cpace.prependLen("1234".toByteArray())),
    hex(Cpace.lvCat("1234".toByteArray(), "5".toByteArray(), ByteArray(0), "678".toByteArray())),
    hex(Cpace.prependLen(ByteArray(128) { it.toByte() }).copyOf(3)),
  ).map { q(it) }
  println("{" + listOf(
    "g" to q(hex(g)), "Ya" to q(hex(Ya)), "Yb" to q(hex(Yb)), "K" to q(hex(K)), "isk" to q(hex(isk)),
    "low" to low.joinToString(",", "[", "]"),
    "aYa" to q(hex(st.ya)), "aYb" to q(hex(r.first)), "ta" to q(hex(f.ta)), "tb" to q(hex(f.tb)),
    "box" to q(hex(box)), "opened" to (opened?.let { q(it.replace("\\"", "\\\\\\"")) } ?: "null"),
    "tampered" to (Cpace.open(f.isk, sid, bad)?.let { q(it) } ?: "null"),
    "fp" to q(hex(fp)), "len" to lenVec.joinToString(",", "[", "]"),
  ).joinToString(",") { q(it.first) + ":" + it.second } + "}")
}
`;

Deno.test({
  name:
    "android client: Cpace.kt reproduces the draft-21 B.1 vectors and aio's golden vector on a JVM",
  ignore: skip !== null,
  // aio-ok: two JVM processes (the compiler, the vector run)
  sanitizeResources: false,
  fn: async () => {
    const dir = await tempDir("pake-kotlin-");
    try {
      const src = ANDROID_TEMPLATE["app/src/main/java/aio/app/Cpace.kt"];
      assert(src, "the APK template ships no Cpace.kt");
      await Deno.writeTextFile(join(dir, "Cpace.kt"), src);
      await Deno.writeTextFile(join(dir, "Vec.kt"), VEC_KT);
      const java = join(JDK!, "bin", "java");
      const std = COMPILER[1]!;
      const kc = await new Deno.Command(java, {
        args: [
          "-cp",
          COMPILER.join(":"),
          "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
          "-no-stdlib",
          "-no-reflect",
          "-nowarn",
          "-cp",
          std,
          "-d",
          join(dir, "out"),
          join(dir, "Cpace.kt"),
          join(dir, "Vec.kt"),
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const kerr = new TextDecoder().decode(kc.stderr);
      assert(kc.success, `kotlinc failed:\n${kerr}`);
      const run = await new Deno.Command(java, {
        args: [
          "-cp",
          `${join(dir, "out")}:${std}`,
          "aio.app.VecKt",
          DRAFT.PRS,
          DRAFT.CI,
          DRAFT.sid,
          DRAFT.ya,
          DRAFT.ADa,
          DRAFT.yb,
          DRAFT.ADb,
          DRAFT.lowOrderS,
          DRAFT.lowOrder.map(([u]) => u).join(","),
          AIO.pin,
          AIO.leaf,
          AIO.iv,
          AIO.profile,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const rerr = new TextDecoder().decode(run.stderr);
      assert(run.success, rerr);
      const got = JSON.parse(new TextDecoder().decode(run.stdout));
      assertEquals(got.len, [
        "00",
        "0431323334",
        "043132333401350003363738",
        "800100",
      ]);
      assertEquals(
        [got.g, got.Ya, got.Yb, got.K, got.isk],
        [DRAFT.g, DRAFT.Ya, DRAFT.Yb, DRAFT.K, DRAFT.ISK_IR],
      );
      assertEquals(
        got.low,
        DRAFT.lowOrder.map(([, q]) => q === "0" ? "00".repeat(32) : q),
      );
      assertEquals(
        [got.fp, got.aYa, got.aYb, got.ta, got.tb, got.box, got.opened],
        [AIO.fp, AIO.Ya, AIO.Yb, AIO.ta, AIO.tb, AIO.box, AIO.profile],
      );
      assertEquals(got.tampered, null, "a tampered box must not open");
    } finally {
      await dropTempDir(dir);
    }
  },
});
