# DEPLOY — davinci.darvioninnovations.in (free)

Target: one always-reachable HTTPS origin that also carries the Live-voice
**WebSocket**, on a free tier, at `davinci.darvioninnovations.in`.

The app is written for **Google Cloud Run + Firestore** (it auto-detects Cloud Run
via `K_SERVICE` and uses Application Default Credentials for Firestore — no key file
in the image). That's the primary path below. A **Render** fallback is included because
it's the fastest zero-GCP route and also supports WebSockets + a custom domain for free.

---

## Step 0 — Rotate the leaked credentials FIRST (do not skip)

The archive you sent contained live secrets. Before any deploy, invalidate them:

1. **Firebase service-account key** (`firebase-credentials.json`, project
   `davinci-demo-87dd2`): GCP Console → IAM & Admin → Service Accounts →
   `firebase-adminsdk-…` → **Keys** → delete the exposed key, create a new one only if
   you actually need a key file (Cloud Run does **not** — it uses ADC).
2. **The Google OAuth user tokens** that were in `data/users.json` (a real
   `refresh_token`/`access_token` for a Gmail account): go to
   <https://myaccount.google.com/permissions>, remove the app's access so that refresh
   token is revoked.
3. **The OAuth client secret** (client ID `385471549254-…`): APIs & Services →
   Credentials → your OAuth client → **Reset secret**. Put the new secret only in env,
   never in the repo.

The cleaned repo already git-ignores all three, so a fresh `git add .` won't re-leak
them — but the old values are compromised regardless and must be rotated.

---

## Primary path — Google Cloud Run (free tier) + Firestore

Free allowance (per month, plenty for a demo): 2M requests, 360k vCPU-sec,
180k GiB-sec, scales to zero when idle. WebSockets are supported.

### 1. One-time project setup

```bash
gcloud auth login
gcloud config set project davinci-demo-87dd2      # your existing project

gcloud services enable run.googleapis.com \
  firestore.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

Create the Firestore database once (Native mode, region near you, e.g. asia-south1):

```bash
gcloud firestore databases create --location=asia-south1
```

### 2. Store secrets in Secret Manager (recommended over plain env)

```bash
gcloud services enable secretmanager.googleapis.com
for S in ANTHROPIC_API_KEY GEMINI_API_KEY OPENAI_API_KEY GOOGLE_CLIENT_SECRET; do
  printf "PUT_VALUE_HERE" | gcloud secrets create "$S" --data-file=- 2>/dev/null \
    || printf "PUT_VALUE_HERE" | gcloud secrets versions add "$S" --data-file=-
done
```

(Replace `PUT_VALUE_HERE` with each real value — run one at a time.)

### 3. Deploy from source (Cloud Build reads the Dockerfile)

```bash
gcloud run deploy davinci \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 --max-instances 2 \
  --timeout 3600 \
  --set-env-vars NODE_ENV=production,STORE_BACKEND=firestore,LLM_VENDOR=anthropic \
  --set-env-vars GOOGLE_CLIENT_ID=385471549254-o958ccrenmjirbqtgm5rtl87t1nj60jp.apps.googleusercontent.com \
  --set-env-vars GOOGLE_REDIRECT_URI=https://davinci.darvioninnovations.in/api/auth/google/callback \
  --set-env-vars APP_ORIGIN=https://davinci.darvioninnovations.in \
  --set-secrets ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest \
  --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest \
  --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest \
  --set-secrets GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest
```

Grant the runtime service account Firestore access (once):

```bash
PROJ=davinci-demo-87dd2
SA="$(gcloud run services describe davinci --region asia-south1 \
      --format='value(spec.template.spec.serviceAccountName)')"
gcloud projects add-iam-policy-binding "$PROJ" \
  --member="serviceAccount:${SA}" --role="roles/datastore.user"
```

The deploy prints a `…run.app` URL — confirm it loads before wiring the domain.

### 4. Map the custom subdomain

```bash
# verify the domain once (opens a TXT-record verification flow):
gcloud domains verify darvioninnovations.in

gcloud beta run domain-mappings create \
  --service davinci --region asia-south1 \
  --domain davinci.darvioninnovations.in
```

That command prints the DNS records to add. In your `darvioninnovations.in` DNS
(wherever the zone is hosted), add the shown record for the `davinci` subdomain —
usually a `CNAME davinci → ghs.googlehosted.com`. TLS is auto-provisioned; propagation
takes a few minutes to ~an hour.

> If Cloud Run domain mapping isn't offered in `asia-south1` at deploy time, deploy the
> same service in `us-central1` and map there instead — everything else is identical.

### 5. Point Google OAuth at the live URL

APIs & Services → Credentials → your OAuth client:
- **Authorized redirect URIs**: add
  `https://davinci.darvioninnovations.in/api/auth/google/callback`
- **Authorized JavaScript origins**: add `https://davinci.darvioninnovations.in`

Redeploys: just re-run the `gcloud run deploy … --source .` command.

---

## Fallback — Render (fastest, no GCP LB) 

Free web service; supports WebSockets and a custom domain with free TLS. Trade-off: the
instance sleeps after ~15 min idle, so the first hit after idle cold-starts (~30–60 s).

1. Push the cleaned repo to GitHub.
2. Render → **New → Web Service** → connect the repo.
   - Environment: **Docker** (uses the `Dockerfile`), or Node with
     Build `npm install && npm run build`, Start `npm start`.
   - Add env vars from `.env.example` (the four keys + `GOOGLE_CLIENT_ID`,
     `GOOGLE_REDIRECT_URI`, `APP_ORIGIN`, `NODE_ENV=production`).
   - Firestore on Render needs a key file: set `GOOGLE_APPLICATION_CREDENTIALS` to a
     Secret File containing the **new** service-account JSON (from Step 0), or set
     `STORE_BACKEND=file` for a stateless demo (data resets on restart).
3. Settings → **Custom Domains** → add `davinci.darvioninnovations.in`; Render shows a
   `CNAME` to add in your DNS.
4. Update the OAuth redirect URI/origin as in Primary Step 5.

---

## What only you can do

I prepared and build-verified the repo, but these require your accounts/access:

- Provide the API keys and the (rotated) OAuth client secret.
- Run the `gcloud`/Render deploy against **your** project (auth is yours).
- Add the DNS record for the `davinci` subdomain in the `darvioninnovations.in` zone.
- Rotate the leaked credentials (Step 0).

## Smoke test after deploy

```bash
curl -I https://davinci.darvioninnovations.in            # 200, TLS valid
```
Then open the site, click **Sign in**, complete Google login, and confirm Vision +
Live voice work (Live confirms the WebSocket upgrade is passing through the domain).
