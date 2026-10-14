/**
 * @module
 * Give a Windows exe that has no resources an icon: append one `.rsrc`
 * section holding the images of an `.ico` (`RT_ICON`) and their directory
 * (`RT_GROUP_ICON`, id 1).
 *
 * The one-click `.exe` is the prebuilt stub with a payload after it. The stub
 * is one file for every app and is pinned by hash, so the app's icon cannot
 * be compiled into it: it is written into the copy the build packs. Only a PE
 * of the stub's own shape is touched — PE32+, no resources, nothing after its
 * last section, unsigned, room for one more section header. Anything else is
 * refused with the reason, and the caller packs the stub as it is.
 *
 * Pure: bytes in, bytes out.
 */

/** Resource type ids (`winuser.h`). */
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
/** en-US — what a resource compiler writes by default. */
const LANG = 0x0409;
/** Initialized data, readable: every linker's `.rsrc`. */
const RSRC_CHARACTERISTICS = 0x40000040;
/** The largest `.ico` written into an exe. `run.ps1` reads everything before
 *  the payload to learn what the stub can do, and reads at most 16 MB. */
const MAX_ICO_BYTES = 8 * 1024 * 1024;

const SECTION_HEADER = 40;
const align = (n: number, to: number) => Math.ceil(n / to) * to;

/** One image of an `.ico`: its directory entry's first 12 bytes (width,
 *  height, colours, reserved, planes, bit count, byte length) and its data. */
type IcoImage = { entry: Uint8Array; data: Uint8Array };

/** The images of an `.ico`, or why it cannot be read. Pure. */
export function icoImages(ico: Uint8Array): IcoImage[] | string {
  const v = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  if (
    ico.length < 6 || v.getUint16(0, true) !== 0 || v.getUint16(2, true) !== 1
  ) {
    return "the icon is not an .ico file";
  }
  const count = v.getUint16(4, true);
  if (count < 1 || 6 + 16 * count > ico.length) {
    return "the .ico has no images";
  }
  const out: IcoImage[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const size = v.getUint32(e + 8, true);
    const at = v.getUint32(e + 12, true);
    if (size < 1 || at + size > ico.length) {
      return `image ${i} of the .ico lies outside the file`;
    }
    out.push({
      entry: ico.subarray(e, e + 12),
      data: ico.subarray(at, at + size),
    });
  }
  return out;
}

/** The `.rsrc` section's bytes for `images`, to be mapped at `rva`. Pure.
 *
 *  Three directory levels, as Windows reads them — type, then id, then
 *  language — each a 16-byte table header followed by 8-byte entries sorted by
 *  id; then one 16-byte data entry per resource; then the data, each item on
 *  an 8-byte boundary. */
function rsrcSection(images: readonly IcoImage[], rva: number): Uint8Array {
  const n = images.length;
  // root(2) · icons(n) · n language tables · group(1) · its language table
  const dataEntries = (16 + 2 * 8) + (16 + n * 8) + n * 24 + 24 + 24;
  const group = new Uint8Array(6 + 14 * n);
  const gv = new DataView(group.buffer);
  gv.setUint16(2, 1, true); // type: icon
  gv.setUint16(4, n, true);
  images.forEach((img, i) => {
    group.set(img.entry, 6 + 14 * i);
    gv.setUint16(6 + 14 * i + 12, i + 1, true); // the RT_ICON id
  });
  const blobs = [...images.map((img) => img.data), group];
  let at = align(dataEntries + 16 * (n + 1), 8);
  const offsets = blobs.map((b) => {
    const here = at;
    at = align(at + b.length, 8);
    return here;
  });
  const out = new Uint8Array(at);
  const v = new DataView(out.buffer);
  const SUBDIR = 0x80000000;
  /** A table of `count` id entries at `off`; returns its entries' offset. */
  const table = (off: number, count: number) => {
    v.setUint16(off + 14, count, true); // NumberOfIdEntries
    return off + 16;
  };
  const entry = (off: number, id: number, to: number) => {
    v.setUint32(off, id, true);
    v.setUint32(off + 4, to >>> 0, true);
  };
  const iconsDir = 16 + 2 * 8;
  const iconLangs = iconsDir + 16 + n * 8;
  const groupDir = iconLangs + n * 24;
  const groupLang = groupDir + 24;
  const root = table(0, 2);
  entry(root, RT_ICON, SUBDIR | iconsDir);
  entry(root + 8, RT_GROUP_ICON, SUBDIR | groupDir);
  const icons = table(iconsDir, n);
  blobs.forEach((b, i) => {
    const isGroup = i === n;
    const lang = isGroup ? groupLang : iconLangs + i * 24;
    if (isGroup) entry(table(groupDir, 1), 1, SUBDIR | lang);
    else entry(icons + i * 8, i + 1, SUBDIR | lang);
    const data = dataEntries + 16 * i;
    entry(table(lang, 1), LANG, data);
    v.setUint32(data, rva + offsets[i]!, true);
    v.setUint32(data + 4, b.length, true);
    out.set(b, offsets[i]!);
  });
  return out;
}

