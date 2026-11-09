/**
 * Two modes. By default (`pnpm package:mac`) an ad-hoc signed build for trying the app on this Mac. With
 * COMMITSCOPE_RELEASE=1 (`pnpm release:mac`) a public build: signed with the Developer ID Application certificate
 * in the login keychain (or CSC_NAME), hardened runtime, and notarized with the notarytool keychain profile named
 * by APPLE_KEYCHAIN_PROFILE. See docs/RELEASE.md.
 */
const { dirname, join } = require("node:path");

const release = process.env.COMMITSCOPE_RELEASE === "1";
const electronDist = join(dirname(require.resolve("electron/package.json")), "dist");

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "io.github.watsonhs.cherrypeek",
  productName: "CherryPeek",
  directories: {
    app: "apps/desktop/dist",
    output: "release",
  },
  asar: true,
  files: ["main/**", "preload.cjs", "renderer/**", "package.json"],
  extraResources: [
    { from: "apps/desktop/dist/resources/commitscope-daemon", to: "commitscope-daemon" },
    { from: "LICENSE", to: "LICENSE" },
    { from: "THIRD_PARTY_LICENSES.md", to: "THIRD_PARTY_LICENSES.md" },
    { from: join(electronDist, "LICENSES.chromium.html"), to: "LICENSES.chromium.html" },
  ],
  npmRebuild: false,
  publish: null,
  artifactName: "${productName}-${version}-${arch}.${ext}",
  mac: release ? {
    category: "public.app-category.developer-tools",
    minimumSystemVersion: "12.0",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: true,
    target: ["dmg", "zip"],
  } : {
    category: "public.app-category.developer-tools",
    identity: "-",
    hardenedRuntime: false,
    notarize: false,
    target: ["dmg"],
  },
  dmg: { title: "CherryPeek ${version}", sign: release },
};
