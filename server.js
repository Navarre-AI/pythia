// Pythia: general-purpose conversational reporting for FileMaker databases.
// Ask in plain English; answers come from a local DuckDB copy of the connected
// database (synced over OData), with the AI choosing queries and the server
// injecting the real rows, not model-written numbers. See README.md and RULES.md.

import "./env.js";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fmConfigured, fetchSchema, fetchCounts, layoutStats, baseName } from "./fm.js";
import { sql as cubeSql, buildCube, syncTables, reconcileCube, cubeManifest, cubeExists, sampleAvailable, loadSampleData } from "./cube.js";
import { renderReport, renderReportParts } from "./report.js";
import { SEED_REPORTS } from "./reports.seed.js";

// AI config: env vars are the DEFAULTS; the Settings > AI panel overrides any
// of them per-install (stored on the volume in config.json). Getters read the
// config first, fall back to env — so a blank key field keeps the env key.
//   key      — ANTHROPIC_API_KEY / config.aiKey
//   model    — claude-fable-5 | -sonnet-5 | -haiku-... | -opus-4-8
//   speed    — "fast": fast mode (Opus-only, ~2.5x tok/s, premium, separate
//              quota; needs the beta flag + top-level speed param).
//   thinking — "off" (thinking:disabled, straight-to-output; matters on Sonnet),
//              "deep" (extended thinking with a budget), or "" (adaptive default).
// On any failure with a knob applied, retry once with a plain request.
const ENV_KEY = process.env.ANTHROPIC_API_KEY || "";
const ENV_MODEL = process.env.ANTHROPIC_MODEL || "claude-fable-5";
const ENV_SPEED = process.env.ANTHROPIC_SPEED || "";
const ENV_THINKING = process.env.ANTHROPIC_THINKING || "";
const aiKey = () => readConfig().aiKey || ENV_KEY;
const aiModel = () => readConfig().aiModel || ENV_MODEL;
const aiSpeed = () => { const c = readConfig(); return c.aiSpeed !== undefined ? c.aiSpeed : ENV_SPEED; };
const aiThinking = () => { const c = readConfig(); return c.aiThinking !== undefined ? c.aiThinking : ENV_THINKING; };
// Snapshot taken ONCE at the start of a task, so a mid-task Settings change can't
// switch model/params mid-loop. Pass it through every call in a multi-call flow.
const aiSnapshot = () => ({ key: aiKey(), model: aiModel(), speed: aiSpeed(), thinking: aiThinking() });

async function anthropicFetch(body, timeoutMs, ai) {
  const a = ai || aiSnapshot();
  const fast = a.speed === "fast";
  const think = a.thinking; // "off" | "deep" | ""
  const plainHeaders = { "x-api-key": a.key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const thinkBody = think === "off" ? { thinking: { type: "disabled" } }
    : think === "deep" ? { thinking: { type: "enabled", budget_tokens: 6000 }, max_tokens: Math.max(body.max_tokens || 2000, 8000) }
    : {};
  const post = (headers, b) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers, body: JSON.stringify(b), signal: AbortSignal.timeout(timeoutMs),
  });
  let res = await post(
    { ...plainHeaders, ...(fast ? { "anthropic-beta": "fast-mode-2026-02-01" } : {}) },
    { ...body, ...(fast ? { speed: "fast" } : {}), ...thinkBody }
  );
  if (!res.ok && (fast || think)) res = await post(plainHeaders, body);
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const app = express();

// Password gate (Hecate's three-way pattern): if SITE_PASSWORD is set, the
// whole site requires it. Accepted three ways so it works in a browser AND a
// FileMaker web viewer (which cannot answer a Basic-auth prompt):
//   1. ?key=<password> in the URL  -> also drops a cookie for later calls.
//   2. a pythia_auth cookie (set by #1).
//   3. HTTP Basic (browser prompt / curl -u).
if (SITE_PASSWORD) {
  const cookieVal = `pythia_auth=${encodeURIComponent(SITE_PASSWORD)}`;
  app.use((req, res, next) => {
    if (req.query.key === SITE_PASSWORD) {
      // Secure only on HTTPS so local http dev still works; Fly terminates TLS
      // and sets x-forwarded-proto.
      const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      res.setHeader("Set-Cookie", `${cookieVal}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${secure}`);
      return next();
    }
    const cookies = req.headers.cookie || "";
    if (cookies.split(";").some((c) => c.trim() === cookieVal)) return next();
    const header = req.headers.authorization || "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      if (decoded.slice(decoded.indexOf(":") + 1) === SITE_PASSWORD) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Pythia"');
    return res.status(401).send("Authentication required. Load with ?key=<password> in a web viewer.");
  });
}

// No caching: FileMaker web viewers cache aggressively.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

app.use(express.json({ limit: "5mb" })); // OnWindowTransaction payloads can be chunky
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "pythia", stage: "config", fm: fmConfigured });
});

// --- Relevance ranking ------------------------------------------------------
// "Which tables actually matter for reporting?" An AI pass reads each table's
// name, size, field names + developer comments, and how many layouts reference
// it, then tiers them core | reference | system and pre-picks the ones worth
// syncing. Cached to the volume, keyed by the OData schema version, so it costs
// one model call per schema change. Heuristic fallback when no API key.

const RELEVANCE_PATH = path.join(DATA_DIR, "relevance.json");

async function callAnthropic(system, user, maxTokens = 2000, ai) {
  const a = ai || aiSnapshot();
  // A 38-table ranking reply can exceed 60s to generate; 60s here silently
  // degraded the whole pass to heuristic (no display names, no homing).
  const json = await anthropicFetch(
    { model: a.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] },
    180000, a
  );
  return json.content.map((c) => c.text || "").join("");
}

function heuristicRelevance(tables, stats) {
  const SYSTEM = /log|dashboard|chart|field\s*def|field\s*choice|example|subtype|image|selector|self\s|address book/i;
  const REFERENCE = /category|note|review|phone|employee|join|type/i;
  return tables.map((t) => {
    const layouts = stats?.counts?.[t.name] ?? 0;
    const rows = t.rowCount; // null = count failed, NOT an empty table
    let tier = "reference";
    if (SYSTEM.test(t.name) || (rows != null && rows <= 2) || (layouts === 0 && t.fields.length < 6)) tier = "system";
    else if (layouts >= 3 || rows >= 500) tier = "core";
    else if (REFERENCE.test(t.name)) tier = "reference";
    return { name: t.name, tier, include: tier !== "system", reason: `${layouts} layouts, ${rows == null ? "?" : rows.toLocaleString()} rows (heuristic)` };
  });
}

