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
