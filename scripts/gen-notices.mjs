// Writes THIRD_PARTY_NOTICES.txt: the licences of everything that ships inside the app.
// Run with `pnpm notices` after changing dependencies and commit the result; `pnpm notices:check`
// (used by the CI) regenerates it in memory, fails if the file is out of date, and never uses the network.
// Rust: `cargo metadata` (normal dependencies only, for each target we ship).
// npm: `pnpm licenses list --prod`. Sidecars: the texts in scripts/notices/.
// A package that publishes no licence file gets it from its repository, once, into scripts/notices/cache/.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const notice = (name) =>
  clean(readFileSync(join(root, "scripts/notices", name), "utf8"));
// The systems we ship. macOS is not distributed yet: add "aarch64-apple-darwin" with it.
const TARGETS = ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"];
const CHECK = process.argv.includes("--check");
// Crates that declare no repository: found by hand, and checked against the commit in their `.cargo_vcs_info.json`.
const REPOSITORIES = {
  "libappindicator-sys": "https://github.com/tauri-apps/libappindicator-rs",
};
const CACHE = join(root, "scripts/notices/cache");
// Where a repository keeps its licence, in the order we try.
const LICENSE_NAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "LICENSE-ZLIB",
  "LICENSE-2.0.txt",
  "LICENCE",
  "COPYING",
  "UNLICENSE",
];
// npm licences we accept in the interface bundle; anything else stops the script so someone looks at it.
const NPM_ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "OFL-1.1",
  "MPL-2.0",
  "Unlicense",
  "CC0-1.0",
  "Zlib",
]);
// Dev-only test bridge: registered under `cfg(debug_assertions)` / `import.meta.env.DEV`, never used in a release.
const SKIP = new Set(["tauri-plugin-mcp"]);
const LICENSE_FILE = /^(licen[cs]e|copying|unlicense|notice)/i;
const RULE = "=".repeat(80);

function clean(text) {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function licenseTexts(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => clean(readFileSync(join(dir, e.name), "utf8")))
    .filter(Boolean);
}

/** `https://github.com/o/r(.git)` (or `git+...`, `github.com:o/r`) -> `o/r`. */
function githubRepo(url) {
  const m = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[/#].*)?$/.exec(
    url ?? "",
  );
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * A published package often leaves out the licence (a workspace keeps one at the repository root).
 * Fetches it from the repository at the commit (or tag) it was published from and keeps it in
 * scripts/notices/cache/<key>, so generating the file does not need the network afterwards.
 * Returns the cache folder when it holds something.
 */
async function cachedLicences(key, repoUrl, refs, subdir) {
  const dir = join(CACHE, key);
  const has = () => existsSync(dir) && licenseTexts(dir).length > 0;
  if (has() || CHECK) return has() ? dir : null;
  const repo = githubRepo(repoUrl);
  if (!repo) return null;
  const places = subdir ? [subdir, ""] : [""];
  for (const ref of refs) {
    for (const place of places) {
      let found = 0;
      for (const name of LICENSE_NAMES) {
        const path = place ? `${place}/${name}` : name;
        const res = await fetch(
          `https://raw.githubusercontent.com/${repo}/${ref}/${path}`,
        ).catch(() => null);
        if (!res?.ok) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), await res.text());
        found++;
      }
      if (found) return dir;
    }
  }
  return null;
}

/** Groups packages by identical licence text; those with no text go to `missing`. */
class Collector {
  byText = new Map();
  missing = [];

  add(label, dirs, spdx, url) {
    const texts =
      [dirs]
        .flat()
        .filter(Boolean)
        .map((d) => licenseTexts(d))
        .find((t) => t.length > 0) ?? [];
    if (texts.length === 0) {
      this.missing.push(
        `${label} - ${spdx || "no licence declared"}${url ? ` - ${url}` : ""}`,
      );
      return;
    }
    const text = texts.join("\n\n");
    const key = createHash("sha256").update(text).digest("hex");
    const group = this.byText.get(key) ?? { text, labels: new Set() };
    group.labels.add(label);
    this.byText.set(key, group);
  }

