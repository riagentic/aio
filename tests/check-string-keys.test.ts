// The string-key ratchet must be able to SEE the two shipped spellings:
//   • `[...subs].sort().join(",")` as a cache key (server view-key collision —
//     {"a,b"} and {"a","b"} were one key), and
//   • `plist.replace(re, `$1${valueXml}`)` (an app title holding `$&` wrote
//     the matched tag into Info.plist — a replacement STRING expands `$`).
// Pinned on TEXT: what it must catch, what it must not, and `aio-ok`.
import { assertEquals } from "@std/assert";
import { scanSource } from "../scripts/check-string-keys.ts";

Deno.test("string-keys gate: it sees a sorted-join key, whatever the variable is called", () => {
  const r = scanSource(`
    const subs = meta.subscriptions ? [...meta.subscriptions].sort().join(",") : "*";
    const key = [...held].sort().join("|");
    cache.get(parts.sort((a, b) => a.localeCompare(b)).join(":"));
    const k = xs.slice().sort().join("");
  `);
  assertEquals(r.keys, [2, 3, 4, 5]);
});

Deno.test("string-keys gate: a prose join, an unsorted join and text do not count", () => {
  const r = scanSource(`
    throw new Error("Valid keys: " + [...VALID].sort().join(", "));
    log(\`known: \${[...known].sort().join(", ")}\`);
    const path = segs.join(".");
    // [...s].sort().join(",") in a comment
    const doc = "[...s].sort().join(',')";
    const safe = JSON.stringify([...parts].sort());
  `);
  assertEquals(r.keys, [], JSON.stringify(r.keys));
});

Deno.test("string-keys gate: it sees an interpolated or concatenated replacement string", () => {
  const r = scanSource(`
    if (re.test(plist)) return plist.replace(re, \`$1\${valueXml}\`);
    v = v.replaceAll("{nonce}", \`'nonce-\${nonce}'\`);
    raw.replace(existing, line + (hadComma ? "," : ""));
    s.replace(
      re,
      "$1" + value,
    );
  `);
  assertEquals(r.replaces, [2, 3, 4, 5]);
});

Deno.test("string-keys gate: replacer functions and plain literals do not count", () => {
  const r = scanSource(`
    plist.replace(re, (_m, pre: string) => pre + valueXml);
    s.replace(re, function (m) { return \`\${m}!\`; });
    s.replace(re, async (m) => m);
    s.replace(/a/g, "b");
    s.replace(/a/g, \`$1-plain\`);
    s.replace(/a/g, fn);
    s.replace(re, f(a + b));
    const t = s.replace;
    // s.replace(re, \`\${x}\`)
  `);
  assertEquals(r.replaces, [], JSON.stringify(r.replaces));
});

Deno.test("string-keys gate: aio-ok is scoped per rule and read from the comment", () => {
  const r = scanSource(`
    // aio-ok(string-key): cell ids are identifiers, never hold a comma
    const key = [...held].sort().join(",");
    s.replace(re, \`\${n}px\`); // aio-ok(replace-template): n is a number

    s.replace(re, \`\${n}px\`); // aio-ok(string-key): wrong rule
  `);
  assertEquals(r.keys, []);
  assertEquals(r.replaces, [6]);
  assertEquals(r.justified, 2);
});
