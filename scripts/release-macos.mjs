// Builds the public macOS release on this Mac: Developer ID signed, hardened runtime, notarized and stapled app,
// signed DMG and zip, verified with codesign / stapler / spctl the way Gatekeeper will, plus SHA-256 sums.
// Supports two official Apple notarization paths without storing secrets in the repository:
//   1. notarytool keychain profile (when APPLE_KEYCHAIN_PROFILE is set or stored in Keychain), or
//   2. Xcode logged-in account (`xcodebuild -exportArchive -allowProvisioningUpdates` with destination=upload).
// See docs/RELEASE.md.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const allowDirty = process.argv.includes("--allow-dirty");
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";

function fail(message) {
  console.error(`\nrelease:mac 未开始或已中止：${message}\n`);
  process.exit(1);
}

function output(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" });
}

function unregisterBundle(bundlePath) {
  if (!existsSync(LSREGISTER) || !existsSync(bundlePath)) return;
  try {
    execFileSync(LSREGISTER, ["-u", bundlePath], { stdio: "ignore" });
  } catch { /* best-effort LaunchServices cleanup */ }
}

async function run(command, args, env = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

function hasNotaryProfile(name) {
  if (!name) return false;
  try {
    execFileSync("xcrun", ["notarytool", "history", "--keychain-profile", name], { cwd: root, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function detectXcodeTeamId(identityLine) {
  if (process.env.APPLE_TEAM_ID) return process.env.APPLE_TEAM_ID;
  const fromIdentity = identityLine.match(/\(([A-Z0-9]{10})\)/u)?.[1];
  if (fromIdentity) return fromIdentity;
  try {
    const raw = output("defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeams"]);
    return raw.match(/teamID\s*=\s*"?([A-Z0-9]{10})"?;/u)?.[1] ?? null;
  } catch {
    return null;
  }
}

function isTimestampFlake(text) {
  return /A timestamp was expected but was not found|timestamp service is not available/iu.test(text);
}

// Preconditions, checked before anything is built.
if (process.platform !== "darwin" || process.arch !== "arm64") fail("第一版只发布 Apple 芯片版，请在 Apple 芯片的 Mac 上运行。");
const identities = output("security", ["find-identity", "-v", "-p", "codesigning"]);
const identityMatch = identities.match(/"(Developer ID Application: [^"]+)"/u);
if (!identityMatch) fail("钥匙串里没有 Developer ID Application 证书（security find-identity -v -p codesigning）。");
const developerId = identityMatch[1];

const requestedProfile = process.env.APPLE_KEYCHAIN_PROFILE;
let notaryMode = null;
let notaryProfile = null;
let teamId = null;

if (requestedProfile) {
  if (!hasNotaryProfile(requestedProfile)) {
    fail(`钥匙串里找不到指定的公证配置 "${requestedProfile}"。请先用 xcrun notarytool store-credentials 保存，或不设 APPLE_KEYCHAIN_PROFILE 以使用已登录的 Xcode 账号公证。`);
  }
  notaryMode = "notarytool";
  notaryProfile = requestedProfile;
} else if (hasNotaryProfile("cherrypeek")) {
  notaryMode = "notarytool";
  notaryProfile = "cherrypeek";
} else {
  teamId = detectXcodeTeamId(developerId);
  try {
    execFileSync("xcodebuild", ["-version"], { cwd: root, stdio: "pipe" });
  } catch {
    fail("未配置 notarytool 钥匙串凭据，且未安装完整 Xcode（xcodebuild 不可用）。");
  }
  if (!teamId) fail("未能从证书或 Xcode 配置识别 10 位 Apple Team ID，请设置 APPLE_TEAM_ID 或 APPLE_KEYCHAIN_PROFILE。");
  notaryMode = "xcode";
}

console.log(`签名身份：${developerId}`);
console.log(`公证通道：${notaryMode === "notarytool" ? `notarytool (${notaryProfile})` : `Xcode 已登录账号 (Team ${teamId})`}`);

// The license list is part of the app; regenerate it, then require a clean tree so the release matches a commit.
await run(process.execPath, ["scripts/third-party-licenses.mjs"]);
const dirty = output("git", ["status", "--porcelain"]).trim();
if (dirty && !allowDirty) fail(`工作区有未提交的改动（若是 THIRD_PARTY_LICENSES.md，说明依赖变了，先提交它）：\n${dirty}`);

const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const app = resolve(root, "release/mac-arm64/CherryPeek.app");
const dmg = resolve(root, `release/CherryPeek-${version}-arm64.dmg`);
const zip = resolve(root, `release/CherryPeek-${version}-arm64.zip`);

if (notaryMode === "notarytool") {
  // Build, sign and notarize the app (electron-builder staples it), and sign the DMG.
  await run(process.execPath, ["scripts/package-macos.mjs"], { COMMITSCOPE_RELEASE: "1", APPLE_KEYCHAIN_PROFILE: notaryProfile });
  // electron-builder notarizes the app inside; the DMG itself gets its own ticket so it opens cleanly when downloaded.
  await run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", notaryProfile, "--wait"]);
  await run("xcrun", ["stapler", "staple", dmg]);
} else {
  // 1. Build and Developer-ID-sign CherryPeek.app (with hardened runtime + entitlements), deferring notarization to Xcode.
  await run(process.execPath, ["scripts/package-macos.mjs", "--dir"], { COMMITSCOPE_RELEASE: "1", COMMITSCOPE_NOTARIZE: "0" });
  const work = await mkdtemp(join(tmpdir(), "cherrypeek-xcode-notarize-"));
  try {
    await writeFile(join(work, ".metadata_never_index"), "");
    const archive = join(work, "CherryPeek.xcarchive");
    const archiveApps = join(archive, "Products/Applications");
    const exportDir = join(work, "export");
    await mkdir(archiveApps, { recursive: true });
    await mkdir(join(archive, "dSYMs"), { recursive: true });
    execFileSync("/usr/bin/ditto", [app, join(archiveApps, "CherryPeek.app")]);

    const bundleId = output("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Contents/Info.plist")]).trim();
    const archivePlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ApplicationProperties</key>
  <dict>
    <key>ApplicationPath</key>
    <string>Applications/CherryPeek.app</string>
    <key>Architectures</key>
    <array>
      <string>arm64</string>
    </array>
    <key>CFBundleIdentifier</key>
    <string>${bundleId}</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
    <key>CFBundleVersion</key>
    <string>${version}</string>
    <key>SigningIdentity</key>
    <string>${developerId}</string>
    <key>Team</key>
    <string>${teamId}</string>
  </dict>
  <key>ArchiveVersion</key>
  <integer>2</integer>
  <key>CreationDate</key>
  <date>${new Date().toISOString().replace(/\.\d{3}Z$/u, "Z")}</date>
  <key>Name</key>
  <string>CherryPeek</string>
  <key>SchemeName</key>
  <string>CherryPeek</string>
</dict>
</plist>
`;
    await writeFile(join(archive, "Info.plist"), archivePlist);

    const exportOptionsPath = join(work, "ExportOptions-upload.plist");
    await writeFile(exportOptionsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>developer-id</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>${teamId}</string>
</dict>
</plist>
`);

    console.log("\n==> 通过 Xcode 已登录账号提交 Apple 公证（xcodebuild -exportArchive destination=upload）…");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await rm(exportDir, { recursive: true, force: true });
      try {
        execFileSync("xcodebuild", [
          "-exportArchive",
          "-archivePath", archive,
          "-exportPath", exportDir,
          "-exportOptionsPlist", exportOptionsPath,
          "-allowProvisioningUpdates",
        ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 << 20 });
        break;
      } catch (error) {
        const combined = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
        if (attempt < 4 && isTimestampFlake(combined)) {
          console.warn(`Apple 时间戳服务瞬时抖动（第 ${attempt}/4 次），${attempt * 20}s 后重试…`);
          await delay(attempt * 20_000);
          continue;
        }
        console.error(combined);
        throw new Error("xcodebuild -exportArchive (destination=upload) 提交公证失败");
      }
    }

    const submissionId = output("/usr/bin/plutil", ["-extract", "Distributions.0.identifier", "raw", "-o", "-", join(archive, "Info.plist")]).trim();
    const submittedApp = join(archive, "Submissions", submissionId, "CherryPeek.app");
    if (!submissionId || !existsSync(submittedApp)) {
      throw new Error(`未在 xcarchive/Submissions 下找到已提交公证的 CherryPeek.app（submissionId=${submissionId}）`);
    }
    console.log(`已提交 Apple Notary（submissionId=${submissionId}），等待公证票据签发并装订（通常 1–10 分钟）…`);

    const waitMinutes = Number(process.env.CHERRYPEEK_NOTARY_WAIT_MINUTES || "30");
    const deadline = Date.now() + waitMinutes * 60_000;
    let stapled = false;
    while (Date.now() < deadline) {
      try {
        execFileSync("xcrun", ["stapler", "staple", submittedApp], { cwd: root, stdio: "pipe" });
        stapled = true;
        break;
      } catch {
        process.stdout.write(".");
        await delay(20_000);
      }
    }
    process.stdout.write("\n");
    if (!stapled) throw new Error(`等待 ${waitMinutes} 分钟仍未拿到公证票据（submissionId=${submissionId}）`);

    await rm(app, { recursive: true, force: true });
    execFileSync("/usr/bin/ditto", [submittedApp, app]);
    unregisterBundle(join(archiveApps, "CherryPeek.app"));
    unregisterBundle(submittedApp);

    // Build DMG and ZIP directly from the notarized+stapled CherryPeek.app without modifying a single byte inside .app.
    const dmgStage = join(work, "dmg-stage");
    await mkdir(dmgStage, { recursive: true });
    execFileSync("/usr/bin/ditto", [app, join(dmgStage, "CherryPeek.app")]);
    execFileSync("/bin/ln", ["-s", "/Applications", join(dmgStage, "Applications")]);
    const stageKb = Number(output("/usr/bin/du", ["-sk", dmgStage]).trim().split(/\s+/u)[0]);
    const sizeMb = Math.ceil((stageKb * 1.25) / 1024) + 64;
    await rm(dmg, { force: true });
    await run("/usr/bin/hdiutil", [
      "create", "-size", `${sizeMb}m`,
      "-volname", `CherryPeek ${version}`,
      "-srcfolder", dmgStage,
      "-ov", "-format", "UDZO",
      dmg,
    ]);
    unregisterBundle(join(dmgStage, "CherryPeek.app"));
    await run("codesign", ["--force", "--timestamp", "--sign", developerId, dmg]);

    await rm(zip, { force: true });
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Check what a downloading user's Mac will check.
await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
await run("xcrun", ["stapler", "validate", app]);
await run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
await run("codesign", ["--verify", "--verbose=2", dmg]);
if (notaryMode === "notarytool") {
  await run("xcrun", ["stapler", "validate", dmg]);
  await run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmg]);
}

const sums = [];
for (const file of [dmg, zip]) {
  const info = await stat(file);
  if (info.size <= 0) throw new Error(`产物为空：${file}`);
  const hash = createHash("sha256").update(await readFile(file)).digest("hex");
  sums.push(`${hash}  ${file.split("/").at(-1)}`);
}
const sumsFile = resolve(root, `release/CherryPeek-${version}-arm64.sha256`);
await writeFile(sumsFile, `${sums.join("\n")}\n`);

console.log(`\n已签名、公证并通过 Gatekeeper 检查：\n  ${dmg}\n  ${zip}\n  ${sumsFile}\n`);
console.log(`上传到 GitHub Release（先推送提交和标签 v${version}）：`);
console.log(`  git tag v${version} && git push origin v${version}`);
console.log(`  gh release create v${version} "${dmg}" "${zip}" "${sumsFile}" --title "CherryPeek ${version}" --notes-file docs/releases/v${version}.md`);
