// Cleaning of text that a site chose: titles, channel names, thumbnail addresses. It
// goes to the interface, the database, file names and the system notification, and a site (or a
// playlist someone made) can put anything in it: megabytes, line breaks, control characters and
// the Unicode controls that reorder text, which would make a title scramble the words around it.
// Cleaning happens once, where the text enters (the metadata and playlist readers, and what the
// frontend sends back when queueing), so nothing after that has to think about it.

/// Longest title (or playlist name), in characters.
pub const TITLE_MAX: usize = 1000;
/// Longest channel or uploader name.
pub const NAME_MAX: usize = 300;
/// Longest short label: a site's name, a format's note, a language's name.
pub const LABEL_MAX: usize = 100;
/// Longest thumbnail address. Matches the limit of the queue (`db::DownloadInfo`).
pub const THUMBNAIL_MAX: usize = 2048;

/// The embedding, override and isolate controls (U+202A to U+202E and U+2066 to U+2069). They have
/// no use in a title and are how a text is made to read backwards. Numbers, not characters: the
/// compiler refuses them written in a literal. The marks used inside right-to-left text
/// (U+200E, U+200F) and the joiners of emoji and Indic scripts stay.
pub fn is_direction_control(c: char) -> bool {
    matches!(c as u32, 0x202A..=0x202E | 0x2066..=0x2069)
}

/// `text` as one line of at most `max` characters: line and paragraph breaks and tabs become
/// spaces, other control characters and direction controls go, the ends are trimmed, and what is
/// too long is cut with an ellipsis. It reads at most `max` characters of the clean text, so a
/// huge input costs no more memory than the result.
pub fn clean(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut count = 0;
    let mut cut = false;
    for c in text.chars() {
        let c = match c {
            '\n' | '\r' | '\t' => ' ',
            c if matches!(c as u32, 0x2028 | 0x2029) => ' ',
            c if c.is_control() || is_direction_control(c) => continue,
            c => c,
        };
        if count == max {
            cut = true;
            break;
        }
        out.push(c);
        count += 1;
    }
    let mut out = out.trim().to_string();
    if cut {
        out.push('\u{2026}');
    }
    out
}

/// `clean`, and `None` for what is left empty.
pub fn clean_opt(text: Option<String>, max: usize) -> Option<String> {
    text.map(|t| clean(&t, max)).filter(|t| !t.is_empty())
}

/// A thumbnail address the interface may use: http(s), short, and without spaces or control
/// characters. The CSP lets only `https:` load anyway; this keeps a hostile value from travelling.
pub fn thumbnail(url: Option<String>) -> Option<String> {
    url.filter(|u| {
        u.len() <= THUMBNAIL_MAX
            && (u.starts_with("https://") || u.starts_with("http://"))
            && !u
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || is_direction_control(c))
    })
}

/// A line of yt-dlp's stderr with the cookie values taken out. When yt-dlp skips a
/// bad entry of a cookies file it quotes the WHOLE line, value included (checked with
/// 2026.08.19: `skipping cookie file entry due to invalid expires at x: '.site\tTRUE\t/\t...\tvalue'`),
/// and a load error of the file does the same. That line would go to the database (the failure's
/// detail), to the "copy detail" button and to the log. Whatever sits between the first and the
/// last quote of a line that talks about a cookies file is removed.
pub fn scrub_secrets(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let about_cookies = ["cookie file", "cookies file", "cookie jar", "cookiejar"]
        .iter()
        .any(|phrase| lower.contains(phrase));
    if !about_cookies {
        return line.to_string();
    }
    let Some(open) = line.find(['\'', '"']) else {
        return line.to_string();
    };
    // Up to the opening quote, a marker, and the last quote (or the end) as it was.
    let kept_end = line
        .rfind(['\'', '"'])
        .filter(|&close| close > open)
        .map_or("", |close| &line[close..]);
    format!("{}<removed>{kept_end}", &line[..=open])
}

