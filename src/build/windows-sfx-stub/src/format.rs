//! The SFX trailer, shared with the Deno packer (`appendSfxPayload` in
//! ../../build-windows-exe.ts). Built for the host too, so `cargo test` covers
//! the parser on any machine.
use std::io::{Read, Seek, SeekFrom};

/// Magic trailer both ends agree on. `AIOSFX01` was a bare zip payload;
/// `AIOSFX02` is a zstd-compressed tar. Keep in sync with
/// src/build/build-windows-exe.ts — a Deno test compares the two and the
/// committed PE.
pub const MAGIC: &str = "AIOSFX02";

#[derive(Debug)]
pub struct Header {
    pub sha256: String,
    pub binary: String,
    pub arch: String,
    /// "tar.zstd" (the default) or "zip" (the fallback payload).
    pub format: String,
    /// The app version the payload holds, or empty (an exe packed before the
    /// stub knew versions): an install that is NEWER than it is kept.
    pub version: String,
    /// The app's display name — the Start-menu shortcut's — or empty.
    pub title: String,
    /// Add a Start-menu shortcut when the app is installed.
    pub shortcut: bool,
}

// Trailer layout (logical end of file):
//
//   [payload bytes]
//   [JSON header]
//   [u32 LE header length]
//   [u64 LE payload length]
//   [8 magic "AIOSFX02"]
const TRAILER_FIXED: u64 = 4 + 8 + MAGIC.len() as u64;

fn read_at<F: Read + Seek>(f: &mut F, off: u64, buf: &mut [u8]) -> std::io::Result<()> {
    f.seek(SeekFrom::Start(off))?;
    f.read_exact(buf)
}

/// Locates and parses the SFX trailer of an exe of `size` bytes. Returns the
/// header, the payload's offset and its length.
pub fn read_trailer<F: Read + Seek>(f: &mut F, size: u64) -> Result<(Header, u64, u64), String> {
    let end = trailer_end(f, size)?;
    let mut fixed = [0u8; TRAILER_FIXED as usize];
    read_at(f, end - TRAILER_FIXED, &mut fixed).map_err(|e| e.to_string())?;
    let hdr_len = u32::from_le_bytes(fixed[0..4].try_into().unwrap()) as u64;
    let payload_len = u64::from_le_bytes(fixed[4..12].try_into().unwrap());
    let corrupt = || format!("corrupt SFX trailer (payloadLen={payload_len} hdrLen={hdr_len})");
    if payload_len == 0 || hdr_len == 0 || hdr_len > 1 << 20 {
        return Err(corrupt());
    }
    let hdr_off = (end - TRAILER_FIXED)
        .checked_sub(hdr_len)
        .ok_or_else(corrupt)?;
    let payload_off = hdr_off.checked_sub(payload_len).ok_or_else(corrupt)?;
    let mut raw = vec![0u8; hdr_len as usize];
    read_at(f, hdr_off, &mut raw).map_err(|e| e.to_string())?;
    let json: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|e| format!("SFX header: {e}"))?;
    let field = |name: &str| match json.get(name) {
        None | Some(serde_json::Value::Null) => Ok(String::new()),
        Some(serde_json::Value::String(s)) => Ok(s.clone()),
        Some(_) => Err(format!("SFX header: {name} is not a string")),
    };
    let mut hdr = Header {
        sha256: field("sha256")?,
        binary: field("binary")?,
        arch: field("arch")?,
        format: field("format")?,
        version: field("version")?,
        title: field("title")?,
        shortcut: json.get("shortcut") == Some(&serde_json::Value::Bool(true)),
    };
    if hdr.binary.is_empty() || hdr.sha256.is_empty() || hdr.arch.is_empty() {
        return Err("SFX header incomplete".into());
    }
    // Both become one folder name under %LOCALAPPDATA%\aio-sfx: a separator or
    // a drive in one would install somewhere else.
    for name in [&hdr.binary, &hdr.arch] {
        if name == "." || name == ".." || name.contains(['/', '\\', ':']) {
            return Err(format!("SFX header: {name:?} is not a file name"));
        }
    }
    if hdr.format.is_empty() {
        hdr.format = "zip".into(); // pre-AIOSFX02 headers carried a zip
    }
    Ok((hdr, payload_off, payload_len))
}

