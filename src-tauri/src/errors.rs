// Errors the frontend sees. Each one reaches JS as `{ code, message }`: the code picks the
// translated text and the suggested action in the UI, the message is the raw detail (usually
// yt-dlp's stderr line) for logs and the "details" view. Mirrored by `AppError` in ipc.ts.
use std::fmt;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
// Adjacent tagging turns `Network("timed out")` into `{"code":"network","message":"timed out"}`.
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum AppError {
    /// Transient network failure; the only kind the queue retries.
    Network(String),
    /// The site changed and yt-dlp's extractor no longer works (an update usually fixes it).
    ExtractorBroken(String),
    /// Private, deleted, geo-blocked or otherwise unavailable content.
    Unavailable(String),
    NoSpace(String),
    Ffmpeg(String),
    /// yt-dlp could not run the JS runtime (Deno) it needs for YouTube.
    JsRuntimeMissing(String),
    Cancelled(String),
    /// The input is not an http(s) URL; rejected before running yt-dlp.
    InvalidUrl(String),
    /// The site wants a signed-in user (age check, "not a bot" check, members only). Permanent:
    /// browser cookies are the way out.
    LoginRequired(String),
    /// yt-dlp has no extractor for the link.
    UnsupportedUrl(String),
    /// The same request is already pending, active or paused. Permanent: nothing to retry.
    AlreadyQueued(String),
    /// The output folder cannot be created or written to. Permanent: the user must
    /// pick another one, so retrying would only fail again.
    FolderUnavailable(String),
    /// yt-dlp could not read the cookies of the browser chosen in the settings: it is
    /// not installed, has no profile, keeps its cookie file locked while it is open, or encrypts
    /// it in a way yt-dlp cannot undo. Permanent: the user has to close the browser or choose
    /// another one.
    CookiesUnavailable(String),
    /// The link is a playlist or channel, not one video. Not a failure: the frontend
    /// reacts by listing it with `fetch_playlist`.
    Playlist(String),
    /// Anything that does not fit the categories above.
    Unknown(String),
}

impl AppError {
    /// The same `code` and `message` the frontend gets (also stored with a failed download).
    pub fn parts(&self) -> (&'static str, &str) {
        match self {
            Self::Network(m) => ("network", m),
            Self::ExtractorBroken(m) => ("extractorBroken", m),
            Self::Unavailable(m) => ("unavailable", m),
            Self::NoSpace(m) => ("noSpace", m),
            Self::Ffmpeg(m) => ("ffmpeg", m),
            Self::JsRuntimeMissing(m) => ("jsRuntimeMissing", m),
            Self::Cancelled(m) => ("cancelled", m),
            Self::InvalidUrl(m) => ("invalidUrl", m),
            Self::LoginRequired(m) => ("loginRequired", m),
            Self::UnsupportedUrl(m) => ("unsupportedUrl", m),
            Self::AlreadyQueued(m) => ("alreadyQueued", m),
            Self::FolderUnavailable(m) => ("folderUnavailable", m),
            Self::CookiesUnavailable(m) => ("cookiesUnavailable", m),
            Self::Playlist(m) => ("playlist", m),
            Self::Unknown(m) => ("unknown", m),
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (code, message) = self.parts();
        write!(f, "{code}: {message}")
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_and_message() {
        let json = serde_json::to_value(AppError::ExtractorBroken("boom".into())).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "extractorBroken", "message": "boom" })
        );
    }

    #[test]
    fn display_uses_the_same_code_as_serde() {
        let err = AppError::JsRuntimeMissing("no deno".into());
        let code = serde_json::to_value(&err).unwrap()["code"].clone();
        assert_eq!(
            err.to_string(),
            format!("{}: no deno", code.as_str().unwrap())
        );
    }
}
