# Security policy

AlbaRo Downloader is a personal, open-source project maintained by one person. Security reports are welcome and are
handled on a best-effort basis.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting instead: on the repository, go to **Security → Report a vulnerability**.
Include what you found, the version, your operating system and, if you can, the steps to reproduce it.

This is a hobby project, so there is no promised response time. Serious problems get fixed in a new release, and you
are credited in the release notes unless you prefer not to be.

## Supported versions

Only the latest release gets security fixes. The app checks for new versions on its own and asks before installing.

## What counts

In scope: the app itself (the Rust backend, the interface, the installers and the update checks), for example a way
to run commands or write files outside the download folder, to read cookies or other private data, or to get the
updater to install something that was not published by the project.

Out of scope:

- Bugs in yt-dlp, FFmpeg or Deno. Report them to those projects. If the app ships a version with a known problem,
  tell us.
- Anything that needs control of the user's computer first (another program already running as the same user).
- Downloading content you are not allowed to download. See "Responsible use" in the README.

## What the app does to stay safe

In short: the page can only call a short list of commands, nothing is run through a shell, links and
file names are checked before they reach yt-dlp, yt-dlp updates are verified against its OpenPGP signature, app
updates are signed, and cookies are never written to logs or error messages.

---

# Política de seguridad

AlbaRo Downloader es un proyecto personal de código abierto, mantenido por una persona. Los avisos de seguridad se
agradecen y se atienden lo mejor posible.

**No abras una incidencia pública** por un problema de seguridad. Usa el aviso privado de GitHub: en el
repositorio, **Security → Report a vulnerability**. Cuenta qué has encontrado, la versión, tu sistema operativo y,
si puedes, cómo reproducirlo. Es un proyecto personal, sin plazo de respuesta prometido. Solo la última versión recibe arreglos de
seguridad. Los fallos de yt-dlp, FFmpeg o Deno hay que avisarlos a esos proyectos.
