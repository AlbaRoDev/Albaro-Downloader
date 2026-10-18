// Sorts yt-dlp's stderr into an `AppError` category. Only `ERROR:` lines are read, plus the one
// warning that explains an error (no JS runtime), and they are matched, lowercased, against
// short fragments of yt-dlp's English messages: whole sentences change between versions,
// these fragments rarely do. The message keeps yt-dlp's original text for logs and support;
// the frontend shows its own text for each code.
//
// `Network` means transient and is the only category the queue retries; all the
// others are permanent. So HTTP 404/410 are `Unavailable`, while 429 and 5xx are `Network`.
// HTTP 403 stays `Unknown` and is not retried, because it can be geo-blocking or an expired link,
// with one exception: "unable to download video data: HTTP Error 403", which YouTube returns for
// a signed media URL now and then (the same video downloads fine a moment later). A retry asks
// for fresh URLs, so that one is `Network`.
// The exit code is not used: yt-dlp exits with 1 for every one of these errors.
use crate::errors::AppError;

/// The browser's cookies could not be read, with `--cookies-from-browser`. Real
/// messages: "could not find firefox cookies database in ...", "unsupported platform: win32"
/// (Safari off macOS); handwritten: the locked Chrome file and the encrypted one.
const COOKIES: &[&str] = &[
    "cookies database",
    "cookie database",
    "failed to decrypt",
    "unsupported platform",
    // A cookies file that is not Netscape format (real): "'<path>' does not look like a
    // Netscape format cookies file".
    "does not look like a netscape format cookies file",
];

/// A full disk ("[Errno 28]"; Windows' own wording for the same error).
const NO_SPACE: &[&str] = &["no space left on device", "not enough space on the disk"];

/// Gone for good, retrying will not help.
const UNAVAILABLE: &[&str] = &[
    "video unavailable",          // YouTube: removed, or the id never existed
    "is unavailable",             // "This video is unavailable"
    "private video",              // YouTube private video
    "has been removed",           // removed by the uploader or for a policy
    "no longer available",        // account terminated
    "available in your country",  // geo-blocked ("not available in your country")
    "recording is not available", // live stream that was not recorded
    "http error 404",             // the page or file does not exist
    "http error 410",             // gone
];

/// The site wants a signed-in user. Checked after `UNAVAILABLE`: yt-dlp ends a private video's
/// message with the same cookie hint ("Private video. Sign in if you've been granted access
/// to this video. Use --cookies-from-browser..."), and private stays `Unavailable`.
const LOGIN_REQUIRED: &[&str] = &[
    "sign in to confirm",     // "...your age", "...you're not a bot" (YouTube)
    "--cookies-from-browser", // yt-dlp's hint whenever a login would help (Vimeo, members only)
];

/// No extractor for the link ("Unsupported URL: https://example.com/").
const UNSUPPORTED_URL: &[&str] = &["unsupported url"];

/// Transient: the connection or the server failed this time.
const NETWORK: &[&str] = &[
    "timed out",                                     // connect or read timeout
    "connection reset",                              // dropped by the peer
    "connection refused",                            // nothing listening
    "connection aborted",                            // dropped locally
    "remote end closed connection",                  // server hung up mid-response
    "failed to resolve",                             // DNS: offline, or the domain does not exist
    "getaddrinfo failed",                            // DNS, Windows
    "temporary failure in name resolution",          // DNS, Linux
    "network is unreachable",                        // no route, offline
    "http error 429",                                // rate limited
    "http error 5",                                  // 500-599, server errors
    "unable to download video data: http error 403", // YouTube refuses a media URL, intermittently
];

/// Post-processing: merging, remuxing, converting, embedding the cover.
const FFMPEG: &[&str] = &[
    "postprocessing:", // prefix of every post-processing failure ("Conversion failed!")
    "ffmpeg not found", // also "ffprobe and ffmpeg not found"
];

/// Printed as a warning on every YouTube run without a working Deno.
const NO_JS_RUNTIME: &str = "no supported javascript runtime";

