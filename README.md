# SWARM Video Script Agent

Vercel-ready version of the SWARM script generator.

## Deploy on Vercel

1. Upload this folder or ZIP to a new Vercel project.
2. Keep the project framework as "Other" or "Static".
3. Deploy.

The app is served from `index.html`.
The research/script endpoint runs at:

```txt
/api/generate
```

## Optional X/Twitter research

Public X/Twitter indexing is limited. For direct recent tweet search, add one of these environment variables in Vercel:

```txt
X_BEARER_TOKEN
TWITTER_BEARER_TOKEN
```

Reddit and Amazon research work through public web/RSS/search endpoints.

## Local dev

If you have the Vercel CLI:

```bash
npm i -g vercel
vercel dev
```
