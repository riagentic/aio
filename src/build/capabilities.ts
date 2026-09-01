// capabilities.ts — least-privilege capability manifest. A wallet shipping with `-A` is a
// contradiction; scan the app's source for the Deno APIs that actually need a
// permission and emit the minimal `--allow-*` set instead.
//
// Conservative by design: if a category shows ANY sign of use it's included
// (too-narrow only breaks the app at runtime — it's never a silent security
// hole). Static + heuristic: it can't see permissions reached only through
// fully-dynamic indirection, so it's a STARTING manifest to review, not a proof.

/** The permission categories an app's source shows signs of needing — the input
 *  to its least-privilege run flags. Conservative: any sign of use ⇒ true. */
export type Capabilities = {
  net: boolean; // fetch / Deno.connect / Deno.listen
  read: boolean; // file reads, SQLite/KV, import of data
  write: boolean; // file writes, SQLite/KV writes
  ffi: boolean; // Deno.dlopen — USB/HID device access
  env: boolean; // Deno.env
  run: boolean; // Deno.Command / subprocess
  sys: boolean; // hostname/osRelease/systemMemoryInfo/networkInterfaces
};

/** What EVERY aio app needs before a line of its own code asks for anything.
 *
 *  The scan starts HERE, not at zero, and that is the whole point. Scanning an
 *  app's own sources answers "what does MY code need" — but the binary also
 *  contains aio, which binds a socket, opens SQLite, writes logs and a lock,
 *  and reads config from the environment. A scaffolded counter app touches
 *  none of those APIs itself, so the scan returned nothing and the manifest
 *  said `least-privilege run flags: (none)`.
 *
 *  MEASURED, not assumed: `deno run src/app.ts` on a freshly scaffolded app
 *  dies inside `immer` reading `NODE_ENV` — before aio prints a line, in a
 *  dependency the user never wrote. With these four it boots. Advice that
 *  produces an app which cannot start is worse than no advice, and this one
 *  also travels: `runFlags` is part of the SIGNED release manifest.
 *
 *  This file records two earlier instances of the same bug, both fixed by
 *  widening a regex rather than giving the scan a floor — `updates:` forced
 *  into the net signal, and the `*Sync` spellings ("the signed manifest
 *  advertised `runFlags: []` — following that advice launched a binary that
 *  died on PermissionDenied at its first file read"). Three patches, one
 *  cause: a scan of the app cannot see the framework. */
export const AIO_BASELINE: Readonly<Capabilities> = Object.freeze({
  net: true, // the server binds; the client connects
  read: true, // deno.json, dist/, the app dir
  write: true, // state.db, logs, the lock, the socket
  env: true, // AIO_PORT / HOME / XDG_* — and immer's NODE_ENV
  // Not baseline: aio degrades without them, and they are real escalations.
  ffi: false, // windows named pipes only
  run: false, // spawning electron / a subprocess
  sys: false, // heap policy reads system memory, and does without
});

