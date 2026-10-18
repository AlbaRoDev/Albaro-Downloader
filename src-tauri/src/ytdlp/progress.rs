// Parses yt-dlp's download progress. yt-dlp runs with `--progress-template TEMPLATE`, so each
// update is one stdout line: `MARKER` followed by the `%(progress)j` JSON. Lines without the
// marker are yt-dlp's normal messages and are never parsed.
use serde::{Deserialize, Serialize};

/// Starts every progress line. yt-dlp's own lines start with `[youtube]`, `[download]`,
/// `[Merger]`..., and the template puts the marker first, so no other line begins with it.
const MARKER: &str = "[albaro-progress] ";

/// Value for `--progress-template`. `download:` limits it to downloads: post-processing (the
/// final video+audio merge) reports nothing through it.
pub const TEMPLATE: &str = "download:[albaro-progress] %(progress)j";

/// Starts the line with the final file's path. Like the progress marker, no line of
/// yt-dlp's own starts with it.
const FILE_MARKER: &str = "[albaro-file] ";

/// Value for `--print`: `after_move` runs once the file is in its final place, and
/// `%(filepath)s` is that place (after the merge, remux or audio extraction). `--print` implies
/// `--quiet`, which also silences the progress template, so the arguments add `--progress`
/// (checked with yt-dlp 2026.08.19: errors and warnings still reach stderr).
pub const PRINT_FILE: &str = "after_move:[albaro-file] %(filepath)s";

/// The final file's path, if `line` is the `PRINT_FILE` line. Anything else (progress, yt-dlp's
/// own messages) is `None`; so is an empty path.
pub fn parse_file(line: &str) -> Option<&str> {
    line.strip_prefix(FILE_MARKER)
        .map(str::trim)
        .filter(|path| !path.is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Downloading,
    Finished,
    Error,
}

/// One update for one file. A video+audio download reports two files in a row, each from 0 to
/// 100 %, and the merge afterwards reports nothing.
///
/// Read from yt-dlp's snake_case JSON and sent to the frontend in camelCase. Unknown fields
/// are ignored (no `deny_unknown_fields`) so a newer yt-dlp can add some; missing or `null`
/// fields become `None`. Numbers are `f64` because yt-dlp mixes integers and decimals (`1024`
/// and `3072.0` in the same field) and JS numbers are `f64` anyway; byte counts stay exact up
/// to 2^53.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct Progress {
    pub status: Status,
    pub downloaded_bytes: Option<f64>,
    /// Exact size, or yt-dlp's estimate when it lacks one (fragmented downloads).
    pub total_bytes: Option<f64>,
    /// Only read, to fill `total_bytes`. Not an alias: yt-dlp often sends both keys.
    #[serde(skip_serializing)]
    total_bytes_estimate: Option<f64>,
    /// Bytes per second; `None` right after a file starts.
    pub speed: Option<f64>,
    /// Seconds left.
    pub eta: Option<f64>,
    pub filename: Option<String>,
    /// Fragmented downloads (HLS/DASH) only. Steadier than the estimated total, which jumps
    /// around (the first updates even estimate the total as what was downloaded so far).
    pub fragment_index: Option<f64>,
    pub fragment_count: Option<f64>,
}

