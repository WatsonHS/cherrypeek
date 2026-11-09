/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "app.commitscope.desktop",
  productName: "CommitScope",
  directories: {
    app: "apps/desktop/dist",
    output: "release",
  },
  asar: true,
  files: ["main/**", "preload.cjs", "renderer/**", "package.json"],
  extraResources: [
    { from: "apps/desktop/dist/resources/commitscope-daemon", to: "commitscope-daemon" },
  ],
  npmRebuild: false,
  publish: null,
  artifactName: "${productName}-${version}-${arch}.${ext}",
  mac: {
    category: "public.app-category.developer-tools",
    identity: "-",
    hardenedRuntime: false,
    notarize: false,
    target: ["dmg"],
  },
  dmg: { title: "CommitScope ${version}", sign: false },
};
