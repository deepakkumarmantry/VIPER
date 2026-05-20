# Development and validation

Use this guide for local development commands and validation checks.

## Python backend

Install dependencies:

```powershell
poetry install
```

Run the FastAPI backend:

```powershell
poetry run uvicorn cobrapy.api.app:app --host 0.0.0.0 --port 8000
```

Main endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/videos/upload` | Upload a video locally or to Azure Storage |
| `POST` | `/analysis/action-summary` | Run Action Summary analysis |
| `POST` | `/analysis/chapter-analysis` | Run Chapter Analysis |

## VIPER UI

The UI is optional for backend-only COBRA work. It requires PostgreSQL. Use `VIPER_AUTH_MODE=anonymous` only for local non-production smoke testing, or test EasyAuth after deploying to Azure Container Apps.

```powershell
Set-Location src\ui
npm install
npm run dev
```

The development server listens on port 3000 and proxies backend calls to `http://localhost:8000` by default.

## Tests and builds

Run Python tests:

```powershell
python -m pytest -q
```

Build Bicep:

```powershell
az bicep build --file infra\main.bicep
```

Build containers:

```powershell
docker build -f Dockerfile.backend -t viper-backend-localcheck .
docker build -f Dockerfile.frontend -t viper-frontend-localcheck .
```

Check the local analysis runner without invoking Azure services:

```powershell
python scripts\run_local_video_analysis.py --help
```

Run local MP4 analysis only when FFmpeg/ffprobe and real Azure service configuration are available:

```powershell
python scripts\run_local_video_analysis.py "C:\path\to\video.mp4" --output-dir outputs\local-smoke
```

## Deployed UI smoke expectations

Unauthenticated smoke:

| Path | Expected |
| --- | --- |
| `/login` | HTTP 200 and rendered Entra ID sign-in prompt |
| `/api/auth/session` | HTTP 410 because NextAuth credentials are disabled |
| `/dashboard` | Redirect to `/.auth/login/aad` |

Authenticated dashboard testing requires a valid Entra user and a mapped VIPER role. Set `VIPER_ADMIN_EMAILS` before deployment to bootstrap platform admins.

## Hygiene checks

Before committing:

```powershell
git --no-pager diff --check
git --no-pager status --short
```

Do not commit:

- `.env`
- generated videos
- generated local analysis outputs
- `infra\main.json`
- tenant IDs, subscription IDs, customer names, secrets, or environment-specific resource names
