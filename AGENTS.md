# Webnox OS — developer notes

Product: Webnox OS (multi-tenant SaaS). Repo: `webnox-os`.
Stack: plain HTML/CSS/vanilla JS modules, one Express file (`server.js`), Supabase, Vercel. No React, no bundler.

## Decisions that override the docs
- Product name is **Webnox OS** (docs say Webnox Hub).
- Master sign-in route is **`/master-signin`** (docs say `/master-login`). The "no link anywhere" rule applies to this string.
- Up to **3 Master accounts** (docs say one). `promote_to_master()` refuses a 4th. Master notices go to all Masters. Access/payment logs record which Master acted.
- Space types: **Personal (non-rented)** and **On rent** (docs: master_project / rented).
- Master theme: dark navy with cyan-to-indigo gradient (from owner's screenshot), not light blue. Business workspaces stay white.
- First Master email: Webnoxhub@gmail.com.

## Phase log
- **M0** — package.json, server.js (`/api/config`), vercel.json (`/master-signin` rewrite), .env.example, .gitignore, placeholder pages, robots.txt.
- **M1** — `/master-signin` (dark glass card, network-dots canvas background), `css/auth.css`, `js/auth.js` (`initMasterLogin`), `js/supabase.js`, `js/net-bg.js`, favicon. One refusal sentence for every failure, 600 ms floor.
- **M2** — `supabase/schema.sql` Parts 1-3 (tenancy core, Master billing tables, `promote_to_master()` capped at 3). `set-password.html` + `initSetPassword()`. `index.html` forwards invite/recovery hashes. `tests/db.test.mjs` (PGlite).
- **M3** — `app.html` boot (config -> session -> profile -> world), Master shell (`css/master.css`, dark), `pages/master-home.js`, `pages/master-workspaces.js`, `lib/master-guard.js` + `api/master/ping.js` (401 no token, 403 non-Master), business `login.html` (white; refuses a Master with the same sentence). `api/config.js` replaces the Express route on Vercel.

## Conventions
- Vercel runs `api/*.js` as functions and serves `public/**`; `server.js` is for local dev only (`npm run dev`).
- Every Master API route starts with `requireMaster(req)` from `lib/master-guard.js`.
- Dates are shown in Asia/Karachi (`js/time.js`). Money shown in PKR (base currency).
- The string `master-signin` may appear only in `public/master-signin.html`, `public/robots.txt`, `vercel.json`, `server.js` and `AGENTS.md`. `tests/static.test.mjs` enforces it for `public/`.
- `app.html` and `login.html` never contain the word "Master"; the Master UI is built by JS only for a Master.
- Not built yet: workspace creation (M4), branded business login (M5), Master finance, billing sweep, everything inside a business workspace.
- **Phase 3 (Leads + Clients)** — `supabase/schema.sql` PART 13 (per-workspace `role_permissions`, `perm()`/`pm_perm()` gated by the Master's role switches, `leads`, `clients` with per-workspace BUID, `client_files` + `client-files` bucket at `<workspace>/<client>/<file>`, `lead_convert`), `public/js/eco/pages/leads.js` + `clients.js`, public lead form `/lead-form.html?t=<workspaces.public_form_token>` served by `api/public/form.js` + `api/public/lead.js` (`lib/public-form.js`). `clients.js` has `INVOICES_READY` / `PROJECTS_READY` flags and `eco/invoices.js` is a placeholder until Finance/Projects land.
- **Phase 4 (Projects)** — `supabase/schema.sql` PART 15: bigint `projects`, `project_members`, `project_requirements`, `staffing_requests` (+ `_items`, `request_comments`), `tasks.project_id`, `client_files.project_id`; staffing flow as RPCs (`staffing_request_create/decide/comment`, `project_member_add/remove`, `project_candidates`, `agent_fits`) that write English activity lines + notifications; `projects` module in `role_permissions`; storage path `<workspace>/<client>/p<project>/<file>`. First-version uuid projects are moved across once. Old `api/projects.js`, `api/inbox.js`, `lib/project-rules.js`, old pages and the `activity_log` table are gone. UI: `public/js/eco/pages/projects.js` + `project.js` (7 tabs + Team). `INVOICES_READY` stays false in `project.js` / `clients.js` until Phase 5.
