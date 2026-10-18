// Checks the OpenPGP signature yt-dlp publishes for its checksum file. The updater
// downloads `SHA2-256SUMS` and `SHA2-256SUMS.sig` from a release, and a checksum is only trusted
// if the signature on that file is valid and made by yt-dlp's release signing key, which is
// embedded here. Without it, whoever could publish a release asset (a stolen token, a hijacked
// account, a hostile mirror) could publish a binary and the checksum to match.
//
// This is not a general OpenPGP implementation. It accepts exactly what yt-dlp publishes: a
// binary version 4 detached signature (type 0x00) with an RSA key, made with SHA-256, SHA-384 or
// SHA-512, by the one key below, named in the signed part of the signature. Everything else is
// refused. The arithmetic is `ring`'s (already in the build through rustls); this file only
// reads the packet and builds what was signed (RFC 4880, sections 5.2 and 5.2.4).
use ring::{digest, signature};

/// yt-dlp's release signing key: "Simon Sawicki (yt-dlp signing key)", RSA 4096, created
/// 2023-02-26, no expiry. Published in the repository (public.key), in its README, on the
/// OpenPGP keyservers (keys.openpgp.org and keyserver.ubuntu.com) with this same fingerprint, and
/// it is the key behind `GPG_SIGNING_KEY` in the release workflow. Taken on 2026-10-16 and
/// checked against the signature of release 2026.08.19 (`gpg --verify`: good signature).
/// If yt-dlp ever changes it, updates fail closed (the bundled yt-dlp stays) until the app
/// gets the new one.
pub const KEY_FINGERPRINT: &str = "AC0CBBE6848D6A873464AF4E57CF65933B5A7581";
/// Seconds since 1970, as stored in the key: part of what its fingerprint covers.
#[cfg(test)]
const KEY_CREATED: u32 = 1_677_455_406;
const KEY_E: [u8; 3] = [0x01, 0x00, 0x01];
/// The 4096-bit modulus, big endian.
const KEY_N_HEX: &str = "f4ac5f738c63c0b74b6196de42d5e6f371c0155fb35bd6ff9ea908e4f961197531135428375803399e002b947766fdf66acd480efa9018ac1eb418a7a0edf7d40dff92d1714a11975e44b61e01aaaa2a14a26d56a50e3bce04ecedbb75bad3b1cb113400a80ef04cfb88b765aa9a92fad0d21ccabdbb2f1aa681d37798dbd9da22cef9b3f49ca47f0be3e013d1f8cadcb00dad76cccc7a3e66429d538e3aee97644166754c71750f5f143a9df4b701298d8b0ce712628d6c698d185a26561edcd5a19bb590ece39d2e458eaff204724b2260c7ee93711e6eecfcf9dababa66405b4316bba4b7eda58439e9294986aff23fdc81ea1ff5fef673e84b8ba2a90e47a5b941f012bee167e96a2120ef92e7bee38f7d920f298c976bfd00ed0a2333080eac3f3ca334fe54290a92427e8a35d9ee01cd8e670169474a2bb7c320439823adcbc9ce905a41904e28057df4945d61c308ef5a5cd84fdde8ea15680632d094b2b6e4709916b9663bab9011cbfd391db48cdcae0353d7aab67c66895d5643c9d7b88f49809411be1e4f4e49f2e4bb71ab3726aaf58ef538c705baecd7804f10ef5f717c4a2ff08505bcd70d2bef02002b76aaa53289dc43fca271395f2faab327c10a162a96d7840c4dd027e92bae653a1d5c24e2227c284fb5a38ee14f28a76f7c7d463f86e7a9dcd39f32f10920c812d7f27cfb085fef4623b26493fcd98d";

fn hex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap_or("0"), 16).unwrap_or(0))
        .collect()
}

/// Whether `signature` is a valid signature of `document` by yt-dlp's release key.
pub fn verify(document: &[u8], signature: &[u8]) -> Result<(), String> {
    verify_with(
        &hex(KEY_N_HEX),
        &KEY_E,
        KEY_FINGERPRINT,
        document,
        signature,
    )
}

