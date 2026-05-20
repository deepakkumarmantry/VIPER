# Azure deployment

Deploy COBRA/VIPER with Azure Developer CLI (`azd`). Azure deployment is the primary path for hosted testing and tenant rollout.

## Deployment choices

| Mode | What is deployed | Use when |
| --- | --- | --- |
| Backend-only | COBRA FastAPI backend, Container Apps environment, ACR, Storage, Search | The caller will integrate directly with the COBRA API |
| Full stack | Backend-only resources plus the VIPER Next.js UI | Users need the browser UI, auth, and UI state |

Backend-only is the preferred first milestone for a new tenant because it avoids UI-only requirements such as EasyAuth app registration and PostgreSQL.

## Prerequisites

- Azure CLI (`az`)
- Azure Developer CLI (`azd`)
- Docker Desktop
- Azure subscription with permission to create resource groups, Container Apps, ACR, Storage, and Search
- Azure OpenAI or Azure AI Services resource with a chat/vision-capable deployment
- Azure Speech-capable resource when transcript generation is enabled

## Tenant isolation

When working with multiple tenants or subscriptions, isolate Azure CLI and azd state before any Azure command:

```powershell
$env:AZURE_CONFIG_DIR = "C:\Users\<you>\.azure-tenants\<alias>"
$env:AZD_CONFIG_DIR = "C:\Users\<you>\.azd-tenants\<alias>"
az login --tenant "<tenant-id>"
az account set --subscription "<subscription-name-or-id>"
az account show --query "{subscription:name, tenant:tenantId}" -o table
azd auth login
```

## Configure deployment values

Copy the template and set values for your environment:

```powershell
Copy-Item sample.env .env
```

At minimum, configure:

```text
AZURE_OPENAI_GPT_VISION_ENDPOINT="https://<resource>.cognitiveservices.azure.com/"
AZURE_OPENAI_GPT_VISION_API_VERSION="<api-version>"
AZURE_OPENAI_GPT_VISION_DEPLOYMENT="<deployment-name>"
AZURE_OPENAI_GPT_VISION_API_KEY=""

AZURE_SPEECH_REGION="<region>"
AZURE_SPEECH_USE_MANAGED_IDENTITY="true"
AZURE_SPEECH_RESOURCE_ID="/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.CognitiveServices/accounts/<resource-name>"
```

Load the `.env` values into the selected azd environment before provisioning:

```powershell
azd env set --file .env
```

See [configuration.md](configuration.md) for the full environment variable reference.

## Fill local `.env` from azd

After `azd env set --file .env`, `azd provision`, or `azd up`, the selected azd environment is the source of truth for deployment values. To quickly refresh a local `.env` from that azd environment:

```powershell
azd env get-values |
  Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } |
  Set-Content .env
```

This overwrites `.env`, and `.env` is ignored by git. Review the result before running local scripts.

## Backend-only deployment

Use this first when the goal is to expose only the COBRA API.

```powershell
azd env set --file .env
azd env set ENABLE_FRONTEND false
azd provision
azd deploy backend
```

The backend receives Storage/Search settings from infrastructure outputs and can use Entra ID for Azure OpenAI and Speech when API keys are blank.

## Full-stack deployment

Use this when the VIPER UI is required.

```powershell
azd up --no-prompt
```

Full-stack deployment also needs UI runtime values:

```text
VIPER_AUTH_MODE="easyauth"
VIPER_ADMIN_EMAILS="<admin1@contoso.com,admin2@contoso.com>"

FRONTEND_EASYAUTH_ENABLED="true"
FRONTEND_EASYAUTH_CLIENT_ID="<entra-app-client-id>"
FRONTEND_EASYAUTH_CLIENT_SECRET="<entra-app-client-secret>"
FRONTEND_EASYAUTH_OPENID_ISSUER=

# Choose one database option:
DATABASE_URL="<postgresql-connection-string>"
# or:
CREATE_POSTGRES="true"
POSTGRES_ADMINISTRATOR_PASSWORD="<strong-postgresql-password>"
```

