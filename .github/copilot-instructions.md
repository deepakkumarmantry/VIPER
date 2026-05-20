# Copilot instructions for COBRA / VIPER

This repository contains COBRA, a Python video-analysis library and FastAPI backend, plus VIPER, an optional Next.js UI. Keep changes aligned with the architecture, Azure deployment, and real-service local validation flows documented in `README.md`, `docs/architecture.md`, `docs/azure-deployment.md`, and `docs/local-validation.md`.

## Non-negotiables

- Do not add stubs, fake model responses, or mock analysis paths to product code or documentation. Local validation must call real preprocessing, real Azure Speech when transcripts are enabled, and real Azure OpenAI.
- Prefer Entra ID authentication. Keep API keys optional and never require keys when managed identity or developer credentials can be used.
- Do not commit `.env`, generated videos, local analysis outputs, Bicep build output, secrets, tenant IDs, subscription IDs, customer names, or environment-specific resource names.
- Preserve `VideoClient(upload_to_azure=False)` as a local-only mode that does not initialize Storage or Search unless remote blob input requires Storage.

## Architecture notes

- Python package and FastAPI backend live under `src/cobrapy`.
- Next.js UI lives under `src/ui`.
- Azure deployment is driven by `azure.yaml`, `infra/main.bicep`, and `azure/containerapps.bicep`.
- Local MP4 validation uses `scripts/run_local_video_analysis.py` and `samples/cobra_sample_usage.ipynb`.
- Generated local artifacts belong under `outputs/` or `samples/local-test/`, both ignored by git.

## Azure authentication patterns

- Reuse `src/cobrapy/azure_credentials.py` for Azure SDK credentials.
- The credential chain should support local development and Azure hosting: Azure Developer CLI, Azure CLI, then managed identity.
- Azure OpenAI uses `azure_ad_token_provider` when `AZURE_OPENAI_GPT_VISION_API_KEY` is blank.
- Azure Speech managed identity auth requires `AZURE_SPEECH_RESOURCE_ID` and formats tokens as `aad#<resourceId>#<token>`.
- Deployment-time BYO AI RBAC is handled in `azure.yaml` postprovision hooks using `AZURE_OPENAI_GPT_VISION_RESOURCE_ID` and `AZURE_SPEECH_RESOURCE_ID`.

## Audio and video processing

- Extract audio for Speech as WAV PCM: `pcm_s16le`, mono, 16 kHz, `-f wav`.
- Do not reintroduce MP3 extraction for Speech SDK file transcription.
- Keep FFmpeg and ffprobe prerequisite checks explicit in user-facing local test paths.

## Deployment conventions

- Use `azd env set --file .env` before `azd up`, `azd provision`, or `azd deploy`.
- Keep full-stack deployment as the default.
- Preserve backend-only deployment with `ENABLE_FRONTEND=false`, `azd provision`, and `azd deploy backend`.
- Leave Cosmos disabled by default unless runtime code starts depending on it.
- Keep first-run ACR bootstrap safe: provision with placeholder images, configure Container Apps registry after identities/RBAC exist, then deploy real images.

## Validation

Run the narrowest checks that cover the change, and prefer these existing commands:

```powershell
python -m pytest -q
az bicep build --file infra\main.bicep
docker build -f Dockerfile.backend -t viper-backend-localcheck .
docker build -f Dockerfile.frontend -t viper-frontend-localcheck .
python scripts\run_local_video_analysis.py --help
```

For deployed frontend smoke tests, unauthenticated expected behavior is:

- `/login` returns HTTP 200 and renders the Entra ID sign-in prompt.
- `/api/auth/session` returns HTTP 410 because NextAuth credentials are disabled.
- `/dashboard` redirects to `/.auth/login/aad`.

## Documentation

- Keep `README.md` as an Azure-first index, not a long how-to.
- Update `docs/architecture.md` for architecture, runtime flow, auth model, or deployment topology changes.
- Update `docs/azure-deployment.md` for deployment changes.
- Update `docs/local-validation.md` for local MP4 workflow changes.
- Update `docs/configuration.md` for environment variable changes.
- Keep examples generic and free of tenant/resource/customer-specific values.
