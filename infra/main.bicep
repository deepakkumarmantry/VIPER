targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment that can be used as part of naming resource convention')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

// Optional parameters to override defaults
@description('Name of the resource group to create or use')
param resourceGroupName string = ''

@description('Name of the Azure Container Registry')
param acrName string = ''

@description('Name of the Container Apps managed environment')
param managedEnvironmentName string = ''

@description('Name of the Log Analytics workspace')
param logAnalyticsWorkspaceName string = ''

@description('Name of the backend container app')
param backendContainerAppName string = ''

@description('Name of the frontend container app')
param frontendContainerAppName string = ''

@description('Name of the virtual network')
param virtualNetworkName string = ''

@description('Name of the Storage Account')
param storageAccountName string = ''

@description('Name of the Azure AI Search service')
param searchServiceName string = ''

@description('Name of the Azure Cosmos DB account')
param cosmosAccountName string = ''

@description('Name of the Azure Database for PostgreSQL Flexible Server used by the full-stack UI')
param postgresServerName string = ''

@description('Create a new Azure Cosmos DB account for manifest storage. Disabled by default because VIPER currently does not use Cosmos at runtime.')
param createCosmosAccount bool = false

@description('Create Azure Database for PostgreSQL for the full-stack VIPER UI. Ignored when the frontend is disabled.')
param createPostgres string = 'false'

@description('Provision the Viper frontend container app. Set to false for backend-only COBRA API deployments.')
param enableFrontend string = 'true'

@description('Azure AI Search index name')
param searchIndexName string = 'viper-search'

@description('Storage container for videos')
param storageVideoContainer string = 'videos'

@description('Storage container for analysis output')
param storageOutputContainer string = 'analysis'

@description('Cosmos DB database name')
param cosmosDatabaseName string = 'viper'

@description('Cosmos DB container name')
param cosmosContainerName string = 'manifests'

// Environment variables from .env file (passed via azd)
@secure()
@description('Azure OpenAI GPT Vision API Key')
param azureOpenaiGptVisionApiKey string = ''

@description('Azure OpenAI GPT Vision Endpoint')
param azureOpenaiGptVisionEndpoint string = ''

@description('Azure OpenAI GPT Vision API Version')
param azureOpenaiGptVisionApiVersion string = '2024-06-01'

@description('Azure OpenAI GPT Vision Deployment name')
param azureOpenaiGptVisionDeployment string = 'gpt4o'

@description('Azure OpenAI or Azure AI Services resource ID used for backend managed identity RBAC')
param azureOpenaiGptVisionResourceId string = ''

@description('Azure Speech Region')
param azureSpeechRegion string = ''

@description('Azure Speech use managed identity')
param azureSpeechUseManagedIdentity string = 'true'

@description('Azure Speech or AI Services resource ID for Entra ID authentication')
param azureSpeechResourceId string = ''

@description('Azure Storage Account URL (auto-generated if not provided)')
param azureStorageAccountUrl string = ''

@description('Azure Search Endpoint (auto-generated if not provided)')
param azureSearchEndpoint string = ''

@secure()
@description('Azure OpenAI Key for UI')
param azOpenaiKey string = ''

@description('Azure OpenAI Base URL for UI')
param azOpenaiBase string = ''

@description('Azure OpenAI Version for UI')
param azOpenaiVersion string = ''

@description('GPT4 deployment name')
param gpt4 string = '4turbo'

@description('Search endpoint for UI')
param searchEndpoint string = ''

@secure()
@description('Search API Key for UI')
param searchApiKey string = ''

@secure()
@description('Database connection URL')
param databaseUrl string = ''

@description('VIPER UI auth mode. Use easyauth for Azure Container Apps EasyAuth, or anonymous only for non-production local smoke testing.')
param viperAuthMode string = ''

@description('Comma-separated list of Entra user emails that should receive VIPER ADMIN role on sign-in.')
param viperAdminEmails string = ''

@description('Enable Azure Container Apps EasyAuth on the frontend.')
param frontendEasyAuthEnabled string = ''

@description('Entra app registration client ID used by Container Apps EasyAuth.')
param frontendEasyAuthClientId string = ''

@secure()
@description('Entra app registration client secret used by Container Apps EasyAuth.')
param frontendEasyAuthClientSecret string = ''

