; Included by Tauri's NSIS installer (bundle.windows.nsis.installerHooks).
;
; The installer carries ffmpeg.exe and ffprobe.exe, ~28 MB each and nearly identical. NSIS compresses
; the whole installer as one LZMA stream (SOLID) with an 8 MB dictionary by default, which cannot see
; that far back, so ffprobe is compressed from scratch. A 32 MB dictionary lets it reuse ffmpeg's
; data: the installer went from 72.2 to 62.6 MB (measured with makensis on the same files).
; It only costs memory while building the installer; installing needs the same dictionary size (32 MB).
SetCompressorDictSize 32
