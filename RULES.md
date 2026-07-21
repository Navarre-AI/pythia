# Pythia rules (enforced)

The living rulebook. These are enforced in the model's system prompts (server.js: the chat prompt and the report-generation prompt) and must stay in sync here. Add to this list as new rules surface; treat them as permanent, not one-off fixes.

## Presentation (what the user may see)
1. **Never show SQL**, table names, or column names. Not in answers, not in report/PDF footers, nowhere.
2. **Never show a UUID, internal ID, or raw foreign key.** Always resolve a key to its human label (join to show the Company Name, the person's full name, the product name). Never include a bare `ID` column. Identify rows by name, not key.
3. **Use friendly / display names**, the ones set in Settings (e.g. Customers, People), in prose.
4. **Plain, warm, business English.** The user is a report person, not a developer.

## Data integrity
5. **Numbers come from the data, never the model**: the server injects real query rows; the model chooses which query feeds which chart, and writes narrative.
6. **Be honest about gaps.** If the data can't answer something (a field that's rarely filled in, a link that doesn't exist), say so and offer the closest thing, don't draw a misleading chart.
7. **No domain assumptions.** Pythia is general-purpose: everything the model knows about the data comes from the connected schema at runtime, never from anything baked into the code.

## Behavior
8. Everything answers from the **local copy** (DuckDB). Freshness comes from incremental mod-date sync, not per-query.
9. Time-series get **readable period labels** ("2024-Q1"), never bare numbers.

## Known safety nets to add (belt-and-suspenders)
- Render-time guard: auto-hide any column that is a bare `ID` / `ID_*` or whose values are UUID-shaped, so a UUID never reaches the screen even if the model slips (rules 1-2 are the primary guard; this is backup).