@description('Optional Entra OpenID issuer override. Leave blank to use the deployment tenant.')
param frontendEasyAuthOpenIdIssuer string = ''

@description('PostgreSQL administrator login when createPostgres is true.')
param postgresAdministratorLogin string = 'viperadmin'

@secure()
@description('PostgreSQL administrator password when createPostgres is true.')
param postgresAdministratorPassword string = ''

@description('PostgreSQL database name when createPostgres is true.')
param postgresDatabaseName string = 'viper'

// Tags for all resources
var tags = {
  'azd-env-name': environmentName
  'SOLUTION OWNER': 'luis_yamada@bat.com'
  'CHARGING-TYPE': 'Core Platform'
  'CUST-CODE': 'To Be Filled'
  'CUST-CODE OWNER': 'omar_vazquez@bat.com'
  APPLICATION: 'To Be Filled'
  RFC: 'To Be Filled'
  ENVIRONMENT: 'Sandbox'
}

// Generate resource names if not provided
var abbrs = {
  resourceGroup: 'rg-'
  containerRegistry: 'acr'
  containerAppsEnvironment: 'cae-'
  containerApp: 'ca-'
  logAnalyticsWorkspace: 'log-'
  virtualNetwork: 'vnet-'
  storageAccount: 'st'
  searchService: 'srch-'
  cosmosAccount: 'cosmos-'
}

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var resolvedResourceGroupName = !empty(resourceGroupName) ? resourceGroupName : '${abbrs.resourceGroup}${environmentName}'
var resolvedAcrName = !empty(acrName) ? acrName : '${abbrs.containerRegistry}${resourceToken}'
var resolvedManagedEnvironmentName = !empty(managedEnvironmentName) ? managedEnvironmentName : '${abbrs.containerAppsEnvironment}${environmentName}'
var resolvedLogAnalyticsName = !empty(logAnalyticsWorkspaceName) ? logAnalyticsWorkspaceName : '${abbrs.logAnalyticsWorkspace}${environmentName}'
var resolvedBackendAppName = !empty(backendContainerAppName) ? backendContainerAppName : '${abbrs.containerApp}backend-${resourceToken}'
var resolvedFrontendAppName = !empty(frontendContainerAppName) ? frontendContainerAppName : '${abbrs.containerApp}frontend-${resourceToken}'
var resolvedVirtualNetworkName = !empty(virtualNetworkName) ? virtualNetworkName : '${abbrs.virtualNetwork}${environmentName}'
var resolvedStorageAccountName = !empty(storageAccountName) ? storageAccountName : '${abbrs.storageAccount}${resourceToken}'
var resolvedSearchServiceName = !empty(searchServiceName) ? searchServiceName : '${abbrs.searchService}${resourceToken}'
var resolvedCosmosAccountName = createCosmosAccount ? (!empty(cosmosAccountName) ? cosmosAccountName : '${abbrs.cosmosAccount}${resourceToken}') : cosmosAccountName
var resolvedPostgresServerName = !empty(postgresServerName) ? postgresServerName : 'psql-${environmentName}-${resourceToken}'
var containerAppProvisionImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
var deployFrontend = toLower(trim(enableFrontend)) != 'false'
var deployPostgres = deployFrontend && toLower(trim(createPostgres)) == 'true'
var deployFrontendEasyAuth = deployFrontend && toLower(trim(frontendEasyAuthEnabled)) == 'true'

// Resource Group
resource rg 'Microsoft.Resources/resourceGroups@2022-09-01' = {
  name: resolvedResourceGroupName
  location: location
  tags: tags
}

// Azure Container Registry
module acr 'modules/acr.bicep' = {
  name: 'acr'
  scope: rg
  params: {
    name: resolvedAcrName
    location: location
    tags: tags
  }
}

// Compute endpoint URLs (use provided values or generate from resource names)
var computedStorageAccountUrl = !empty(azureStorageAccountUrl) ? azureStorageAccountUrl : 'https://${resolvedStorageAccountName}.blob.${environment().suffixes.storage}'
var computedSearchEndpoint = !empty(azureSearchEndpoint) ? azureSearchEndpoint : 'https://${resolvedSearchServiceName}.search.windows.net'

module postgres 'modules/postgres.bicep' = if (deployPostgres) {
  name: 'postgres'
  scope: rg
  params: {
    name: resolvedPostgresServerName
    location: location
    tags: tags
    administratorLogin: postgresAdministratorLogin
    administratorPassword: postgresAdministratorPassword
    databaseName: postgresDatabaseName
  }
}

