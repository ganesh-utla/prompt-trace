/**
 * Glob matching shared by the extension and the capture CLI (which can't reach
 * the `vscode` API). Supports `**`, `*`, `?`. Path separators normalized to `/`.
 */

export function isExcluded(filePath: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  for (const pattern of patterns) {
    if (matchGlob(filePath, pattern)) return true;
  }
  return false;
}

export function matchGlob(pathStr: string, pattern: string): boolean {
  const norm = pathStr.replace(/\\/g, "/");
  const p = pattern.replace(/\\/g, "/");
  return globToRegex(p).test(norm);
}

function globToRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++; // consume second *
        if (pattern[i + 1] === "/") {
          i++; // consume following /
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+()[]{}^$|\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}