/// A title for the system notification: short, and on Linux and macOS without the characters a
/// notification server may read as markup (some render `<b>` and links in the body).
pub fn for_notification(text: &str) -> String {
    let short = clean(text, 120);
    if cfg!(windows) {
        short
    } else {
        short
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rtl() -> String {
        char::from_u32(0x202E).unwrap().to_string()
    }

    #[test]
    fn breaks_become_spaces_and_controls_and_overrides_go() {
        let hostile = format!("a\nb\r\nc\td\0e\u{7f}f{}g", rtl());
        assert_eq!(clean(&hostile, 100), "a b  c defg");
        assert_eq!(clean("  padded  ", 100), "padded");
        assert_eq!(clean("\0\u{202e}", 100), "");
        // Ordinary text is untouched: accents, CJK, emoji with a joiner, right-to-left marks.
        for ok in [
            "Ñandú café",
            "日本語 😀",
            "👨\u{200d}👩\u{200d}👧",
            "a\u{200f}b",
        ] {
            assert_eq!(clean(ok, 100), ok);
        }
    }

    #[test]
    fn the_length_is_bounded_and_marked_and_costs_no_more_than_the_result() {
        assert_eq!(clean("abcdef", 3), "abc\u{2026}");
        assert_eq!(clean("abc", 3), "abc");
        // Characters, not bytes: nothing is split.
        assert_eq!(clean("日本語日本語", 3), "日本語\u{2026}");
        let huge = "x".repeat(50_000_000);
        assert_eq!(clean(&huge, TITLE_MAX).chars().count(), TITLE_MAX + 1);
    }

    #[test]
    fn no_input_comes_out_with_a_control_a_break_or_too_much() {
        // Generated: every property, whatever the pieces.
        let mut seed = 0x1234_5678_9ABC_DEF1_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let pieces = [
            "a", " ", "\n", "\r\n", "\t", "\0", "\u{7f}", "\u{85}", "\u{2028}", "\u{2029}", "é",
            "日", "😀", "\u{200d}", "%(id)s", "<b>", "..", "\u{feff}",
        ];
        let bidi = [0x202A, 0x202D, 0x202E, 0x2066, 0x2069];
        for _ in 0..20_000 {
            let mut text = String::new();
            for _ in 0..(next() % 40) {
                if next() % 8 == 0 {
                    text.push(char::from_u32(bidi[(next() % 5) as usize]).unwrap());
                } else {
                    text.push_str(pieces[(next() % pieces.len() as u64) as usize]);
                }
            }
            let max = 1 + (next() % 20) as usize;
            let out = clean(&text, max);
            assert!(out.chars().count() <= max + 1, "{text:?} -> {out:?}");
            assert!(
                !out.chars()
                    .any(|c| c.is_control() || is_direction_control(c)),
                "{text:?} -> {out:?}"
            );
            assert_eq!(out, out.trim(), "{text:?} -> {out:?}");
            // Cleaning twice changes nothing.
            if !out.ends_with('\u{2026}') {
                assert_eq!(clean(&out, max), out);
            }
        }
    }

    #[test]
    fn a_cookie_value_quoted_by_yt_dlp_never_survives() {
        // The real lines of yt-dlp 2026.08.19 for a bad cookies file (the values are made up).
        for line in [
            "WARNING: skipping cookie file entry due to invalid expires at notanumber: '.example.test\tTRUE\t/\tFALSE\tnotanumber\tsession\tTOPSECRETVALUE456\n'",
            "WARNING: skipping cookie file entry due to invalid length 1: 'this line is broken TOPSECRETINBROKENLINE\n'",
            "ERROR: invalid Netscape format cookies file 'C:\\Users\\Ana\\AppData\\run-1.txt': '.site\tTRUE\t/\tFALSE\t1\tsid\tSECRETSESSION'",
            "http.cookiejar.LoadError: bad cookie jar entry \"sid=SECRETSESSION; path=/\"",
        ] {
            let clean = scrub_secrets(line);
            assert!(!clean.contains("SECRET"), "{line} -> {clean}");
            assert!(clean.contains("<removed>"), "{clean}");
            // It still says what happened.
            assert!(clean.to_ascii_lowercase().contains("cookie"), "{clean}");
            // Cleaning twice changes nothing.
            assert_eq!(scrub_secrets(&clean), clean);
        }
        assert_eq!(
            scrub_secrets("WARNING: skipping cookie file entry due to invalid length 1: 'a b'"),
            "WARNING: skipping cookie file entry due to invalid length 1: '<removed>'"
        );
    }

    #[test]
    fn other_lines_are_left_alone() {
        for line in [
            "ERROR: [youtube] abc: Video unavailable",
            "WARNING: 'cookies' are not used here",
            "ERROR: Unable to download webpage: HTTP Error 403: Forbidden",
            "cookie file is missing",
            "",
        ] {
            assert_eq!(scrub_secrets(line), line);
        }
    }

    #[test]
    fn only_http_thumbnails_without_junk_travel() {
        let ok = Some("https://i.ytimg.com/vi/x/hq.jpg".to_string());
        assert_eq!(thumbnail(ok.clone()), ok);
        for bad in [
            "javascript:alert(1)",
            "file:///C:/Windows/win.ini",
            "data:image/svg+xml,<svg/>",
            "https://e.com/a b",
            "https://e.com/a\nb",
            "//e.com/x",
        ] {
            assert_eq!(thumbnail(Some(bad.into())), None, "{bad}");
        }
        assert_eq!(
            thumbnail(Some(format!("https://e.com/{}", "a".repeat(THUMBNAIL_MAX)))),
            None
        );
        assert_eq!(thumbnail(None), None);
    }

    #[test]
    fn a_notification_title_is_short_and_not_markup_off_windows() {
        let long = for_notification(&"x".repeat(5000));
        assert!(long.chars().count() <= 121);
        let markup = for_notification("<a href=\"http://evil\">click</a> & more\nline");
        if cfg!(windows) {
            assert_eq!(markup, "<a href=\"http://evil\">click</a> & more line");
        } else {
            assert!(!markup.contains('<') && !markup.contains('>'), "{markup}");
        }
    }
}
