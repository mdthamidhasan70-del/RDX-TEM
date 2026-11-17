# RDX TEM Command Center

A full-stack React + Express app for guild/team orchestration, live stats, and bot management.

## Local development

1. Install dependencies:
   `npm install`
2. Copy `.env.example` to `.env` and fill in any required values.
3. Run the app:
   `npm run dev`
4. Open: `http://localhost:3000`

## Production build

```bash
npm run build
npm run start
```

## Deploy to Render

This repo includes a `render.yaml` file for a quick Render setup.

1. Push this folder to a new GitHub repository.
2. In Render, choose "New +" → "Blueprint" and connect the GitHub repo.
3. Render will read `render.yaml` and deploy the app automatically.
4. Set environment variables in Render if your app requires them.

## Notes

- The app serves the Vite build in production mode from `dist/`.
- The API lives under `/api/*` and is already active in local and deployed builds.
- The local runtime was verified live with the `/api/ping` endpoint returning a successful response.
