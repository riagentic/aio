// Two promises a first-hour reader copies verbatim, checked against what the
// code actually does.
//
// - quickstart: `dev` picks a FREE port and prints it; a doc that promises
//   `http://localhost:8000` sends the reader to a port nothing listens on.
// - signing: `ship keygen` writes `~/.aio/keys/<app>-release-key.json` and
//   `ship`/`am publish` default to that file; a doc that shows
//   `--key=release-key.json` (in-repo) teaches the location keygen refuses.
import { assert, assertEquals } from "@std/assert";

const ROOT = new URL("../", import.meta.url).pathname;
const read = (rel: string) => Deno.readTextFile(ROOT + rel);

Deno.test("quickstart describes the printed boot line, not a fixed port", async () => {
  const qs = await read("docs/basics/quickstart.md");
  assert(!/localhost:8000/.test(qs), "dev picks a free port — say so");
  assert(/localhost:<port>/.test(qs), "shows the shape of the printed line");
});

Deno.test("deploy docs name the keygen default key location, never an in-repo key", async () => {
  for (const rel of ["docs/deploy/updates.md", "docs/deploy/signing.md"]) {
    const doc = await read(rel);
    const inRepo = doc.split("\n").filter((l) =>
      /--key=release-key\.json/.test(l)
    );
    assertEquals(inRepo, [], `${rel}: an in-repo key path`);
    assert(doc.includes("~/.aio/keys/"), `${rel}: names the keygen default`);
  }
});
