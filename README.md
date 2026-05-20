# COBRA / VIPER

COBRA is a Python video-analysis backend for extracting structured insights from video with Azure Speech and vision-capable Azure OpenAI deployments. VIPER is the optional Next.js UI that can sit in front of the COBRA API.

This README is the index. Start with Azure deployment so the required Azure AI resources exist, then use local validation when you want the easier path for testing one MP4.

## Contents

| Section | Start here when |
| --- | --- |
| [Deploy to Azure](#start-here-deploy-to-azure) | You want to host COBRA or the full COBRA/VIPER app |
| [Validate locally on one MP4](#then-validate-locally-on-one-mp4) | Azure AI resources already exist and you want a quick real-service test |
| [Documentation index](#documentation-index) | You need detailed setup, configuration, deployment, or development docs |
| [Repository layout](#repository-layout) | You want to understand where code and infrastructure live |
| [Principles](#principles) | You are changing code or docs and need project guardrails |
| [Contributing](#contributing) | You are opening a PR or need project policy links |

## Start here: deploy to Azure

Use Azure Developer CLI (`azd`) for deployment.

| Deployment | Use when | Command |
| --- | --- | --- |
| Backend-only COBRA API | You only need the API for video upload and analysis | `azd provision` then `azd deploy backend` |
| Full COBRA + VIPER UI | You also need the browser UI, auth, and PostgreSQL-backed UI state | `azd up --no-prompt` |

Minimal flow:

```powershell
Copy-Item sample.env .env
# Edit .env with Azure OpenAI/Speech settings and deployment choices.
# For full-stack UI, also set EasyAuth and PostgreSQL values.
azd env set --file .env
azd up --no-prompt
```

For backend-only deployment:

```powershell
Copy-Item sample.env .env
# Edit .env with Azure OpenAI/Speech settings and set ENABLE_FRONTEND=false.
azd env set --file .env
azd env set ENABLE_FRONTEND false
azd provision
azd deploy backend
```

Detailed guide: [docs/azure-deployment.md](docs/azure-deployment.md)

## Then validate locally on one MP4

Local validation is the easier test path after Azure OpenAI/Azure AI Services and Speech resources exist. If you do not have those resources yet, start with Azure deployment above. You can use existing AI resources, or deploy/provision first and then hydrate `.env` from the selected azd environment:

```powershell
azd env get-values |
  Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } |
  Set-Content .env
```

This overwrites the local `.env` file, which is ignored by git. Review the file, then run the real COBRA pipeline against a local video file:

```powershell
python -m pip install -e .
python scripts\run_local_video_analysis.py "C:\path\to\video.mp4" `
  --output-dir outputs\my-video `
  --segment-length 10 `
  --fps 0.5
```

Skip Speech transcription if you only need visual analysis:

```powershell
python scripts\run_local_video_analysis.py "C:\path\to\video.mp4" --no-transcripts
```

Detailed guide: [docs/local-validation.md](docs/local-validation.md)

## Documentation index

| Document | Purpose |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Component architecture, runtime flows, auth model, and deployment topology |
| [docs/azure-deployment.md](docs/azure-deployment.md) | Azure deployment with azd, backend-only vs full-stack, RBAC, smoke tests |
| [docs/local-validation.md](docs/local-validation.md) | Local MP4 validation with the CLI script or notebook |
| [docs/configuration.md](docs/configuration.md) | Environment variables and keyless auth configuration |
| [docs/development.md](docs/development.md) | Local backend/UI development and validation commands |
| [azure/README.md](azure/README.md) | Additional Azure infrastructure details |
| [AGENTS.md](AGENTS.md) | Coding-agent rules for this repository |

## Repository layout

| Path | Purpose |
| --- | --- |
| `src\cobrapy` | COBRA Python package, preprocessing, analysis, Azure integration, and FastAPI backend |
| `src\ui` | VIPER Next.js UI |
| `scripts\run_local_video_analysis.py` | Local MP4 validation runner |
| `samples\cobra_sample_usage.ipynb` | Notebook version of the local validation flow |
| `infra\main.bicep` and `azure\containerapps.bicep` | azd/Bicep deployment templates |
| `azure.yaml` | Azure Developer CLI service and deployment hooks |
| `sample.env` | Environment variable template |

## Principles

- Real code paths only: no stubbed analysis or fake model responses.
- Prefer Entra ID and managed identity. API keys are optional where keyless auth is supported.
- Keep tenant, subscription, customer, and resource-specific values out of committed files.
- Keep generated videos and analysis outputs out of git.

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information, see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com).

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow [Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general). Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos is subject to those third party's policies.
