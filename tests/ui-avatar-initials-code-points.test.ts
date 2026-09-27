// Bug hunt r2: Avatar's `initials()` (src/ui/mod.ts) indexes UTF-16 code
// units (`parts[0][0]`), so a name whose first character is outside the BMP —
// a Japanese surname written with 𠮷 (U+20BB7, as in 𠮷田), an emoji — gets
// HALF a surrogate pair as its "initial": ill-formed text that renders as �.
import { assert, assertEquals } from "@std/assert";
import { h, renderToString } from "../src/air/vdom.ts";
import { Avatar } from "../src/ui/mod.ts";

function initialsOf(name: string): string {
  const html = renderToString(h(Avatar, { name }));
  const m = html.match(/<span[^>]*>([^<]*)<\/span>/);
  assert(m, html);
  return m[1]!;
}

Deno.test("Avatar: an astral first character is kept whole", () => {
  const got = initialsOf("𠮷田 太郎");
  assert(
    got.isWellFormed(),
    `lone surrogate in initials: ${JSON.stringify(got)}`,
  );
  assertEquals(got, "𠮷太");
});

Deno.test("Avatar: an emoji-led name yields a well-formed initial", () => {
  const got = initialsOf("🦊 Fox");
  assert(
    got.isWellFormed(),
    `lone surrogate in initials: ${JSON.stringify(got)}`,
  );
});