  render() {
    const groups = [...this.byText.values()].sort(
      (a, b) => b.labels.size - a.labels.size,
    );
    const out = groups.map(
      (g) =>
        `${wrap([...g.labels].sort().join(", "))}\n${"-".repeat(80)}\n${g.text}`,
    );
    if (this.missing.length) {
      out.push(
        `Packages that ship no licence file (licence as declared in their metadata)\n${"-".repeat(80)}\n${this.missing.sort().join("\n")}`,
      );
    }
    return out.join(`\n\n${RULE}\n\n`);
  }
}

function wrap(text, width = 100) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  return [...lines, line].join("\n");
}

function rustCrates() {
  const found = new Map();
  for (const target of TARGETS) {
    const json = execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--filter-platform",
        target,
        "--manifest-path",
        "src-tauri/Cargo.toml",
      ],
      { cwd: root, maxBuffer: 1 << 28, encoding: "utf8" },
    );
    const meta = JSON.parse(json);
    const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const seen = new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const pkg = pkgs.get(id);
      // A proc-macro runs at build time only: it is not in the binary, and neither are its dependencies.
      if (pkg.targets.some((t) => t.kind.includes("proc-macro"))) return;
      if (id !== meta.resolve.root && !SKIP.has(pkg.name)) found.set(id, pkg);
      for (const dep of nodes.get(id).deps) {
        if (dep.dep_kinds.some((k) => k.kind === null)) visit(dep.pkg);
      }
    };
    visit(meta.resolve.root);
  }
  return [...found.values()];
}

function npmPackages() {
  const json = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    cwd: root,
    maxBuffer: 1 << 28,
    encoding: "utf8",
    shell: true,
  });
  return Object.values(JSON.parse(json))
    .flat()
    .filter((p) => !SKIP.has(p.name))
    .flatMap((p) =>
      p.paths.map((path, i) => ({
        ...p,
        path,
        version: p.versions[i] ?? p.versions[0],
      })),
    );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const rust = new Collector();
for (const p of rustCrates()) {
  const dir = dirname(p.manifest_path);
  let extra = null;
  if (licenseTexts(dir).length === 0) {
    // `.cargo_vcs_info.json` says which commit, and which folder of it, the crate was published from.
    const vcs = readJson(join(dir, ".cargo_vcs_info.json"));
    const refs = [vcs.git?.sha1, `v${p.version}`, p.version, "HEAD"].filter(
      Boolean,
    );
    extra = await cachedLicences(
      `${p.name}-${p.version}`,
      p.repository ?? REPOSITORIES[p.name] ?? p.homepage,
      refs,
      vcs.path_in_vcs,
    );
  }
  rust.add(`${p.name} ${p.version}`, [dir, extra], p.license, p.repository);
}
const npm = new Collector();
const disallowed = [];
for (const p of npmPackages()) {
  // An SPDX expression: one alternative of `A OR B` is enough, every part of `A AND B` must be allowed.
  const allowed = String(p.license)
    .replace(/[()]/g, "")
    .split(/ OR /)
    .some((alt) => alt.split(/ AND /).every((l) => NPM_ALLOWED.has(l.trim())));
  if (!allowed) disallowed.push(`${p.name} ${p.version}: ${p.license}`);
  let extra = null;
  if (licenseTexts(p.path).length === 0) {
    const pkg = readJson(join(p.path, "package.json"));
    const repo = pkg.repository?.url ?? pkg.repository ?? p.homepage;
    extra = await cachedLicences(
      `${p.name.replace("/", "__")}-${p.version}`,
      repo,
      [pkg.gitHead, `v${p.version}`, p.version, "HEAD"].filter(Boolean),
      null,
    );
  }
  npm.add(`${p.name} ${p.version}`, [p.path, extra], p.license, p.homepage);
}
if (disallowed.length) {
  console.error(
    `npm packages with a licence that is not on the allowed list (NPM_ALLOWED):\n  ${disallowed.join("\n  ")}`,
  );
  process.exit(1);
}

const section = (title, body) => `${RULE}\n${title}\n${RULE}\n\n${body}\n`;