async function aiRelevance(tables, stats) {
  const multiFile = tables.some((t) => t.occByDb && Object.keys(t.occByDb).length > 1);
  const summary = tables.map((t) => ({
    name: t.name,
    occurrences: (t.occurrences || []).slice(0, 8),
    // OData cannot say which FILE a base table lives in (GOTCHAS.md), so give
    // the model each candidate file with the TO names seen there and let it
    // pick the home. Legacy multi-file solutions usually name files after
    // their table, so this is strong signal.
    ...(multiFile ? { candidateFiles: Object.fromEntries(Object.entries(t.occByDb || {}).map(([db, occs]) => [db, occs.slice(0, 4)])) } : {}),
    rows: t.rowCount ?? null,
    layouts: stats?.counts?.[t.name] ?? 0,
    fields: t.fields.slice(0, 14).map((f) => f.name),
    comments: t.fields.map((f) => f.comment).filter(Boolean).slice(0, 4),
  }));
  const system =
    "You are a FileMaker data architect helping decide which base tables of a solution are worth " +
    "replicating into a SQL reporting copy. Tier each table: 'core' (the central entities users " +
    "report on — whatever this solution is about: e.g. transactions, orders, cases, records, people), " +
    "'reference' (lookup/supporting data useful in reports: categories, notes, contact details), or 'system' (utility/UI/dev plumbing not " +
    "worth reporting: logs, dashboards, chart configs, field definitions, example data, join/selector " +
    "helper tables). Signals: many layouts referencing a table and higher row counts suggest importance; " +
    "developer field comments reveal intent. Set include=true for core and reference, false for system. " +
    "Each `name` is derived from the table's occurrence names and may be a cryptic prefixed fragment " +
    "(P__Person, REP_ort, HEXP__Harvest Expense); also propose displayName, the clean human name of the " +
    "underlying entity, inferred from the occurrence names, fields, and comments (e.g. \"Person\", " +
    "\"Report\", \"Harvest Expense\"). Singular, title case, no prefixes. " +
    "Reply ONLY with a JSON array of {name, displayName, tier, include, reason} where reason is <=12 words. " +
    "Where a table has candidateFiles, ALSO set homeFile: the file the base table most likely LIVES in. " +
    "Judge by file naming (a file named after the entity is its home; e.g. SubQuotes lives in 'New Quotes', " +
    "not in a hub UI file like 'New Master' that references everything) and by TO naming per file. " +
    "homeFile MUST be one of that table's candidateFiles keys. " +
    "A row's rows:null means the count failed, not an empty table.";
  const text = await callAnthropic(system, "Tables:\n" + JSON.stringify(summary, null, 1), 8192);
  const jsonStr = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  return JSON.parse(jsonStr);
}

async function getRelevance(schema, stats, { light = false } = {}) {
  try {
    const cached = JSON.parse(fs.readFileSync(RELEVANCE_PATH, "utf8"));
    // A "light" ranking (no layout stats — computed for a fast Settings open)
    // satisfies light callers, but /api/schema recomputes it with full stats.
    if (cached.version === schema.version && !(cached.basis === "light" && !light)) return cached;
  } catch { /* no cache yet */ }
  let ranking, source;
  if (aiKey()) {
    try { ranking = await aiRelevance(schema.tables, stats); source = "ai"; }
    catch (e) { ranking = heuristicRelevance(schema.tables, stats); source = "heuristic (AI failed: " + String(e.message).slice(0, 80) + ")"; }
  } else {
    ranking = heuristicRelevance(schema.tables, stats);
    source = "heuristic (set ANTHROPIC_API_KEY for AI ranking)";
  }
  const out = { version: schema.version, basis: light ? "light" : "full", source, ranking, rankedAt: new Date().toISOString() };
  try { fs.writeFileSync(RELEVANCE_PATH, JSON.stringify(out, null, 2)); } catch { /* read-only fs ok */ }
  return out;
}

// Re-home merged tables to their AI-proposed home file and re-derive the real
// name from THAT file's occurrence names. OData can't tell us where a base
// table lives (GOTCHAS.md), and the most-occurrences heuristic crowns the hub
// UI file, so the ranking's homeFile — validated against the candidates we
// actually saw — is the authority. Renames flow into ranking entries (rawName
// preserved so a cached ranking still matches a fresh schema fetch) and edges.
function rehomeAndRename(schema, relevance) {
  const byName = new Map(schema.tables.map((t) => [t.name, t]));
  const renames = new Map();
  let entriesChanged = false;
  const pairs = [];
  for (const r of relevance.ranking || []) {
    const t = byName.get(r.rawName ?? r.name) || byName.get(r.name);
    if (!t) continue;
    pairs.push([t, r]);
    if (r.homeFile && t.occByDb?.[r.homeFile] && r.homeFile !== t.db) {
      t.db = r.homeFile;
      t.occurrences = t.occByDb[r.homeFile];
      // Only a re-homed table gets a re-derived name: the home file's own TO
      // names beat a name derived from 20 hub-file TOs. Un-moved tables keep
      // their already-disambiguated name (re-deriving collapsed fmLog and
      // AI_Log both to "Log" once).
      const derived = baseName(t.occurrences);
      if (derived && derived !== t.name) {
        if (r.rawName === undefined) { r.rawName = r.name; entriesChanged = true; }
        renames.set(t.name, derived);
        byName.delete(t.name);
        t.name = derived;
        byName.set(t.name, t);
      }
    }
    if (r.name !== t.name) { r.name = t.name; entriesChanged = true; }
  }
  // Guarantee global uniqueness: qualify with the home file, then the shortest
  // occurrence name, then a counter. First claimant keeps the plain name.
  const used = new Set();
  const entryFor = new Map(pairs.map(([t, r]) => [t, r]));
  for (const t of schema.tables) {
    if (!used.has(t.name)) { used.add(t.name); continue; }
    const shortest = t.occurrences.slice().sort((a, b) => a.length - b.length)[0];
    let candidate = [`${t.name} (${t.db})`, shortest, `${shortest} (${t.db})`].find((c) => c && !used.has(c));
    for (let i = 2; !candidate; i++) if (!used.has(`${t.name} ${i}`)) candidate = `${t.name} ${i}`;
    renames.set(t.name, candidate);
    const r = entryFor.get(t);
    if (r) { if (r.rawName === undefined) { r.rawName = r.name; } r.name = candidate; entriesChanged = true; }
    t.name = candidate;
    used.add(t.name);
  }
  if (renames.size) for (const e of schema.edges || []) {
    if (renames.has(e.from)) e.from = renames.get(e.from);
    if (renames.has(e.to)) e.to = renames.get(e.to);
  }
  if (entriesChanged) { try { fs.writeFileSync(RELEVANCE_PATH, JSON.stringify(relevance, null, 2)); } catch { /* read-only fs ok */ } }
  return schema;
}

