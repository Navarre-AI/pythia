// setup.mjs — guided installer. `npm run setup`
// Walks a new user from a fresh clone to a running Pythia: their own app name
// (never a default), their keys, optionally their FileMaker connection (skip it
// to play with the bundled sample data), then local run or Fly deploy.
// Zero dependencies. Non-interactive use: pass flags (see USAGE below).

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import readline from "readline/promises";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `
Usage: npm run setup [-- flags]

Flags (all optional; anything missing is asked interactively):
  --local                 run locally instead of deploying to Fly
  --fly-token <token>     Fly API token (else uses your fly login / prompts ONCE)
  --app <name>            Fly app name (yours, globally unique)
  --region <code>         Fly region (e.g. iad, ams, syd)
  --anthropic-key <key>   Anthropic API key
  --site-password <pw>    site password (omit to auto-generate)
  --fm-host <host>        FileMaker Server host (omit all fm-* for sample mode)
  --fm-db <name>          database name
  --fm-user <user>        account name
  --fm-pass <pw>          account password
  --skip-fm               explicitly skip FileMaker (sample mode)
  --dry-run               print the fly commands instead of running them
`;

const args = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--help" || a[i] === "-h") { console.log(USAGE); process.exit(0); }
    if (!a[i].startsWith("--")) continue;
    const key = a[i].slice(2);
    if (["local", "skip-fm", "dry-run"].includes(key)) args[key] = true;
    else args[key] = a[++i];
  }
}

// Input: a buffered line queue instead of rl.question, so piped answers
// (echo "..." | npm run setup) work as well as a live terminal — lines that
// arrive between questions queue up rather than being dropped.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const CLOSED = Symbol("stdin-closed");
const lineQueue = [];
let lineWaiter = null, stdinClosed = false;
rl.on("line", (l) => { if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); } else lineQueue.push(l); });
rl.on("close", () => { stdinClosed = true; if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(CLOSED); } });
function nextLine() {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (stdinClosed) return Promise.resolve(CLOSED);
  return new Promise((res) => { lineWaiter = res; });
}
async function ask(q, { def = "", required = false, secret = false } = {}) {
  for (;;) {
    const suffix = def ? ` [${def}]` : "";
    process.stdout.write(`${q}${suffix}: `);
    const answer = await nextLine();
    if (answer === CLOSED) {
      // Non-interactive (piped/EOF): optional questions fall back to their
      // default; only a truly required missing answer is fatal.
      if (!required) { console.log(def ? `(auto) ${def}` : "(auto: default)"); return def; }
      console.log("\nInput ended before setup finished. Re-run interactively, or pass flags (npm run setup -- --help).");
      process.exit(1);
    }
    const v = String(answer).trim() || def;
    if (v || !required) return v;
    console.log("  (required)");
  }
}
const say = (s) => console.log(s);

function fly(argv, { capture = false } = {}) {
  if (args["dry-run"]) { say(`  [dry-run] fly ${argv.join(" ")}`); return { status: 0, stdout: "" }; }
  const r = spawnSync("fly", argv, capture ? { encoding: "utf8" } : { stdio: "inherit" });
  return { status: r.status, stdout: r.stdout || "" };
}

