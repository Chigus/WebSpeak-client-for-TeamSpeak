import { cp, mkdir, readdir, copyFile, stat, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobileDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(mobileDir, "..");
const webDist = path.join(rootDir, "web", "dist");
const outputDir = path.join(webDist, "nodejs");

for (const required of [path.join(rootDir, "dist", "mobile", "index.js"), path.join(mobileDir, "node_modules"), path.join(webDist, "index.html")]) {
  if (!(await stat(required).catch(() => null))) throw new Error(`Missing Android build input: ${required}`);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(path.join(outputDir, "www"), { recursive: true });
await cp(path.join(rootDir, "dist"), path.join(outputDir, "dist"), { recursive: true, force: true });
await cp(path.join(mobileDir, "node_modules"), path.join(outputDir, "node_modules"), { recursive: true, force: true });
await copyFile(path.join(mobileDir, "index.cjs"), path.join(outputDir, "index.cjs"));
const appPackage = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const mobilePackage = JSON.parse(await readFile(path.join(mobileDir, "package.json"), "utf8"));
mobilePackage.version = appPackage.version;
await writeFile(path.join(outputDir, "package.json"), `${JSON.stringify(mobilePackage, null, 2)}\n`);

for (const entry of await readdir(webDist, { withFileTypes: true })) {
  if (entry.name === "nodejs") continue;
  await cp(path.join(webDist, entry.name), path.join(outputDir, "www", entry.name), { recursive: entry.isDirectory(), force: true });
}

console.log(`Android gateway assets prepared at ${outputDir}`);
