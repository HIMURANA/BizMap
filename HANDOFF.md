# HANDOFF — Bangladesh Business Data project

Written at the end of a long Claude Code session so a NEW session (or you, by hand) can continue.
**To resume with Claude:** open a terminal in `E:\Projects\Data`, start Claude Code, and say:
> Read HANDOFF.md and continue from "NEXT STEPS". Do not redo finished work.

---

## 1. Goal
Collect business data from open map sources for **all of Bangladesh**, classify it, enrich it, and use it as the data engine for a future SaaS
(radius search on a map, filters, analysis for sales / marketing / real-estate / site-selection / research users).
Rules agreed: **no Google Maps scraping**, free/open sources only, never invent phones/emails/links, accuracy over quantity,
never claim the directory is complete, keep OpenStreetMap + Overture attribution, ownership (public/private) is never inferred.

## 2. Where things are
| Thing | Location |
|---|---|
| Project (TypeScript, Node 24, no runtime deps) | `E:\Projects\Data` |
| Database (SQLite) | `data/db/dhaka.sqlite` (backups next to it: `dhaka.before-*.sqlite`) |
| Outputs (CSV/JSON/MD/dashboard) | `data/exports/` — open `dashboard.html`, `coverage_by_district.csv`, `discovery_summary.md` |
| Secrets | `.env` (only `FIRECRAWL_API_KEY`; optional `CONTACT_EMAIL`). Never commit/share. |
| OSM source file (356 MB, MD5 verified) | `data/osm-extract/bangladesh-latest.osm.pbf` (Geofabrik) |
| Population CSVs (HDX, CC BY-IGO) | `data/population/adm1|adm2|adm3.csv` |
| Overture data (local copies) | `data/overture/bd_places_full.csv` (conf >= 0.5, Bangladesh box) + `bd_places.parquet` |
| DuckDB CLI (checksum-verified) | `data/tools/duckdb/duckdb.exe` |
| Logs | `data/*.log` (e.g. `overture_import.log`) |
| Scratch edit scripts | not needed any more (lived in a temp folder) |

## 3. State at handoff (31 Oct 2026)
- **Database before Overture:** 48,068 records (OSM Bangladesh-wide + Dhaka web discovery), 47,052 exported, 1,016 held for review.
- **Boundaries:** 8 divisions, 64 districts, 447 upazilas (real OSM polygons) + Dhaka Metropolitan polygon + 60 Dhaka neighbourhood areas
  (8 real polygons, 52 approximate point+1 km radius, 33 not found in OSM). Population 2022 loaded for 64 districts, 423/447 upazilas.
- **Categories (26):** 19 OSM/web ones + 7 Overture-driven (events, travel, beauty, real_estate, automotive, money_transfer, internet_providers).
- **Overture import: IN PROGRESS when this was written** (99,123 candidate places; ~15k done; resumable). Overture records are
  `business_id` = `ovt:<id>`; confidence >= 0.8 -> `record_status='new'`, 0.5–0.8 -> `'lead'` (kept OUT of category files, written to `leads_overture.csv`).
  Overture places that match an existing OSM record only ADD unverified contacts to the OSM record (no duplicate record).
- **Firecrawl credits left: 823** (of 1,393 at start). ~570 spent: sample 102, web discovery 83, enrichment batch 385.
- **Not yet done after the import** (see next steps): assign areas/districts for the new records, rescoring, duplicate check, re-export.

## 3b. UPDATE (31 Oct 2026, later session, project now at `D:\Data\Data`)
- Steps 1–3 below are DONE. Overture import finished (EXIT=0): 91,958 `ovt:` records; DB total 140,026. Resumed run took ~16 s, so the old slowness was environmental, not code.
- assign-areas, assign-admin, quality, export all ran (log: `data/post_overture.log`).
- New `npm run overture-sample` rebuilds the validation sample from the DB (300 rows, 100/band); the import now calls it too. Still needs a human to fill `ReviewerVerdict`.
- `findDuplicates` fixed: shared website/phone/social keys held by > 5 businesses (chains like MoneyGram agents) and platform hosts (youtube, facebook, google...) are skipped. Pairs went 1.6M -> 17,874.
- `export` needs `NODE_OPTIONS=--max-old-space-size=8192` at this size (default heap OOMs). Consider streaming the exporter.
- Confidence bands are 24 high / 29 medium / 139,973 low. This is BY DESIGN: medium/high need *verified* evidence, and a fully
  unverified record maxes at 55. The 0–100 score still spreads 20s–50s inside "low", so sort by score, not band. Changing the
  weights is a product decision (it would rate unverified Facebook-derived data as trustworthy); not done.
