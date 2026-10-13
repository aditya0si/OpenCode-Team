import { buildSite, defaultPaths } from "./build.mjs";

export default async function globalSetup() {
  const emitted = await buildSite(defaultPaths());
  console.log(`[global-setup] built ${emitted.length} files`);
}
