// Builds the public macOS release on this Mac: Developer ID signed, hardened runtime, notarized and stapled app and
// DMG, then checks them the way Gatekeeper will and writes SHA-256 sums. Credentials never leave the keychain:
// signing uses the Developer ID Application certificate, notarization the notarytool profile in APPLE_KEYCHAIN_PROFILE.
// See docs/RELEASE.md.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const allowDirty = process.argv.includes("--allow-dirty");

function fail(message) {
  console.error(`\nrelease:mac 未开始：${message}\n`);
  process.exit(1);
}

function output(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" });
}

async function run(command, args, env = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

// Preconditions, checked before anything is built.
if (process.platform !== "darwin" || process.arch !== "arm64") fail("第一版只发布 Apple 芯片版，请在 Apple 芯片的 Mac 上运行。");
const profile = process.env.APPLE_KEYCHAIN_PROFILE || "cherrypeek";
const identities = output("security", ["find-identity", "-v", "-p", "codesigning"]);
if (!/Developer ID Application/u.test(identities)) fail("钥匙串里没有 Developer ID Application 证书（security find-identity -v -p codesigning）。");
try {
  execFileSync("xcrun", ["notarytool", "history", "--keychain-profile", profile], { cwd: root, stdio: "pipe" });
} catch {
  fail(`钥匙串里找不到可用的公证配置 "${profile}"。请先运行一次：\n  xcrun notarytool store-credentials ${profile} --apple-id <Apple ID 邮箱> --team-id <Team ID>\n（按提示输入在 appleid.apple.com 生成的 App 专用密码，或改用 --key/--key-id/--issuer 保存 App Store Connect API Key），再重新执行 pnpm release:mac。`);
}

// The license list is part of the app; regenerate it, then require a clean tree so the release matches a commit.
await run(process.execPath, ["scripts/third-party-licenses.mjs"]);
const dirty = output("git", ["status", "--porcelain"]).trim();
if (dirty && !allowDirty) fail(`工作区有未提交的改动（若是 THIRD_PARTY_LICENSES.md，说明依赖变了，先提交它）：\n${dirty}`);

const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const app = resolve(root, "release/mac-arm64/CherryPeek.app");
const dmg = resolve(root, `release/CherryPeek-${version}-arm64.dmg`);
const zip = resolve(root, `release/CherryPeek-${version}-arm64.zip`);

// Build, sign and notarize the app (electron-builder staples it), and sign the DMG.
await run(process.execPath, ["scripts/package-macos.mjs"], { COMMITSCOPE_RELEASE: "1", APPLE_KEYCHAIN_PROFILE: profile });
// electron-builder notarizes the app inside; the DMG itself gets its own ticket so it opens cleanly when downloaded.
await run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", profile, "--wait"]);
await run("xcrun", ["stapler", "staple", dmg]);

// Check what a downloading user's Mac will check.
await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
await run("xcrun", ["stapler", "validate", app]);
await run("xcrun", ["stapler", "validate", dmg]);
await run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
await run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmg]);

const sums = [];
for (const file of [dmg, zip]) {
  const hash = createHash("sha256").update(await readFile(file)).digest("hex");
  sums.push(`${hash}  ${file.split("/").at(-1)}`);
}
const sumsFile = resolve(root, `release/CherryPeek-${version}-arm64.sha256`);
await writeFile(sumsFile, `${sums.join("\n")}\n`);

console.log(`\n已签名、公证并通过 Gatekeeper 检查：\n  ${dmg}\n  ${zip}\n  ${sumsFile}\n`);
console.log(`上传到 GitHub Release（先推送提交和标签 v${version}）：`);
console.log(`  git tag v${version} && git push origin v${version}`);
console.log(`  gh release create v${version} "${dmg}" "${zip}" "${sumsFile}" --title "CherryPeek ${version}" --notes-file docs/releases/v${version}.md`);
