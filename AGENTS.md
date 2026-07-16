# Installing Pythia (for an AI coding agent)

Pythia is a conversational reporting app for FileMaker data. A user will ask you to "install Pythia and connect it to my database." Follow this recipe. Keep it light: there are no plugins and no FileMaker-side layouts to build. Everything is environment variables.

## What Pythia needs

- **Node.js 20+** and **git**.
- The **DuckDB CLI** on PATH (`brew install duckdb`, or it is bundled in the Docker image).
- An **Anthropic API key** (Pythia uses Claude; env `ANTHROPIC_API_KEY`).
- The user's **FileMaker Server** with **OData enabled** and a **read-only account** (extended privileges `fmodata` AND `fmrest`). No layouts required.
- No FileMaker Server handy? Leave the `FM_*` variables unset and Pythia loads a small bundled fictional sales dataset, so the user can try everything with just the AI key. It is replaced automatically on the first real sync.
- Deployment target: **Fly.io** (Docker + fly.toml are included). Local `npm start` also works for trying it.

## Steps

1. **Clone + install**
   ```bash
   git clone https://github.com/Navarre-AI/pythia && cd pythia
   npm install
   ```

2. **Gather from the user, up front, ONCE** (do not ask repeatedly):
   - Their **Fly.io API token** (fly.io > Account > Access Tokens), unless `fly auth whoami` already succeeds.
   - **Their app name.** It is THEIR app: ask them what to call it. Never default to "pythia" or anything derived from this repo's author.
   - Their **Anthropic API key**; a **site password** (or generate one).
   - Their **FileMaker connection** (host, database, account, password) — or skip it to start on the bundled sample data. Never guess or enumerate database names on their server; use exactly what the user gives you.

3. **Run the guided setup non-interactively** (it verifies the FM connection over OData, writes fly.toml with their app name, creates the app + volume, sets secrets, deploys):
   ```bash
   npm run setup -- --fly-token <token> --app <their-app-name> --region <region> \
     --anthropic-key <key> --site-password <pw> \
     --fm-host <host> --fm-db <db> --fm-user <user> --fm-pass <pw>
   ```
   Omit the four `--fm-*` flags and pass `--skip-fm` for sample mode. For a local install instead of Fly: `npm run setup -- --local ...` then `npm start`.

4. **First run in the browser** (`https://<app>.fly.dev/?key=<SITE_PASSWORD>`)
   - Open **Settings & tables** (bottom-left), pick the tables to report on, click **Save & apply**. Watch the per-table sync progress.
   - Click **Generate reports from my data** to have Pythia design a starter set of reports for this specific database.
   - Ask a question in plain English. Done.

## Notes

- The reporting copy is **OData-only**; no layouts or relationships are needed.
- Removing a table in Settings drops its local copy but keeps it available to re-enable.
- To surface Pythia inside FileMaker, point a web viewer at `https://<app>.fly.dev/?key=<SITE_PASSWORD>`.
- Do not commit `.env` or the `data/` folder (both gitignored).
- For fast incremental sync, each reportable table should have a UUID primary key and a `z_ModifiedTS` modification timestamp (see SETUP.md); Pythia detects them automatically and falls back to full pulls without them.
