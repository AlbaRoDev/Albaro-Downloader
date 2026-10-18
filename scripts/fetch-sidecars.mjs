// Downloads the sidecar binaries (yt-dlp, ffmpeg + ffprobe, deno) for one target triple into
// src-tauri/binaries/, named `<tool>-<triple>[.exe]` as Tauri's externalBin expects.
// Every download is verified against the checksum file published in the same release.
// yt-dlp and Deno come from their projects' releases; ffmpeg and ffprobe from OUR releases
// (`ffmpeg-n<version>-albaro<N>`, built by scripts/build-ffmpeg.sh).
//
// Usage: node scripts/fetch-sidecars.mjs [--target <triple>] [--force]
// Set GITHUB_TOKEN to avoid the anonymous GitHub API rate limit (useful in CI). While the repository
// is private it is needed to read our own releases; without it, `gh auth token` is tried.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const BINARIES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src-tauri",
  "binaries",
);

const FFMPEG_REPO = "AlbaRoDev/Albaro-Downloader";

// ffmpeg is null where scripts/build-ffmpeg.sh does not build it (macOS is not built yet; ARM is not planned).
// The script fails clearly for those targets.
const TARGETS = {
  "x86_64-pc-windows-msvc": {
    ytdlp: "yt-dlp.exe",
    deno: "deno-x86_64-pc-windows-msvc.zip",
    ffmpeg: "win64",
  },
  "aarch64-pc-windows-msvc": {
    ytdlp: "yt-dlp_arm64.exe",
    deno: "deno-aarch64-pc-windows-msvc.zip",
    ffmpeg: null,
  },
  "x86_64-unknown-linux-gnu": {
    ytdlp: "yt-dlp_linux",
    deno: "deno-x86_64-unknown-linux-gnu.zip",
    ffmpeg: "linux64",
  },
  "aarch64-unknown-linux-gnu": {
    ytdlp: "yt-dlp_linux_aarch64",
    deno: "deno-aarch64-unknown-linux-gnu.zip",
    ffmpeg: null,
  },
  "x86_64-apple-darwin": {
    ytdlp: "yt-dlp_macos",
    deno: "deno-x86_64-apple-darwin.zip",
    ffmpeg: null,
  },
  "aarch64-apple-darwin": {
    ytdlp: "yt-dlp_macos",
    deno: "deno-aarch64-apple-darwin.zip",
    ffmpeg: null,
  },
};

/** Finds the sha256 for `name` in a checksum file. Handles `<hash>  <name>` lists and
 * single-asset files such as Deno's, which are `certutil` output (`Hash : <UPPERCASE>`). */
export function findChecksum(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+?)\s*$/i);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  const all = text.match(/\b[0-9a-f]{64}\b/gi) ?? [];
  if (all.length === 1) return all[0].toLowerCase();
  throw new Error(`no checksum found for ${name}`);
}

/** Picks the newest of our own ffmpeg archives for `platform` ("win64" or "linux64") out of a
 * release's asset names, e.g. `ffmpeg-n9.0.2-albaro1-win64.zip`: the higher FFmpeg version wins,
 * then the higher build revision. */
export function pickFfmpegAsset(names, platform) {
  const re = new RegExp(
    `^ffmpeg-n(\\d+)\\.(\\d+)\\.(\\d+)-albaro(\\d+)-${platform}\\.(zip|tar\\.xz)$`,
  );
  const found = names
    .map((name) => ({ name, v: name.match(re)?.slice(1, 5).map(Number) }))
    .filter((x) => x.v)
    .sort((a, b) => {
      for (let i = 0; i < 4; i++) if (a.v[i] !== b.v[i]) return b.v[i] - a.v[i];
      return 0;
    });
  if (found.length === 0) throw new Error(`no ffmpeg build for ${platform}`);
  return found[0].name;
}

// What `ffmpeg -version` may say was enabled. Our build links only these; anything else (a GPL
// library, a codec we did not choose) means this is not the build we made, and it is not installed.
const ALLOWED_FEATURES = new Set([
  "static",
  "zlib",
  "libmp3lame",
  "libopus",
  "schannel",
]);

/** The reason a build's `-version` output is not acceptable, or null. */
export function licenceProblem(info) {
  if (/--enable-(gpl|nonfree|version3)\b/.test(info))
    return "it enables GPL, nonfree or version3 code";
  for (const [, feature] of info.matchAll(/--enable-([\w-]+)/g)) {
    if (!ALLOWED_FEATURES.has(feature))
      return `it enables "${feature}", which is not part of our build`;
  }
  return null;
}

/** The token for GitHub: GITHUB_TOKEN, or (only for our own, maybe private, repository) the one `gh` holds. */
function githubToken(allowGh) {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (!allowGh) return null;
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** A release of `repo`: the latest one, or (with `tagPrefix`) the newest whose tag starts with it.
 * `urls` maps asset names to what `get` needs. With a token that is the API address of the asset,
 * which also works for a private repository. */
async function getRelease(repo, tagPrefix) {
  const token = githubToken(repo === FFMPEG_REPO);
  const headers = {
    "User-Agent": "albaro-downloader",
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = tagPrefix
    ? `https://api.github.com/repos/${repo}/releases?per_page=50`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}`);
  const body = await res.json();
  const release = tagPrefix
    ? body.find((r) => r.tag_name.startsWith(tagPrefix) && !r.draft)
    : body;
  if (!release) throw new Error(`no release "${tagPrefix}*" in ${repo}`);
  const urls = Object.fromEntries(
    release.assets.map((a) => [
      a.name,
      token ? { url: a.url, token } : { url: a.browser_download_url },
    ]),
  );
  return { tag: release.tag_name, urls };
}

/** GET for what `getRelease` returns. The API address of an asset answers with the file only when
 * asked for `application/octet-stream`. */
function get({ url, token }) {
  const headers = { "User-Agent": "albaro-downloader" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers.Accept = "application/octet-stream";
  }
  return fetch(url, { headers });
}

async function fetchText(asset) {
  const res = await get(asset);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${asset.url}`);
  return res.text();
}

