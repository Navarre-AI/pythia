// env.js — load .env with OVERRIDE semantics, no dependency.
// Why override: dev machines in this ecosystem export ambient FM_* vars
// (the Comm Station shell profile: FM_USER=Clawdia etc). Node's --env-file
// refuses to override those, so Pythia would silently connect as the wrong
// account. A .env file sitting in this repo is the more specific intent;
// it wins. In production (Fly) there is no .env file and secrets flow
// through the environment untouched.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith("#")) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[m[1]] = val;
  }
}
