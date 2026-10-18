// Builds what a release publishes next to the installers: `latest.json` (what the app's
// updater reads), `SHA256SUMS` and `RELEASE_NOTES.md` (with the hashes and the SmartScreen note).
//
//   node scripts/release-manifest.mjs <folder with the installers and their .sig> <tag> <owner/repo>
//
// The folder holds, for each installer, the file and `<file>.sig` (made by `tauri signer sign
// --app-version`). File names have no spaces: GitHub turns them into dots, and the URL must match.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Installer name -> key in latest.json. The updater looks for `{os}-{arch}-{installer}` and then
// `{os}-{arch}`; a .deb install must not fall back to the AppImage (it would refuse it), so it
// gets its own key.
const PLATFORMS = [
  [/_windows-x64-setup\.exe$/, "windows-x86_64"],
  [/_linux-amd64\.AppImage$/, "linux-x86_64"],
  [/_linux-amd64\.deb$/, "linux-x86_64-deb"],
];

/** `files`: [{ name, signature, sha256 }]. Pure: no disk, no clock. */
export function buildManifest({ tag, repo, files, notes, date }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag))
    throw new Error(`"${tag}" is not a vX.Y.Z tag`);
  const platforms = {};
  for (const [pattern, key] of PLATFORMS) {
    const file = files.find((f) => pattern.test(f.name));
    if (!file)
      throw new Error(`no installer for ${key} (looked for ${pattern})`);
    if (!file.signature?.trim())
      throw new Error(`${file.name} has no signature`);
    platforms[key] = {
      signature: file.signature.trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${file.name}`,
    };
  }
  return {
    version: tag.slice(1),
    notes,
    pub_date: date.toISOString(),
    platforms,
  };
}

export function releaseNotes(tag, files) {
  const sums = files.map((f) => `${f.sha256}  ${f.name}`).join("\n");
  return `## AlbaRo Downloader ${tag}

**SHA-256** of the installers (\`Get-FileHash <file>\` in PowerShell, \`sha256sum <file>\` on Linux):

\`\`\`text
${sums}
\`\`\`

The Windows installer is not code-signed yet: SmartScreen may show "Windows protected your PC". Choose
*More info* and then *Run anyway* (see the README).
`;
}

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function main(dir, tag, repo) {
  const names = readdirSync(dir);
  const files = names
    .filter((n) => PLATFORMS.some(([pattern]) => pattern.test(n)))
    .sort()
    .map((name) => ({
      name,
      sha256: sha256(join(dir, name)),
      signature: names.includes(`${name}.sig`)
        ? readFileSync(join(dir, `${name}.sig`), "utf8")
        : "",
    }));
  const notes = releaseNotes(tag, files);
  // The app never shows these notes: the real ones are the release page.
  const manifest = buildManifest({
    tag,
    repo,
    files,
    notes: `AlbaRo Downloader ${tag}`,
    date: new Date(),
  });
  writeFileSync(
    join(dir, "latest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "SHA256SUMS"),
    files.map((f) => `${f.sha256}  ${f.name}\n`).join(""),
  );
  writeFileSync(join(dir, "RELEASE_NOTES.md"), notes);
  console.log(
    `latest.json for ${manifest.version}: ${Object.keys(manifest.platforms).join(", ")}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, tag, repo] = process.argv.slice(2);
  if (!dir || !tag || !repo)
    throw new Error("usage: release-manifest.mjs <folder> <tag> <owner/repo>");
  main(dir, tag, repo);
}