/// `Ok(None)` for lines that are not progress, `Err` for a progress line whose JSON cannot be
/// read. The caller logs the `Err` and carries on.
pub fn parse_line(line: &str) -> Result<Option<Progress>, serde_json::Error> {
    let Some(json) = line.strip_prefix(MARKER) else {
        return Ok(None);
    };
    let mut progress: Progress = serde_json::from_str(json)?;
    // `take()` moves the estimate out, leaving `None` behind.
    progress.total_bytes = progress
        .total_bytes
        .or(progress.total_bytes_estimate.take());
    Ok(Some(progress))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real stdout captured with the bundled yt-dlp and `TEMPLATE` (see tests/fixtures).
    const SINGLE: &str = include_str!("../../../tests/fixtures/progress-single-file.stdout.txt");
    const HLS: &str = include_str!("../../../tests/fixtures/progress-fragmented-hls.stdout.txt");
    const SOUNDCLOUD: &str =
        include_str!("../../../tests/fixtures/progress-soundcloud-hls.stdout.txt");
    const ALREADY: &str =
        include_str!("../../../tests/fixtures/progress-already-downloaded.stdout.txt");
    const MERGE: &str =
        include_str!("../../../tests/fixtures/progress-video-audio-merge.stdout.txt");
    const UNAVAILABLE: &str =
        include_str!("../../../tests/fixtures/progress-unavailable.stdout.txt");

    /// Parses every line, failing the test on any unreadable progress line.
    fn parse_all(stdout: &str) -> Vec<Progress> {
        stdout
            .lines()
            .filter_map(|line| parse_line(line).unwrap())
            .collect()
    }

    #[test]
    fn the_final_path_line_is_read_and_is_not_progress() {
        let line = r"[albaro-file] C:UsersaDescargasMe at the zoo [jNQXAC9IVRw].mp4";
        assert_eq!(
            parse_file(line),
            Some(r"C:UsersaDescargasMe at the zoo [jNQXAC9IVRw].mp4")
        );
        // The two markers never overlap: neither parser takes the other's line.
        assert_eq!(parse_line(line).unwrap(), None);
        assert_eq!(
            parse_file("[albaro-progress] {\"status\": \"finished\"}"),
            None
        );
        assert!(PRINT_FILE.ends_with("[albaro-file] %(filepath)s"));
    }

    #[test]
    fn a_path_with_accents_and_other_scripts_comes_through_whole() {
        // What yt-dlp prints with `--encoding utf-8`, decoded as UTF-8 by the runner.
        for name in [
            "Lectura la Niña y el Ñandú [RTq7ZHpfVwY].opus",
            "「万聖街」日本語吹替版　番宣CM15秒 [FErrKdU_0XM].opus",
            "Fade Into You [4K] [MCtn3j_xYzw].opus",
        ] {
            let line = format!("[albaro-file] C:/out/{name}");
            assert_eq!(parse_file(&line), Some(format!("C:/out/{name}").as_str()));
        }
    }

    #[test]
    fn a_missing_or_empty_path_is_none() {
        for line in [
            "[albaro-file] ",
            "[albaro-file]",
            "",
            "[download] Destination: x",
        ] {
            assert_eq!(parse_file(line), None, "{line:?}");
        }
        // Real stdout fixtures never contain it.
        for stdout in [SINGLE, HLS, SOUNDCLOUD, ALREADY, MERGE, UNAVAILABLE] {
            assert!(stdout.lines().all(|l| parse_file(l).is_none()));
        }
    }

    #[test]
    fn template_starts_with_the_marker() {
        assert_eq!(TEMPLATE, format!("download:{MARKER}%(progress)j"));
    }

    #[test]
    fn single_file_has_a_known_total_and_ends_finished() {
        let updates = parse_all(SINGLE);
        assert_eq!(updates.len(), 9);
        assert!(updates.iter().all(|p| p.total_bytes == Some(252182.0)));
        let last = &updates[8];
        assert_eq!(last.status, Status::Finished);
        assert_eq!(last.downloaded_bytes, Some(252182.0));
        assert_eq!(
            last.filename.as_deref(),
            Some("Me at the zoo [jNQXAC9IVRw].webm")
        );
    }

    #[test]
    fn fragmented_download_uses_the_estimate_and_reports_fragments() {
        let updates = parse_all(HLS);
        assert_eq!(updates.len(), 26);
        // No exact total while downloading: it comes from `total_bytes_estimate` (an
        // integer here, a decimal like `3072.0` in the next line).
        assert_eq!(updates[0].total_bytes, Some(1024.0));
        assert_eq!(updates[1].total_bytes, Some(3072.0));
        assert!(updates.iter().all(|p| p.eta.is_none()));
        assert_eq!(updates[0].fragment_count, Some(3.0));
        assert_eq!(updates[24].fragment_index, Some(3.0));
        let last = &updates[25];
        assert_eq!(last.status, Status::Finished);
        assert_eq!(last.total_bytes, Some(365096.0));
    }

    #[test]
    fn fragment_index_can_pass_the_count_and_eta_can_be_decimal() {
        // Real yt-dlp behaviour, passed through as is: whoever computes a percentage from
        // fragments must cap it at 100 %.
        let updates = parse_all(SOUNDCLOUD);
        let last_downloading = &updates[updates.len() - 2];
        assert_eq!(last_downloading.fragment_index, Some(23.0));
        assert_eq!(last_downloading.fragment_count, Some(22.0));
        assert!(updates
            .iter()
            .any(|p| p.eta.is_some_and(|e| e.fract() != 0.0)));
        assert_eq!(updates[updates.len() - 1].status, Status::Finished);
    }

    #[test]
    fn video_and_audio_are_two_separate_runs_from_zero() {
        let updates = parse_all(MERGE);
        let files: Vec<_> = updates.iter().map(|p| p.filename.as_deref()).collect();
        let video = Some("Me at the zoo [jNQXAC9IVRw] merged.f395.mp4");
        let audio = Some("Me at the zoo [jNQXAC9IVRw] merged.f251.webm");
        assert_eq!(files.iter().filter(|f| **f == video).count(), 9);
        assert_eq!(files.iter().filter(|f| **f == audio).count(), 9);
        assert_eq!(updates[8].status, Status::Finished);
        assert_eq!(updates[17].status, Status::Finished);
        // The second file starts over with no speed yet.
        assert_eq!(updates[9].downloaded_bytes, Some(1024.0));
        assert_eq!(updates[9].speed, None);
        // The merge itself only prints `[Merger] ...`, which is not progress.
        assert!(MERGE.lines().any(|l| l.starts_with("[Merger]")));
    }

    #[test]
    fn already_downloaded_file_sends_one_finished_without_downloaded_bytes() {
        let updates = parse_all(ALREADY);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].status, Status::Finished);
        assert_eq!(updates[0].downloaded_bytes, None);
        assert_eq!(updates[0].total_bytes, Some(4315797.0));
    }

    #[test]
    fn failed_extraction_prints_no_progress() {
        assert!(parse_all(UNAVAILABLE).is_empty());
    }

    #[test]
    fn nulls_and_missing_fields_become_none() {
        let line = r#"[albaro-progress] {"status": "downloading", "downloaded_bytes": 10, "speed": null, "eta": null}"#;
        let p = parse_line(line).unwrap().unwrap();
        assert_eq!(p.downloaded_bytes, Some(10.0));
        assert_eq!((p.total_bytes, p.speed, p.eta), (None, None, None));
        assert_eq!(p.filename, None);
    }

    #[test]
    fn frontend_gets_camel_case_without_the_estimate() {
        let line = r#"[albaro-progress] {"status": "downloading", "downloaded_bytes": 1, "total_bytes_estimate": 2}"#;
        let json = serde_json::to_value(parse_line(line).unwrap().unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "status": "downloading", "downloadedBytes": 1.0, "totalBytes": 2.0,
                "speed": null, "eta": null, "filename": null,
                "fragmentIndex": null, "fragmentCount": null
            })
        );
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let line = r#"[albaro-progress] {"status": "finished", "total_bytes": 5.5, "new_field": {"x": 1}}"#;
        let p = parse_line(line).unwrap().unwrap();
        assert_eq!((p.status, p.total_bytes), (Status::Finished, Some(5.5)));
    }

    #[test]
    fn broken_json_after_the_marker_is_an_error() {
        assert!(parse_line(r#"[albaro-progress] {"status": "downlo"#).is_err());
        assert!(parse_line(r#"[albaro-progress] {"status": "paused"}"#).is_err());
    }

    #[test]
    fn other_lines_are_not_progress() {
        for line in [
            "[download] Destination: Me at the zoo [jNQXAC9IVRw].webm",
            "[Merger] Merging formats into \"x.webm\"",
            "",
            " [albaro-progress] {}",
        ] {
            assert_eq!(parse_line(line).unwrap(), None, "{line}");
        }
    }
}