async function checkFm(host, db, user, pass) {
  try {
    const res = await fetch(`https://${host}/fmi/odata/v4/${encodeURIComponent(db)}/$metadata`, {
      headers: { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"), Accept: "*/*" },
      signal: AbortSignal.timeout(15000),
    });
    return res.ok ? null : `HTTP ${res.status} from the OData endpoint`;
  } catch (e) { return String(e.message || e); }
}

say("");
say("Pythia setup: ask a question, get a report.");
say("This walks you through your own install. Nothing here is shared with anyone.");
say("");

// --- Gather ------------------------------------------------------------------

const local = args.local ? true
  : args.app ? false // an app name was given, so it's a Fly deploy; don't ask
  : (await ask("Deploy to Fly.io, or run locally? (fly/local)", { def: "fly" })).toLowerCase().startsWith("l");

// --- Fly account first (fly mode). One gate, up front, exactly once. ---------
// A pasted token goes into process.env.FLY_API_TOKEN, which every fly command
// in this run inherits — you will never be asked twice.
if (!local && !args["dry-run"]) {
  const v = spawnSync("fly", ["version"], { encoding: "utf8" });
  if (v.status !== 0) {
    say("\nThe Fly CLI isn't installed. Install it first:");
    say("  macOS/Linux:  curl -L https://fly.io/install.sh | sh");
    say("  (docs: https://fly.io/docs/flyctl/install/)");
    say("Then re-run:  npm run setup");
    process.exit(1);
  }
  if (args["fly-token"]) process.env.FLY_API_TOKEN = args["fly-token"];
  for (;;) {
    const who = spawnSync("fly", ["auth", "whoami"], { encoding: "utf8" });
    if (who.status === 0) { say(`✓ Fly account: ${(who.stdout || "").trim()}`); break; }
    say("\nYou need a Fly.io account (free tier is fine): https://fly.io/app/sign-up");
    const token = await ask("Paste a Fly API token (fly.io > Account > Access Tokens), or press Enter to log in via browser");
    if (token) { process.env.FLY_API_TOKEN = token; continue; }
    const login = spawnSync("fly", ["auth", "login"], { stdio: "inherit" });
    if (login.status !== 0) say("  Login didn't complete; let's try again.");
  }
}

let appName = "";
if (!local) {
  // The app name is the user's own. Deliberately no default: this is THEIR app.
  appName = args.app || "";
  for (;;) {
    if (!appName) appName = await ask("Name for YOUR Fly app (lowercase letters, digits, dashes; e.g. acme-reports)", { required: true });
    if (/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(appName)) break;
    say("  That name won't work on Fly. Use 3-30 lowercase letters, digits, or dashes.");
    appName = "";
  }
}
const region = local ? "" : (args.region || (await ask("Fly region (run `fly platform regions` to list)", { def: "iad" })));

const anthropicKey = args["anthropic-key"] || (await ask("Anthropic API key (console.anthropic.com; Enter to add later)", { secret: true }));
if (!anthropicKey) say("  OK — the app will run, but AI answers need ANTHROPIC_API_KEY set later.");

let sitePassword = args["site-password"] || (await ask("Site password (Enter to generate one)"));
if (!sitePassword) { sitePassword = crypto.randomBytes(8).toString("hex"); say(`  Generated site password: ${sitePassword}  (save this)`); }

let fm = null;
if (!args["skip-fm"]) {
  const wantFm = args["fm-host"] ? "y" : (await ask("Connect your FileMaker Server now? (y/N; Enter to start with the bundled sample data)", { def: "n" })).toLowerCase();
  if (wantFm.startsWith("y") || args["fm-host"]) {
    for (;;) {
      const host = args["fm-host"] || (await ask("  FileMaker Server host (e.g. fms.example.com)", { required: true }));
      const db = args["fm-db"] || (await ask("  Database name (as it appears on the server)", { required: true }));
      const user = args["fm-user"] || (await ask("  Account name (read access + fmodata/fmrest privileges)", { required: true }));
      const pass = args["fm-pass"] || (await ask("  Account password", { required: true, secret: true }));
      say("  Checking the connection (OData $metadata)…");
      const err = await checkFm(host, db, user, pass);
      if (!err) { say("  ✓ Connected."); fm = { host, db, user, pass }; break; }
      say(`  ✗ Could not connect: ${err}`);
      say("    Check: OData enabled on the server, exact database name, account privileges.");
      const again = (await ask("  Try again? (y/N; N continues with sample data)", { def: "n" })).toLowerCase();
      if (!again.startsWith("y")) break;
      delete args["fm-host"]; delete args["fm-db"]; delete args["fm-user"]; delete args["fm-pass"];
    }
  }
}

// --- Apply -------------------------------------------------------------------

if (local) {
  const lines = [
    "# Written by setup.mjs (local dev configuration). Never commit this file.",
    anthropicKey ? `ANTHROPIC_API_KEY=${anthropicKey}` : "# ANTHROPIC_API_KEY=",
    `SITE_PASSWORD=${sitePassword}`,
    ...(fm ? [`FM_HOST=${fm.host}`, `FM_DB="${fm.db}"`, `FM_USER=${fm.user}`, `FM_PASS=${fm.pass}`] : ["# FM_* unset: bundled sample data loads on first run"]),
  ];
  fs.writeFileSync(path.join(__dirname, ".env"), lines.join("\n") + "\n");
  say("");
  say("✓ Wrote .env");
  say("Run:  npm start");
  say(`Then open:  http://localhost:8080/?key=${sitePassword}`);
} else {
  const template = fs.readFileSync(path.join(__dirname, "fly.template.toml"), "utf8");
  fs.writeFileSync(path.join(__dirname, "fly.toml"), template.replace("{{APP_NAME}}", appName).replace("{{REGION}}", region));
  say(`\n✓ Wrote fly.toml for app "${appName}" (${region})`);

  say(`\nCreating the app…`);
  if (fly(["apps", "create", appName]).status !== 0) { say(`\nCouldn't create "${appName}" (name taken, or not logged in). Re-run setup with a different name.`); process.exit(1); }

  say("Creating the data volume…");
  if (fly(["volumes", "create", "pythia_data", "--app", appName, "--region", region, "--size", "1", "--yes"]).status !== 0) process.exit(1);

  say("Setting secrets…");
  const secrets = [`SITE_PASSWORD=${sitePassword}`];
  if (anthropicKey) secrets.push(`ANTHROPIC_API_KEY=${anthropicKey}`);
  if (fm) secrets.push(`FM_HOST=${fm.host}`, `FM_DB=${fm.db}`, `FM_USER=${fm.user}`, `FM_PASS=${fm.pass}`);
  if (fly(["secrets", "set", "--app", appName, "--stage", ...secrets]).status !== 0) process.exit(1);

  say("Deploying (first build takes a few minutes)…");
  if (fly(["deploy", "--remote-only", "--app", appName]).status !== 0) process.exit(1);
  fly(["scale", "count", "1", "--app", appName]);

  say("");
  say("✓ Done.");
  say(`Open:  https://${appName}.fly.dev/?key=${sitePassword}`);
  say(fm
    ? "Next: open Settings & tables (bottom left), pick your tables, Save & apply."
    : "You're on the bundled sample data. Connect your own database any time: set the FM_* secrets (fly secrets set) and hit Reset in Settings.");
}
rl.close();
