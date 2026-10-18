# AlbaRo Downloader

[Español](README.es.md)

A free, open desktop app to download video and audio from the web, built on
[yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org/). No download, resolution or
playlist limits, no accounts, no ads and no telemetry.

![Pasting a link: preview, format options and subtitles](docs/screenshots/card.png)

## Features

- **Video**: the best quality the source offers (4K or 8K when available). Pick MP4, MP4 compatible (H.264),
  MKV or WebM and a maximum resolution. The app never re-encodes video: it only repackages it (`-c copy`).
- **Audio**: the original audio without re-encoding (Opus or AAC) by default, or convert to MP3, M4A, Opus, FLAC
  or WAV. Cover art and metadata are embedded.
- **Subtitles**: embedded in the video, including automatic ones, in the languages you choose.
- **Playlists and channels**: see every entry, pick the ones you want, number the files in the list's order and
  save them in their own folder. Private or deleted videos are marked and skipped, not fatal.
- **A real queue**: several downloads at once (3 by default), pause, resume, cancel and retry. Network errors are
  retried with backoff, and the queue survives closing the app.
- **Limits you control**: number of simultaneous downloads and an overall speed limit.
- **Restricted content**: optionally use your browser's cookies, or a `cookies.txt` file, for videos that need a
  login or age verification. Off by default.
- **History** with search and filters, desktop notifications when the queue finishes, and a tray icon so
  downloads keep going when you close the window.
- **Always current**: yt-dlp updates itself in the background (checksum verified), because sites change often.
  The app tells you when a new version of itself is available and never installs without asking.
- Spanish and English, light and dark themes, and keyboard shortcuts.

![Downloads in progress](docs/screenshots/downloads.png)

![Choosing videos from a playlist](docs/screenshots/playlist.png)

The screenshots use the app's built-in simulator with made-up titles.

## Supported sites

Whatever yt-dlp supports: over a thousand sites, among them YouTube, Vimeo, Twitch, X, TikTok, Instagram, Reddit,
SoundCloud, Bandcamp and Dailymotion. What works at any moment depends on yt-dlp and on the sites themselves, so
no site is guaranteed. Content protected by DRM (Netflix, Prime Video, Spotify...) is not supported.

## Install

Download the installer for your system from the
[Releases page](https://github.com/AlbaRoDev/Albaro-Downloader/releases).

| System | File | Status |
| --- | --- | --- |
| Windows 10/11 | `.exe` installer | Main platform |
| Linux | `.AppImage` or `.deb` | Built by CI, not yet tested on real hardware |
| macOS | | Not available yet |

**Windows and SmartScreen.** The installer is not code-signed yet, so Windows SmartScreen may show "Windows
protected your PC". If you downloaded it from the Releases page, choose *More info* and then *Run anyway*. Each
release lists the SHA-256 checksum of its installers: compare it with the one of the file you downloaded
(`Get-FileHash <file>` in PowerShell) if you want to be sure it is untouched.

yt-dlp, FFmpeg and Deno come bundled: there is nothing else to install.

## Responsible use

AlbaRo Downloader is a tool, and what you download with it is your responsibility.

- Download only what you have the right to download: your own content, content under a licence that allows it
  (such as Creative Commons), public domain material, or copies you are allowed to make for personal use where
  your local law permits it.
- Respect the terms of service of the sites you use, and copyright law. Many sites forbid downloading in their
  terms, and downloading or sharing copyrighted works without permission may be illegal where you live.
- The app does not bypass DRM and does not help you do so.
- Do not use it to overload a site: the app limits its own request rate, and you should not work around that.

The authors do not encourage or take responsibility for any misuse. This is not legal advice. The software is
provided "as is", without warranty of any kind (see [LICENSE](LICENSE)). AlbaRo Downloader is not affiliated with,
endorsed by or sponsored by YouTube, Google, or any other site, nor by the yt-dlp, FFmpeg or Deno projects.
All trademarks belong to their owners.

## Privacy

There are no accounts, analytics or telemetry. Your history, queue and settings stay in a local database on your
computer. The app only connects to:

- the sites you download from, and the thumbnails they serve;
- GitHub, to check for new yt-dlp releases and new versions of the app.

If you use your browser's cookies or a `cookies.txt` file, they are read locally and only sent to the site you
are downloading from, by yt-dlp. For each download the app works on a private copy of the file and deletes it
afterwards.

## Security

Found a vulnerability? Please report it privately, as described in [SECURITY.md](SECURITY.md).

## Build from source

You need [Node.js](https://nodejs.org/) 24, [pnpm](https://pnpm.io/) 12, a stable
[Rust](https://rustup.rs/) toolchain and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system.

```sh
pnpm install
pnpm sidecars      # downloads yt-dlp, FFmpeg and Deno into src-tauri/binaries/
pnpm tauri dev     # run the app
pnpm tauri build   # build the installer
```

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and in `src-tauri/`: `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings` and `cargo test`. `pnpm dev` runs only the interface in a browser, with
a simulated backend.

The stack is Tauri 2 (Rust) with React, TypeScript and Tailwind, and SQLite for the queue and history.

## License

The code of AlbaRo Downloader is released under the [MIT License](LICENSE). The bundled programs and libraries keep
their own licences, listed in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). FFmpeg is built by this project
([`scripts/build-ffmpeg.sh`](scripts/build-ffmpeg.sh)) from the official source with only LGPL-compatible libraries
(libmp3lame, libopus, zlib), so `ffmpeg` and `ffprobe` are LGPL. They are separate programs you can replace, and
their source code is available at <https://github.com/FFmpeg/FFmpeg>.