/** Streams `asset` to `dest` and returns the sha256 of what was written. */
async function download(asset, dest) {
  const res = await get(asset);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${asset.url}`);
  const hash = createHash("sha256");
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => hash.update(chunk));
  await pipeline(body, createWriteStream(dest));
  return hash.digest("hex");
}

async function downloadVerified(asset, dest, expected) {
  const actual = await download(asset, dest);
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${asset.url}\n  expected ${expected}\n  got      ${actual}`,
    );
  }
}

function extract(archive, dest) {
  if (archive.endsWith(".zip")) {
    // On Windows call System32's bsdtar explicitly: Git Bash puts GNU tar first on PATH and
    // GNU tar cannot read zip files.
    if (process.platform === "win32") {
      const tar = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "tar.exe",
      );
      execFileSync(tar, ["-xf", archive, "-C", dest]);
    } else {
      execFileSync("unzip", ["-q", archive, "-d", dest]);
    }
  } else {
    execFileSync("tar", ["-xf", archive, "-C", dest]);
  }
}

async function install(from, tool, triple) {
  const ext = triple.includes("windows") ? ".exe" : "";
  const to = join(BINARIES_DIR, `${tool}-${triple}${ext}`);
  await copyFile(from, to);
  await chmod(to, 0o755);
  return to;
}

function hostTriple() {
  return execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
    /^host: (.+)$/m,
  )?.[1];
}

/** Runs `<bin> <arg>` and returns the first line of output. Only possible for the host target. */
function firstLine(bin, arg) {
  return execFileSync(bin, [arg], { encoding: "utf8" }).split(/\r?\n/)[0];
}

async function main() {
  const host = hostTriple();
  const flag = process.argv.indexOf("--target");
  const triple = flag === -1 ? host : process.argv[flag + 1];
  const spec = TARGETS[triple];
  if (!spec) {
    throw new Error(
      `unsupported target "${triple}". Supported: ${Object.keys(TARGETS).join(", ")}`,
    );
  }
  if (!spec.ffmpeg) {
    throw new Error(
      `no ffmpeg build for ${triple} yet (scripts/build-ffmpeg.sh builds Windows and Linux x64)`,
    );
  }
  const force = process.argv.includes("--force");
  const canRun = triple === host;
  const ext = triple.includes("windows") ? ".exe" : "";
  const has = (tool) =>
    existsSync(join(BINARIES_DIR, `${tool}-${triple}${ext}`));

  await mkdir(BINARIES_DIR, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), "albaro-sidecars-"));
  try {
    if (force || !has("yt-dlp")) {
      const { tag, urls } = await getRelease("yt-dlp/yt-dlp");
      const sums = await fetchText(urls["SHA2-256SUMS"]);
      const file = join(tmp, spec.ytdlp);
      await downloadVerified(
        urls[spec.ytdlp],
        file,
        findChecksum(sums, spec.ytdlp),
      );
      const dest = await install(file, "yt-dlp", triple);
      console.log(
        `yt-dlp ${tag}${canRun ? ` (reports ${firstLine(dest, "--version")})` : ""}`,
      );
    } else console.log("yt-dlp: already present (use --force to refresh)");

    if (force || !has("deno")) {
      const { tag, urls } = await getRelease("denoland/deno");
      const sum = await fetchText(urls[`${spec.deno}.sha256sum`]);
      const zip = join(tmp, spec.deno);
      await downloadVerified(
        urls[spec.deno],
        zip,
        findChecksum(sum, spec.deno),
      );
      const out = join(tmp, "deno");
      await mkdir(out);
      extract(zip, out);
      const dest = await install(join(out, `deno${ext}`), "deno", triple);
      console.log(
        `deno ${tag}${canRun ? ` (reports ${firstLine(dest, "--version")})` : ""}`,
      );
    } else console.log("deno: already present (use --force to refresh)");

    if (force || !has("ffmpeg") || !has("ffprobe")) {
      const { tag, urls } = await getRelease(FFMPEG_REPO, "ffmpeg-");
      const asset = pickFfmpegAsset(Object.keys(urls), spec.ffmpeg);
      const sums = await fetchText(urls.SHA256SUMS);
      const archive = join(tmp, asset);
      console.log(`ffmpeg: downloading ${asset} from ${tag}`);
      await downloadVerified(urls[asset], archive, findChecksum(sums, asset));
      const out = join(tmp, "ffmpeg");
      await mkdir(out);
      extract(archive, out);
      const [root] = await readdir(out);
      const bin = join(out, root, "bin");
      if (canRun) {
        // Enforces the licence rule (LGPL only, never GPL or nonfree) before installing.
        const info = execFileSync(join(bin, `ffmpeg${ext}`), ["-version"], {
          encoding: "utf8",
        });
        const problem = licenceProblem(info);
        if (problem) throw new Error(`ffmpeg build refused: ${problem}`);
        console.log(`${info.split(/\r?\n/)[0]} [LGPL check ok]`);
      } else {
        console.log(`ffmpeg ${asset} (cross target: LGPL check skipped)`);
      }
      await install(join(bin, `ffmpeg${ext}`), "ffmpeg", triple);
      await install(join(bin, `ffprobe${ext}`), "ffprobe", triple);
    } else
      console.log("ffmpeg/ffprobe: already present (use --force to refresh)");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`fetch-sidecars: ${err.message}`);
    process.exit(1);
  });
}
