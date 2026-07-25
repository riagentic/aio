// capabilities.ts — least-privilege capability manifest (risoto #9, the
// structural half of `aio ship`). A wallet shipping with `-A` is a
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

const EMPTY: Capabilities = {
  net: false,
  read: false,
  write: false,
  ffi: false,
  env: false,
  run: false,
  sys: false,
};

// Signal → capability. Matched against comment-stripped source.
const SIGNALS: [keyof Capabilities, RegExp][] = [
  [
    "net",
    /\bfetch\s*\(|\bDeno\.(?:connect|listen|serve|connectTls|listenTls)\b|new\s+WebSocket\b/,
  ],
  [
    "read",
    /\bDeno\.(?:readFile|readTextFile|readDir|open|stat|realPath|readLink)\b|\bDeno\.openKv\b|\bcreateDB\b|\bopenCassette\b/,
  ],
  [
    "write",
    /\bDeno\.(?:writeFile|writeTextFile|mkdir|remove|rename|create|truncate|symlink|link|chmod|chown)\b/,
  ],
  ["ffi", /\bDeno\.dlopen\b|\bDeno\.UnsafePointer\b|\bDeno\.UnsafeCallback\b/],
  ["env", /\bDeno\.env\b/],
  ["run", /\bDeno\.Command\b|\bDeno\.run\b/],
  [
    "sys",
    /\bDeno\.(?:hostname|osRelease|systemMemoryInfo|networkInterfaces|loadavg|osUptime|uid|gid)\b/,
  ],
];

/** Scan source contents → the capabilities they require. */
export function scanCapabilities(sources: { content: string }[]): Capabilities {
  const caps: Capabilities = { ...EMPTY };
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
 *  by the caller; net can be host-scoped — kept coarse here (the safe superset). */
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

/** A human-readable manifest: the flags + why each was included. */
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
    if (on) lines.push(`  • --allow-${cap} — ${why[cap]}`);
  }
  return lines.join("\n");
}
