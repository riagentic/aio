// A filesystem path, as something an `import` or an import map can name.
//
// A fixture that writes `from "${REPO}mod.ts"` or `"aio": `${REPO}mod.ts`` is
// writing a PATH where a module specifier goes. POSIX forgives it — `/a/b.ts`
// is also a valid URL path — and Windows does not: `C:\a\b.ts` reads as a URL
// with the scheme `c:` ("Unsupported scheme "c" for module …"), the fixture
// app never boots, and a test waiting for it waits forever. Measured on a real
// Windows 11: three suite files hung on exactly this.
import { toFileUrl } from "@std/path";

/** `file:` URL text for an absolute path — a trailing separator survives, so
 *  `${spec(REPO)}mod.ts` and `${spec(REPO)}/src/` both keep working. Anything
 *  that already is a specifier (`file://…`, `npm:…`, `jsr:…`, `https://…`, a
 *  relative `./x`, a bare name) is returned as it came. Pure. */
export function spec(pathOrSpecifier: string): string {
  const s = pathOrSpecifier;
  const isWinPath = /^[A-Za-z]:[\\/]/.test(s);
  if (!isWinPath && !s.startsWith("/")) return s;
  return toFileUrl(s).href;
}