/** `pe` with the images of `ico` as its icon, or `{ refused }` saying why
 *  this PE is left alone. Never throws; `pe` is not modified. Pure.
 *
 *  The result is `pe` byte for byte up to its old end, but for the header
 *  fields a new section moves (the section count, `SizeOfInitializedData`,
 *  `SizeOfImage`, `CheckSum` — zero, as the stub's already is — and the
 *  resource data directory) and the new section header, written into the
 *  unused header space after the last one. */
export function peWithIcon(
  pe: Uint8Array,
  ico: Uint8Array,
): { pe: Uint8Array } | { refused: string } {
  const refused = (why: string) => ({ refused: why });
  // aio-ok(utf16-bytes): a Uint8Array — this length is bytes
  if (ico.length > MAX_ICO_BYTES) {
    return refused(
      `the icon is ${ico.length} bytes (at most ${MAX_ICO_BYTES} fit)`,
    );
  }
  const images = icoImages(ico);
  if (typeof images === "string") return refused(images);

  const v = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
  if (pe.length < 0x40 || v.getUint16(0, true) !== 0x5a4d) {
    return refused("not a PE file");
  }
  const sig = v.getUint32(0x3c, true);
  if (sig + 24 + 240 > pe.length || v.getUint32(sig, true) !== 0x00004550) {
    return refused("not a PE file");
  }
  const opt = sig + 24;
  if (v.getUint16(opt, true) !== 0x20b) return refused("not a PE32+ exe");
  const sectionCount = v.getUint16(sig + 6, true);
  const sections = opt + v.getUint16(sig + 20, true);
  const sectionAlign = v.getUint32(opt + 32, true);
  const fileAlign = v.getUint32(opt + 36, true);
  const dirs = opt + 112;
  const RESOURCE = 2, SECURITY = 4;
  if (
    sectionCount < 1 || fileAlign < 1 || sectionAlign < fileAlign ||
    v.getUint32(opt + 108, true) <= SECURITY ||
    sections + sectionCount * SECTION_HEADER > pe.length
  ) {
    return refused("a PE header this build does not know");
  }
  if (v.getUint32(dirs + RESOURCE * 8, true) !== 0) {
    return refused("the exe already has resources");
  }
  if (
    v.getUint32(dirs + SECURITY * 8, true) !== 0 ||
    v.getUint32(dirs + SECURITY * 8 + 4, true) !== 0
  ) {
    return refused("the exe is signed");
  }
  let firstRaw = Infinity, rawEnd = 0, virtualEnd = 0;
  for (let i = 0; i < sectionCount; i++) {
    const s = sections + i * SECTION_HEADER;
    const virtualSize = v.getUint32(s + 8, true);
    const rva = v.getUint32(s + 12, true);
    const rawSize = v.getUint32(s + 16, true);
    const raw = v.getUint32(s + 20, true);
    if (rawSize > 0) {
      firstRaw = Math.min(firstRaw, raw);
      rawEnd = Math.max(rawEnd, raw + rawSize);
    }
    virtualEnd = Math.max(virtualEnd, rva + Math.max(virtualSize, rawSize));
  }
  if (rawEnd !== pe.length || rawEnd % fileAlign !== 0) {
    return refused("the exe has data after its last section");
  }
  const header = sections + sectionCount * SECTION_HEADER;
  const headerRoom = Math.min(firstRaw, v.getUint32(opt + 60, true));
  if (
    header + SECTION_HEADER > headerRoom ||
    pe.subarray(header, header + SECTION_HEADER).some((b) => b !== 0)
  ) {
    return refused("no room for one more section header");
  }

  const rva = align(virtualEnd, sectionAlign);
  const body = rsrcSection(images, rva);
  const rawSize = align(body.length, fileAlign);
  const out = new Uint8Array(pe.length + rawSize);
  out.set(pe, 0);
  out.set(body, pe.length);
  const o = new DataView(out.buffer);
  out.set(new TextEncoder().encode(".rsrc"), header);
  o.setUint32(header + 8, body.length, true); // VirtualSize
  o.setUint32(header + 12, rva, true); // VirtualAddress
  o.setUint32(header + 16, rawSize, true); // SizeOfRawData
  o.setUint32(header + 20, pe.length, true); // PointerToRawData
  o.setUint32(header + 36, RSRC_CHARACTERISTICS, true);
  o.setUint16(sig + 6, sectionCount + 1, true);
  o.setUint32(opt + 8, v.getUint32(opt + 8, true) + rawSize, true);
  o.setUint32(opt + 56, align(rva + body.length, sectionAlign), true);
  o.setUint32(opt + 64, 0, true); // CheckSum: not checked for an exe
  o.setUint32(dirs + RESOURCE * 8, rva, true);
  o.setUint32(dirs + RESOURCE * 8 + 4, body.length, true);
  return { pe: out };
}