- Step 4 DONE: dashboard viewed in a browser (desktop + 375 px phone): renders, filters work, no console errors, no horizontal scroll.
  Fixed: footer now also credits Overture. Preview it with the `exports` config in `.claude/launch.json` (serves data/exports on :4173).
- Step 5 partly done: shared-contact pairs that also have the same name now score 0.9 (others 0.6). duplicate_report.csv is sorted
  by score: 7,662 pairs >= 0.9 (review first), 613 at 0.7–0.9, 9,599 below. needs_review.csv (1,016): 587 shop=general,
  136 border points, 122 amenity=doctors, 109 diagnostics-by-name, 53 sports centres, 9 other. Human review still needed.
- Remaining: human review (validation sample, duplicates, needs_review), then step 6 (pick first product).

## 3c. F-commerce (added 31 Oct 2026)
- No complete public list of F-commerce sellers exists. **Meta Ad Library is NOT scraped** (Meta terms forbid automated collection;
  its API covers only political ads for Bangladesh). Instead: people collect pages BY HAND -> import.
- `data/fcommerce/HOW_TO_COLLECT.md` (instructions + keywords), `ad_library_collection_template.csv` (one row per page).
- `npm run import-adlibrary -- data/fcommerce/<file>.csv` -> new `adl:` records (category online_businesses, status 'new',
  social link 'unverified', no coordinates; stated district only as text). Pages already in the DB get an extra
  `meta_ad_library_manual` source instead of a duplicate. Bad rows -> `<file>.rejected.csv`. Idempotent (tested on a DB copy).
- Export now writes `fcommerce_candidates.csv` (8,566 today: 70 online-category + 8,496 retail records with a Facebook/Instagram
  page and no website) and labels the `ad_library` source layer. `npm run export` now sets an 8 GB heap itself.