Container Apps EasyAuth requires an Entra app registration. Configure its redirect URI for the deployed frontend callback:

```text
https://<frontend-fqdn>/.auth/login/aad/callback
```

If the frontend FQDN is not known yet, run a first provision with `FRONTEND_EASYAUTH_ENABLED=false` to create the Container App and get `SERVICE_FRONTEND_URL`, add the callback URI to the Entra app registration, then set `FRONTEND_EASYAUTH_ENABLED=true` and redeploy.

When `CREATE_POSTGRES=true`, azd provisions Azure Database for PostgreSQL Flexible Server and the frontend runs `prisma migrate deploy` before starting. Leave `CREATE_POSTGRES=false` when supplying a bring-your-own `DATABASE_URL`.

## What the deployment creates

- Azure Resource Group
- Azure Container Registry
- Azure Container Apps managed environment
- COBRA backend Container App
- VIPER frontend Container App when `ENABLE_FRONTEND` is not `false`
- Container Apps EasyAuth on the frontend when `FRONTEND_EASYAUTH_ENABLED=true`
- Azure Database for PostgreSQL Flexible Server when `CREATE_POSTGRES=true`
- Storage Account
- Azure AI Search
- Private endpoints and private DNS where configured

Cosmos DB is disabled by default because the current backend runtime does not require it.

## Keyless auth and RBAC

The Python backend uses this credential chain:

1. Azure Developer CLI credential
2. Azure CLI credential
3. Managed identity credential

When resource IDs are supplied, `azure.yaml` postprovision hooks assign backend managed identity RBAC:

| Variable | Role assigned |
| --- | --- |
| `AZURE_OPENAI_GPT_VISION_RESOURCE_ID` | `Cognitive Services OpenAI User` |
| `AZURE_SPEECH_RESOURCE_ID` | `Cognitive Services User` |

If you prefer to assign RBAC manually, leave these values blank and assign equivalent roles yourself.

## Post-deploy smoke tests

Check Container App health:

```powershell
$rg = azd env get-value AZURE_RESOURCE_GROUP
$backend = azd env get-value SERVICE_BACKEND_NAME
$frontend = azd env get-value SERVICE_FRONTEND_NAME

az containerapp revision list -g $rg -n $backend --query "[?properties.active].{name:name,health:properties.healthState,traffic:properties.trafficWeight}" -o table
if ($frontend) {
  az containerapp revision list -g $rg -n $frontend --query "[?properties.active].{name:name,health:properties.healthState,traffic:properties.trafficWeight}" -o table
}
```

Unauthenticated frontend smoke expectations:

| Path | Expected |
| --- | --- |
| `/login` | HTTP 200 and rendered Entra ID sign-in prompt |
| `/api/auth/session` | HTTP 410 because NextAuth credentials are disabled |
| `/dashboard` | Redirect to `/.auth/login/aad` when EasyAuth has not authenticated the user |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Deployed env vars contain literal `$(envOrDefault ...)` | azd env values were not loaded or unsupported parameter syntax was used | Use `${VAR}` in `infra\main.parameters.json` and run `azd env set --file .env` |
| Frontend redirects to `/.auth/login/aad` but sign-in fails | Missing or incorrect EasyAuth app registration values | Verify `FRONTEND_EASYAUTH_CLIENT_ID`, secret, issuer, and redirect URI |
| Frontend starts but dashboard database queries fail | Missing UI database or migrations | Supply `DATABASE_URL` or set `CREATE_POSTGRES=true`; the container runs `prisma migrate deploy` at startup |
| Backend cannot call Azure OpenAI | Wrong tenant context or missing RBAC | Verify isolated Azure login and assign `Cognitive Services OpenAI User` |
| Speech transcription auth fails | Missing Speech resource ID or RBAC | Set `AZURE_SPEECH_RESOURCE_ID` and assign `Cognitive Services User` |
| First provision cannot pull private ACR image | Managed identity/RBAC is not ready yet | Keep placeholder-image provision and postprovision registry setup in `azure.yaml` |