// Signal → capability. Matched against comment-stripped source.
const SIGNALS: [keyof Capabilities, RegExp][] = [
  [
    // `updates:` is in here on purpose. An app whose source never calls fetch
    // scans to net:false, and its least-privilege binary then cannot reach its
    // own release host — the update check fails in PRODUCTION ONLY, silently,
    // at the moment a user most needs it. Configuring updates IS a declaration
    // of network use.
    "net",
    /\bfetch\s*\(|\bDeno\.(?:connect|listen|serve|connectTls|listenTls)\b|new\s+WebSocket\b|\bupdates\s*:\s*[{"'`]/,
  ],
  // `Sync` is matched explicitly, never left to `\b`: "readFile" cannot match
  // inside "readFileSync" (e→S is not a word boundary), so an app whose I/O is
  // the *Sync spellings scanned to read:false/write:false and the signed
  // manifest advertised `runFlags: []` — following that advice launched a
  // binary that died on PermissionDenied at its first file read.
  [
    "read",
    /\bDeno\.(?:readFile|readTextFile|readDir|open|stat|lstat|realPath|readLink)(?:Sync)?\b|\bDeno\.openKv\b|\bcreateDB\b|\bopenCassette\b/,
  ],
  [
    "write",
    /\bDeno\.(?:writeFile|writeTextFile|mkdir|remove|rename|create|truncate|symlink|link|chmod|chown|copyFile|makeTempDir|makeTempFile)(?:Sync)?\b/,
  ],
  ["ffi", /\bDeno\.dlopen\b|\bDeno\.UnsafePointer\b|\bDeno\.UnsafeCallback\b/],
  ["env", /\bDeno\.env\b/],
  ["run", /\bDeno\.Command\b|\bDeno\.run\b/],
  [
    "sys",
    /\bDeno\.(?:hostname|osRelease|systemMemoryInfo|networkInterfaces|loadavg|osUptime|uid|gid)\b/,
  ],
];

/** Every `Deno.*` API name the read/write signals above recognize — the guard
 *  test walks this so a newly used API cannot quietly go unscanned. */
export const _SCANNED_FS_APIS: readonly string[] = [
  "readFile",
  "readTextFile",
  "readDir",
  "open",
  "stat",
  "lstat",
  "realPath",
  "readLink",
  "writeFile",
  "writeTextFile",
  "mkdir",
  "remove",
  "rename",
  "create",
  "truncate",
  "symlink",
  "link",
  "chmod",
  "chown",
  "copyFile",
  "makeTempDir",
  "makeTempFile",
];

/** The capabilities an app's binary requires: {@linkcode AIO_BASELINE} — what
 *  aio itself needs — plus whatever the app's own sources ask for on top. */
export function scanCapabilities(sources: { content: string }[]): Capabilities {
  const caps: Capabilities = { ...AIO_BASELINE };
  for (const { content } of sources) {
    // Strip comments so a mention in a comment doesn't grant a permission.
    const code = content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const [cap, re] of SIGNALS) {
      if (!caps[cap] && re.test(code)) caps[cap] = true;
    }
  }
  return caps;
}

/** The minimal `--allow-*` flags for a capability set — `[]` (no perms) up to the
 *  full least-privilege list. Never returns `-A`. Read/write can be path-scoped
 *  by the caller; net can be host-scoped — kept coarse here (the safe superset).
 *  @internal alpha70 — test seam via src/testing/internal.ts */
export function permissionFlags(caps: Capabilities): string[] {
  const flags: string[] = [];
  if (caps.net) flags.push("--allow-net");
  if (caps.read) flags.push("--allow-read");
  if (caps.write) flags.push("--allow-write");
  if (caps.ffi) flags.push("--allow-ffi");
  if (caps.env) flags.push("--allow-env");
  if (caps.run) flags.push("--allow-run");
  if (caps.sys) flags.push("--allow-sys");
  return flags;
}

/** A human-readable manifest: the flags + why each was included.
 *  @internal alpha70 — test seam via src/testing/internal.ts */
export function manifestReport(caps: Capabilities): string {
  const flags = permissionFlags(caps);
  const why: Record<keyof Capabilities, string> = {
    net: "network (fetch / sockets / RPC)",
    read: "file reads (SQLite / KV / assets)",
    write: "file writes (persistence)",
    ffi: "native FFI (USB/HID devices)",
    env: "environment variables",
    run: "subprocesses",
    sys: "system info",
  };
  const lines = [
    `least-privilege run flags: ${flags.length ? flags.join(" ") : "(none)"}`,
    "  (replaces -A; review + path/host-scope before shipping)",
  ];
  for (
    const [cap, on] of Object.entries(caps) as [keyof Capabilities, boolean][]
  ) {
    // WHY a flag is there is the difference between a manifest you can narrow
    // and one you can only accept: "aio itself" is not something the reader
    // can remove by changing their code, and everything else is.
    if (on) {
      lines.push(
        `  • --allow-${cap} — ${why[cap]}${
          AIO_BASELINE[cap] ? " (aio itself)" : ""
        }`,
      );
    }
  }
  return lines.join("\n");
}
