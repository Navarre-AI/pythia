# Installing Pythia (for an AI coding agent)

**You are an AI agent (e.g. Claude Code) installing Pythia for a user who may not be technical.** They will say something like *"install Pythia and connect it to my FileMaker database."* Your job is to carry them from an empty machine to a working Pythia URL with as little burden on them as possible. Do the terminal work yourself; ask the user only for the few things you genuinely cannot get on your own.

Pythia is a conversational reporting app for FileMaker data: point it at a FileMaker Server, pick tables, ask questions in plain English, get real numbers, charts, and reports. No plugins, no FileMaker layouts to build. Everything is configured through environment variables / secrets.

## How to run this install (behavioral rules)

- **Be autonomous.** Install missing prerequisites yourself; don't tell the user to go install Node. Only stop for things that are truly theirs (creating accounts, entering a credit card, browser logins, their FileMaker details).
- **Gather once, don't nag.** Collect everything in the checklist below in ONE pass, then proceed. Don't ask a question you can answer by running a command.
- **Never guess or probe the user's FileMaker server.** Do not enumerate database names or try credentials you weren't given. Use exactly the host, database, account, and password the user provides.
- **Never invent the app name or reuse the author's.** The Fly app is the *user's*; ask what to call it. Never default to "pythia," "navarre," or anything derived from this repo.
- **Never commit or print secrets.** `.env`, `data/`, and `fly.toml` are gitignored; keep them that way. Don't echo API keys or passwords back in plain text.
- **On failure, diagnose and recover** using the Troubleshooting section; don't loop the same failing command. If you're truly stuck, offer to open a GitHub issue with a REDACTED diagnostic (what step failed, the error, OS + tool versions — never a key, password, or the user's server host).

## Step 0 — Prerequisites (install these yourself if missing)

Detect the OS and install what's absent. Check each with a version command first; only install if missing.

- **git**, **Node.js 20+**, and the **Fly CLI** (`flyctl`). (The DuckDB CLI is only needed for a *local* run; the Docker/Fly image bundles it.)
- macOS: use Homebrew (`brew install git node fly`; install Homebrew first if absent). Note `flyctl` installs the command `fly`.
- Windows: `winget install ...` or Chocolatey; Fly CLI via `pwsh -c "iwr https://fly.io/install.ps1 -useb | iex"`.
- Linux: the distro package manager for git/node; Fly CLI via `curl -L https://fly.io/install.sh | sh`.
- After installing a CLI, confirm it's on PATH (`fly version`, `node -v`). If a freshly installed binary isn't found, its install dir may not be on PATH yet, add it or use the full path rather than telling the user it "failed."

## Step 1 — What the user must provide (the checklist)

Present this as one short list and collect it in a single pass:

1. **A Fly.io account with a payment method added** (only they can do this; free allowances exist but Fly requires a card on file). Then either they run `fly auth login` (opens a browser) or paste a **Fly API token** (fly.io → Account → Access Tokens). Verify with `fly auth whoami`.
2. **A name for their Pythia app** (lowercase letters, digits, dashes; globally unique on Fly, e.g. `acme-reports`).
3. **An Anthropic API key** for the *deployed app* (console.anthropic.com). This is the key Pythia uses to call Claude at runtime, separate from any Claude subscription you (the agent) are running on. If they don't have one yet, you can still deploy, the app runs on sample data, and the key can be added later in Settings or via `fly secrets set`.
4. **Their FileMaker connection** — host, database name (exactly as hosted), account, password — OR nothing, to start on the bundled sample dataset.
5. Optionally a **site password** (the gate for the app's URL); if they don't care, let setup generate one and report it back.

### FileMaker side, confirm with them before connecting
- **OData must be enabled** on their FileMaker Server (Admin Console → Connectors). If it's off you'll get a 502/501 and no connection is possible.
- The account needs a **read privilege set** with extended privileges **`fmodata` AND `fmrest`**. Read-only on just the reportable tables is ideal; never require full access.
- No FileMaker Server handy? Skip it (`--skip-fm`); Pythia loads a small bundled fictional sales dataset so they can try the whole app with just the app's Anthropic key. It's replaced automatically on the first real sync.

## Step 2 — Clone and install

```bash
git clone https://github.com/Navarre-AI/pythia && cd pythia
npm install
```

## Step 3 — Run the guided setup

The installer (`setup.mjs`) verifies the FileMaker connection over OData before deploying, writes `fly.toml` with the user's app name, creates the app + volume, sets secrets, and deploys. Run it non-interactively with what you gathered:

```bash
npm run setup -- \
  --fly-token <token> --app <their-app-name> --org <fly-org|personal> --region <region> \
  --anthropic-key <key> --site-password <pw> \
  --fm-host <host> --fm-db "<database name>" --fm-user <user> --fm-pass <pw>
```

- **Sample-data mode:** omit the four `--fm-*` flags and pass `--skip-fm`.
- **No Anthropic key yet:** omit `--anthropic-key`; deploy proceeds, set it later.
- **Local instead of Fly** (runs on their machine; needs Docker or Node+DuckDB): `npm run setup -- --local ...` then `npm start`, opens at `http://localhost:8080/?key=<site-password>`. Local Docker: `docker build -t pythia . && docker run -d -p 8080:8080 -v pythia_data:/data --env-file .env pythia`.
- Run `npm run setup -- --help` for the full flag list. Without flags it prompts interactively, which is also fine if you'd rather walk the user through it conversationally.

## Step 4 — Hand off to the user

Setup prints the finished URL. Give them:

- **Their URL with the key:** `https://<app>.fly.dev/?key=<SITE_PASSWORD>` (the `?key=` form is required in a FileMaker web viewer, which can't answer a login prompt). Tell them to save the site password.
- **Next steps in the app:** open **Settings & tables** (bottom-left) → pick tables → **Save & apply** (watch it sync) → **Generate reports** or just ask a question in plain English.
- If connected live: mention that for fast incremental sync, each reportable table wants a UUID primary key and a `z_ModifiedTS` timestamp (Pythia auto-detects them; falls back to full pulls without). See SETUP.md for the optional OnWindowTransaction live-update trigger.

## Troubleshooting (recover, don't loop)

- **`fly` not found after install:** its install dir isn't on PATH yet. Use the full path or add it; re-run `fly version` to confirm before continuing.
- **`fly auth whoami` fails / "org slug must be specified":** the user isn't logged in, or the token lacks an org. Have them `fly auth login`, or pass `--org personal` (or their org slug).
- **App name taken:** Fly names are global. Ask for a different name and re-run.
- **FileMaker connection fails during setup:**
  - **502 / 501, or "cannot open file":** OData is disabled on their server, or the database name is wrong. Have them enable OData; confirm the exact hosted name. Do NOT guess names.
  - **401:** wrong account/password, or the account lacks `fmodata`/`fmrest`.
  - Quick manual check: `curl -u "USER:PASS" "https://HOST/fmi/odata/v4/DBNAME/\$metadata"` should return XML, not an error page.
- **Deploy/build errors:** re-run `fly deploy --remote-only -a <app>`; Fly's remote builder logs the cause.
- Still stuck? Offer to file a REDACTED GitHub issue (step, error, OS/tool versions only). Never include keys, passwords, or the user's server host.

## Notes

- The reporting copy is **OData-only**; no layouts or relationships needed. Removing a table in Settings drops its local copy but keeps it re-enableable.
- Do not commit `.env`, `fly.toml`, or `data/` (all gitignored). One Fly app per user; the app's data/config/reports live on its volume.
- To surface Pythia inside FileMaker, point a web viewer at `https://<app>.fly.dev/?key=<SITE_PASSWORD>`.