/// The site changed and yt-dlp no longer understands it (an update usually fixes it).
const EXTRACTOR_BROKEN: &[&str] = &[
    "please report this issue", // yt-dlp's suffix for unexpected extractor errors
    "unable to extract",        // a pattern no longer matches the page
    "signature extraction failed", // YouTube player changed
    "nsig extraction failed",   // YouTube player changed
];

/// The category of a failed run's stderr. The order of the checks is the priority when lines
/// match more than one category:
/// 0. Cookies first: yt-dlp stops before it tries anything else, so nothing else explains the run.
/// 1. No space: a full disk also surfaces inside post-processing errors.
/// 2. Unavailable before Network: if anything says the video is gone, retrying is pointless.
///    Also before LoginRequired, so a private video (which also suggests cookies) is gone.
/// 3. LoginRequired and UnsupportedUrl: permanent and specific.
/// 4. Network: transient, so the queue may retry it.
/// 5. FFmpeg.
/// 6. JS runtime: its warning shows up on every run without Deno, so it only explains errors
///    that nothing more specific explains (missing formats, a failed extraction).
/// 7. Extractor broken last: "please report this issue" is yt-dlp's catch-all.
pub fn classify(stderr: &str) -> AppError {
    let lower = stderr.to_lowercase();
    let errors: Vec<&str> = lower
        .lines()
        .map(str::trim_start)
        .filter(|line| line.starts_with("error:"))
        .collect();
    let has = |fragments: &[&str]| {
        errors
            .iter()
            .any(|line| fragments.iter().any(|f| line.contains(f)))
    };
    // Tuple variants are functions `fn(String) -> AppError`, so the category can be picked
    // first and given the message once at the end.
    let category: fn(String) -> AppError = if errors.is_empty() {
        AppError::Unknown
    } else if has(COOKIES) {
        AppError::CookiesUnavailable
    } else if has(NO_SPACE) {
        AppError::NoSpace
    } else if has(UNAVAILABLE) {
        AppError::Unavailable
    } else if has(LOGIN_REQUIRED) {
        AppError::LoginRequired
    } else if has(UNSUPPORTED_URL) {
        AppError::UnsupportedUrl
    } else if has(NETWORK) {
        AppError::Network
    } else if has(FFMPEG) {
        AppError::Ffmpeg
    } else if lower.contains(NO_JS_RUNTIME) {
        AppError::JsRuntimeMissing
    } else if has(EXTRACTOR_BROKEN) {
        AppError::ExtractorBroken
    } else {
        AppError::Unknown
    };
    category(stderr.trim().to_string())
}