fn verify_with(
    n: &[u8],
    e: &[u8],
    fingerprint: &str,
    document: &[u8],
    sig: &[u8],
) -> Result<(), String> {
    let packet = signature_packet(sig)?;
    let mut r = Reader(packet);
    if r.u8()? != 4 {
        return Err("only version 4 signatures are accepted".into());
    }
    let sig_type = r.u8()?;
    if sig_type != 0x00 {
        return Err(format!(
            "not a signature of a binary document (type {sig_type})"
        ));
    }
    let public_key_algorithm = r.u8()?;
    if public_key_algorithm != 1 {
        return Err(format!(
            "not an RSA signature (algorithm {public_key_algorithm})"
        ));
    }
    let hash_algorithm = r.u8()?;
    let (params, hasher): (
        &'static signature::RsaParameters,
        &'static digest::Algorithm,
    ) = match hash_algorithm {
        8 => (&signature::RSA_PKCS1_2048_8192_SHA256, &digest::SHA256),
        9 => (&signature::RSA_PKCS1_2048_8192_SHA384, &digest::SHA384),
        10 => (&signature::RSA_PKCS1_2048_8192_SHA512, &digest::SHA512),
        other => return Err(format!("unsupported hash algorithm {other}")),
    };
    let hashed_len = usize::from(r.u16()?);
    let hashed = r.take(hashed_len)?;
    // Not signed, so not trusted: skipped.
    let unhashed_len = usize::from(r.u16()?);
    r.take(unhashed_len)?;
    // The first 16 bits of the hash, a shortcut for a reader that has no key. Checked too, below:
    // a signature with any byte out of place is refused, not just one that fails the RSA check.
    let left_16 = r.take(2)?;
    let value = r.mpi()?;
    if !r.0.is_empty() {
        return Err("unexpected data after the signature".into());
    }

    // The key must be named in the signed part: the issuer fingerprint (subpacket 33, version 4).
    let named = issuer_fingerprint(hashed)?;
    if !named.eq_ignore_ascii_case(fingerprint) {
        return Err(format!("signed by {named}, not by {fingerprint}"));
    }

    // What was signed: the document, the signature's own header and a trailer saying how long
    // that header was (RFC 4880, 5.2.4).
    let mut message = Vec::with_capacity(document.len() + hashed.len() + 16);
    message.extend_from_slice(document);
    message.extend_from_slice(&[4, sig_type, public_key_algorithm, hash_algorithm]);
    message.extend_from_slice(&(hashed_len as u16).to_be_bytes());
    message.extend_from_slice(hashed);
    message.extend_from_slice(&[4, 0xFF]);
    message.extend_from_slice(&((6 + hashed_len) as u32).to_be_bytes());

    if digest::digest(hasher, &message).as_ref()[..2] != *left_16 {
        return Err("the signature does not match its own hash prefix".into());
    }

    // The signature is a number: its leading zeros were dropped. `ring` wants the key's length.
    if value.len() > n.len() {
        return Err("the signature is longer than the key".into());
    }
    let mut padded = vec![0u8; n.len() - value.len()];
    padded.extend_from_slice(value);
    signature::RsaPublicKeyComponents { n, e }
        .verify(params, &message, &padded)
        .map_err(|_| "the signature does not match".to_string())
}

/// The body of the one signature packet in `data` (a detached signature file is just that).
fn signature_packet(data: &[u8]) -> Result<&[u8], String> {
    let mut r = Reader(data);
    let ctb = r.u8()?;
    if ctb & 0x80 == 0 {
        return Err("not an OpenPGP packet".into());
    }
    let (tag, len) = if ctb & 0x40 != 0 {
        // The new format: a one, two or five byte length (partial lengths are not signatures).
        let first = r.u8()?;
        let len = match first {
            0..=191 => usize::from(first),
            192..=223 => ((usize::from(first) - 192) << 8) + usize::from(r.u8()?) + 192,
            255 => r.u32()? as usize,
            _ => return Err("a packet of partial length".into()),
        };
        (ctb & 0x3F, len)
    } else {
        let len = match ctb & 3 {
            0 => usize::from(r.u8()?),
            1 => usize::from(r.u16()?),
            2 => r.u32()? as usize,
            _ => return Err("a packet of indeterminate length".into()),
        };
        ((ctb >> 2) & 0x0F, len)
    };
    if tag != 2 {
        return Err(format!("not a signature packet (tag {tag})"));
    }
    let body = r.take(len)?;
    if !r.0.is_empty() {
        return Err("unexpected data after the signature packet".into());
    }
    Ok(body)
}

