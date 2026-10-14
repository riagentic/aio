// sfx-sign-helper.ts — what an Authenticode signature does to a one-click
// `.exe`, without a certificate: the file padded to 8 bytes, a certificate
// table after it, and the PE's security directory pointing at the table. The
// trailer is then no longer at the end of the file — the shape every reader
// of it (the stub, run.ps1, am publish) has to find it in.

/** `exe` as a signing tool would leave it. */
export function fakeSigned(exe: Uint8Array): Uint8Array {
  const head = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const opt = head.getUint32(0x3c, true) + 24;
  const dirs = opt + (head.getUint16(opt, true) === 0x20b ? 112 : 96);
  const table = Math.ceil(exe.length / 8) * 8;
  const out = new Uint8Array(table + 4096);
  out.set(exe);
  out.fill(0xc5, table);
  const view = new DataView(out.buffer);
  view.setUint32(dirs + 4 * 8, table, true);
  view.setUint32(dirs + 4 * 8 + 4, 4096, true);
  return out;
}
