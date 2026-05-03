# Full-stack assessment (Vite + API)

## Layout

- **Root** — one command runs Vite and the API via npm workspaces.
- **frontend** — Vite on **5173**, `server.host: '0.0.0.0'` (required for host port mapping to the container).
- **backend** — API on **4000**; keep it internal; the browser only talks to **5173** and Vite **proxies** `/api/*` → the backend.

## Run

```bash
npm install
npm run dev
```

You should see both processes in one terminal. Open the **Preview** tab in the assessment UI (it points at your mapped **5173** port).

## How API calls work in preview

- Use **relative** URLs in the browser: `fetch('/api/health')`, not `http://localhost:4000/...`.
- The browser talks to the same origin as the Vite page (**5173**). Vite forwards `/api` to `http://127.0.0.1:4000`.

## If Preview is blank

1. Confirm `npm run dev` is running and Vite printed “ready” on 5173.
2. In this template, the backend must be up for `/api/health` to return 200 (check the terminal for “Backend listening on 4000”).
3. Click **Reload** on the preview toolbar.

## Seeded bugs (optional)

Decide per assessment whether work is in `frontend/`, `backend/`, or both. For DB work, add scripts like `db:reset` to `package.json` and document them here.
