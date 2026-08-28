// An app's NAME reduces to a slug in four places, and the slug is its identity:
// it names the lock file, the data directory, the UDS socket — and the
// shared-key cookie. The same expression was written out in four files.
//
// They agreed, which is the dangerous state rather than the safe one. Changing
// the appId rule in `single-instance-lock.ts` alone would have left two apps
// whose ids differ only in punctuation holding SEPARATE locks while SHARING a
// cookie — a credential crossing between apps, from an edit that looked local.
// Cookies ignore the port, so two aio apps on one host already share a jar;
// the slug is the only thing keeping their credentials apart.
//
// One transform now. The FALLBACK stays a caller's choice, because it genuinely
// is one: a lock with no id is `aio-app`, a nameless binary is `myapp`.
import { assertEquals } from "@std/assert";
import { slugify } from "../src/server/single-instance-lock.ts";
import { slugify as buildSlug } from "../src/build/build-helpers.ts";
import { toSlug } from "../src/electron/electron-shared.ts";
import { keyCookieNameFor } from "../src/server/server.ts";

/** Names that reduce differently under a careless rule — punctuation, case,
 *  runs of separators, and the edges where a trim rule shows itself. */
const NAMES = [
  "my-app",
  "my_app",
  "my.app",
  "My App",
  "MY  APP",
  "my---app",
  "-leading",
  "trailing-",
  "--both--",
  "app123",
  "123app",
  "ünïcode",
  "a",
  "",
  "!!!",
  "a!!!b",
  "  spaced  ",
];

Deno.test("every consumer reduces a name the same way", () => {
  const disagree: string[] = [];
  for (const n of NAMES) {
    const base = slugify(n);
    // The build's binary name and Electron's userData path must agree with the
    // lock about what this name IS — only the empty-input fallback may differ.
    const b = buildSlug(n);
    const e = toSlug(n);
    if (e !== base) {
      disagree.push(`toSlug(${JSON.stringify(n)}): ${e} ≠ ${base}`);
    }
    if (base !== "aio-app" && b !== base) {
      disagree.push(`buildSlug(${JSON.stringify(n)}): ${b} ≠ ${base}`);
    }
    // …and so must the cookie, which is what keeps two apps' credentials apart.
    const cookie = keyCookieNameFor(n);
    const expected = `aio_key_${base === "aio-app" ? "app" : base}`;
    if (cookie !== expected) {
      disagree.push(`cookie(${JSON.stringify(n)}): ${cookie} ≠ ${expected}`);
    }
  }
  assertEquals(disagree, [], disagree.join("\n"));
});

Deno.test("the fallback is the caller's, the transform is not", () => {
  assertEquals(slugify(""), "aio-app");
  assertEquals(slugify("", "myapp"), "myapp");
  assertEquals(slugify("!!!", "app"), "app");
  // A name that DOES reduce ignores the fallback entirely.
  assertEquals(slugify("My App", "unused"), "my-app");
});

Deno.test("two names that differ only in punctuation are ONE app", () => {
  // Not a defect — a consequence, and one worth stating: the slug is the
  // identity, so `my-app`, `my_app` and `my.app` are the same app everywhere,
  // including its cookie. What must never happen is them being the same in one
  // place and different in another.
  const forms = ["my-app", "my_app", "my.app", "My App"];
  const slugs = new Set(forms.map((f) => slugify(f)));
  const cookies = new Set(forms.map((f) => keyCookieNameFor(f)));
  assertEquals(slugs.size, 1, "one identity");
  assertEquals(cookies.size, 1, "…and one cookie, consistently");
});
