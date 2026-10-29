# Repeat Cult — Vercel + PostgreSQL

This version replaces local SQLite (`better-sqlite3`) with hosted PostgreSQL (`pg`) and exposes the Express app as a Vercel serverless function.

## 1. Create a hosted PostgreSQL database
Create a database on Neon or Supabase and copy its PostgreSQL connection string. Keep the string private.

## 2. Configure environment variables
In Vercel: Project → Settings → Environment Variables, add:
- `DATABASE_URL` = your provider's PostgreSQL connection string

Add the same variable to a local `.env` file for local development (do not commit `.env`). `.env.example` is only a template.

## 3. Deploy
Replace `db.js`, `server.js`, and `package.json`; add `api/index.js` and `vercel.json`. Remove the old `package-lock.json` (it still references `better-sqlite3`) and run `npm install` locally to generate a fresh lockfile, then commit/upload it. Upload/commit these project files, then redeploy. On first request, `db.js` creates the required tables and indexes automatically. Check `/api/health`; it should report PostgreSQL and `configured: true`.

## 4. Important data note
This code does **not** import the old `data/repeatcult.db` file. If it contains real customers, orders, or subscribers, export/migrate that data to PostgreSQL before switching production traffic. The old database is not deleted. The previous automatic demo-order seeding has been disabled so production won't create fake customer/order records.

## 5. Local development
Install dependencies with `npm install`, set `DATABASE_URL`, then run `npm start`.

## API notes
Existing REST endpoints and response shapes are retained. PostgreSQL database operations are asynchronous. CSV exports, customer/order CRUD, newsletter subscriptions, and dashboard statistics use the hosted database.
