# Pointing Pythia at your FileMaker Server

Pythia is read-only and OData-first. The FileMaker side is small: enable one connector, make one scoped account, build the map.

## 1. Enable OData

Admin Console > Connectors: enable **OData** and the **FileMaker Data API** for the file. Pythia uses both: OData for the schema map and sync pulls, the Data API for script execution, containers, and layout-scoped reads.

Confirm reachability:

```bash
curl -u user:pass "https://HOST/fmi/odata/v4/DBNAME/\$metadata"
```

DB names with spaces get URL-encoded.

## 2. Scoped read-only account

Create one account for Pythia:

- Privilege set: **read-only** access to the tables you want reportable. Not full access, ever.
- Extended privilege: `fmodata` and `fmrest`.
- Keep it separate from any human admin account.

What the account cannot see, Pythia cannot report on. That's the security boundary.

## 3. (Recommended) Sync fields on each table

For fast incremental sync, give each reportable table two fields:

- A **UUID primary key** (auto-enter `Get(UUID)`).
- A **`z_ModifiedTS`** modification timestamp (auto-enter, modify).

Pythia detects them automatically. Without them it still works, it just falls back to full-table pulls instead of pulling only changed rows.

## 4. Deploy to Fly

The easy way (asks for your Fly account once, your own app name, keys, and optionally the FileMaker connection, then does everything):

```bash
npm run setup
```

Or by hand, picking your own app name (the examples use `my-reports`):

```bash
fly apps create my-reports
cp fly.template.toml fly.toml    # then set app = "my-reports" and your region
fly volumes create pythia_data --region <region> --size 1 -a my-reports
fly secrets set -a my-reports \
  ANTHROPIC_API_KEY=... SITE_PASSWORD=... \
  FM_HOST=host FM_DB="YourDB" FM_USER=pythia FM_PASS=...
fly deploy --remote-only -a my-reports
fly scale count 1 -a my-reports   # single instance: the local copy lives on one volume
```

## 5. Surface it in FileMaker (optional)

A web viewer pointed at `https://my-reports.fly.dev/?key=<SITE_PASSWORD>`. The `?key=` gate exists because a web viewer cannot answer a Basic-auth prompt.

## 6. Live updates via OnWindowTransaction (optional)

Without this, the local copy refreshes when you click Save & apply (incremental, so it's fast). With it, FileMaker itself tells Pythia the moment records are committed, and the copy follows the live file within seconds — including deletes. Skip it entirely for static data.

Requires FileMaker 20.1 (2023) or later. Reference: [OnWindowTransaction trigger](https://help.claris.com/en/pro-help/content/onwindowtransaction.html).

1. **One script** (e.g. "Notify Pythia"): a single `Insert from URL` step that POSTs the trigger's JSON to Pythia. URL: `https://my-reports.fly.dev/api/notify?key=<SITE_PASSWORD>`. cURL options: `-X POST` with header `Content-Type: application/json` and the script parameter (`Get ( ScriptParameter )`) as the body. Pythia answers instantly and processes in the background.
2. **File Options > Script Triggers > OnWindowTransaction**: point it at that script.
3. **Per-table opt-in**: give each table you want live a field named `OnWindowTransaction` (or set a custom field name in File Options) — an unstored calculation that returns the table's **UUID primary key**. Only tables with this field are included in the trigger's payload, and the UUID is what lets Pythia remove deleted records from the copy (a delete has no row left to sync).

Pythia's notify endpoint only acts on tables you selected in Settings; anything else in the payload is ignored. New/Modified records trigger an incremental sync of just that table; Deleted records are removed by UUID.

## Quick checklist

- [ ] OData enabled for the file
- [ ] Scoped read-only account with `fmodata`
- [ ] UUID + `z_ModifiedTS` fields on the reportable tables (recommended)
- [ ] Fly app deployed, secrets set, volume created, scaled to 1
- [ ] Web viewer loads with `?key=`
