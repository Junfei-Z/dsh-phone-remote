// Regenerate cordis.patch.yml from lib/models.mjs. `--check` fails instead of
// writing when the committed file is stale (used by CI and the test suite).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renderPatch } from "../lib/patch.mjs";

const target = fileURLToPath(new URL("../cordis.patch.yml", import.meta.url));
const next = renderPatch();
const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";

if (process.argv.includes("--check")) {
  if (current !== next) {
    console.error("cordis.patch.yml is stale; run `npm run gen` and commit the result.");
    process.exit(1);
  }
  console.log("cordis.patch.yml is up to date.");
} else if (current !== next) {
  fs.writeFileSync(target, next);
  console.log("cordis.patch.yml regenerated.");
} else {
  console.log("cordis.patch.yml already up to date.");
}
