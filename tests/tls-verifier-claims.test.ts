// Every verifier the TLS code says was MEASURED has a probe in tests/, or the
// comment says it was measured by hand.
//
// `src/server/tls.ts` said "openssl, rustls, NSS and Go all refuse the forgery
// — measured, not hoped (tests/tls-anchor-stability, tests/x509)". Only openssl
// had a probe there: tls-anchor-stability never issues a forgery, nothing in
// tests/ runs NSS or Go, and the rustls tests only ever ACCEPTED a legitimate
// chain. The NSS/Go/macOS/Windows/Java answers are real — measured by hand in
// the 1.0.8-beta round, table in todo.md — but a comment that cites a test for
// them is a claim no run re-checks, which is the thing that rots silently.
//
// So:
//   1. a rustls probe (below): Deno's own TLS client, trusting ONLY the
//      constrained aio root, refuses a leaf that names a public host beside
//      `localhost` — and accepts the same leaf without it (the instrument);
//   2. a gate: in every comment paragraph of tls.ts / x509.ts that says
//      "measured", each verifier it names is either PROBED (a test file here
//      that actually drives it) or the paragraph says "by hand".
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { generateRoot, issueLeaf } from "../src/server/x509.ts";
import { ROOT_PERMITTED_DNS, ROOT_PERMITTED_IPS } from "../src/server/tls.ts";
import { freePort } from "../src/testing/server-test.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** Verifier → how a comment names it, and — for the probed ones — the test
 *  file that drives it and the call that proves it runs there (read as text,
 *  so a probe that is deleted or renamed turns this red). */
