// Mirror the static web app into www/ so Capacitor can bundle it into the iOS
// app. The web app has no build step — this is just a copy with an exclude list.
// Idempotent: www/ is cleared first, then repopulated. Run via `npm run sync:web`
// (and automatically by `npm run cap:sync`).
import { readdirSync, statSync, rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const www = join(root, "www");

// Directories that are NOT part of the shipped web app.
const EXCLUDE_DIRS = new Set([
  "node_modules",
  "www",
  "ios",
  "ios-plugin",
  "scripts",
  "supabase",
  "eval",
  "tool",
  "docs",
  ".git",
  ".vercel",
  ".gstack",
]);

// Top-level files to leave behind (tooling/config/docs, not web assets).
const EXCLUDE_FILES = new Set([
  "package.json",
  "package-lock.json",
  "capacitor.config.json",
  ".gitignore",
  ".DS_Store",
]);

// A web asset if it has one of these extensions, or is an asset directory.
const WEB_EXT = /\.(html|js|css|webmanifest|json|png|jpg|jpeg|svg|ico|webp|woff2?|ttf)$/i;
const ASSET_DIRS = new Set(["icons", "assets", "fonts", "img", "images"]);

function isWebFile(name) {
  if (EXCLUDE_FILES.has(name)) return false;
  if (name.endsWith(".md")) return false; // READMEs, handoff docs
  return WEB_EXT.test(name);
}

// Fresh start so deletions on the web side don't linger in www/.
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

let fileCount = 0;
let dirCount = 0;
for (const entry of readdirSync(root)) {
  const abs = join(root, entry);
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    if (!ASSET_DIRS.has(entry)) continue; // only copy known asset dirs
    cpSync(abs, join(www, entry), { recursive: true });
    dirCount += 1;
    continue;
  }
  if (isWebFile(entry)) {
    cpSync(abs, join(www, entry));
    fileCount += 1;
  }
}

if (!existsSync(join(www, "index.html"))) {
  console.error("sync-web: index.html was not copied — aborting so a broken bundle isn't shipped.");
  process.exit(1);
}

console.log(`sync-web: copied ${fileCount} files + ${dirCount} asset dir(s) into www/`);