const versions = readJson(join(root, "scripts/notices/versions.json"));
// The FFmpeg we build: its versions live in one place, the build script.
const build = Object.fromEntries(
  [
    ...readFileSync(join(root, "scripts/build-ffmpeg.sh"), "utf8").matchAll(
      /^([A-Z]+_VERSION)=(\S+)$/gm,
    ),
  ].map((m) => [m[1], m[2]]),
);
const programs = `AlbaRo Downloader bundles three programs that it runs as separate processes (they are not
linked into the application): yt-dlp, FFmpeg (with ffprobe) and Deno. The texts below are those of
the versions bundled when this file was generated (see scripts/refresh-notices.mjs).

${"-".repeat(80)}
yt-dlp ${versions.ytDlp} - Unlicense
Source: https://github.com/yt-dlp/yt-dlp
${"-".repeat(80)}
${notice("yt-dlp.LICENSE")}

The yt-dlp executable is a PyInstaller bundle that includes Python and other components. Their
licences, as published by the yt-dlp project (THIRD_PARTY_LICENSES.txt), follow.

${notice("yt-dlp.THIRD_PARTY_LICENSES.txt")}

${"-".repeat(80)}
Deno ${versions.deno} - MIT
Source: https://github.com/denoland/deno
${"-".repeat(80)}
${notice("deno.LICENSE")}

${"-".repeat(80)}
FFmpeg and ffprobe ${build.FFMPEG_VERSION} - GNU Lesser General Public License, version 2.1 or later
Source: https://ffmpeg.org/download.html
${"-".repeat(80)}
FFmpeg is Copyright (c) 2000-2026 the FFmpeg developers. The ffmpeg and ffprobe executables in this
application are built by this project (scripts/build-ffmpeg.sh, in the repository) from the official
FFmpeg ${build.FFMPEG_VERSION} source release, configured without --enable-gpl, --enable-version3 or
--enable-nonfree, so they are licensed under the LGPL version 2.1 or later. They link statically only
these libraries (and, on Windows, the system's own, such as Schannel for https):

  - FFmpeg's own libraries: libavcodec, libavformat, libavutil, libavfilter, libswscale, libswresample
  - libmp3lame ${build.LAME_VERSION}: LGPL version 2 (https://lame.sourceforge.io)
  - libopus ${build.OPUS_VERSION}: BSD 3-clause (https://opus-codec.org)
  - zlib ${build.ZLIB_VERSION}: zlib licence (https://zlib.net)

Run "ffmpeg -version" to see the exact configuration. The source of every component is the upstream
release named above, whose SHA-256 is pinned in scripts/build-ffmpeg.sh together with the recipe that
builds the executables; each release of this project that carries them keeps that script.

ffmpeg and ffprobe are separate executables in the application folder. You can replace them with
your own build of FFmpeg and the application will use it.

The licence texts follow: FFmpeg (LGPL 2.1), libmp3lame, libopus and zlib.

${notice("ffmpeg/COPYING.LGPLv2.1")}

${"-".repeat(40)}
libmp3lame
${"-".repeat(40)}

${notice("ffmpeg/lame.COPYING")}

${"-".repeat(40)}
libopus
${"-".repeat(40)}

${notice("ffmpeg/opus.COPYING")}

${"-".repeat(40)}
zlib
${"-".repeat(40)}

${notice("ffmpeg/zlib.LICENSE")}
`;

const header = `THIRD-PARTY NOTICES - AlbaRo Downloader

AlbaRo Downloader is released under the MIT licence (see LICENSE). It includes the third-party
software listed below. This file is generated by scripts/gen-notices.mjs; do not edit it by hand.
`;

const output = [
  header,
  section("1. Bundled programs (yt-dlp, FFmpeg, Deno)", programs),
  section("2. Rust libraries (linked into the application)", rust.render()),
  section(
    "3. JavaScript libraries and fonts (in the interface), including Playfair Display (SIL OFL 1.1)",
    npm.render(),
  ),
].join("\n");
const target = join(root, "THIRD_PARTY_NOTICES.txt");

if (CHECK) {
  const current = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  if (current !== output) {
    console.error(
      "THIRD_PARTY_NOTICES.txt is out of date: run `pnpm notices` and commit the result.",
    );
    process.exit(1);
  }
  console.log("THIRD_PARTY_NOTICES.txt is up to date");
} else {
  writeFileSync(target, output);
  console.log(
    `THIRD_PARTY_NOTICES.txt: ${rust.byText.size + rust.missing.length} Rust and ${npm.byText.size + npm.missing.length} npm entries`,
  );
}