var resolvedDatabaseUrl = deployPostgres ? postgres.outputs.databaseUrl : databaseUrl

// Build environment variables for backend
var backendEnvVars = {
  AZURE_OPENAI_GPT_VISION_API_KEY: azureOpenaiGptVisionApiKey
  AZURE_OPENAI_GPT_VISION_ENDPOINT: azureOpenaiGptVisionEndpoint
  AZURE_OPENAI_GPT_VISION_API_VERSION: azureOpenaiGptVisionApiVersion
  AZURE_OPENAI_GPT_VISION_DEPLOYMENT: azureOpenaiGptVisionDeployment
  AZURE_OPENAI_GPT_VISION_RESOURCE_ID: azureOpenaiGptVisionResourceId
  AZURE_SPEECH_REGION: azureSpeechRegion
  AZURE_SPEECH_USE_MANAGED_IDENTITY: azureSpeechUseManagedIdentity
  AZURE_SPEECH_RESOURCE_ID: azureSpeechResourceId
  AZURE_STORAGE_ACCOUNT_URL: computedStorageAccountUrl
  AZURE_STORAGE_VIDEO_CONTAINER: storageVideoContainer
  AZURE_STORAGE_OUTPUT_CONTAINER: storageOutputContainer
  AZURE_SEARCH_ENDPOINT: computedSearchEndpoint
  AZURE_SEARCH_INDEX_NAME: searchIndexName
  DATABASE_URL: databaseUrl
}

// Compute frontend search endpoint (use provided value or computed value)
var computedFrontendSearchEndpoint = !empty(searchEndpoint) ? searchEndpoint : computedSearchEndpoint

// Build environment variables for frontend
var frontendEnvVars = {
  AZ_OPENAI_KEY: azOpenaiKey
  AZ_OPENAI_BASE: azOpenaiBase
  AZ_OPENAI_VERSION: azOpenaiVersion
  GPT4: gpt4
  SEARCH_ENDPOINT: computedFrontendSearchEndpoint
  SEARCH_API_KEY: searchApiKey
  INDEX_NAME: searchIndexName
  DATABASE_URL: resolvedDatabaseUrl
  VIPER_AUTH_MODE: viperAuthMode
  VIPER_ADMIN_EMAILS: viperAdminEmails
}

// Deploy Container Apps infrastructure using existing bicep
module containerApps '../azure/containerapps.bicep' = {
  name: 'containerApps'
  scope: rg
  params: {
    location: location
    acrName: acr.outputs.name
    managedEnvironmentName: resolvedManagedEnvironmentName
    logAnalyticsWorkspaceName: resolvedLogAnalyticsName
    backendContainerAppName: resolvedBackendAppName
    frontendContainerAppName: resolvedFrontendAppName
    backendImage: containerAppProvisionImage
    frontendImage: containerAppProvisionImage
    enableFrontend: deployFrontend
    tags: tags
    frontendEasyAuthEnabled: deployFrontendEasyAuth
    frontendEasyAuthClientId: frontendEasyAuthClientId
    frontendEasyAuthClientSecret: frontendEasyAuthClientSecret
    frontendEasyAuthOpenIdIssuer: frontendEasyAuthOpenIdIssuer
    configureAcrRegistry: false
    virtualNetworkName: resolvedVirtualNetworkName
    storageAccountName: resolvedStorageAccountName
    searchServiceName: resolvedSearchServiceName
    createCosmosAccount: createCosmosAccount
    cosmosAccountName: resolvedCosmosAccountName
    cosmosDatabaseName: cosmosDatabaseName
    cosmosContainerName: cosmosContainerName
    backendEnvVars: backendEnvVars
    frontendEnvVars: frontendEnvVars
  }
}

// Outputs for azd
output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = acr.outputs.loginServer
output AZURE_CONTAINER_REGISTRY_NAME string = acr.outputs.name
output SERVICE_BACKEND_NAME string = resolvedBackendAppName
output SERVICE_FRONTEND_NAME string = deployFrontend ? resolvedFrontendAppName : ''
output SERVICE_FRONTEND_URL string = containerApps.outputs.frontendUrl
output SERVICE_BACKEND_INTERNAL_URL string = containerApps.outputs.backendInternalUrl
