# Gotchas

Hard-won platform quirks and their fixes. Each entry: symptom, cause, where it's
handled. Add to this file the moment a quirk costs you more than ten minutes;
future you (and any AI session working on this code) reads this before fm.js.

Client-specific facts (accounts, file lists, credentials) do NOT belong here.
They live in each deployment's NOTES.md, outside this repo.

## FileMaker OData

**External-file TOs are CONDITIONALLY visible.** A TO whose base table lives in
another file is served over OData ONLY when the account can also open that other
file with fmodata there. While the target file lacks access, the TO is silently
omitted from the entity list and querying it returns -1020 "Table not defined" —
so a hub file's exposure GROWS as satellite files gain the privilege (verified:
New-file entity list went 111 → 145 sets the moment satellites came online). The
Data API serves layouts on external TOs regardless, so a solution can look
connected via Data API while OData can't see the data. Two consequences: every
file where data lives needs the account + fmodata even if you only ever query the
hub, and the same base table then surfaces in EVERY file that TOs it — dedup by
full field name:type signature, keep the copy with the most occurrences (handled
in `fetchSchema()`, fm.js). (Not in Claris docs; verified on FMS 26.0.1, 2026-07.)

**Service root = discovery.** `GET /fmi/odata/v4` (Basic auth) lists exactly the
files this account can reach with fmodata. Files missing the account, or missing
the extended privilege, simply don't appear. Handled: `listDatabases()` in fm.js.

**Spaced entity names may need DOUBLE-encoding.** Some deployments (seen on FMS 26
behind nginx) decode the URL path once before the OData parser sees it, so
`/Master%20ID` arrives as a raw space and fails with -1002 "syntax error in URL",
even though the server's own service document advertises the %20 URLs. Those
servers want `%2520`. Other servers want plain %20. The database path segment is
fine single-encoded on both, and so are query strings ($filter). Handled:
`odataGetEntity()` in fm.js detects the -1002 signature once per boot and flips
to double-encoding; occurrence lists sort space-free names first to dodge it.

**`/$count` needs `Accept: */*`.** FMS OData returns 406 "Unexpected internal
OData Provider error" for `/$count` with an explicit `text/plain` accept header.
Handled: `fetchCounts()` in fm.js.

**`$select` support is HOST-DEPENDENT.** Some FMS builds fail to parse
`$select`; Trout's FMS 21 host accepts it (verified live 2026-07-17). Currently
we always fetch all fields and drop unwanted columns client-side
(`fetchAllRows()` `keep` in fm.js). Queued: probe once per boot and use $select
where supported — skips server-side evaluation of unstored calcs/summaries
during sync (Trout: 516 calc fields, 181 summaries).

**Fractional numbers without a leading zero.** FileMaker serializes values in
(-1,1) as `.5` / `-.06`, which is invalid JSON and breaks `res.json()`. Handled:
`parseODataJson()` in fm.js repairs number tokens in value position.

**Raw control characters in row JSON.** FM's OData serializer passes control
characters sitting in field data (tabs, vertical tabs, stray \r pasted into a
field years ago) straight into JSON string literals unescaped; strict JSON.parse
throws "Bad control character in string literal in JSON at position N". Seen on
Trout's first real sync, mid-page of a 1,000-row pull, after one table had
already synced clean. Same disease breaks their Save-as-XML export (control
chars in script comments) — it's FM trusting field bytes, not an OData-only bug.
Handled: `parseODataJson()` in fm.js — on parse failure, re-walk the text and
\u-escape control chars INSIDE string literals only (structural whitespace
between tokens must stay raw). Escape, don't strip: the bytes are client data.
(Verified on FMS 21, 2026-07-17.)

**Failed calcs serialize as a bare `?` in JSON.** When an unstored calc errors
during OData evaluation (`"cRate": ?` on Trout's Species Data — every page),
FMS writes the layout-style error marker straight into the JSON, which is a
syntax error ("Unexpected token '?'"). Killed the sync at table 19/23. Handled:
`parseODataJson()`/`repairODataText()` in fm.js — string-aware walk replaces
`?` tokens OUTSIDE string literals with null (a bare ? is never legal JSON, so
data can't be touched). Same walk escapes in-string control chars and repairs
zero-less fractions. (Verified on FMS 21, 2026-07-17.)

**TO names containing `?` or `~` are unqueryable.** The FMS URL parser 400s with
-1002 "syntax error in URL" on any entity path containing them, encoded or not
(%3F/%7E decode before the parser sees them). Such TOs exist in real files
(`?HAR_Item_Company~Mill`, `CO_Load~hauler`). Handled: occurrence sort in
`fetchSchemaForDb()` puts `?`/`~`-free names first, so `occurrences[0]` — the
$count and sync target — is always a clean name. (Verified on FMS 21, 2026-07-17.)

**`$filter` encoding.** Encode spaces only; colons, dashes, T and Z in ISO
timestamps must stay raw or the parser chokes. Handled: `fetchAllRows()` in fm.js.

**Base-table names are not exposed — anywhere.** $metadata EntityType names are
TO names, and on FMS 21 hosts there are NO com.filemaker.odata annotations for
TableID/FieldID/FMComment at all (FMS 26 hosts do emit them); FileMaker_Tables /
FileMaker_Fields 404 with -1020. The real base-table name exists only inside the
file (Manage Database / Save-as-XML). Handled: FMFID high-word grouping where
annotations exist, field name:type signature grouping where not, then
word-boundary `baseName()` for the derived name and the AI displayName pass on
top (fm.js, server.js — fixed 2026-07-17, validated against Trout's
Save-as-XML). A client's XML export is a validation artifact, never a runtime
dependency.

**Base-table FILE ownership is not exposed — at all.** In a multi-file solution
there is no runtime way to tell which file a base table lives in. Verified dead
ends (FMS 26, 2026-07): FieldID/TableID annotations absent server-wide;
FileMaker_Tables / FileMaker_Fields system tables -1020 over OData; AutoGenerated,
BestRowID, RowVersion, VersionID, Global, MaxRepetitions annotations identical on
the home file's view and every borrowing file's view; Key/nav structure uniform.
Occurrence counts mislead (a hub UI file TOs everything, so it looks like the
home of every table). Consequence: homing a merged table to its real file needs
knowledge from outside OData — AI inference over file/occurrence names with a
user override, or a client-side helper. Display-only concern: any exposed TO
serves identical rows, so sync correctness never depends on the guess.

## FileMaker Data API

**Layouts cannot be created via any API.** Pythia can only detect and report a
missing layout; a human adds it in Pro. Comment in fm.js above `dataApiLayouts()`.

**Per-file auth.** Data API and OData both authenticate against each file
independently. One account name across files is only "one account" if the
password matches in every file.

## DuckDB

**One writer, exclusive lock.** Each `sql()` call is a fresh duckdb CLI process;
a writer holds an exclusive file lock and any concurrent reader dies with
"Conflicting lock". Handled: all calls serialize through one in-process queue
plus retry, in cube.js.

## Environment

**`.env` OVERRIDES ambient env vars** (opposite of Node's `--env-file`). Dev
machines here export ambient FM_* vars (Comm Station), so the repo's .env must
win. Consequence: to run this code against a different server than .env points
at, move .env aside; inline `FM_HOST=... node ...` will NOT beat it. See env.js.
