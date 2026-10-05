//! Version order — the same answer as `compareVersions` in
//! src/server/updates-core.ts, for the one question the stub asks: is the
//! install already newer than the payload this exe carries? Both comparators
//! are checked against ../version-order.json (here, and by a Deno test).
use std::cmp::Ordering;

/// `a` against `b`, or `None` when either is not a version this can order: an
/// optional leading `v`, one to three numeric components, an optional
/// `-prerelease`, an optional `+build` (which takes no part in the order).
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let (na, pa) = parse(a)?;
    let (nb, pb) = parse(b)?;
    Some(
        na.cmp(&nb)
            .then_with(|| match (pa.is_empty(), pb.is_empty()) {
                // No prerelease outranks any prerelease: 1.0.0 > 1.0.0-alpha.
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => compare_pieces(&pa, &pb),
            }),
    )
}

fn tag(s: &str) -> bool {
    let first = s.bytes().next();
    first.is_some_and(|c| c.is_ascii_alphanumeric())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
}

/// The numeric components and the prerelease, as the letter runs and digit
/// runs it is made of: `alpha62` and `alpha.62` are both `["alpha", "62"]`.
fn parse(v: &str) -> Option<([u64; 3], Vec<&str>)> {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let (v, build) = match v.split_once('+') {
        Some((v, build)) => (v, Some(build)),
        None => (v, None),
    };
    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    };
    if build.is_some_and(|b| !tag(b)) || pre.is_some_and(|p| !tag(p)) {
        return None;
    }
    let mut nums = [0u64; 3];
    for (i, part) in core.split('.').enumerate() {
        if i == 3 || part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        nums[i] = part.parse().ok()?;
    }
    let mut pieces = Vec::new();
    for id in pre.unwrap_or("").split('.') {
        let mut rest = id;
        while let Some(first) = rest.bytes().next() {
            let digits = first.is_ascii_digit();
            let end = rest
                .bytes()
                .position(|c| c.is_ascii_digit() != digits)
                .unwrap_or(rest.len());
            pieces.push(&rest[..end]);
            rest = &rest[end..];
        }
    }
    Some((nums, pieces))
}

fn compare_pieces(a: &[&str], b: &[&str]) -> Ordering {
    let numeric = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    for (x, y) in a.iter().zip(b) {
        let order = match (numeric(x), numeric(y)) {
            (true, true) => {
                // As numbers of any length: by digit count, then digit by digit.
                let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                x.len().cmp(&y.len()).then_with(|| x.cmp(y))
            }
            (true, false) => Ordering::Less, // numeric pieces rank below alphabetic ones
            (false, true) => Ordering::Greater,
            (false, false) => x.cmp(y),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len()) // the shorter sequence is the earlier one
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(key: &str) -> Vec<serde_json::Value> {
        let all: serde_json::Value =
            serde_json::from_str(include_str!("../version-order.json")).unwrap();
        all[key].as_array().unwrap().clone()
    }

    #[test]
    fn ascending() {
        let list: Vec<String> = table("ascending")
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        assert!(list.len() > 20);
        for (i, a) in list.iter().enumerate() {
            for (j, b) in list.iter().enumerate() {
                assert_eq!(compare_versions(a, b), Some(i.cmp(&j)), "{a} vs {b}");
            }
        }
    }

    #[test]
    fn equal() {
        let pairs = table("equal");
        assert!(pairs.len() > 5);
        for pair in pairs {
            let (a, b) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
            assert_eq!(compare_versions(a, b), Some(Ordering::Equal), "{a} vs {b}");
        }
    }

    #[test]
    fn unorderable() {
        let list = table("unorderable");
        assert!(list.len() > 5);
        for v in list {
            let v = v.as_str().unwrap();
            assert_eq!(compare_versions(v, "1.0.0"), None, "{v:?}");
            assert_eq!(compare_versions("1.0.0", v), None, "{v:?}");
        }
    }
}
