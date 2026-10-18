#!/usr/bin/env bash
# Builds the FFmpeg (ffmpeg + ffprobe) that AlbaRo Downloader bundles.
#
#   scripts/build-ffmpeg.sh windows|linux [output-dir]
#
# Why our own build: the "lgpl" builds of BtbN link FFTW (GPL) through chromaprint, and 45 libraries
# the app never uses. This one links only what the app needs, so it is really LGPL:
#   - libmp3lame (LGPL 2) and libopus (BSD-3): the mp3 and opus conversions. AAC, FLAC and WAV are FFmpeg's own.
#   - zlib: PNG and compressed headers in mp4 and mkv.
#   - Windows: Schannel (the system's TLS) for https inputs. Linux: no TLS, so the binary needs nothing but
#     libc (a missing libgnutls would stop it from starting at all); yt-dlp downloads over https by itself.
# Everything else is autodetect-off, and there is no --enable-gpl, --enable-version3 or --enable-nonfree.
#
# Windows is cross-compiled from Linux with mingw-w64. Needs: build-essential, nasm, pkg-config, curl,
# xz-utils and, for Windows, mingw-w64. Sources are pinned by SHA-256 (FFmpeg's is also signed by
# FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8, checked when gpg is available).
set -euo pipefail

FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
LAME_VERSION=3.101
LAME_SHA256=7578af6eebd578b2bd64e468fac4ae1f03670a7e028166e67f855674b9b6aeac
OPUS_VERSION=1.6.1
OPUS_SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
ZLIB_VERSION=1.3.1
ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
# Bump when the recipe changes without a new FFmpeg version.
REVISION=${BUILD_REVISION:-1}

target=${1:?usage: build-ffmpeg.sh windows|linux [output-dir]}
out=$(realpath -m "${2:-ffmpeg-out}")
work=$(realpath -m "${WORK_DIR:-ffmpeg-work/$target}")
jobs=$(nproc)
mkdir -p "$out" "$work/src"
# A fixed, neutral place for the libraries: the configure line is printed by `ffmpeg -version`, and a
# builder's home folder (a user name) must not end up in a published binary.
prefix=/tmp/albaro-ffdeps/$target
rm -rf "$prefix"
mkdir -p "$prefix"

case $target in
  windows)
    host=x86_64-w64-mingw32
    name=ffmpeg-n$FFMPEG_VERSION-albaro$REVISION-win64
    exe=.exe
    ;;
  linux)
    host=
    name=ffmpeg-n$FFMPEG_VERSION-albaro$REVISION-linux64
    exe=
    ;;
  *) echo "unknown target: $target" >&2; exit 2 ;;
esac

if [ -n "$host" ]; then
  export CC=$host-gcc AR=$host-ar RANLIB=$host-ranlib STRIP=$host-strip
  cross=(--host="$host")
else
  export STRIP=strip
  cross=()
fi
# Only our own prefix: a system libopus or libz must never leak into the build.
export PKG_CONFIG_LIBDIR=$prefix/lib/pkgconfig PKG_CONFIG_PATH=
export CFLAGS="-O2 -I$prefix/include" LDFLAGS="-L$prefix/lib"

fetch() { # name url sha256
  local file=$work/src/$1
  if [ ! -f "$file" ]; then curl -fL --retry 3 -sS -o "$file" "$2"; fi
  echo "$3  $file" | sha256sum -c --quiet - || { echo "bad checksum: $1" >&2; exit 1; }
}
unpack() { # archive -> directory under $work
  rm -rf "$work/$2"
  tar -xf "$work/src/$1" -C "$work"
}

fetch "ffmpeg-$FFMPEG_VERSION.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256"
fetch "lame-$LAME_VERSION.tar.gz" "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz" "$LAME_SHA256"
fetch "opus-$OPUS_VERSION.tar.gz" "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz" "$OPUS_SHA256"
fetch "zlib-$ZLIB_VERSION.tar.gz" "https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.gz" "$ZLIB_SHA256"

if command -v gpg >/dev/null && curl -fsS -o "$work/src/ffmpeg.asc" "https://ffmpeg.org/ffmpeg-devel.asc" \
  && curl -fsS -o "$work/src/ffmpeg-$FFMPEG_VERSION.tar.xz.asc" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz.asc"; then
  export GNUPGHOME=$work/gnupg
  mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"
  gpg --batch -q --import "$work/src/ffmpeg.asc" 2>/dev/null
  gpg --batch --status-fd 1 --verify "$work/src/ffmpeg-$FFMPEG_VERSION.tar.xz.asc" "$work/src/ffmpeg-$FFMPEG_VERSION.tar.xz" 2>/dev/null \
    | grep -q "VALIDSIG FCF986EA15E6E293A5644F10B4322F04D67658D8" \
    || { echo "FFmpeg signature check failed" >&2; exit 1; }
  echo "FFmpeg signature: ok"