// Schema (base tables, counts, per-table layout reference counts, AI relevance
// ranking), cached in memory per boot. ?refresh=1 re-reads from the server and
// re-ranks.
let schemaCache = null;

// Every consumer of table names (sync, chat, reports) must see the SAME homed
// and renamed tables the Settings UI shows, or selections stop matching.
async function rehomedSchema() {
  if (schemaCache) return schemaCache;
  const schema = await fetchSchema();
  try { rehomeAndRename(schema, await getRelevance(schema, { counts: {} }, { light: true })); } catch { /* un-homed is still usable */ }
  return schema;
}
app.get("/api/schema", async (req, res) => {
  try {
    if (!fmConfigured) return res.status(503).json({ error: "FM_* env not configured" });
    if (!schemaCache || req.query.refresh) {
      const schema = await fetchSchema(Boolean(req.query.refresh));
      const counts = await fetchCounts(schema.tables);
      for (const t of schema.tables) t.rowCount = counts[t.name] ?? null;
      let stats = { counts: {}, layoutsByTable: {}, aiLayouts: [], totalLayouts: null };
      try { stats = await layoutStats(schema.tables); } catch (e) { schema.layoutStatsError = String(e.message); }
      for (const t of schema.tables) {
        t.layoutCount = stats.counts[t.name] ?? 0;
        t.layoutNames = stats.layoutsByTable[t.name] ?? [];
      }
      if (req.query.refresh) { try { fs.unlinkSync(RELEVANCE_PATH); } catch {} }
      const relevance = await getRelevance(schema, stats);
      schema.relevanceSource = relevance.source;
      rehomeAndRename(schema, relevance);
      tablesCache = null; // table names/homes may have changed
      const byName = Object.fromEntries(relevance.ranking.map((r) => [r.name, r]));
      for (const t of schema.tables) {
        const r = byName[t.name] || { tier: "reference", include: true, reason: "" };
        t.tier = r.tier; t.suggestInclude = r.include; t.reason = r.reason;
      }
      schema.counts = counts;
      schema.aiLayouts = stats.aiLayouts;
      schema.totalLayouts = stats.totalLayouts;
      schemaCache = schema;
    }
    res.json(schemaCache);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/api/config", (_req, res) => {
  const c = readConfig();
  // AI config for the Settings panel: current model/speed/thinking + whether a
  // key is set (NEVER the key itself). keyIsCustom = a key was saved in-app.
  res.json({ includeTables: c.includeTables || [], displayNames: getDisplayNames(), savedAt: c.savedAt || null,
    ai: { model: aiModel(), speed: aiSpeed(), thinking: aiThinking(), hasKey: Boolean(aiKey()), keyIsCustom: Boolean(c.aiKey) } });
});

// Lightweight base-table list for the settings panel (names + row counts only,
// no layout/relevance work) so Settings opens fast.
let tablesCache = null;
app.get("/api/tables", async (_req, res) => {
  try {
    if (!fmConfigured) return res.status(503).json({ error: "FM_* env not configured" });
    if (!tablesCache || _req.query.refresh) {
      const schema = await fetchSchema(Boolean(_req.query.refresh));
      const counts = await fetchCounts(schema.tables);
      for (const t of schema.tables) t.rowCount = counts[t.name] ?? null; // attach BEFORE renames
      // Apply AI homing + display naming so Settings shows tables under the
      // file they live in. Uses the cached ranking when present; otherwise a
      // "light" ranking (no layout stats) so the first Settings open works.
      try { rehomeAndRename(schema, await getRelevance(schema, { counts: {} }, { light: true })); } catch { /* FM-only view is fine */ }
      tablesCache = { db: schema.db, dbs: schema.dbs, dbErrors: schema.dbErrors || [], tables: schema.tables.map((t) => ({ name: t.name, db: t.db, rowCount: t.rowCount, fields: t.fields.length })) };
    }
    res.json(tablesCache);
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// Save table selection and/or friendly display names. Merges into the existing
// config so it never clobbers dataSource or the other field.
app.post("/api/config", async (req, res) => {
  const config = readConfig();
  if (Array.isArray(req.body?.includeTables)) config.includeTables = req.body.includeTables;
  if (req.body?.displayNames && typeof req.body.displayNames === "object") config.displayNames = { ...(config.displayNames || {}), ...req.body.displayNames };
  const ai = req.body?.ai;
  if (ai && typeof ai === "object") {
    if (typeof ai.aiKey === "string" && ai.aiKey.trim()) config.aiKey = ai.aiKey.trim(); // blank => keep current key
    if (typeof ai.model === "string") config.aiModel = ai.model;
    if (typeof ai.speed === "string") config.aiSpeed = ai.speed;
    if (typeof ai.thinking === "string") config.aiThinking = ai.thinking;
  }
  config.savedAt = new Date().toISOString();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json({ saved: true }); // never echo the config back (holds the key)
});

// --- The cube (local SQL copy) ---------------------------------------------

app.get("/api/cube/status", (_req, res) => {
  res.json({ exists: cubeExists(), ...cubeManifest() });
});

// Rebuild the cube for the currently-configured tables (or ?tables=a,b).
app.post("/api/cube/sync", async (req, res) => {
  try {
    if (!fmConfigured) return res.status(503).json({ error: "FM_* env not configured" });
    const schema = await rehomedSchema();
    let include = req.body?.tables;
    if (!Array.isArray(include)) {
      try { include = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).includeTables; } catch { include = []; }
    }
    if (!include.length) return res.status(400).json({ error: "No tables selected. Save a config or pass {tables:[...]}." });
    // Reconcile: sync the included tables AND drop any that were removed.
    const manifest = await reconcileCube(schema.tables, include, (m) => console.log("[sync]", m));
    res.json(manifest);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Streaming sync (Server-Sent Events) so the UI can show live per-table +
// overall progress. GET because EventSource is GET-only. Reconciles the cube to
// ?tables=a,b,c (or the saved config) and emits structured events.
app.get("/api/cube/sync/stream", async (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  const send = (evt) => { res.write(`data: ${JSON.stringify(evt)}\n\n`); };
  try {
    if (!fmConfigured) { send({ type: "error", message: "FileMaker not configured" }); return res.end(); }
    const schema = await rehomedSchema();
    let include = req.query.tables ? String(req.query.tables).split(",").filter(Boolean) : configuredTables();
    if (!include.length) { send({ type: "error", message: "No tables selected" }); return res.end(); }
    // Attach expected row counts (from the tables cache) to the plan event.
    const expected = {};
    for (const t of (tablesCache?.tables || [])) expected[t.name] = t.rowCount;
    const onEvent = (evt) => {
      if (evt.type === "plan") evt = { ...evt, tables: evt.tables.map((n) => ({ name: n, expected: expected[n] ?? null })) };
      send(evt);
    };
    await reconcileCube(schema.tables, include, (m) => console.log("[sync]", m), onEvent);
    res.end();
  } catch (e) {
    send({ type: "error", message: String(e.message || e) });
    res.end();
  }
});

// Browse shadowed data: table list, or rows of one table.
app.get("/api/cube/tables", async (_req, res) => {
  try {
    const t = await cubeSql(
      "SELECT table_name AS name, estimated_size AS rows FROM duckdb_tables() ORDER BY table_name"
    );
    res.json(t);
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/api/cube/table/:name", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 2000);
    const name = req.params.name.replace(/"/g, '""');
    const rows = await cubeSql(`SELECT * FROM "${name}" LIMIT ${limit}`);
    res.json({ name: req.params.name, rows });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// Ad-hoc SELECT (data browser table peek uses /api/cube/table; this stays for tools).
app.post("/api/query", async (req, res) => {
  try {
    const rows = await cubeSql(String(req.body?.sql || ""));
    res.json({ columns: rows.length ? Object.keys(rows[0]) : [], rows });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// --- Config helpers ----------------------------------------------------------
// "copy": query the persisted DuckDB on the Fly volume (fast; as-of last sync).
// "live": re-pull from FileMaker (OData) into that same DuckDB just before the
// query, so numbers are current. Same engine (DuckDB local to Fly) either way;
// live just refreshes it first. Stored in config.json.
// Pythia is general-purpose: no hardcoded tables or names. The table selection
// and any friendly names are per-connection config, derived from the connected
// schema (Settings pre-checks the AI relevance-ranked tables). Empty until set.
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; } }
function configuredTables() { const c = readConfig(); return c.includeTables && c.includeTables.length ? c.includeTables : []; }
// Friendly names: AI-proposed displayNames (from the cached relevance ranking)
// underneath, the user's own renames on top.
function getDisplayNames() {
  const proposed = {};
  try {
    for (const r of JSON.parse(fs.readFileSync(RELEVANCE_PATH, "utf8")).ranking || [])
      if (r.displayName && r.displayName !== r.name) proposed[r.name] = r.displayName;
  } catch { /* no ranking cached yet */ }
  return { ...proposed, ...(readConfig().displayNames || {}) };
}

async function syncConfigured() {
  const schema = await rehomedSchema();
  await buildCube(schema.tables, configuredTables(), (m) => console.log("[sync]", m));
}
// Ensure the cube exists at all (build once if missing). Everything answers from
// the local copy; freshness comes from incremental sync (mod-date watermark),
// triggered manually or by a FileMaker script — not per query.
// With no FileMaker connection, fall back to the bundled sample dataset so a
// fresh install is playable with just an AI key.
async function ensureData() {
  if (cubeExists()) return;
  if (fmConfigured) return syncConfigured();
  if (sampleAvailable()) return loadSampleData((m) => console.log("[sample]", m));
}

// Guard for the AI endpoints: a readable schema, or a friendly pointer.
async function cubeSchemaOrNull() {
  const schema = await cubeSchemaText();
  return schema.trim() ? schema : null;
}
const NEEDS_SETUP_MSG = "There's no data to report on yet. Open Settings & tables (bottom left), pick the tables you want, and click Save & apply.";

// --- Saved reports ----------------------------------------------------------

const REPORTS_PATH = path.join(DATA_DIR, "reports.json");
function loadReports() {
  try { return JSON.parse(fs.readFileSync(REPORTS_PATH, "utf8")); }
  catch { fs.writeFileSync(REPORTS_PATH, JSON.stringify(SEED_REPORTS, null, 2)); return SEED_REPORTS.slice(); }
}
function saveReports(list) { fs.writeFileSync(REPORTS_PATH, JSON.stringify(list, null, 2)); }
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "report";

app.get("/api/reports", (_req, res) => res.json(loadReports()));

app.post("/api/reports", (req, res) => {
  const list = loadReports();
  const b = req.body || {};
  let id = b.id || slug(b.name || "report");
  while (list.some((r) => r.id === id)) id += "-2";
  const rep = { id, name: b.name || "Untitled", description: b.description || "", sql: b.sql || "", chart: b.chart || null, ...(Array.isArray(b.parts) && b.parts.length ? { parts: b.parts } : {}), updatedAt: new Date().toISOString() };
  list.push(rep); saveReports(list);
  res.json(rep);
});

// Save/overwrite one report.
app.put("/api/reports/:id", (req, res) => {
  const list = loadReports();
  const i = list.findIndex((r) => r.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  list[i] = { ...list[i], name: b.name ?? list[i].name, description: b.description ?? list[i].description, sql: b.sql ?? list[i].sql, chart: b.chart ?? list[i].chart, updatedAt: new Date().toISOString() };
  saveReports(list);
  res.json(list[i]);
});

// Duplicate.
app.post("/api/reports/:id/duplicate", (req, res) => {
  const list = loadReports();
  const src = list.find((r) => r.id === req.params.id);
  if (!src) return res.status(404).json({ error: "not found" });
  let id = src.id + "-copy";
  while (list.some((r) => r.id === id)) id += "-2";
  const copy = { ...src, id, name: src.name + " (copy)", updatedAt: new Date().toISOString() };
  list.push(copy); saveReports(list);
  res.json(copy);
});

app.delete("/api/reports/:id", (req, res) => {
  const list = loadReports().filter((r) => r.id !== req.params.id);
  saveReports(list);
  res.json({ ok: true });
});

// Run a report against current data (honors the live/copy switch).
const renderedReports = new Map(); // id -> html, for the iframe/print view
function buildArtifact(report, columns, rows) {
  const chart = report.chart;
  const series = chart && chart.type !== "table" && chart.x && chart.y && columns.includes(chart.x) && columns.includes(chart.y)
    ? rows.map((r) => ({ label: String(r[chart.x] ?? ""), value: Number(r[chart.y]) || 0 })) : null;
  return {
    title: report.name || "Report", chartType: series ? chart.type : "table",
    columns, rows: rows.slice(0, 300), series, saveable: false,
    sql: report.sql, chart: chart || null,
  };
}
async function runReport(report) {
  await ensureData();
  if (report.parts?.length) {
    // Multi-part: run every section fresh, render one document.
    const rendered = [];
    for (const p of report.parts) {
      try {
        const rows = await cubeSql(p.sql);
        rendered.push({ title: p.title, note: p.note || "", chart: p.chart, columns: rows.length ? Object.keys(rows[0]) : [], rows });
      } catch { /* section query failed against current data; skip it */ }
    }
    if (!rendered.length) throw new Error("None of this report's sections ran against the current data.");
    renderedReports.set(report.id, renderReportParts({ report, parts: rendered, meta: cubeManifest() }));
    const artifact = { title: report.name, chartType: "report", sections: rendered.map((p) => ({ title: p.title, rows: p.rows.length })), reportId: report.id, saveable: false };
    return { reportId: report.id, artifact, ts: new Date().toISOString() };
  }
  const rows = await cubeSql(report.sql);
  const columns = rows.length ? Object.keys(rows[0]) : [];
  renderedReports.set(report.id, renderReport({ report, columns, rows, meta: cubeManifest() }));
  return { columns, rows, reportId: report.id, artifact: buildArtifact(report, columns, rows), ts: new Date().toISOString() };
}

app.post("/api/reports/:id/run", async (req, res) => {
  try {
    const report = loadReports().find((r) => r.id === req.params.id);
    if (!report) return res.status(404).json({ error: "not found" });
    res.json(await runReport(report));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Run an unsaved draft (live editor preview).
app.post("/api/run", async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await runReport({ id: "_draft", name: b.name || "Draft", description: b.description || "", sql: b.sql || "", chart: b.chart || null }));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.get("/report/:id", (req, res) => {
  const html = renderedReports.get(req.params.id);
  if (!html) return res.status(404).send("Report not run yet.");
  res.type("html").send(html);
});

// --- Conversations: independent chat threads (master-detail) -----------------
// Each conversation is its own file with its own message history, so threads
// stay independent. The sidebar lists them; switching loads only that thread.
const CONVOS_DIR = path.join(DATA_DIR, "conversations");
fs.mkdirSync(CONVOS_DIR, { recursive: true });
let convoSeq = 0;
const newConvoId = () => `c_${Date.now().toString(36)}${(convoSeq++).toString(36)}`;
const convoPath = (id) => path.join(CONVOS_DIR, String(id).replace(/[^\w-]/g, "") + ".json");
function loadConvo(id) { try { return JSON.parse(fs.readFileSync(convoPath(id), "utf8")); } catch { return null; } }
function saveConvo(c) { fs.writeFileSync(convoPath(c.id), JSON.stringify(c)); }
function listConvos() {
  return fs.readdirSync(CONVOS_DIR).filter((f) => f.endsWith(".json"))
    .map((f) => { try { const c = JSON.parse(fs.readFileSync(path.join(CONVOS_DIR, f), "utf8")); return { id: c.id, title: c.title, updated: c.updated }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
}

app.get("/api/conversations", (_req, res) => res.json({ conversations: listConvos() }));
app.get("/api/conversations/:id", (req, res) => { const c = loadConvo(req.params.id); c ? res.json(c) : res.status(404).json({ error: "not found" }); });
app.patch("/api/conversations/:id", (req, res) => {
  const c = loadConvo(req.params.id); if (!c) return res.status(404).json({ error: "not found" });
  if (req.body?.title) { c.title = String(req.body.title).slice(0, 80); c.updated = new Date().toISOString(); saveConvo(c); }
  res.json({ ok: true });
});
app.delete("/api/conversations/:id", (req, res) => { try { fs.unlinkSync(convoPath(req.params.id)); } catch {} res.json({ ok: true }); });

// --- Chat: pure natural-language prompt -> query -> inline chart -------------
// The user only ever sees plain English + charts. SQL is written by the model
// and executed server-side against the local DuckDB copy; it is never shown.
// Two tools: query_data (SELECT) and present (turn the last result into a chart
// or table the UI renders). Numbers come straight from the query rows.

async function callAnthropicTools(system, messages, tools, maxTokens = 1500, ai) {
  const a = ai || aiSnapshot();
  return anthropicFetch({ model: a.model, max_tokens: maxTokens, system, tools, messages }, 60000, a);
}

async function cubeSchemaText() {
  const cols = await cubeSql("SELECT table_name, column_name FROM information_schema.columns ORDER BY table_name, ordinal_position");
  const byTable = {};
  for (const c of cols) (byTable[c.table_name] ||= []).push(c.column_name);
  return Object.entries(byTable).map(([t, cs]) => `- "${t}"(${cs.map((c) => `"${c}"`).join(", ")})`).join("\n");
}

// Generic guidance for the model. Pythia is general-purpose: it learns the
// actual schema at runtime (cubeSchemaText); nothing domain-specific lives here.
const DATA_NOTES = [
  "Working with this data (DuckDB SQL):",
  "- Use ONLY the tables and columns listed above; never assume others exist.",
  '- Quote identifiers containing spaces or punctuation in double quotes, e.g. "Order Date".',
  "- Dates/timestamps: use year(col), month(col), quarter(col), or strftime(col,'%Y-%m') to group.",
  "- Join tables on their keys (typically a primary-key column and a matching foreign-key column that references the other table).",
  "- For time-series, label each period readably (e.g. '2024-Q1' or '2024-03'), never a bare number.",
  "- Reason only from the actual schema and data shown. Do not assume domain facts that aren't visible in the columns.",
].join("\n");

const CHAT_TOOLS = [
  { name: "query_data", description: "Run one read-only DuckDB SQL SELECT against the local copy of the FileMaker data. Quote identifiers that contain spaces or start oddly with double quotes. Returns rows as JSON plus a queryIndex you can reference in compose_report.",
    input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
  { name: "present", description: "Display the most recent query_data result to the user as a chart or table. Use bar for category comparisons, line for time series, table for detailed rows. x/y are column names from that result (needed for bar/line).",
    input_schema: { type: "object", properties: { title: { type: "string" }, chartType: { type: "string", enum: ["bar", "line", "table"] }, x: { type: "string" }, y: { type: "string" } }, required: ["title", "chartType"] } },
  { name: "compose_report", description: "Bundle SEVERAL query results from this reply into ONE saved, printable report with multiple sections. Use when the user wants a single report with multiple parts. Run query_data (and present) for each section first, then call this once at the end. Each section references a query by its queryIndex.",
    input_schema: { type: "object", properties: {
      name: { type: "string" }, description: { type: "string" },
      sections: { type: "array", items: { type: "object", properties: {
        title: { type: "string" },
        queryIndex: { type: "number", description: "queryIndex returned by the query_data call whose rows this section shows" },
        chartType: { type: "string", enum: ["bar", "line", "table"] },
        x: { type: "string" }, y: { type: "string" },
        note: { type: "string", description: "One plain-English sentence of takeaway for this section" },
      }, required: ["title", "queryIndex", "chartType"] } },
    }, required: ["name", "sections"] } },
];

app.post("/api/chat", async (req, res) => {
  try {
    if (!aiKey()) return res.json({ reply: "The AI key isn't set yet, so I can't answer questions. Set ANTHROPIC_API_KEY.", artifacts: [] });
    await ensureData();
    const schema = await cubeSchemaOrNull();
    if (!schema) return res.json({ reply: NEEDS_SETUP_MSG, artifacts: [] });
    const dn = getDisplayNames();
    const aliasLine = "Users refer to tables by these friendly names (use them when talking to the user; still write SQL against the REAL names on the left): " +
      Object.entries(dn).map(([real, friendly]) => `${real}="${friendly}"`).join(", ") + ".";
    const system =
      "You are Pythia, a reporting oracle over the user's FileMaker data. Answer their questions in plain, concise English backed by real numbers. " +
      "You work against a local SQL copy of these tables (DuckDB):\n" + schema + "\n\n" + DATA_NOTES + "\n" + aliasLine + "\n\n" +
      'Rules: (1) To get numbers, call query_data with a DuckDB SELECT. Quote identifiers with spaces like "Order Date". ' +
      "(2) After querying, call present to show the result as a chart (bar for rankings/comparisons, line for time-over-time) or table (for detailed row lists). x/y are column names from the result. " +
      "(3) Then give a 1-2 sentence plain-English takeaway the user can act on. " +
      "If the user asks for ONE report with MULTIPLE parts/sections, run query_data (and present) for each part, then call compose_report ONCE at the end to bundle them into a single saved, printable report. " +
      "If a question needs data this database doesn't track, say so honestly and offer the closest thing you CAN answer, rather than returning a misleading chart. " +
      "PRESENTATION RULES (always): never show SQL, table names, or column names. NEVER show a UUID, internal ID, or raw foreign key in your answer or any table/chart — always resolve keys to the human label (join to the related table and show its name/title column), and never include a bare ID column. Label rows by their name, not their key. Use friendly names and plain, warm, business English.";

    const messages = (req.body?.messages || []).map((m) => ({ role: m.role, content: String(m.content) }));
    const artifacts = [];
    const queryLog = []; // every query_data this reply: {sql, columns, rows} — compose_report references these
    let lastRows = [], lastSql = "", replyText = "";
    const ai = aiSnapshot(); // one model/speed/thinking snapshot for the whole turn

    for (let hop = 0; hop < 8; hop++) {
      const resp = await callAnthropicTools(system, messages, CHAT_TOOLS, 1500, ai);
      messages.push({ role: "assistant", content: resp.content });
      const toolUses = resp.content.filter((b) => b.type === "tool_use");
      replyText = resp.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim() || replyText;
      if (!toolUses.length) break;
      const results = [];
      for (const tu of toolUses) {
        let out;
        try {
          if (tu.name === "query_data") {
            lastSql = tu.input.sql; lastRows = await cubeSql(lastSql);
            queryLog.push({ sql: lastSql, columns: lastRows[0] ? Object.keys(lastRows[0]) : [], rows: lastRows });
            out = { queryIndex: queryLog.length, rowCount: lastRows.length, columns: lastRows[0] ? Object.keys(lastRows[0]) : [], rows: lastRows.slice(0, 60) };
          } else if (tu.name === "compose_report") {
            const secs = Array.isArray(tu.input.sections) ? tu.input.sections : [];
            const parts = [], rendered = [];
            for (const s of secs) {
              const q = queryLog[(Number(s.queryIndex) || 0) - 1];
              if (!q || !q.rows.length) continue;
              const chart = s.chartType !== "table" && s.x && s.y && q.columns.includes(s.x) && q.columns.includes(s.y)
                ? { type: s.chartType, x: s.x, y: s.y } : null;
              parts.push({ title: s.title || "", note: s.note || "", sql: q.sql, chart });
              rendered.push({ title: s.title || "", note: s.note || "", chart, columns: q.columns, rows: q.rows });
            }
            if (!parts.length) { out = { error: "No valid sections; check queryIndex values." }; }
            else {
              const list = loadReports();
              let id = slug(tu.input.name || "report"); while (list.some((r) => r.id === id)) id += "-2";
              const rep = { id, name: tu.input.name || "Report", description: tu.input.description || "", parts, updatedAt: new Date().toISOString() };
              list.push(rep); saveReports(list);
              renderedReports.set(id, renderReportParts({ report: rep, parts: rendered, meta: cubeManifest() }));
              artifacts.push({ title: rep.name, chartType: "report", sections: rendered.map((p) => ({ title: p.title, rows: p.rows.length })), reportId: id, saveable: false });
              out = { saved: true, reportId: id, sections: parts.length };
            }
          } else if (tu.name === "present") {
            const columns = lastRows[0] ? Object.keys(lastRows[0]) : [];
            const rep = { name: tu.input.title, sql: lastSql, chart: tu.input.chartType === "table" ? null : { type: tu.input.chartType, x: tu.input.x, y: tu.input.y } };
            const art = buildArtifact(rep, columns, lastRows); art.saveable = true;
            // Store a printable HTML render so the user can Save as PDF from the card.
            const rid = "chat-" + tu.id.slice(-10);
            renderedReports.set(rid, renderReport({ report: rep, columns, rows: lastRows, meta: cubeManifest() }));
            art.reportId = rid;
            artifacts.push(art);
            out = { shown: true, rows: lastRows.length };
          } else out = { error: "unknown tool" };
        } catch (e) { out = { error: String(e.message || e).slice(0, 300) }; }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
    }

    const reply = replyText || "Here's what I found.";
    const ts = new Date().toISOString();
    // Persist to the conversation thread (create if new). Keep it independent:
    // we store only this thread's plain user/assistant turns, with source+ts.
    const incoming = req.body?.messages || [];
    const lastUser = [...incoming].reverse().find((m) => m.role === "user");
    let convo = req.body?.conversationId ? loadConvo(req.body.conversationId) : null;
    if (!convo) convo = { id: newConvoId(), title: String(lastUser?.content || "New chat").slice(0, 60), created: ts, messages: [] };
    if (lastUser) convo.messages.push({ role: "user", content: String(lastUser.content), ts });
    convo.messages.push({ role: "assistant", content: reply, artifacts, ts });
    convo.updated = ts;
    saveConvo(convo);

    res.json({ reply, artifacts, ts, conversationId: convo.id });
  } catch (e) {
    res.status(200).json({ reply: "", error: String(e.message || e) });
  }
});

// --- Overview: an AI-designed landing dashboard ------------------------------
// General-purpose: the model reads the connected schema and proposes a dashboard
// spec (KPIs + charts, each backed by one SQL). The server validates every query
// by running it, drops failures, and caches the spec per schema — instant after
// the first build, regenerated when the synced schema changes.
const OVERVIEW_PATH = path.join(DATA_DIR, "overview.json");

async function overviewSpec(schema) {
  try {
    const cached = JSON.parse(fs.readFileSync(OVERVIEW_PATH, "utf8"));
    if (cached.schema === schema && cached.spec) return cached.spec;
  } catch { /* no cache yet */ }
  if (!aiKey()) throw new Error("No AI key set, so the overview can't be designed yet.");
  const dn = getDisplayNames();
  const system =
    "You design a landing dashboard for a database. Given the DuckDB tables below, propose the overview its owner would want to see first: " +
    "3-5 KPIs (single headline numbers) and 2-4 charts, each backed by ONE DuckDB SELECT against the real table names, on ONE line. " +
    'Return ONLY JSON, no markdown: {"kpis":[{"label":string,"sql":string,"format":"number"|"money"|"percent"}],"charts":[{"title":string,"type":"bar"|"line","sql":string,"x":string,"y":string}]}. ' +
    "Each KPI SQL returns exactly one row with one column. Each chart SQL returns the columns named in x and y (at most 12 rows, with ORDER BY; readable period labels like '2024-Q1' for time series). " +
    "Quote identifiers with spaces. Only use tables/columns that exist below. Pick 'money' format only for columns that are clearly monetary. " +
    "PRESENTATION RULE: never select a UUID, internal ID, or foreign key as a shown column — identify rows by their human-readable label.\n\n" +
    "Tables:\n" + schema + "\n\n" + DATA_NOTES +
    (Object.keys(dn).length ? "\nFriendly names (for labels/titles only; SQL uses real names): " + Object.entries(dn).map(([r, f]) => `${r}=${f}`).join(", ") : "");
  const txt = await callAnthropic(system, "Design the dashboard now. JSON only.", 3000);
  const spec = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
  try { fs.writeFileSync(OVERVIEW_PATH, JSON.stringify({ schema, spec, savedAt: new Date().toISOString() }, null, 2)); } catch { /* read-only fs ok */ }
  return spec;
}

app.get("/api/overview", async (req, res) => {
  try {
    await ensureData();
    if (req.query.refresh) { try { fs.unlinkSync(OVERVIEW_PATH); } catch {} }
    const schema = await cubeSchemaOrNull();
    if (!schema) return res.status(200).json({ error: NEEDS_SETUP_MSG, needsSetup: true });
    const spec = await overviewSpec(schema);
    const kpis = [], charts = [];
    for (const k of spec.kpis || []) {
      try {
        const row = (await cubeSql(k.sql))[0] || {};
        const value = Object.values(row)[0];
        if (value !== undefined && value !== null) kpis.push({ label: k.label, value, format: k.format || "number" });
      } catch { /* drop KPIs whose SQL doesn't run */ }
    }
    for (const c of spec.charts || []) {
      try {
        const rows = await cubeSql(c.sql);
        if (rows.length && rows[0][c.x] !== undefined && rows[0][c.y] !== undefined)
          charts.push({ title: c.title, type: c.type === "line" ? "line" : "bar", x: c.x, y: c.y, rows: rows.slice(0, 24) });
      } catch { /* drop charts whose SQL doesn't run */ }
    }
    if (!kpis.length && !charts.length) {
      try { fs.unlinkSync(OVERVIEW_PATH); } catch {} // bad spec: don't keep it cached
      throw new Error("The overview design didn't run cleanly. Reload to try again.");
    }
    res.json({ kpis, charts, syncedAt: cubeManifest().syncedAt });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// AI "what stands out" — separate so the dashboard renders instantly and the
// insights fill in when the model returns.
app.post("/api/overview/insights", async (req, res) => {
  if (!aiKey()) return res.json({ insights: [] });
  try {
    const txt = await callAnthropic(
      "You are a sharp data analyst. Given these dashboard figures, write 3 short, specific, punchy insights the data's owner would act on. One sentence each, no preamble. Return ONLY a JSON array of strings.",
      JSON.stringify(req.body || {}), 700);
    res.json({ insights: JSON.parse(txt.slice(txt.indexOf("["), txt.lastIndexOf("]") + 1)) });
  } catch { res.json({ insights: [] }); }
});

// Suggested next questions — fuel the manager's drill-down. Loaded async after
// an answer so it never slows the reply.
app.post("/api/followups", async (req, res) => {
  if (!aiKey()) return res.json({ followups: [] });
  try {
    const txt = await callAnthropic(
      "You suggest what the user would naturally ask NEXT about their data. Given their question and the answer, propose 3 short natural-language follow-up questions (max 7 words each) that drill deeper or pivot usefully, answerable from the same data. Return ONLY a JSON array of 3 strings.",
      JSON.stringify({ question: String(req.body?.question || ""), answer: String(req.body?.reply || "") }), 300);
    res.json({ followups: JSON.parse(txt.slice(txt.indexOf("["), txt.lastIndexOf("]") + 1)).slice(0, 3) });
  } catch { res.json({ followups: [] }); }
});

// Reset: clear reports, conversations, config, and the cached overview design.
// Back to a fresh install. Does not touch the local copy data itself.
app.post("/api/reset", (_req, res) => {
  try {
    fs.writeFileSync(REPORTS_PATH, JSON.stringify(SEED_REPORTS, null, 2));
    for (const f of fs.readdirSync(CONVOS_DIR)) { try { fs.unlinkSync(path.join(CONVOS_DIR, f)); } catch {} }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ savedAt: new Date().toISOString() }, null, 2));
    try { fs.unlinkSync(OVERVIEW_PATH); } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// AI auto-generated reports: given the actual synced schema, propose reports a
// manager would want, validate each SQL by running it, keep the ones that work.
app.post("/api/reports/generate", async (req, res) => {
  try {
    if (!aiKey()) return res.status(400).json({ error: "No AI key set." });
    await ensureData();
    const schema = await cubeSchemaText();
    const dn = getDisplayNames();
    const system =
      "You are a data analyst. Given a database (DuckDB tables below), design 6 reports its owner would actually keep and run regularly. " +
      "Cover what THIS data supports: trends over time, top/bottom rankings, distributions and breakdowns, geography or segments, health/exception lists — pick the strongest stories in the schema. " +
      "For each report return: name, description (one sentence), sql (a single DuckDB SELECT against the real table names, on ONE line), and chart ({type:'bar'|'line', x, y} or null for a list). " +
      "Quote identifiers with spaces. Use readable period labels for time-series. Only use tables/columns that exist. Keep each SQL compact. " +
      "PRESENTATION RULE: reports must NEVER select a UUID, internal ID, or raw foreign key as a shown column — always join to and select the human label (a name/title column) and never include a bare ID column. Rows are identified by name, not key. " +
      "Return ONLY a JSON array of 6 objects, no markdown.\n\n" +
      "Tables:\n" + schema + "\n\n" + DATA_NOTES +
      "\nFriendly names (for the description wording only; SQL uses real names): " + Object.entries(dn).map(([r, f]) => `${r}=${f}`).join(", ");
    const txt = await callAnthropic(system, "Design the reports now. JSON array only.", 4096);
    let proposed = [];
    try {
      const s = txt.indexOf("["), e = txt.lastIndexOf("]");
      proposed = JSON.parse(txt.slice(s, e + 1));
    } catch { console.log("[generate] parse failed, raw len", txt.length, txt.slice(-160)); return res.status(502).json({ error: "AI did not return valid report specs. Try again." }); }
    const list = loadReports();
    const created = [];
    for (const p of proposed) {
      if (!p?.sql || !p?.name) continue;
      try { const rows = await cubeSql(p.sql); if (!rows.length) continue; } catch { continue; } // keep only reports that actually run
      let id = slug(p.name); while (list.some((r) => r.id === id) || created.some((r) => r.id === id)) id += "-2";
      created.push({ id, name: p.name, description: p.description || "", sql: p.sql, chart: p.chart || null, generated: true, updatedAt: new Date().toISOString() });
    }
    if (!created.length) return res.status(502).json({ error: "None of the proposed reports ran cleanly. Try again." });
    saveReports([...list, ...created]);
    res.json({ created: created.map((r) => ({ id: r.id, name: r.name })), count: created.length });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// FileMaker OnWindowTransaction webhook. Body is the trigger's JSON:
//   { "<FileName>": { "<BaseTable>": [ ["New|Modified|Deleted", recordID, fieldContent], ... ] } }
// New/Modified -> incremental sync of that table (fast, mod-date). Deleted with
// a UUID in fieldContent -> remove that row from the copy. Responds immediately
// so a FileMaker commit is never held up; work runs in the background, one at a
// time (DuckDB is single-writer).
let notifyChain = Promise.resolve();
app.post("/api/notify", (req, res) => {
  const payload = req.body || {};
  res.json({ ok: true }); // fast ack; process out of band
  notifyChain = notifyChain.then(async () => {
    if (!fmConfigured) return;
    const schema = await rehomedSchema();
    const included = new Set(configuredTables()); // only tables the user reports on
    const findTable = (name) => schema.tables.find((t) => t.name === name || t.occurrences.includes(name));
    const toSync = new Set(), deletes = [];
    for (const file of Object.values(payload)) {
      if (!file || typeof file !== "object") continue;
      for (const [baseTable, ops] of Object.entries(file)) {
        const t = findTable(baseTable);
        if (!t || !included.has(t.name) || !Array.isArray(ops)) continue;
        const pk = t.keys?.[0] || t.fields.find((f) => /^id$/i.test(f.name))?.name;
        for (const row of ops) {
          const [op, , fieldContent] = row;
          if (op === "Deleted") { if (fieldContent && pk) deletes.push({ table: t.name, pk, id: fieldContent }); }
          else toSync.add(t.name); // New / Modified
        }
      }
    }
    if (toSync.size) await syncTables(schema.tables, [...toSync], (m) => console.log("[notify]", m));
    for (const d of deletes) {
      await cubeSql(`DELETE FROM "${d.table.replace(/"/g, '""')}" WHERE "${d.pk.replace(/"/g, '""')}" = '${String(d.id).replace(/'/g, "''")}'`, { allowWrite: true });
    }
    console.log(`[notify] synced [${[...toSync].join(",")}] deleted ${deletes.length}`);
  }).catch((e) => console.log("[notify] error:", e.message));
});

app.listen(PORT, () => {
  console.log(`Pythia listening on :${PORT} (fm=${fmConfigured}, cube=${cubeExists()})`);
  // First-run: if connected but no local copy yet, build it in the background.
  // With no connection at all, load the bundled sample so the app is playable.
  if (fmConfigured && !cubeExists()) {
    console.log("[first-run] no local copy; syncing configured tables…");
    syncConfigured().then(() => console.log("[first-run] initial sync done")).catch((e) => console.log("[first-run] sync failed:", e.message));
  } else if (!fmConfigured && !cubeExists() && sampleAvailable()) {
    console.log("[first-run] no FileMaker connection; loading bundled sample data…");
    loadSampleData((m) => console.log("[sample]", m)).then(() => console.log("[first-run] sample ready")).catch((e) => console.log("[first-run] sample load failed:", e.message));
  }
});
