#!/usr/bin/env bash
# Quick check of a built ffmpeg/ffprobe: every conversion and remux the app asks yt-dlp for,
# on a generated tone and test picture. Runs wherever the binaries run (Linux, or Git Bash on Windows).
#
#   scripts/smoke-ffmpeg.sh <folder with ffmpeg and ffprobe>
set -euo pipefail

bin=$(cd "${1:?usage: smoke-ffmpeg.sh <bin folder>}" && pwd)
ext=; [ -f "$bin/ffmpeg.exe" ] && ext=.exe
ffmpeg=$bin/ffmpeg$ext ffprobe=$bin/ffprobe$ext
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cd "$dir"

run() { "$ffmpeg" -hide_banner -loglevel error -y "$@"; }
codec() { "$ffprobe" -v error -select_streams "$2" -show_entries stream=codec_name -of csv=p=0 "$1"; }
expect() { # file stream wanted
  local got
  got=$(codec "$1" "$2")
  [ "$got" = "$3" ] || { echo "FAIL: $1 has $got, wanted $3"; exit 1; }
  echo "ok: $1 -> $got"
}

"$ffmpeg" -version | head -1
# What the build must not contain: anything GPL, nonfree, or a library we did not choose.
if "$ffmpeg" -version | grep -E -- "--enable-(gpl|nonfree|version3)"; then echo "FAIL: not LGPL-only"; exit 1; fi
if grep -a -q "fftw" "$bin/ffmpeg$ext"; then echo "FAIL: FFTW inside"; exit 1; fi

# The sources: a tone and a picture, made by FFmpeg itself.
run -f lavfi -i "sine=frequency=440:duration=2" -c:a pcm_s16le tone.wav
run -f lavfi -i "testsrc=duration=1:size=96x64:rate=10" -frames:v 1 pic.png
run -f lavfi -i "testsrc=duration=1:size=96x64:rate=10" -c:v mpeg4 video.mp4

# Audio conversions: mp3, m4a (AAC), opus, flac, wav.
run -i tone.wav -c:a libmp3lame -b:a 128k out.mp3 && expect out.mp3 a:0 mp3
run -i tone.wav -c:a aac -b:a 128k out.m4a && expect out.m4a a:0 aac
run -i tone.wav -c:a libopus -b:a 96k out.opus && expect out.opus a:0 opus
run -i tone.wav -c:a flac out.flac && expect out.flac a:0 flac
run -i tone.wav -c:a pcm_s16le out.wav && expect out.wav a:0 pcm_s16le
# Best quality, no re-encoding: the opus and AAC streams move to their own container.
run -i out.opus -c copy copy.opus && expect copy.opus a:0 opus
run -i out.m4a -c copy copy.m4a && expect copy.m4a a:0 aac
# Opus into mp3 reads one codec and writes another.
run -i out.opus -c:a libmp3lame from-opus.mp3 && expect from-opus.mp3 a:0 mp3

# Merging video and audio without re-encoding, into each container.
run -i video.mp4 -i out.m4a -c copy -map 0:v -map 1:a merged.mp4 && expect merged.mp4 v:0 mpeg4
run -i video.mp4 -i out.m4a -c copy -map 0:v -map 1:a merged.mkv && expect merged.mkv a:0 aac
run -i video.mp4 -i out.opus -c copy -map 0:v -map 1:a merged.webm 2>/dev/null || true # mpeg4 is not WebM: yt-dlp falls back to mkv

# The thumbnail: PNG (needs zlib) to JPEG, then embedded as cover art.
run -i pic.png -frames:v 1 -q:v 2 pic.jpg && expect pic.jpg v:0 mjpeg
run -i out.mp3 -i pic.jpg -map 0:a -map 1:v -c copy -id3v2_version 3 -disposition:v:0 attached_pic covered.mp3 && expect covered.mp3 v:0 mjpeg
run -i out.m4a -i pic.jpg -map 0:a -map 1:v -c copy -disposition:v:0 attached_pic covered.m4a && expect covered.m4a v:0 mjpeg

# Metadata and subtitles.
run -i out.mp3 -c copy -metadata title="Título ñ" tagged.mp3
"$ffprobe" -v error -show_entries format_tags=title -of csv=p=0 tagged.mp3 | grep -q "Título ñ" || { echo "FAIL: title"; exit 1; }
printf '1\n00:00:00,000 --> 00:00:01,000\nHola\n' > sub.srt
run -i video.mp4 -i sub.srt -c copy -c:s mov_text subbed.mp4 && expect subbed.mp4 s:0 mov_text
run -i video.mp4 -i sub.srt -c copy subbed.mkv && expect subbed.mkv s:0 subrip

echo "all good"