/// The runner knows nothing about yt-dlp: a failed run is `Unknown` with all of stderr. This
/// sorts that into a category and leaves the rest (`Cancelled`, `InvalidUrl`...) as is.
pub fn refine(error: AppError) -> AppError {
    match error {
        AppError::Unknown(stderr) => classify(&stderr),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads a stderr fixture from tests/fixtures.
    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!("../../../tests/fixtures/", $name))
        };
    }

    /// Classifies and checks the text survives untouched (`Display` is "code: message").
    fn check(stderr: &str) -> AppError {
        let error = classify(stderr);
        assert!(error.to_string().ends_with(stderr.trim()), "{error}");
        error
    }

    // Real stderr, captured with the bundled yt-dlp 2026.08.19.

    #[test]
    fn real_unavailable_and_removed_videos() {
        let unavailable = fixture!("progress-unavailable.stderr.txt");
        assert!(matches!(check(unavailable), AppError::Unavailable(_)));
        let removed = fixture!("classify-removed-video.stderr.txt");
        assert!(matches!(check(removed), AppError::Unavailable(_)));
    }

    #[test]
    fn real_http_404_is_permanent() {
        let not_found = fixture!("classify-http-404.stderr.txt");
        assert!(matches!(check(not_found), AppError::Unavailable(_)));
    }

    #[test]
    fn real_unknown_domain_is_network() {
        let dns = fixture!("classify-invalid-domain.stderr.txt");
        assert!(matches!(check(dns), AppError::Network(_)));
    }

    #[test]
    fn real_ffmpeg_failures() {
        let webm = fixture!("classify-webm-conversion-failed.stderr.txt");
        assert!(matches!(check(webm), AppError::Ffmpeg(_)));
        let missing = fixture!("classify-ffmpeg-not-found.stderr.txt");
        assert!(matches!(check(missing), AppError::Ffmpeg(_)));
    }

    #[test]
    fn real_js_runtime_warning_alone_is_not_an_error() {
        // yt-dlp exits 0 with only this warning; should it reach `classify`, it must not
        // pretend to know the cause.
        let warning = fixture!("classify-js-runtime-warning.stderr.txt");
        assert!(matches!(check(warning), AppError::Unknown(_)));
    }

    #[test]
    fn real_age_restricted_needs_login() {
        let age = fixture!("classify-age-restricted.stderr.txt");
        assert!(matches!(check(age), AppError::LoginRequired(_)));
    }

    #[test]
    fn real_cookie_failures_are_their_own_category() {
        for fixture in [
            fixture!("classify-cookies-firefox-missing.stderr.txt"),
            fixture!("classify-cookies-vivaldi-missing.stderr.txt"),
            fixture!("classify-cookies-safari-windows.stderr.txt"),
        ] {
            assert!(
                matches!(check(fixture), AppError::CookiesUnavailable(_)),
                "{fixture}"
            );
        }
    }

    #[test]
    fn real_cookies_file_that_is_not_netscape_is_a_cookies_error() {
        let junk = fixture!("classify-cookies-file-not-netscape.stderr.txt");
        assert!(matches!(check(junk), AppError::CookiesUnavailable(_)));
    }

    #[test]
    fn handwritten_cookie_failures_are_their_own_category() {
        for fixture in [
            fixture!("classify-cookies-chrome-copy.handwritten.stderr.txt"),
            fixture!("classify-cookies-decrypt.handwritten.stderr.txt"),
        ] {
            assert!(
                matches!(check(fixture), AppError::CookiesUnavailable(_)),
                "{fixture}"
            );
        }
    }

    #[test]
    fn real_unsupported_url() {
        let unsupported = fixture!("classify-unsupported-url.stderr.txt");
        assert!(matches!(check(unsupported), AppError::UnsupportedUrl(_)));
    }

    // Hand-written fixtures (marked as such inside each file): these cases cannot be provoked.

    #[test]
    fn handwritten_no_space() {
        let full = fixture!("classify-no-space.handwritten.stderr.txt");
        assert!(matches!(check(full), AppError::NoSpace(_)));
    }

    #[test]
    fn handwritten_extractor_broken() {
        let broken = fixture!("classify-extractor-broken.handwritten.stderr.txt");
        assert!(matches!(check(broken), AppError::ExtractorBroken(_)));
    }

    #[test]
    fn handwritten_rate_limit_and_timeout_are_network() {
        let limited = fixture!("classify-http-429.handwritten.stderr.txt");
        assert!(matches!(check(limited), AppError::Network(_)));
        let timeout = fixture!("classify-read-timeout.handwritten.stderr.txt");
        assert!(matches!(check(timeout), AppError::Network(_)));
    }

    #[test]
    fn handwritten_js_runtime_explains_a_format_error() {
        let js = fixture!("classify-js-runtime-missing.handwritten.stderr.txt");
        assert!(matches!(check(js), AppError::JsRuntimeMissing(_)));
    }

    #[test]
    fn handwritten_bot_check_needs_login() {
        let bot = fixture!("classify-bot-check.handwritten.stderr.txt");
        assert!(matches!(check(bot), AppError::LoginRequired(_)));
    }

    #[test]
    fn handwritten_private_video_stays_unavailable_despite_the_cookie_hint() {
        let private = fixture!("classify-private-video.handwritten.stderr.txt");
        assert!(private.contains("--cookies-from-browser"));
        assert!(matches!(check(private), AppError::Unavailable(_)));
    }

    // Edges and priorities.

    #[test]
    fn empty_or_warnings_only_is_unknown() {
        assert!(matches!(check(""), AppError::Unknown(m) if m.is_empty()));
        let warnings = "WARNING: [youtube] something odd\nWARNING: connection reset, retrying";
        // Network words in a warning do not count: yt-dlp recovered from it.
        assert!(matches!(check(warnings), AppError::Unknown(_)));
    }

    #[test]
    fn http_status_decides_transient_or_permanent() {
        let e = |code: &str| check(&format!("ERROR: [x] y: HTTP Error {code}: Reason"));
        for transient in ["429", "500", "502", "503", "504"] {
            assert!(matches!(e(transient), AppError::Network(_)), "{transient}");
        }
        for permanent in ["404", "410"] {
            assert!(
                matches!(e(permanent), AppError::Unavailable(_)),
                "{permanent}"
            );
        }
        // 403 can be geo-blocking or an expired link: ambiguous, so not retried...
        assert!(matches!(e("403"), AppError::Unknown(_)));
        // ...except when the media data itself is refused: seen on a normal public video, and the
        // next attempt got through.
        let data = fixture!("classify-http-403-video-data.stderr.txt");
        assert!(matches!(check(data), AppError::Network(_)));
    }

    #[test]
    fn priority_when_several_errors_match() {
        let gone_and_timeout =
            "ERROR: [youtube] x: Video unavailable\nERROR: The read operation timed out";
        assert!(matches!(check(gone_and_timeout), AppError::Unavailable(_)));
        let full_while_merging =
            "ERROR: Postprocessing: Conversion failed!\nERROR: [Errno 28] No space left on device";
        assert!(matches!(check(full_while_merging), AppError::NoSpace(_)));
        let report_and_timeout =
            "ERROR: Unable to extract x; please report this issue\nERROR: timed out";
        assert!(matches!(check(report_and_timeout), AppError::Network(_)));
        // A removed video's page may still suggest cookies: gone wins.
        let removed_with_hint =
            "ERROR: [youtube] x: This video has been removed. Use --cookies-from-browser to sign in";
        assert!(matches!(check(removed_with_hint), AppError::Unavailable(_)));
        // A login wall is permanent: it is not retried even if a timeout also shows up.
        let login_and_timeout = "ERROR: x: Sign in to confirm your age\nERROR: timed out";
        assert!(matches!(
            check(login_and_timeout),
            AppError::LoginRequired(_)
        ));
        // "Sign in" alone is not enough to ask for a login.
        let sign_in_only = "ERROR: [x] y: Sign in to see more videos like this";
        assert!(matches!(check(sign_in_only), AppError::Unknown(_)));
        // The JS warning loses to a real cause.
        let js_and_gone = format!(
            "{}\nERROR: [youtube] x: Video unavailable",
            fixture!("classify-js-runtime-warning.stderr.txt")
        );
        assert!(matches!(check(&js_and_gone), AppError::Unavailable(_)));
    }

    #[test]
    fn case_does_not_matter() {
        assert!(matches!(
            check("error: [YouTube] x: PRIVATE VIDEO"),
            AppError::Unavailable(_)
        ));
        assert!(matches!(
            check("  Error: http ERROR 503"),
            AppError::Network(_)
        ));
    }

    #[test]
    fn unknown_message_keeps_the_text() {
        let odd = "ERROR: [newsite] 42: Something nobody has seen before\n";
        assert!(matches!(check(odd), AppError::Unknown(m) if m == odd.trim()));
    }

    #[test]
    fn refine_only_touches_unknown() {
        let failed = AppError::Unknown("ERROR: [youtube] x: Video unavailable".into());
        assert!(matches!(refine(failed), AppError::Unavailable(_)));
        let cancelled = AppError::Cancelled("ERROR: Video unavailable".into());
        assert!(matches!(refine(cancelled), AppError::Cancelled(_)));
    }
}
