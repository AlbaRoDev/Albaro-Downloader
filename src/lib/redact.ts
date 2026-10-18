// What a bug report must not carry. The technical detail of an error is yt-dlp's own
// message, and it names local folders (with the user's Windows name in them) and the addresses it
// asked for, whose query strings often hold signed tokens. It is shown as it is, for the user, and
// cleaned only when it is copied to be pasted somewhere else.

// A user folder: `C:\\Users\\Ana María\\...` (any slash, any drive, with or without the `\\?\\` prefix;
// the name may have spaces), `/home/ana/...` and `/Users/ana/...`.
const WINDOWS_USER = /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\r\n"'<>|:*?]+/gi;
const UNIX_USER = /(\/(?:home|Users)\/)[^/\s"'<>|:*?]+/g;
// The query string and the fragment of an http(s) address.
const ADDRESS_EXTRAS = /(https?:\/\/[^\s"'<>?#]+)[?#](?!<removed>)[^\s"'<>]*/g;

export function redactDetail(text: string): string {
  return text
    .replace(WINDOWS_USER, "$1<user>")
    .replace(UNIX_USER, "$1<user>")
    .replace(ADDRESS_EXTRAS, "$1?<removed>");
}
