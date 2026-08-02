import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load the repo-root .env for local runs so `pnpm dev` works without exporting vars.
// Real environments (Railway, CI) inject env vars directly and always win.

export function loadEnvFile(): boolean {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      // Parse the whole file first so a later line wins over an earlier duplicate
      // (a blank placeholder above a filled-in value is an easy mistake to make).
      const parsed = new Map<string, string>();
      for (const raw of readFileSync(candidate, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) continue;
        const idx = line.indexOf("=");
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
        if (!key) continue;
        // Never let a later blank line erase an earlier real value.
        if (value === "" && (parsed.get(key) ?? "") !== "") continue;
        parsed.set(key, value);
      }
      // Real environment variables always win over the file.
      for (const [key, value] of parsed) {
        if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
      }
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}
