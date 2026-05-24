"""
Post-provision hook: configure ACR registry on Container Apps and assign BYO AI roles.

Replaces the shell-based postprovision hook in azure.yaml so that only `azd`
authentication is needed (AzureDeveloperCliCredential). No `az login` required.
"""

import subprocess
import sys


def _ensure_packages():
    """Install required packages into whichever Python is running this script."""
    pkgs = ["azure-identity", "python-dotenv"]
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "--quiet", *pkgs],
        stdout=subprocess.DEVNULL,
    )


_ensure_packages()

import json
import os
import urllib.error
import urllib.request
import uuid

from azure.identity import AzureDeveloperCliCredential, DefaultAzureCredential
from dotenv import load_dotenv

MANAGEMENT_SCOPE = "https://management.azure.com/.default"
API_VERSION_APPS = "2024-03-01"
API_VERSION_RBAC = "2022-04-01"

# Role name -> well-known GUID
ROLE_GUIDS = {
    "Cognitive Services OpenAI User": "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd",
    "Cognitive Services User": "a97b65f3-24c7-4388-baec-2e87135dc908",
}


def get_credential():
    """Return a credential that works with azd's active session."""
    try:
        cred = AzureDeveloperCliCredential()
        # Probe to confirm it works before returning
        cred.get_token(MANAGEMENT_SCOPE)
        return cred
    except Exception:
        return DefaultAzureCredential()


def _fresh_token(credential):
    return credential.get_token(MANAGEMENT_SCOPE).token


def _request(method, url, credential, body=None):
    token = _fresh_token(credential)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {exc.code} {exc.reason} — {url}\n{detail}") from exc


def azd_env_get(key):
    result = subprocess.run(
        ["azd", "env", "get-value", key],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def get_container_app(credential, subscription_id, resource_group, app_name):
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}"
        f"/resourceGroups/{resource_group}/providers/Microsoft.App"
        f"/containerApps/{app_name}?api-version={API_VERSION_APPS}"
    )
    return _request("GET", url, credential)


def configure_acr_registry(credential, subscription_id, resource_group, app_name, acr_server):
    """Add/update the ACR registry entry on a Container App using system identity."""
    app = get_container_app(credential, subscription_id, resource_group, app_name)

    existing_registries = (
        app.get("properties", {})
        .get("configuration", {})
        .get("registries", [])
    ) or []
    # Replace any existing entry for this server and ensure the system identity is set
    updated = [r for r in existing_registries if r.get("server") != acr_server]
    updated.append({"server": acr_server, "identity": "system"})

    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}"
        f"/resourceGroups/{resource_group}/providers/Microsoft.App"
        f"/containerApps/{app_name}?api-version={API_VERSION_APPS}"
    )
    patch_body = {"properties": {"configuration": {"registries": updated}}}
    _request("PATCH", url, credential, patch_body)
    print(f"  Configured ACR registry '{acr_server}' on '{app_name}'")


def get_principal_id(credential, subscription_id, resource_group, app_name):
    app = get_container_app(credential, subscription_id, resource_group, app_name)
    return app.get("identity", {}).get("principalId", "")


def assign_role_if_needed(credential, subscription_id, principal_id, resource_id, role_name):
    if not resource_id or not principal_id:
        return

    role_guid = ROLE_GUIDS.get(role_name)
    if not role_guid:
        raise ValueError(f"Unknown role name: '{role_name}'")

    role_definition_id = (
        f"/subscriptions/{subscription_id}/providers"
        f"/Microsoft.Authorization/roleDefinitions/{role_guid}"
    )

    # Check whether the assignment already exists
    list_url = (
        f"https://management.azure.com{resource_id}"
        f"/providers/Microsoft.Authorization/roleAssignments"
        f"?api-version={API_VERSION_RBAC}&$filter=assignedTo('{principal_id}')"
    )
    try:
        existing = _request("GET", list_url, credential)
        for assignment in existing.get("value", []):
            assigned_role = assignment.get("properties", {}).get("roleDefinitionId", "")
            if assigned_role.lower().endswith(role_guid.lower()):
                print(f"  Role '{role_name}' already assigned — skipping")
                return
    except RuntimeError:
        pass  # If listing fails, attempt to create anyway

    assignment_id = str(uuid.uuid4())
    create_url = (
        f"https://management.azure.com{resource_id}"
        f"/providers/Microsoft.Authorization/roleAssignments/{assignment_id}"
        f"?api-version={API_VERSION_RBAC}"
    )
    body = {
        "properties": {
            "roleDefinitionId": role_definition_id,
            "principalId": principal_id,
            "principalType": "ServicePrincipal",
        }
    }
    _request("PUT", create_url, credential, body)
    print(f"  Assigned role '{role_name}' to principal '{principal_id}' on '{resource_id}'")


def main():
    load_dotenv()

    print("Post-provision: authenticating via azd credentials...")
    credential = get_credential()

    subscription_id = azd_env_get("AZURE_SUBSCRIPTION_ID")
    resource_group = azd_env_get("AZURE_RESOURCE_GROUP")
    acr = azd_env_get("AZURE_CONTAINER_REGISTRY_ENDPOINT")
    backend_app = azd_env_get("SERVICE_BACKEND_NAME")
    frontend_app = azd_env_get("SERVICE_FRONTEND_NAME")

    if not subscription_id or not resource_group or not acr or not backend_app:
        raise RuntimeError(
            "Required azd environment values are missing. "
            "Run `azd env get-values` to inspect the environment."
        )

    print(f"\nConfiguring ACR registry on container apps (resource group: {resource_group})...")
    configure_acr_registry(credential, subscription_id, resource_group, backend_app, acr)
    if frontend_app:
        configure_acr_registry(credential, subscription_id, resource_group, frontend_app, acr)

    print("\nResolving backend managed identity...")
    backend_principal_id = get_principal_id(credential, subscription_id, resource_group, backend_app)
    if not backend_principal_id:
        raise RuntimeError(f"Could not retrieve principalId for container app '{backend_app}'")
    print(f"  Backend principal ID: {backend_principal_id}")

    print("\nAssigning BYO AI roles (if configured)...")
    openai_resource_id = os.environ.get("AZURE_OPENAI_GPT_VISION_RESOURCE_ID", "").strip().strip('"')
    speech_resource_id = os.environ.get("AZURE_SPEECH_RESOURCE_ID", "").strip().strip('"')

    if openai_resource_id:
        assign_role_if_needed(
            credential, subscription_id, backend_principal_id,
            openai_resource_id, "Cognitive Services OpenAI User",
        )
    if speech_resource_id:
        assign_role_if_needed(
            credential, subscription_id, backend_principal_id,
            speech_resource_id, "Cognitive Services User",
        )

    print("\nPost-provision completed successfully.")


if __name__ == "__main__":
    main()