/// The fingerprint in the issuer fingerprint subpacket (type 33) of the hashed subpackets, as
/// upper case hex.
fn issuer_fingerprint(mut subpackets: &[u8]) -> Result<String, String> {
    while !subpackets.is_empty() {
        let mut r = Reader(subpackets);
        let first = r.u8()?;
        let len = match first {
            0..=191 => usize::from(first),
            192..=254 => ((usize::from(first) - 192) << 8) + usize::from(r.u8()?) + 192,
            255 => r.u32()? as usize,
        };
        let body = r.take(len)?;
        subpackets = r.0;
        let Some((&kind, data)) = body.split_first() else {
            return Err("an empty subpacket".into());
        };
        // Bit 7 marks a subpacket as critical; the type is the rest.
        if kind & 0x7F == 33 {
            return match data.split_first() {
                Some((4, fingerprint)) if fingerprint.len() == 20 => {
                    Ok(fingerprint.iter().map(|b| format!("{b:02X}")).collect())
                }
                _ => Err("an issuer fingerprint that is not version 4".into()),
            };
        }
    }
    Err("the signature does not say which key made it".into())
}

/// Bytes read from the front of a slice, never past its end.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if n > self.0.len() {
            return Err("the signature is cut short".into());
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, String> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    /// A multi-precision integer: its length in bits, then the bytes.
    fn mpi(&mut self) -> Result<&'a [u8], String> {
        let bits = usize::from(self.u16()?);
        let bytes = self.take(bits.div_ceil(8))?;
        // Leading zero bytes carry no value.
        let first = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len());
        Ok(&bytes[first..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The real files of yt-dlp release 2026.08.19, as downloaded.
    const SUMS: &[u8] = include_bytes!("../../../tests/fixtures/yt-dlp-2026.08.19-SHA2-256SUMS");
    const SIG: &[u8] = include_bytes!("../../../tests/fixtures/yt-dlp-2026.08.19-SHA2-256SUMS.sig");

    #[test]
    fn the_real_release_signature_is_valid() {
        verify(SUMS, SIG).unwrap();
    }

    /// The embedded key is the key named by the fingerprint that every public source gives: the
    /// fingerprint of a version 4 key is the SHA-1 of its public part, so it is recomputed here
    /// from the bytes in this file and compared with the text.
    #[test]
    fn the_embedded_key_has_the_published_fingerprint() {
        let n = hex(KEY_N_HEX);
        assert_eq!(n.len(), 512);
        let mpi = |bytes: &[u8]| {
            let first = bytes.iter().position(|&b| b != 0).unwrap();
            let bits = (bytes.len() - first) * 8 - bytes[first].leading_zeros() as usize;
            let mut out = (bits as u16).to_be_bytes().to_vec();
            out.extend_from_slice(&bytes[first..]);
            out
        };
        let mut body = vec![4];
        body.extend_from_slice(&KEY_CREATED.to_be_bytes());
        body.push(1);
        body.extend(mpi(&n));
        body.extend(mpi(&KEY_E));
        let mut hashed = vec![0x99];
        hashed.extend_from_slice(&(body.len() as u16).to_be_bytes());
        hashed.extend(body);
        let sha1 = digest::digest(&digest::SHA1_FOR_LEGACY_USE_ONLY, &hashed);
        let got: String = sha1.as_ref().iter().map(|b| format!("{b:02X}")).collect();
        assert_eq!(got, KEY_FINGERPRINT);
        assert_eq!(KEY_FINGERPRINT, "AC0CBBE6848D6A873464AF4E57CF65933B5A7581");
    }

    #[test]
    fn a_changed_document_is_refused() {
        for at in [0, 1, 63, 64, 100, SUMS.len() - 1] {
            let mut bad = SUMS.to_vec();
            bad[at] ^= 1;
            assert!(verify(&bad, SIG).is_err(), "byte {at}");
        }
        // Appended, cut short and empty.
        let mut longer = SUMS.to_vec();
        longer.push(b'\n');
        assert!(verify(&longer, SIG).is_err());
        assert!(verify(&SUMS[..SUMS.len() - 1], SIG).is_err());
        assert!(verify(b"", SIG).is_err());
    }

    #[test]
    fn a_checksum_swapped_for_another_is_refused() {
        // The attack this exists for: the binary is replaced and its line in the list with it.
        let text = String::from_utf8(SUMS.to_vec()).unwrap();
        let line = text.lines().find(|l| l.ends_with("  yt-dlp.exe")).unwrap();
        let forged = text.replace(line, &format!("{}  yt-dlp.exe", "0".repeat(64)));
        assert!(verify(forged.as_bytes(), SIG).is_err());
    }

    /// Where the pieces of the real signature are, to tell what a changed byte must break.
    fn layout() -> (usize, usize) {
        // 3 bytes of packet header, then version, type, algorithms, the hashed subpackets, and
        // then the unhashed ones, which are not covered by the signature.
        let hashed_len = usize::from(u16::from_be_bytes([SIG[7], SIG[8]]));
        let unhashed_at = 3 + 6 + hashed_len;
        let unhashed_len =
            usize::from(u16::from_be_bytes([SIG[unhashed_at], SIG[unhashed_at + 1]]));
        (unhashed_at + 2, unhashed_at + 2 + unhashed_len)
    }

    #[test]
    fn a_changed_signature_is_refused_wherever_the_change_is() {
        let (unhashed_start, unhashed_end) = layout();
        assert!(
            unhashed_end > unhashed_start,
            "the real signature has unhashed data"
        );
        for at in 0..SIG.len() {
            let mut bad = SIG.to_vec();
            bad[at] ^= 0x01;
            let result = verify(SUMS, &bad);
            if (unhashed_start..unhashed_end).contains(&at) {
                // Not signed data: it may change (it is where the key id hint sits) without harm.
                continue;
            }
            assert!(result.is_err(), "a change at byte {at} was accepted");
        }
    }

    #[test]
    fn a_cut_or_padded_signature_never_panics_and_is_refused() {
        for len in 0..SIG.len() {
            assert!(verify(SUMS, &SIG[..len]).is_err(), "cut at {len}");
        }
        let mut padded = SIG.to_vec();
        padded.push(0);
        assert!(verify(SUMS, &padded).is_err());
        assert!(verify(SUMS, b"").is_err());
        assert!(verify(SUMS, SUMS).is_err());
    }

    #[test]
    fn random_junk_never_panics() {
        let mut seed = 0x9E37_79B9_7F4A_7C15_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..20_000 {
            let len = (next() % 700) as usize;
            let mut junk: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            // Often start like a real signature, so the parser gets further in.
            if next() % 2 == 0 && len > 12 {
                junk[..12].copy_from_slice(&SIG[..12]);
            }
            assert!(verify(SUMS, &junk).is_err());
        }
    }

    #[test]
    fn another_key_is_refused() {
        // The same valid signature, checked against a key that differs by one bit, or named by
        // another fingerprint.
        let mut n = hex(KEY_N_HEX);
        n[100] ^= 1;
        assert!(verify_with(&n, &KEY_E, KEY_FINGERPRINT, SUMS, SIG).is_err());
        let other = "0000000000000000000000000000000000000000";
        let err = verify_with(&hex(KEY_N_HEX), &KEY_E, other, SUMS, SIG).unwrap_err();
        assert!(err.contains("not by"), "{err}");
    }

    #[test]
    fn only_what_yt_dlp_publishes_is_accepted() {
        // The header of the real signature: new format is not used, so build variants by hand.
        // Version 3, a text signature, a DSA key and SHA-1 are all refused before any arithmetic.
        let mut v3 = SIG.to_vec();
        v3[3] = 3;
        assert!(verify(SUMS, &v3).unwrap_err().contains("version 4"));
        let mut text = SIG.to_vec();
        text[4] = 0x01;
        assert!(verify(SUMS, &text).unwrap_err().contains("binary"));
        let mut dsa = SIG.to_vec();
        dsa[5] = 17;
        assert!(verify(SUMS, &dsa).unwrap_err().contains("RSA"));
        let mut sha1 = SIG.to_vec();
        sha1[6] = 2;
        assert!(verify(SUMS, &sha1).unwrap_err().contains("hash"));
    }
}