fi

echo "== zlib"
unpack "zlib-$ZLIB_VERSION.tar.gz" "zlib-$ZLIB_VERSION"
(
  cd "$work/zlib-$ZLIB_VERSION"
  if [ -n "$host" ]; then
    make -f win32/Makefile.gcc PREFIX="$host-" -j"$jobs" libz.a
    install -D libz.a "$prefix/lib/libz.a"
    install -D -m 644 zlib.h zconf.h -t "$prefix/include"
  else
    ./configure --static --prefix="$prefix" >/dev/null
    make -j"$jobs" >/dev/null && make install >/dev/null
  fi
)

echo "== lame"
unpack "lame-$LAME_VERSION.tar.gz" "lame-$LAME_VERSION"
(
  cd "$work/lame-$LAME_VERSION"
  ./configure "${cross[@]}" --prefix="$prefix" --disable-shared --enable-static --disable-frontend --disable-decoder >/dev/null
  make -j"$jobs" >/dev/null && make install >/dev/null
)

echo "== opus"
unpack "opus-$OPUS_VERSION.tar.gz" "opus-$OPUS_VERSION"
(
  cd "$work/opus-$OPUS_VERSION"
  ./configure "${cross[@]}" --prefix="$prefix" --disable-shared --enable-static --disable-doc --disable-extra-programs >/dev/null
  make -j"$jobs" >/dev/null && make install >/dev/null
)

echo "== ffmpeg"
unpack "ffmpeg-$FFMPEG_VERSION.tar.xz" "ffmpeg-$FFMPEG_VERSION"
configure=(
  --prefix=/albaro-ffmpeg
  --enable-static --disable-shared
  --disable-autodetect --disable-debug --disable-doc --disable-ffplay
  --enable-zlib --enable-libmp3lame --enable-libopus
  --pkg-config=pkg-config --pkg-config-flags=--static
  --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib"
)
if [ "$target" = windows ]; then
  configure+=(--arch=x86_64 --target-os=mingw32 --cross-prefix="$host-" --enable-schannel
    --extra-ldflags="-static -static-libgcc")
fi
(
  cd "$work/ffmpeg-$FFMPEG_VERSION"
  rm -rf "$work/ffmpeg-install"
  ./configure "${configure[@]}"
  make -j"$jobs" >/dev/null && make install DESTDIR="$work/ffmpeg-install" >/dev/null
)

echo "== package"
pkg=$out/$name
rm -rf "$pkg"
mkdir -p "$pkg/bin" "$pkg/licenses"
for p in ffmpeg ffprobe; do
  "$STRIP" -o "$pkg/bin/$p$exe" "$work/ffmpeg-install/albaro-ffmpeg/bin/$p$exe"
done
cp "$work/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$work/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv3" "$pkg/licenses/"
cp "$work/lame-$LAME_VERSION/COPYING" "$pkg/licenses/lame.COPYING"
cp "$work/opus-$OPUS_VERSION/COPYING" "$pkg/licenses/opus.COPYING"
cp "$work/zlib-$ZLIB_VERSION/LICENSE" "$pkg/licenses/zlib.LICENSE"
{
  echo "AlbaRo Downloader FFmpeg build (scripts/build-ffmpeg.sh, revision $REVISION)"
  echo "FFmpeg $FFMPEG_VERSION  sha256 $FFMPEG_SHA256"
  echo "lame $LAME_VERSION  sha256 $LAME_SHA256"
  echo "opus $OPUS_VERSION  sha256 $OPUS_SHA256"
  echo "zlib $ZLIB_VERSION  sha256 $ZLIB_SHA256"
  echo "target: $target"
  echo "configure: ${configure[*]}"
  if [ "$target" = windows ]; then
    echo "DLLs ffmpeg.exe imports:"
    "$host-objdump" -p "$pkg/bin/ffmpeg.exe" | sed -n 's/.*DLL Name: /  /p' | sort -u
  else
    echo "shared libraries ffmpeg needs:"
    ldd "$pkg/bin/ffmpeg" | sed 's/^/  /'
  fi
} > "$pkg/BUILDINFO.txt"

# The archive the app downloads: .zip on Windows, .tar.xz on Linux (the layouts fetch-sidecars.mjs reads).
(
  cd "$out"
  rm -f "$name.zip" "$name.tar.xz"
  if [ "$target" = windows ]; then zip -qr "$name.zip" "$name"; else tar -cJf "$name.tar.xz" "$name"; fi
)
echo "done: $out/$name"
cat "$pkg/BUILDINFO.txt"
