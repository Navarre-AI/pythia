// cube.js — the local SQL copy ("cube") of the shadowed FileMaker data.
// Bones version: pull each included base table over OData, land it in a DuckDB
// file. Query via the duckdb CLI (no native module to fight during early dev;
// swap for @duckdb/node-api later if we want in-process). SELECT-only guard on
// the query path. Everything here is deliberately loose — we expect churn.

import "./env.js";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { fetchAllRows } from "./fm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const CUBE_DIR = path.join(DATA_DIR, "cube");
const DB_PATH = process.env.DUCKDB_PATH || path.join(DATA_DIR, "pythia.duckdb");
const DUCKDB = process.env.DUCKDB_BIN || "duckdb";
fs.mkdirSync(CUBE_DIR, { recursive: true });

const q = (id) => `"${String(id).replace(/"/g, '""')}"`; // quote a SQL identifier

// Each sql() shells out to a fresh duckdb process. A write process holds an
// EXCLUSIVE lock on the file that blocks any concurrent reader ("Conflicting
// lock" error) — e.g. a status/overview read landing during a multi-table sync.
// Serialize all invocations through one in-process queue so, on a single
// instance, two duckdb processes never touch the file at once; plus a short
// retry to cover the brief post-exit window and any out-of-band writer.
let dbQueue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runDuckDB(query, allowWrite) {
  return new Promise((resolve, reject) => {
    // Read path runs in -safe mode: no filesystem reads, no getenv, no extension
    // installs — model-written SQL can't touch anything but the cube itself.
    // (The write path needs read_json for sync loads, so it stays unrestricted.)
    const args = allowWrite ? [DB_PATH, "-json", "-c", query] : [DB_PATH, "-readonly", "-safe", "-json", "-c", query];
    execFile(DUCKDB, args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(0, 500)));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []); }
      catch (e) { reject(new Error("Bad DuckDB output: " + e.message)); }
    });
  });
}

// Run SQL against the cube, JSON rows back. Read-only unless allowWrite.
export function sql(query, { allowWrite = false } = {}) {
  if (!allowWrite && !/^\s*(select|with|pragma|describe|summarize)\b/i.test(query)) {
    return Promise.reject(new Error("Only SELECT/WITH queries are allowed here."));
  }
  const attempt = async () => {
    for (let i = 0; ; i++) {
      try { return await runDuckDB(query, allowWrite); }
      catch (e) {
        if (i < 40 && /conflicting lock|set lock/i.test(String(e.message))) { await sleep(250); continue; }
        throw e;
      }
    }
  };
  const result = dbQueue.then(attempt, attempt); // serialize regardless of prior outcome
  dbQueue = result.then(() => {}, () => {});      // keep the queue alive
  return result;
}