/** The `.ico` a PE carries as its icon — its first `RT_GROUP_ICON` put back
 *  together with the `RT_ICON` images it names — and how many icon groups the
 *  PE has. `groups: 0` (and no `ico`) for a PE with no icon; null for bytes
 *  that are not a PE this reads. Pure.
 *
 *  `head` may be a file's first bytes only, as long as it holds the headers
 *  and the resource section. */
export function peIcon(
  head: Uint8Array,
): { groups: number; ico: Uint8Array | null } | null {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const u16 = (at: number) =>
    at + 2 <= head.length ? v.getUint16(at, true) : -1;
  const u32 = (at: number) =>
    at + 4 <= head.length ? v.getUint32(at, true) : -1;
  const sig = u32(0x3c);
  if (u16(0) !== 0x5a4d || sig < 0 || u32(sig) !== 0x00004550) return null;
  const opt = sig + 24;
  const magic = u16(opt);
  const dirs = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
  if (dirs < 0) return null;
  const rsrcRva = u32(dirs + 16);
  if (rsrcRva <= 0) return { groups: 0, ico: null };
  const sections = opt + u16(sig + 20);
  /** RVA → file offset, or -1. */
  const fileOf = (rva: number) => {
    for (let i = 0; i < u16(sig + 6); i++) {
      const s = sections + i * SECTION_HEADER;
      const at = u32(s + 12), size = u32(s + 16);
      if (at >= 0 && rva >= at && rva < at + size) {
        return u32(s + 20) + rva - at;
      }
    }
    return -1;
  };
  const base = fileOf(rsrcRva);
  if (base < 0) return null;
  /** The `[id, offset]` entries of the table at `off` — named ones too (their
   *  "id" is the name's offset, high bit set: `deno compile` names its group). */
  const entries = (off: number): [number, number][] => {
    const named = u16(base + off + 12), ids = u16(base + off + 14);
    if (named < 0 || ids < 0) return [];
    return Array.from({ length: named + ids }, (_, i) => {
      const e = base + off + 16 + i * 8;
      return [u32(e), u32(e + 4)] as [number, number];
    });
  };
  /** The bytes of every resource of `type`, by id (first language). */
  const resources = (type: number): Map<number, Uint8Array> => {
    const found = new Map<number, Uint8Array>();
    const dir = entries(0).find(([id]) => id === type);
    if (!dir) return found;
    for (const [id, sub] of entries(dir[1] & 0x7fffffff)) {
      const lang = entries(sub & 0x7fffffff)[0];
      if (!lang) continue;
      const at = fileOf(u32(base + lang[1]));
      const size = u32(base + lang[1] + 4);
      if (at >= 0 && size >= 0 && at + size <= head.length) {
        found.set(id, head.subarray(at, at + size));
      }
    }
    return found;
  };
  const groups = resources(RT_GROUP_ICON);
  const group = [...groups.values()][0];
  if (!group || group.length < 6) return { groups: groups.size, ico: null };
  const icons = resources(RT_ICON);
  const gv = new DataView(group.buffer, group.byteOffset, group.byteLength);
  const count = gv.getUint16(4, true);
  if (group.length < 6 + 14 * count) return { groups: groups.size, ico: null };
  const images: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const img = icons.get(gv.getUint16(6 + 14 * i + 12, true));
    if (!img) return { groups: groups.size, ico: null };
    images.push(img);
  }
  const ico = new Uint8Array(
    6 + 16 * count + images.reduce((n, b) => n + b.length, 0),
  );
  const iv = new DataView(ico.buffer);
  iv.setUint16(2, 1, true);
  iv.setUint16(4, count, true);
  let at = 6 + 16 * count;
  images.forEach((img, i) => {
    ico.set(group.subarray(6 + 14 * i, 6 + 14 * i + 12), 6 + 16 * i);
    iv.setUint32(6 + 16 * i + 12, at, true);
    ico.set(img, at);
    at += img.length;
  });
  return { groups: groups.size, ico };
}

/** What is wrong with the icon of the exe `pe` when it should carry `ico`, or
 *  null: exactly one icon group, holding the images of `ico` byte for byte, in
 *  its order — so the 256 px image Explorer shows is the staged one. Pure. */
export function peIconMismatch(pe: Uint8Array, ico: Uint8Array): string | null {
  const want = icoImages(ico);
  if (typeof want === "string") return want;
  const found = peIcon(pe);
  if (!found) return "the exe is not a readable PE";
  if (found.groups !== 1 || !found.ico) {
    return `the exe has ${found.groups} icon groups, not 1`;
  }
  const got = icoImages(found.ico);
  if (typeof got === "string") return got;
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  const at = want.length !== got.length
    ? -1
    : want.findIndex((w, i) =>
      !same(w.entry, got[i]!.entry) || !same(w.data, got[i]!.data)
    );
  if (want.length !== got.length) {
    return `the exe has ${got.length} icon images, the icon ${want.length}`;
  }
  return at < 0 ? null : `icon image ${at} of the exe is not the icon's`;
}