- `data/fcommerce/data_access_requests.md`: unsent request drafts to Ministry of Commerce (DBID), e-CAB, Meta.
- Collected CSVs are git-ignored (may contain sellers' personal phone numbers).

## 3d. SaaS app "BizMap" (Phase 1 built, 31 Oct 2026)
- **Run (development):** `npm run build-search` once after any pipeline change, then `npm run app:api` (port 8787) and
  `npm run app:web` (Vite on 5173, proxies /api). Or use the `api` / `web` configs in `.claude/launch.json`.
  **Run (single server):** `npm run app:build`, then `npm run app:api` and open http://localhost:8787.
- **Data flow:** pipeline DB -> `npm run build-search` -> table `search_businesses` (flat, indexed, ~5 s) -> API reads it.
  App state (lists, saved views, exports, credit ledger, suppressions, problem reports) lives in `data/db/app.sqlite`,
  separate from the pipeline DB. Delete app.sqlite to reset (gives 5,000 trial credits again). Export files go to `data/app_exports/`.
- **API** `apps/api/server.ts` (node:http + node:sqlite, no deps, binds 127.0.0.1): /api/meta, /search, /facets, /map (top 25k points
  by score), /business/:id (+ /report), /lists (+ items by ids or by filter query, cap 50k), /views, /export/quote, /export, /exports.
  Pricing in code: 1 credit per row when contact columns are included, location-only exports free. Suppressed emails/phones never exported.
- **Web** `apps/web` (React 19 + Vite 8 + Tailwind v4 + TanStack Query/Virtual + MapLibre GL **v5**): Explore (filters: location
  tree, upazila, Dhaka areas, scope, radius picked on the map, "search this area"; category tree; has/verified contacts; status;
  score; source + Overture confidence; F-commerce; chains; first seen; in/not in list) + map clusters + virtualized table
  (sort, column chooser, page size, select page/all matching) + detail drawer/full page + Lists + Exports + saved views + EN/বাংলা.
  Filters live in the URL. Campaigns/Inbox/Reports/Alerts/Settings are honest "planned" pages; Email/WhatsApp/Call buttons explain the phases.
- **Verified in the browser:** filters, map clusters/points, detail drawer, add to list, export (quote -> charge -> download, CSV checked),
  Lists/Exports pages, Bangla, 375 px phone layout, production build served by the API. Search/facets ~100–150 ms on 140k rows.
- **Known gaps:** no login/teams yet (local single workspace); no XLSX (CSV opens in Excel); JS bundle ~390 KB gzip (code-split MapLibre later);
  MapLibre v6 did not render with Vite 8 here, so v5 is pinned; the browser pane's oversized viewport emulation stops WebGL rendering (test the map at native size);
  SQLite instead of PostGIS (fine locally; move to Postgres+PostGIS for hosting). Data-quality example seen: "Sylhet Pet Care" under hospitals.
- **Next (from the agreed plan):** Phase 2 = hosted auth + workspaces, Postgres/PostGIS, payments (SSLCommerz/bKash), radius site report;
  Phase 3 = email campaigns (SES, unsubscribe, bounces) + call queue with outcomes that fix the data; Phase 4 = WhatsApp (opt-in only).

## 3e-status. Phase 2 TESTED (1 Nov 2026)
- Setup done by the user: PostGIS 3.6.2 on PG18, database `bizmap` (owner `bizmap`), pg_trgm, DATABASE_URL in .env, pg_hba back on scram-sha-256.
- `pg:sync`: 140,026 businesses (139,977 with points), 180k contacts, 100k socials, 147k sources, 519 admin areas (all valid geometries) in ~19 s.
- API end-to-end test (`api_e2e.mjs` in the session scratchpad; recreate from this list if needed): **64/64 pass**: auth (signup/login/logout,
  weak password, duplicate email, rate limit), CSRF (form + foreign Origin), all filters incl. PostGIS radius/bbox (8–100 ms), map, detail, lists
  (ids + by filter, workspace-scoped), views, quote/export/credits/402/free location export, test-gateway purchase (forged val_id rejected,
  credited exactly once), site reports, invites (email-bound, single use, member vs admin rights), workspace isolation.
- Bugs found and fixed: report SQL `ORDER BY ready + lead` (Postgres can't use aliases in expressions); dev proxy rewrote Host so the
  CSRF check blocked every browser write (vite proxy now `changeOrigin: false`); a rejected invite sign-up created an orphan account
  (invite now checked before the user is created).
- **Data gap found:** city areas (Dhaka city thanas, central Bogura...) have NO upazila polygons, so site-report population falls back to the
  district average and is far too low in dense areas (Mirpur 10, 1 km: ~39k estimated). Reports now flag this (`population.quality`,
  amber warning, "~" prefix). Real fix = gridded population (e.g. WorldPop / Meta HRSL 100 m, open licences) loaded into PostGIS.
- Browser: sign-in/sign-up screens checked and sign-up confirmed through the dev proxy; the Team/Billing/Reports screens were NOT clicked through
  in the browser yet (only their APIs are tested). All test accounts/workspaces/exports were deleted afterwards (DB has 0 users).

## 3g. Outreach + alerts (Phases 3–5, built 1 Nov 2026)
- **Email campaigns** (`apps/api/campaigns.ts`, web `CampaignPages.tsx`): audience = list or saved view; only public business emails;
  footer with sender name + postal address + why + unsubscribe; List-Unsubscribe + one-click POST (RFC 8058); suppression list checked at
  launch AND before each send; daily cap per workspace (default 200, warm-up); 1 credit per recipient at launch, refund on cancel;
  pause/resume/cancel/schedule; test send. Without SMTP_URL every email is CAPTURED in `email_log` (Outbox tab). Sender domain SPF/DKIM is
  the provider's job (not checked by the app).
- **WhatsApp** (`whatsapp.ts`, web `InboxPages.tsx`): per-workspace Cloud API connection (token + app secret AES-256-GCM encrypted via
  `secrets.ts`), approved templates fetched from Meta, campaigns ONLY to numbers with an unrevoked opt-in (`consents`, with proof),
  free-form replies only inside the 24 h window, STOP/UNSUBSCRIBE/বন্ধ revoke + suppress, START/YES records opt-in, webhook verifies
  X-Hub-Signature-256 and handles retries + delivery statuses. Unconnected workspaces run in TEST mode (stored, not delivered; simulate inbound).
- **Call queues** (`calls.ts`, `CallPages.tsx`): from list/view (≤5,000, deduped, suppression excluded), claim-next with row locks, calling
  hours (Asia/Dhaka, Settings → Sending), outcomes → data_reports (wrong number/closed/not a business), do-not-call → suppression,
  no-answer retries ×3, verbal WhatsApp opt-in recorded with caller + time.
- **Alerts** (`alerts.ts`, `AlertsPage.tsx`): saved filter + daily/weekly/monthly; "new" = first_seen after the alert's watermark (moves
  forward each run); in-app history + optional email digest. New businesses only appear after a pipeline refresh + `npm run pg:sync`.
- **Workers** (`workers.ts`): campaign sender every 10 s, alerts hourly, inside the API process (set WORKERS=0 on extra servers).
- Shared helpers moved to `apps/api/http.ts` (route table, need(), body parsing). Explore's Email/WhatsApp/Call buttons create a list from
  selected rows (or pass the filter) and open the campaign/call-queue screens; saved-views menu has "Alert me about new ones".
- **Tested:** outreach API e2e 51/53 (the 2 "fails" were the test expecting all 1,164 emails while the 50/day cap correctly held the rest);
  all new pages render in the browser with no errors. Test data deleted. NOT tested: real SMTP delivery, a real Meta WhatsApp number/webhook.
- **To go live:** set SMTP_URL + MAIL_FROM (+ verify the sending domain with the provider), connect WhatsApp per workspace (needs a public
  APP_URL for the webhook), get a lawyer's view on Bangladesh rules for unsolicited B2B email/calls before selling outreach.

## 3f. Gridded population (1 Nov 2026), fixes the city population gap above
- Source: **WorldPop R2025A, 2025, 100 m constrained** `bgd_pop_2025_CN_100m_R2025A_v1.tif` (55 MB, CC BY 4.0) from data.worldpop.org,
  stored in `data/population_grid/` (git-ignored). Loaded by `npm run pg:population` (`apps/api/loadPopulationGrid.ts`, needs devDependency `geotiff`)
  into `pop_grid` (10,439,635 populated cells, total 174,617,260 people, matches BD 2025) + `pop_grid_info`; ~2.5 min incl. GiST index.
- Site reports now sum grid cells whose centre is inside the circle (`population.quality = 'grid'`), 7–180 ms. The old census area-weighting
  is kept as `admin_estimate` for comparison and used only if the grid is not loaded. Report page shows source + WorldPop credit.
- Check values: Mirpur 10 1 km ≈ 99.7k (was 39k), Old Dhaka 1 km ≈ 98.7k, Gulshan 2 1 km ≈ 90k, Bogura town 3 km ≈ 191k, Sylhet 2 km ≈ 114k.
  It is a model: probably still low in the very densest cores (Old Dhaka) and smoothed between rich/poor areas. API tests 64/64 after the change.
- Existing saved reports keep their old numbers (stored at creation); generate a new report to get grid-based population.

## 3e. Phase 2 (code written 31 Oct 2026; tested 1 Nov, see above)
- **Decisions:** Postgres 18 + PostGIS (the user's local PG18 service on :5432) and built-in email/password login.
- **User setup still needed:** (1) install PostGIS for PG18 via Stack Builder; (2) as `postgres`: `CREATE ROLE bizmap LOGIN PASSWORD '…'; CREATE DATABASE bizmap OWNER bizmap;`
  then in `bizmap`: `CREATE EXTENSION postgis; CREATE EXTENSION pg_trgm;`; (3) add `DATABASE_URL=postgres://bizmap:…@localhost:5432/bizmap` to `.env`.
- **Then run:** `npm run build-search` → `npm run pg:sync` (copies 140k businesses, contacts, sources, admin polygons + population into PostGIS,
  one transaction) → `npm run app:api` (migrates schema on start) + `npm run app:web`. Sign up in the app = first workspace with 200 trial credits.
- **Files:** `apps/api/schema.sql` (biz_* synced tables + users, workspaces, memberships, sessions, invites, lists, views, exports, credit_ledger,
  suppressions, data_reports, payments, site_reports), `db.ts`, `sync.ts`, `auth.ts`, `filters.ts` (PostGIS ST_DWithin / bbox), `billing.ts`, `report.ts`, `server.ts`.
  Web: `pages/AuthPages.tsx` (login, signup, invite), `SettingsPages.tsx` (team, billing, account), `ReportsPages.tsx` (site report + print), `App.tsx` (auth gate, workspace switcher).
- **Auth:** scrypt hashes, session token only stored as SHA-256, httpOnly SameSite=Lax cookie (Secure in production), login rate limit
  (8 fails / 15 min per email and per IP, in memory), CSRF = JSON-only writes + Origin check, roles owner/admin/member, invite links (7 days, bound to email).
  No password-reset email yet (Phase 3 email sending). Phase 1 `data/db/app.sqlite` is no longer used.
- **Payments:** SSLCOMMERZ (cards, bKash, Nagad…). Without SSLC_STORE_ID → local TEST gateway (no money). Callbacks are always re-validated
  with the SSLCOMMERZ validation API (tran_id, amount, BDT) and credited once (status guard). Pack prices are PLACEHOLDERS (BILLING_PACKS env).
- **Site report:** competitors + anchors + people in radius = area-weighted 2022 upazila population (district fallback), method and caveats printed in the report.
- **Not verified yet:** nothing in Phase 2 has run against a real database. First session after setup: run pg:sync, then test signup/login,
  invite flow, explore/radius, export+credits, test-gateway purchase, site report; fix whatever breaks.

## 4. NEXT STEPS (in this order)
1. **Check the import.** `grep "places (" data/overture_import.log | tail -2` and look for `EXIT=0`.
   - If it stopped early: just run `npm run import-overture` again. It resumes (skips places already processed).
   - If it is very slow: it slows as the DB grows (writes dominate). Suspect an unindexed lookup inside `addContacts`
     (`hasContact` / `hasSocial` in `src/discovery/importOverture.ts`) — consider indexes on `business_contacts(business_id, contact_type)`
     and `business_social_links(business_id, platform)`, or run `PRAGMA optimize`. Do NOT go back to one giant transaction (it ran 14+ min with no progress).
2. When it finishes, run **in this order** (each reads/writes the DB, do not run two at once; use `set -o pipefail` in bash so failures are not hidden):
   `npm run assign-areas` → `npm run assign-admin` → `npm run quality` → `npm run export`
   (`assign-admin` also moves records outside district polygons into the review list.)
3. **Fix the validation sample.** `importOverture.ts` builds `overture_validation_sample.csv` only from places created in the *current* run.
   If the import ran in several pieces the sample is incomplete — rebuild it from the database (all `ovt:%` records, 100 per band:
   >=0.8, 0.65–0.8, 0.5–0.65). Then have a human fill `ReviewerVerdict` (real / wrong_category / not_a_business / closed / duplicate)
   to measure the real error rate. **Do this before selling any Overture-derived list.**
4. Open `data/exports/dashboard.html` in a browser and check it visually (only its data + script syntax were verified, never viewed).
5. Review `duplicate_report.csv` (2,000+ pending pairs; nothing is auto-merged) and `needs_review.csv`.
6. Decide the first SaaS product (see section 7), then build Phase 2 (accounts, PostGIS, map + radius search). Pre-sell to ~10 buyers per segment first.

## 5. Commands (all `npm run <name>`; arguments after `--`)
| Command | What it does |
|---|---|
| `init-db` | Create/migrate tables and load categories/areas. **Run after any category/schema change.** |
| `extract-local -- --bangladesh` / `import-local -- --bangladesh` | Stream the Geofabrik .pbf, extract tagged places, classify and store (OSM). Dhaka-only is the default without the flag. |
| `resolve-boundaries -- --all` | Dhaka neighbourhood boundaries from Nominatim (1 req/s). |
| `resolve-city` | Store the real Dhaka Metropolitan polygon. |
| `resolve-admin` / `assign-admin` | Division/district/upazila polygons (from the .pbf + Nominatim lookup) / assign every business. |
| `load-population` | Load HDX population CSVs onto admin areas (name-matched, prints non-exact pairs). |
| `assign-areas` | Neighbourhood + Dhaka scope (`dhaka_metropolitan` / `greater_dhaka` / `outside_dhaka`). |
| `import-overture` | Import Overture Places layer (needs `data/overture/bd_places_full.csv`). `OVT_LIMIT=4000` limits it for testing. |
| `overture-test` | Coverage comparison Overture vs OSM (reads `data/overture/bd_places.csv`). |
| `enrich-sample`, `enrich-batch <n> <maxCredits>` | Firecrawl: official website, phones, emails, social links. Costs credits (~2–3 per business). |
| `web-discover <maxCredits>` | Firecrawl web search for garments / tech / online businesses (strict rules). |
| `quality` | Confidence score (0–100) + duplicate candidates + branch grouping. |
| `export` | All CSV/JSON/MD reports + dashboard. |
| `stats`, `help` | Counts / command list. |

Refreshing Overture later: re-run the DuckDB export (`data/overture/export2.sql`, edit the release folder to the newest one in
`https://overturemaps-us-west-2.s3.amazonaws.com/?prefix=release/&delimiter=/`), then `import-overture`.

## 6. Known problems / limits (be honest about these)
- **Contact data is thin in OSM** (1–5% have phone/website). Overture has far more contacts but is **93% Meta/Facebook-derived**: stale or wrong
  entries exist (a 14-record eyeball sample had ~3 doubtful). All Overture contacts are stored `unverified`. Privacy: phones/emails of sole traders may be
  personal data — check Bangladeshi data-protection rules before selling contact lists.
- **Overlap Overture vs OSM is uncertain:** ~4% by name match (underestimate: Bangla vs English names), 23% within 30 m / 50% within 100 m by location
  alone (overestimate). The import uses a stricter combined rule.
- **~40% of Dhaka-era records had no neighbourhood**; only ~16–79% (by category) sit inside a known upazila; Dhaka city thanas have no polygons.
- **136 border points** outside simplified district polygons are held in `needs_review.csv` (may be India/Myanmar).
- District "coverage ratings" compare districts with each other, not with reality; rural districts can look dense just because volunteers mapped them.
- `private_hospitals.csv` is the required file name but contains ALL hospitals/clinics; only ~34 carry `operator:type=private` (`hospitals_private_by_osm_tag.csv`).
- Garments (4 web-found + factories as leads), diagnostics (64), online businesses (34, Facebook leads) are thin.
- OSM pharmacy/restaurant totals are almost certainly far below reality; never quote them as national totals.
- Foursquare OS Places is **gated** on Hugging Face (needs the user's login + acceptance). Skipped on purpose: Overture already includes Foursquare data.
- Facebook/Instagram pages from search are `search_match` leads, never verified.

## 7. SaaS direction (agreed)
- Free map data only (OSM + Overture; optional later: official Google Places API as a paid live lookup — its terms restrict storing/reselling, check before use).
  **Never scrape the Google Maps website.**
- Sell **location intelligence first** (counts, density, gaps, coverage score), **verified contact lists as a paid enrichment add-on**.
- First products (data exists today): (1) retail outlet census / territory tool for FMCG + pharma sales (pharmacy, grocery, electronics, clothing),
  (2) site-selection radius report (competitors + anchors + people per business), (3) education directory.
- Retention feature: monthly OSM snapshot diffs -> "new business" alerts.
- Build plan: PostgreSQL + PostGIS, MapLibre map, accounts via a hosted login, job queue, credits shown before any paid enrichment,
  payments (check Stripe availability for Bangladesh; else Paddle/Lemon Squeezy + bKash/SSLCommerz), Bangla UI, mobile-first, lawyer review for data/contact resale.

## 8. Lessons from this session (avoid repeating)
- Long jobs: always batch commits + progress logging + resumability. One giant transaction hid progress and ran 14+ minutes.
- In bash chains use `set -o pipefail`; piping through `grep` hid failures once.
- After adding categories/subcategories run `init-db` or inserts fail with a foreign-key error.
- Nominatim: max 1 request/second, descriptive User-Agent; Overpass: avoid for bulk (use the local .pbf instead).
- Match names with a Latin **and Bangla** aware normalizer (`normName` in `src/discovery/overtureMap.ts`); the older `norm()` strips Bangla.
- Verify anything fetched from the web before trusting it (identity + Dhaka evidence + domain/name relation); never treat generic words ("hotel", "shop") as identity.
- Downloaded files live in their own folders (`data/osm-extract`, `data/population`, `data/overture`, `data/tools`); all are git-ignored.

## 9. Source map (code)
`src/config` (categories, areas, env) · `src/osm` (pbf reader, local extract, classifier, Overpass client) · `src/geo` (boundaries, admin, population, nominatim) ·
`src/discovery` (OSM import, Overpass discovery, web discovery, Overture map + import) · `src/enrich` (Firecrawl client, matching rules, enrichment) ·
`src/quality` (scoring, duplicates) · `src/export` (exporter, dashboard) · `src/analysis` (Overture coverage test) · `src/cli.ts` (all commands) · `src/db` (schema + helpers).
