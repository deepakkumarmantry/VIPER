# Agent guidance for COBRA / VIPER

Follow these repository-specific rules when acting as a coding agent.

## Scope

- COBRA backend and library code is in `src/cobrapy`.
- VIPER UI code is in `src/ui`.
- Azure Developer CLI and Bicep assets are in `azure.yaml`, `infra/`, and `azure/`.
- Local validation assets are `scripts/run_local_video_analysis.py`, `samples/cobra_sample_usage.ipynb`, and `LOCAL_TESTING.md`.

## Required behavior

- Use real code paths only. Do not add stubs, fake model responses, sample-only bypasses, or success-shaped fallbacks.
- Prefer Entra ID and managed identity. API keys must remain optional where keyless auth is supported.
- Keep generated files and local media out of git. Do not commit `.env`, `outputs/`, `samples/local-test/`, or generated `infra/main.json`.
- Keep examples generic. Do not write customer names, tenant IDs, subscription IDs, or internal resource names into committed files.

## Implementation rules

- Reuse `src/cobrapy/azure_credentials.py` for Azure SDK clients.
- Preserve Azure OpenAI keyless auth when `AZURE_OPENAI_GPT_VISION_API_KEY` is blank.
- Preserve Azure Speech Entra token formatting: `aad#<resourceId>#<token>`.
- Preserve Speech-compatible audio extraction: WAV, `pcm_s16le`, mono, 16 kHz.
- Preserve `VideoClient(upload_to_azure=False)` as local-only and avoid Storage/Search initialization unless needed for remote blob input.
- Keep backend-only deployment working with `ENABLE_FRONTEND=false`.

## Validation commands

Use existing validation commands only:

```powershell
python -m pytest -q
az bicep build --file infra\main.bicep
docker build -f Dockerfile.backend -t viper-backend-localcheck .
docker build -f Dockerfile.frontend -t viper-frontend-localcheck .
```

Run local video analysis only when FFmpeg/ffprobe and real Azure service configuration are available:

```powershell
python scripts\run_local_video_analysis.py "C:\path\to\video.mp4" --output-dir outputs\local-smoke
```

## Deployment notes

- Always load azd env values before deployment: `azd env set --file .env`.
- Full stack: `azd up --no-prompt`.
- Backend only: set `ENABLE_FRONTEND=false`, then `azd provision` and `azd deploy backend`.
- If assigning BYO AI RBAC, use `AZURE_OPENAI_GPT_VISION_RESOURCE_ID` and `AZURE_SPEECH_RESOURCE_ID`.
