// Writes extension/dist/THIRD-PARTY-LICENSES.txt: the licence files of every
// npm package esbuild bundled into background.js, read from its metafile.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const fallbackDir = join(import.meta.dirname, "licenses");
const [metaPath, outPath] = process.argv.slice(2);
const meta = JSON.parse(await readFile(metaPath, "utf8"));

const marker = "node_modules/";
const dirs = new Set();
for (const input of Object.keys(meta.inputs)) {
  const at = input.lastIndexOf(marker);
  if (at === -1) {
    continue;
  }
  const parts = input.slice(at + marker.length).split("/");
  const name = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  dirs.add(input.slice(0, at + marker.length) + name);
}

const sections = [];
const missing = [];
for (const dir of [...dirs].sort()) {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  let files = (await readdir(dir))
    .filter(file => /^(licen[sc]e|copying|notice)/i.test(file))
    .sort()
    .map(file => join(dir, file));
  if (!files.length) {
    // Packages that publish no licence file get one from scripts/licenses/,
    // copied by hand from the package's source repository.
    const fallback = join(fallbackDir, `${pkg.name.replace("/", "__")}.txt`);
    if (!existsSync(fallback)) {
      missing.push(pkg.name);
      continue;
    }
    files = [fallback];
  }
  const texts = await Promise.all(files.map(file => readFile(file, "utf8")));
  sections.push(
    `${pkg.name} ${pkg.version} (${pkg.license})\n\n` +
      texts.map(text => text.trim()).join("\n\n")
  );
}

if (missing.length) {
  console.error(`No licence file found for: ${missing.join(", ")}`);
  process.exit(1);
}

const rule = `\n\n${"-".repeat(72)}\n\n`;
await writeFile(
  outPath,
  "background.js bundles the following third-party packages.\n" +
    "Each is distributed under the licence reproduced below it." +
    rule +
    sections.join(rule) +
    "\n"
);
console.log(`Wrote ${sections.length} licences to ${outPath}`);
