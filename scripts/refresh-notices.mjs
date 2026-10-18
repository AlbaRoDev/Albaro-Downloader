// Refreshes the licence texts of the bundled programs to the versions that are actually in
// src-tauri/binaries (run `pnpm sidecars` first), and records those versions in
// scripts/notices/versions.json (yt-dlp and Deno; FFmpeg is our own build, its versions are in
// scripts/build-ffmpeg.sh). Then run `pnpm notices`. Do it before each release: the sidecars
// are always the latest ones, so their licences can change.
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "src-tauri/binaries");
const out = join(root, "scripts/notices");

const run = (name, ...args) => {
  const file = readdirSync(bin).find((f) => f.startsWith(`${name}-`));
  if (!file) throw new Error(`no ${name} in ${bin}: run \`pnpm sidecars\``);
  return execFileSync(join(bin, file), args, { encoding: "utf8" });
};

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
};

const ytDlp = run("yt-dlp", "--version").trim();
const deno = /deno (\S+)/.exec(run("deno", "--version"))?.[1];
if (!deno) throw new Error("could not read the Deno version");

const ytRaw = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${ytDlp}`;
writeFileSync(join(out, "yt-dlp.LICENSE"), await get(`${ytRaw}/LICENSE`));
writeFileSync(
  join(out, "yt-dlp.THIRD_PARTY_LICENSES.txt"),
  await get(`${ytRaw}/THIRD_PARTY_LICENSES.txt`),
);
writeFileSync(
  join(out, "deno.LICENSE"),
  await get(
    `https://raw.githubusercontent.com/denoland/deno/v${deno}/LICENSE.md`,
  ),
);
writeFileSync(
  join(out, "versions.json"),
  `${JSON.stringify({ ytDlp, deno }, null, 2)}\n`,
);
console.log({ ytDlp, deno });
