# Pythia

**Ask a question. Get a report.**

Pythia (the oracle at Delphi) is a conversational reporting app for FileMaker databases. Point it at any FileMaker Server file, pick the tables to report on, and ask questions in plain English. It answers with real numbers, charts, and printable reports. No layouts to build, no relationships required, no plugins.

It is general-purpose by design: nothing about your schema is baked in. Pythia reads the connected database's structure at runtime, an AI ranks which tables matter, the landing dashboard is designed by the AI for *your* data, and the starter reports are generated from *your* schema.

Sibling of [Hecate](https://github.com/Navarre-AI/hecate), the intake gatekeeper. Where Hecate scopes a request and hands it to a downstream worker, Pythia does the whole job herself.

## The two rules

1. **FileMaker is the source of truth. The numbers come from your data, not the model.**
   The model never writes numbers into an answer or report. It chooses which query feeds which chart; the server runs the SQL and injects the real rows verbatim.

2. **You never see the plumbing.**
   No SQL, no table names, no UUIDs or internal keys ever reach the screen. Rows are identified by their human labels; answers are plain business English. (`RULES.md` is the living rulebook.)

## How it works

Express + vanilla HTML/JS, one npm dependency, no SDKs. Pythia pulls your chosen tables over **OData** into a local **DuckDB** copy (the cube) on a persistent volume. Questions run against that copy, so answers are fast and your server isn't hammered. Freshness comes from **incremental mod-date sync**: with a UUID primary key and a `z_ModifiedTS` field on each table, only changed rows are pulled. Optionally, a FileMaker **OnWindowTransaction** trigger can notify Pythia the moment records change, so the copy follows the live file in near real time.

On top of that sits a Claude tool-use loop with two tools (`query_data`, `present`), AI-generated saved reports (each proposed SQL is validated by actually running it), an AI-designed overview dashboard, and printable HTML report rendering with inline SVG charts.

## Running it

```bash
git clone https://github.com/Navarre-AI/pythia && cd pythia
npm install
npm run setup
```

The guided setup asks for everything up front, once: your Fly.io account (browser login or a pasted token), **your own app name** (this is your install, name it whatever you like), your Anthropic key, a site password (or it generates one), and optionally your FileMaker Server connection, which it verifies before deploying. Skip the FileMaker questions to start on the bundled sample data. It can also just write a local `.env` instead of deploying (`npm run setup -- --local`), then `npm start`.

Requires Node 20+ and the DuckDB CLI on PATH (`brew install duckdb`; the Docker image bundles it).

**No FileMaker Server handy?** Leave the `FM_*` variables unset and Pythia loads a small bundled fictional sales dataset (about a thousand invoices), so you can try the chat, the AI overview, and report generation with nothing but an Anthropic key. The moment you connect a real database and sync, the sample is replaced automatically.

Production is Docker + Fly.io; see `SETUP.md` for the FileMaker Server side (enable OData, one read-access account) and the deploy steps. `AGENTS.md` is the same recipe written for an AI coding agent, so "install Pythia and connect it to my database" works as a one-line request to Claude Code.

## Configuration

Everything is environment variables; see `.env.example`. No credentials live in code. The synced data, table selection, reports, and conversations all live in the gitignored `data/` directory (a mounted volume in production).
