// Builds the macOS app icon (build/icon.icns) and the README image from docs/brand/icon/cherrypeek.svg.
// Needs rsvg-convert (`brew install librsvg`) and Apple's iconutil (part of macOS).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "docs/brand/icon/cherrypeek.svg");
if (process.platform !== "darwin") throw new Error("iconutil is macOS only.");

const work = mkdtempSync(join(tmpdir(), "cherrypeek-icon-"));
const iconset = join(work, "icon.iconset");
execFileSync("mkdir", ["-p", iconset]);
const render = (size, file) => execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), source, "-o", file]);
try {
  // Each size is rendered from the vector source, so small icons stay sharp instead of being scaled down.
  for (const size of [16, 32, 128, 256, 512]) {
    render(size, join(iconset, `icon_${size}x${size}.png`));
    render(size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", resolve(root, "build/icon.icns")]);
  render(256, resolve(root, "docs/brand/icon/cherrypeek-256.png"));
  console.log("Wrote build/icon.icns and docs/brand/icon/cherrypeek-256.png");
} finally {
  rmSync(work, { recursive: true, force: true });
}