// Sync one base table. Incremental when possible: if the table has a primary
// key (UUID) and a modification-timestamp field and we already hold a
// watermark, pull only rows changed since the watermark and upsert by PK.
// Otherwise a full pull. Returns the new watermark for next time.
async function syncTable(table, { onProgress, watermark } = {}) {
  const cols = table.fields.filter((f) => f.type !== "Binary");
  const names = cols.map((f) => f.name);
  const typeMap = { Decimal: "DOUBLE", String: "VARCHAR", Date: "DATE", DateTimeOffset: "TIMESTAMP", Boolean: "BOOLEAN" };
  const ddlType = (n) => typeMap[cols.find((c) => c.name === n).type] || "VARCHAR";
  const struct = names.map((n) => `${q(n)}: '${ddlType(n)}'`).join(", ");
  const name = table.name, esc = (s) => String(s).replace(/'/g, "''");

  const pk = table.keys?.[0] || names.find((n) => /^id$/i.test(n)) || null;
  const modField = cols.find((f) => f.type === "DateTimeOffset" && /mod/i.test(f.name))?.name || null;

  // Incremental only if we have a watermark, the two fields, and the existing
  // table's columns still match (schema change forces a full rebuild).
  let incremental = Boolean(watermark && pk && modField);
  if (incremental) {
    const mainCols = (await sql(`SELECT column_name FROM information_schema.columns WHERE table_name='${esc(name)}' ORDER BY ordinal_position`)).map((r) => r.column_name);
    if (mainCols.length !== names.length || !names.every((n, i) => mainCols[i] === n)) incremental = false;
  }

  // Watermark comparison: `ge` (>=) only while the watermark second is recent
  // enough that new edits could still land in it (clock-skew guard). Once it's
  // safely in the past, strict `gt` — otherwise a bulk import that stamped
  // thousands of rows in one second gets re-pulled on every sync forever.
  const wmOp = watermark && Date.now() - Date.parse(watermark) > 5 * 60 * 1000 ? "gt" : "ge";
  const rows = await fetchAllRows(table.occurrences[0], names, { db: table.db, onProgress, filter: incremental ? `${modField} ${wmOp} ${watermark}` : undefined });
  const newWatermark = modField ? rows.reduce((mx, r) => (r[modField] && r[modField] > mx ? r[modField] : mx), watermark || "") : null;

  const file = path.join(CUBE_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(rows));

  if (incremental) {
    if (rows.length) {
      // Upsert the delta by PK, all in one DuckDB command (temp tables are
      // per-connection and each sql() call is a fresh process).
      await sql(
        `CREATE TEMP TABLE _delta AS SELECT * FROM read_json('${file}', columns={${struct}}, format='array', maximum_object_size=16777216);` +
        `DELETE FROM ${q(name)} WHERE ${q(pk)} IN (SELECT ${q(pk)} FROM _delta);` +
        `INSERT INTO ${q(name)} SELECT * FROM _delta;`,
        { allowWrite: true }
      );
    }
  } else {
    const load = rows.length
      ? `CREATE OR REPLACE TABLE ${q(name)} AS SELECT * FROM read_json('${file}', columns={${struct}}, format='array', maximum_object_size=16777216);`
      : `CREATE OR REPLACE TABLE ${q(name)} (${names.map((n) => `${q(n)} ${ddlType(n)}`).join(", ")});`;
    await sql(load, { allowWrite: true });
  }
  const total = (await sql(`SELECT count(*) c FROM ${q(name)}`))[0]?.c ?? rows.length;
  return { name, db: table.db, rows: total, changed: rows.length, mode: incremental ? "incremental" : "full", watermark: newWatermark, columns: names };
}

// Sync a specific set of base tables into the existing cube (create-or-replace
// each), merging their entries into the manifest. Used by both full builds and
// the smart-live path (refresh only the tables a query touches).
export async function syncTables(tables, names, log = () => {}, onEvent = () => {}) {
  const chosen = tables.filter((t) => names.includes(t.name));
  const prior = Object.fromEntries((cubeManifest().tables || []).map((t) => [t.name, t]));
  const results = [];
  for (const t of chosen) {
    log(`syncing ${t.name}…`);
    onEvent({ type: "table-start", name: t.name });
    const r = await syncTable(t, {
      watermark: prior[t.name]?.watermark || null,
      onProgress: (n) => { log(`  ${t.name}: ${n} rows`); onEvent({ type: "table-rows", name: t.name, rows: n }); },
    });
    log(`  ${t.name}: ${r.mode} · ${r.changed} changed · ${r.rows} total`);
    onEvent({ type: "table-done", name: t.name, rows: r.rows, changed: r.changed, mode: r.mode });
    results.push(r);
  }
  const manifest = cubeManifest();
  const byName = Object.fromEntries((manifest.tables || []).map((t) => [t.name, t]));
  for (const r of results) byName[r.name] = r;
  const merged = Object.values(byName);
  const out = { db: DB_PATH, syncedAt: new Date().toISOString(), host: os.hostname(), tables: merged, totalRows: merged.reduce((a, b) => a + b.rows, 0) };
  fs.writeFileSync(path.join(DATA_DIR, "cube-manifest.json"), JSON.stringify(out, null, 2));
  return out;
}

// Full rebuild for the chosen tables.
export async function buildCube(tables, includeNames, log = () => {}) {
  return syncTables(tables, includeNames, log);
}

// Drop tables from the local copy (delete data) and prune them from the
// manifest. The table name still exists upstream and in /api/schema, so it can
// be turned back on later — we only remove the local copy.
export async function dropTables(names, log = () => {}, onEvent = () => {}) {
  for (const n of names) {
    try { await sql(`DROP TABLE IF EXISTS ${q(n)}`, { allowWrite: true }); log(`dropped ${n}`); onEvent({ type: "drop", name: n }); } catch (e) { log(`drop ${n} failed: ${e.message}`); }
  }
  const m = cubeManifest();
  const kept = (m.tables || []).filter((t) => !names.includes(t.name));
  const out = { ...m, tables: kept, totalRows: kept.reduce((a, b) => a + b.rows, 0), syncedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(DATA_DIR, "cube-manifest.json"), JSON.stringify(out, null, 2));
  return out;
}

// Reconcile the local copy to exactly `includeNames`: sync those, drop the rest.
export async function reconcileCube(tables, includeNames, log = () => {}, onEvent = () => {}) {
  const have = (cubeManifest().tables || []).map((t) => t.name);
  const toDrop = have.filter((n) => !includeNames.includes(n));
  onEvent({ type: "plan", tables: includeNames, toDrop });
  await syncTables(tables, includeNames, log, onEvent);
  if (toDrop.length) await dropTables(toDrop, log, onEvent);
  const manifest = cubeManifest();
  onEvent({ type: "done", totalRows: manifest.totalRows, tables: (manifest.tables || []).map((t) => t.name) });
  return manifest;
}

export function cubeManifest() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "cube-manifest.json"), "utf8")); }
  catch { return { syncedAt: null, tables: [], totalRows: 0 }; }
}