const VERIFIERS: {
  name: string;
  said: RegExp;
  probe?: { file: string; drives: RegExp };
}[] = [
  {
    name: "openssl",
    said: /\bopenssl\b/i,
    probe: { file: "tests/x509.test.ts", drives: /openssl\(\[\s*"verify"/ },
  },
  {
    name: "rustls",
    said: /\brustls\b/i,
    probe: {
      file: "tests/tls-verifier-claims.test.ts",
      drives: /Deno\.createHttpClient\(\{ caCerts/,
    },
  },
  {
    name: "Conscrypt",
    said: /\bConscrypt\b/,
    probe: {
      file: "tests/x509-conscrypt.test.ts",
      drives: /new Deno\.Command\("java"/,
    },
  },
  { name: "NSS", said: /\bNSS\b/ },
  { name: "Go", said: /\bGo\b/ },
  { name: "macOS Security.framework", said: /Security\.framework|\bmacOS\b/ },
  { name: "Windows CryptoAPI", said: /CryptoAPI|\bWindows\b(?= and openssl)/ },
  { name: "Java CertPathValidator", said: /\bJava\b|CertPathValidator/ },
  { name: "Python cryptography", said: /\bPython\b/ },
];

/** The comment paragraphs of a source file: consecutive comment lines, split
 *  at a blank comment line. Code lines end a paragraph. Pure. */
export function commentParagraphs(
  src: string,
): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let cur: string[] = [];
  let start = 0;
  const flush = () => {
    if (cur.join("").trim()) out.push({ line: start, text: cur.join(" ") });
    cur = [];
  };
  src.split("\n").forEach((raw, i) => {
    const m = /^\s*(?:\/\/+|\/\*\*?|\*(?!\/))\s?(.*?)(?:\*\/)?\s*$/.exec(raw);
    if (!m) return flush();
    const body = m[1]!;
    if (!body.trim()) return flush();
    if (!cur.length) start = i + 1;
    cur.push(body.trim());
  });
  flush();
  return out;
}

/** The sentences of a paragraph — split after `.`/`!`/`?`/`;` before a
 *  capital, a backtick or a paren. Version numbers (`14.8.9`) never split. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+(?=[A-Z`(])/);
}

/** Why a paragraph over-claims, or null. Pure. SENTENCE by sentence: a
 *  "by hand" elsewhere in the paragraph must not launder a sentence that
 *  cites a test for a verifier no test runs. */
export function overclaim(text: string, probed: Set<string>): string | null {
  const unprobed = new Set<string>();
  for (const s of sentences(text)) {
    if (!/\bmeasured\b/i.test(s) || /\bby hand\b/i.test(s)) continue;
    for (const v of VERIFIERS) {
      if (!probed.has(v.name) && v.said.test(s)) unprobed.add(v.name);
    }
  }
  return unprobed.size
    ? `says "measured" of ${[...unprobed].join(", ")} — no probe in tests/ ` +
      `runs it; say "measured by hand" (and when), or add the probe`
    : null;
}

Deno.test("tls/x509 comments: a verifier called measured has a probe, or says by hand", async () => {
  const probed = new Set<string>();
  for (const v of VERIFIERS) {
    if (!v.probe) continue;
    const src = await Deno.readTextFile(join(ROOT, v.probe.file));
    assert(
      v.probe.drives.test(src),
      `${v.name}'s probe (${v.probe.file}) no longer matches ${v.probe.drives}`,
    );
    probed.add(v.name);
  }
  const bad: string[] = [];
  let paragraphs = 0;
  for (const f of ["src/server/tls.ts", "src/server/x509.ts"]) {
    for (const p of commentParagraphs(await Deno.readTextFile(join(ROOT, f)))) {
      paragraphs++;
      const why = overclaim(p.text, probed);
      if (why) bad.push(`${f}:${p.line} ${why}`);
    }
  }
  assert(paragraphs > 40, `only ${paragraphs} comment paragraphs parsed`);
  assertEquals(bad, [], bad.join("\n"));
});

Deno.test("tls/x509 comments: the gate catches the claim it was written for", () => {
  const probed = new Set(["openssl", "rustls", "Conscrypt"]);
  assert(
    overclaim(
      "Steal the key and openssl, rustls, NSS and Go all refuse the " +
        "forgery — measured, not hoped.",
      probed,
    )?.includes("NSS, Go"),
  );
  assertEquals(
    overclaim(
      "openssl and rustls refuse it — measured (tests/x509.test.ts).",
      probed,
    ),
    null,
  );
  assertEquals(
    overclaim(
      "NSS and Go refuse it too — measured by hand, 2026-09-21.",
      probed,
    ),
    null,
  );
  // A "by hand" in ANOTHER sentence does not cover this one.
  assert(
    overclaim(
      "openssl, rustls, NSS and Go refuse it — measured (tests/x509). " +
        "The macOS row was measured by hand.",
      probed,
    )?.includes("NSS, Go"),
  );
  // Parsing: `//` runs and `/** … */` blocks, split at blank comment lines.
  assertEquals(
    commentParagraphs("// a\n// b\n//\n// c\nx();\n/** d\n *  e */\n")
      .map((p) => p.text),
    ["a b", "c", "d e"],
  );
});

Deno.test("rustls refuses a leaf naming a public host under the aio root — and accepts it without", async () => {
  const root = await generateRoot({
    commonName: "aio local root (rustls probe)",
    org: "aio",
    days: 3650,
    permittedDns: ROOT_PERMITTED_DNS,
    permittedIpMasks: ROOT_PERMITTED_IPS,
  });
  const leaf = (dns: string[]) =>
    issueLeaf({
      commonName: "aio-probe",
      dns,
      ips: ["127.0.0.1"],
      days: 825,
      caCertPem: root.certPem,
      caKeyPem: root.keyPem,
    });
  /** Does Deno's client (rustls/webpki), trusting ONLY the root, complete a
   *  handshake with a server presenting `cert`? */
  const handshakes = async (cert: { certPem: string; keyPem: string }) => {
    const port = freePort();
    const ac = new AbortController();
    const server = Deno.serve({
      port,
      hostname: "127.0.0.1",
      cert: cert.certPem,
      key: cert.keyPem,
      signal: ac.signal,
      onListen() {},
      onError: () => new Response("tls error", { status: 500 }),
    }, () => new Response("ok"));
    const client = Deno.createHttpClient({ caCerts: [root.certPem] });
    try {
      const res = await fetch(
        `https://localhost:${port}/`,
        { client } as RequestInit & { client: Deno.HttpClient },
      );
      await res.body?.cancel();
      return true;
    } catch {
      return false;
    } finally {
      client.close();
      ac.abort();
      await server.finished;
    }
  };
  // The instrument: the same root, the same client, a legitimate leaf.
  assert(await handshakes(await leaf(["localhost"])), "control leaf refused");
  // The forgery: `www.google.com` beside `localhost`. The dialed name is
  // permitted; the certificate is not — a constraint violation is a verdict
  // on the whole certificate, so the handshake must fail.
  assertEquals(
    await handshakes(await leaf(["localhost", "www.google.com"])),
    false,
    "rustls ACCEPTED a leaf naming www.google.com under the constrained root",
  );
});