/// The offset just past the magic: the end of the file, or — for an
/// Authenticode-signed exe — the start of the certificate table that signing
/// appended (after padding the file to 8 bytes).
fn trailer_end<F: Read + Seek>(f: &mut F, size: u64) -> Result<u64, String> {
    if size < TRAILER_FIXED {
        return Err(format!(
            "SFX too small ({size} bytes) — not an aio Windows installer"
        ));
    }
    let magic_len = MAGIC.len() as u64;
    if magic_at(f, size - magic_len) {
        return Ok(size);
    }
    let cert = cert_table_offset(f, size);
    if cert > 0 {
        for pad in 0..8 {
            if let Some(end) = cert.checked_sub(pad) {
                if end >= TRAILER_FIXED && magic_at(f, end - magic_len) {
                    return Ok(end);
                }
            }
        }
    }
    Err(format!("not an aio SFX (missing {MAGIC} trailer)"))
}

fn magic_at<F: Read + Seek>(f: &mut F, off: u64) -> bool {
    let mut b = [0u8; MAGIC.len()];
    read_at(f, off, &mut b).is_ok() && b == MAGIC.as_bytes()
}

/// Reads the PE security directory (IMAGE_DIRECTORY_ENTRY_SECURITY) — the one
/// data directory whose address is a FILE offset. 0 when the file is unsigned
/// or not a PE.
fn cert_table_offset<F: Read + Seek>(f: &mut F, size: u64) -> u64 {
    let mut u32_at = |off: u64| {
        let mut b = [0u8; 4];
        read_at(f, off, &mut b).ok().map(|_| u32::from_le_bytes(b))
    };
    let Some(lfanew) = u32_at(0x3c) else { return 0 };
    let pe = lfanew as u64;
    if u32_at(pe) != Some(0x0000_4550) {
        return 0; // not "PE\0\0"
    }
    let opt = pe + 4 + 20; // past the signature and the COFF file header
    let dirs = match u32_at(opt).map(|m| m & 0xffff) {
        Some(0x20b) => opt + 112, // PE32+
        Some(0x10b) => opt + 96,  // PE32
        _ => return 0,
    };
    const SECURITY: u64 = 4;
    if !matches!(u32_at(dirs - 4), Some(n) if n as u64 > SECURITY) {
        return 0;
    }
    match (u32_at(dirs + SECURITY * 8), u32_at(dirs + SECURITY * 8 + 4)) {
        (Some(off), Some(len)) if off != 0 && len != 0 && off as u64 <= size => off as u64,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A minimal PE32+ header: enough for `cert_table_offset` to find the data
    /// directories. Returns the bytes and the offset of the security entry.
    fn fake_pe() -> (Vec<u8>, usize) {
        const LFANEW: usize = 0x80;
        let mut b = vec![0u8; 0x200];
        b[..2].copy_from_slice(b"MZ");
        b[0x3c..0x40].copy_from_slice(&(LFANEW as u32).to_le_bytes());
        b[LFANEW..LFANEW + 4].copy_from_slice(b"PE\0\0");
        let opt = LFANEW + 4 + 20;
        b[opt..opt + 2].copy_from_slice(&0x20bu16.to_le_bytes());
        b[opt + 108..opt + 112].copy_from_slice(&16u32.to_le_bytes()); // NumberOfRvaAndSizes
        (b, opt + 112 + 4 * 8)
    }

    /// Appends payload + trailer the way `appendSfxPayload` does.
    fn with_trailer(stub: &[u8], payload: &str, hdr: &str) -> Vec<u8> {
        let mut out = stub.to_vec();
        out.extend_from_slice(payload.as_bytes());
        out.extend_from_slice(hdr.as_bytes());
        out.extend_from_slice(&(hdr.len() as u32).to_le_bytes());
        out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        out.extend_from_slice(MAGIC.as_bytes());
        out
    }

    /// Appends an Authenticode-shaped certificate table: the file padded to 8
    /// bytes, the table after it, and the security directory pointing at it.
    fn sign(exe: &[u8], sec_entry: usize) -> Vec<u8> {
        let mut out = exe.to_vec();
        while !out.len().is_multiple_of(8) {
            out.push(0);
        }
        let at = out.len() as u32;
        out[sec_entry..sec_entry + 4].copy_from_slice(&at.to_le_bytes());
        out[sec_entry + 4..sec_entry + 8].copy_from_slice(&4096u32.to_le_bytes());
        out.extend(std::iter::repeat_n(0xC5, 4096));
        out
    }

    const HDR: &str = r#"{"sha256":"ab","binary":"myapp","arch":"x64","format":"tar.zstd"}"#;

    fn parse(exe: &[u8]) -> Result<(Header, u64, u64), String> {
        read_trailer(&mut Cursor::new(exe), exe.len() as u64)
    }

    #[test]
    fn unsigned() {
        let exe = with_trailer(&fake_pe().0, "PAYLOAD", HDR);
        let (hdr, off, n) = parse(&exe).unwrap();
        assert_eq!(
            (hdr.binary.as_str(), hdr.format.as_str()),
            ("myapp", "tar.zstd")
        );
        assert_eq!(&exe[off as usize..(off + n) as usize], b"PAYLOAD");
    }

    /// An Authenticode signature appends the certificate table AFTER the
    /// trailer, so the magic is no longer at EOF. Every padding 0..7 is found.
    #[test]
    fn signed() {
        for pad in 0..8 {
            let (stub, sec) = fake_pe();
            let payload = format!("PAYLOAD{}", "x".repeat(pad));
            let exe = sign(&with_trailer(&stub, &payload, HDR), sec);
            assert!(!exe.ends_with(MAGIC.as_bytes()), "fixture: magic at EOF");
            let (hdr, off, n) = parse(&exe).unwrap_or_else(|e| panic!("pad {pad}: {e}"));
            assert_eq!(hdr.sha256, "ab");
            assert_eq!(&exe[off as usize..(off + n) as usize], payload.as_bytes());
        }
    }

    #[test]
    fn refuses_garbage() {
        let (stub, _) = fake_pe();
        // Bytes appended with no security directory: not a signature, not ours.
        let mut exe = with_trailer(&stub, "PAYLOAD", HDR);
        exe.extend_from_slice(&[0u8; 4096]);
        assert!(
            parse(&exe).is_err(),
            "a trailer that is neither at EOF nor before the cert table"
        );
        // A payload length larger than the file.
        let mut bad = with_trailer(&stub, "P", HDR);
        let at = bad.len() - 16;
        bad[at..at + 8].copy_from_slice(&(1u64 << 40).to_le_bytes());
        assert!(parse(&bad).is_err(), "an oversized payload length");
    }

    #[test]
    fn header_defaults_and_refusals() {
        let stub = fake_pe().0;
        let old = r#"{"sha256":"ab","binary":"myapp","arch":"x64"}"#;
        let hdr = parse(&with_trailer(&stub, "P", old)).unwrap().0;
        assert_eq!(
            (hdr.format.as_str(), hdr.version.as_str(), hdr.shortcut),
            ("zip", "", false)
        );
        let new = r#"{"sha256":"ab","binary":"myapp","arch":"x64","format":"tar.zstd","version":"1.2.3","title":"My App","shortcut":true}"#;
        let hdr = parse(&with_trailer(&stub, "P", new)).unwrap().0;
        assert_eq!(
            (hdr.version.as_str(), hdr.title.as_str(), hdr.shortcut),
            ("1.2.3", "My App", true)
        );
        for bad in [
            r#"{"sha256":"ab","binary":"","arch":"x64"}"#,
            r#"{"sha256":"ab","binary":"..\\..\\evil","arch":"x64"}"#,
            r#"{"sha256":"ab","binary":"C:evil","arch":"x64"}"#,
            r#"{"sha256":"ab","binary":"myapp","arch":"../x"}"#,
            r#"{"sha256":1,"binary":"myapp","arch":"x64"}"#,
            "not json",
        ] {
            assert!(parse(&with_trailer(&stub, "P", bad)).is_err(), "{bad}");
        }
    }
}