export function cubeExists() {
  return fs.existsSync(DB_PATH);
}

// --- Bundled sample data ------------------------------------------------------
// Out-of-box play: when no FileMaker connection is configured and there is no
// cube yet, load the bundled fictional dataset (sample-data/*.json) so a fresh
// clone works with just an AI key. Generic loader: whatever JSON files sit in
// the folder become tables. The first real sync goes through reconcileCube,
// which drops any table the user didn't pick — so connecting a real database
// replaces the sample automatically.
const SAMPLE_DIR = path.join(__dirname, "sample-data");

export function sampleAvailable() {
  // Client/production installs can turn the bundled demo data off entirely.
  if (process.env.LOAD_SAMPLE === "0" || process.env.LOAD_SAMPLE === "false") return false;
  try { return fs.readdirSync(SAMPLE_DIR).some((f) => f.endsWith(".json")); } catch { return false; }
}

export async function loadSampleData(log = () => {}) {
  const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".json")).sort();
  const tables = [];
  for (const f of files) {
    const name = f.replace(/\.json$/, "");
    const file = path.join(SAMPLE_DIR, f).replace(/'/g, "''");
    await sql(`CREATE OR REPLACE TABLE ${q(name)} AS SELECT * FROM read_json('${file}', format='array', maximum_object_size=16777216)`, { allowWrite: true });
    const rows = (await sql(`SELECT count(*) c FROM ${q(name)}`))[0]?.c ?? 0;
    log(`sample: loaded ${name} (${rows} rows)`);
    tables.push({ name, rows, changed: rows, mode: "sample", watermark: null, columns: [] });
  }
  const out = { db: DB_PATH, syncedAt: new Date().toISOString(), host: os.hostname(), sample: true, tables, totalRows: tables.reduce((a, b) => a + b.rows, 0) };
  fs.writeFileSync(path.join(DATA_DIR, "cube-manifest.json"), JSON.stringify(out, null, 2));
  return out;
}
