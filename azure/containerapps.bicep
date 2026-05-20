param location string
param acrName string
param managedEnvironmentName string
param logAnalyticsWorkspaceName string
param backendContainerAppName string
param frontendContainerAppName string
param backendImage string
param frontendImage string

@description('Tags to apply to deployed Azure resources.')
param tags object = {}

@description('Configure the Container Apps to pull images from the supplied Azure Container Registry during provisioning.')
param configureAcrRegistry bool = true

@description('Optional environment variables to inject into the Viper backend container.')
param backendEnvVars object = {}

@description('Optional environment variables to inject into the Viper UI frontend container.')
param frontendEnvVars object = {}

@description('Optional override for the Viper UI base URL that points to the Viper backend.')
param frontendBaseUrl string = ''

@description('Provision the Viper frontend container app.')
param enableFrontend bool = true

@description('Enable Azure Container Apps EasyAuth on the Viper frontend.')
param frontendEasyAuthEnabled bool = false

@description('Entra app registration client ID used by Container Apps EasyAuth.')
param frontendEasyAuthClientId string = ''

@secure()
@description('Entra app registration client secret used by Container Apps EasyAuth.')
param frontendEasyAuthClientSecret string = ''

@description('Optional Entra OpenID issuer override. Leave blank to use the deployment tenant.')
param frontendEasyAuthOpenIdIssuer string = ''

@description('Name of the virtual network that hosts the Container Apps environment and private endpoints.')
param virtualNetworkName string

@description('Resource group for the virtual network when reusing an existing network.')
param virtualNetworkResourceGroup string = resourceGroup().name

@description('Create the virtual network and subnets when true. Set to false to reference existing subnets by resource ID.')
param createVirtualNetwork bool = true

@description('Resource ID of the Container Apps infrastructure subnet when referencing an existing virtual network.')
param containerAppsSubnetResourceId string = ''

@description('Resource ID of the subnet reserved for private endpoints when referencing an existing virtual network.')
param privateEndpointSubnetResourceId string = ''

@description('Address prefix allocated to the virtual network.')
param virtualNetworkAddressPrefix string = '10.100.0.0/16'

@description('Name of the subnet used by Azure Container Apps infrastructure.')
param containerAppsSubnetName string = 'apps-infra'

@description('CIDR block for the Azure Container Apps infrastructure subnet.')
param containerAppsSubnetPrefix string = '10.100.0.0/23'

@description('Name of the subnet assigned to dedicated Container Apps workloads.')
param containerAppsWorkloadSubnetName string = 'apps-workload'

@description('CIDR block for the dedicated Container Apps workload subnet.')
param containerAppsWorkloadSubnetPrefix string = '10.100.3.0/24'

@description('Name of the subnet reserved for private endpoints.')
param privateEndpointSubnetName string = 'private-endpoints'

@description('CIDR block for the private endpoint subnet.')
param privateEndpointSubnetPrefix string = '10.100.2.0/24'

@description('Name of the dedicated workload profile used by the container apps.')
param containerAppsWorkloadProfileName string = 'wp-d4'

@description('Dedicated workload profile SKU for the container apps environment.')
param containerAppsWorkloadProfileType string = 'D4'

@minValue(1)
@description('Minimum number of replicas for the dedicated workload profile.')
param containerAppsWorkloadMinimumCount int = 1

@minValue(1)
@description('Maximum number of replicas for the dedicated workload profile.')
param containerAppsWorkloadMaximumCount int = 3

@description('Enable a dedicated Container Apps workload profile. When false, the apps run on the Consumption workload profile.')
param enableDedicatedWorkloadProfile bool = true

@description('Create a new Storage Account when true. Set to false to reference an existing account.')
param createStorageAccount bool = true

@description('Name of the Storage Account to create or reference.')
param storageAccountName string = ''

@description('Resource group containing the existing Storage Account when createStorageAccount is false.')
param storageAccountResourceGroup string = resourceGroup().name

@description('Create a new Azure AI Search service when true. Set to false to reference an existing service.')
param createSearchService bool = true

@description('Name of the Azure AI Search service to create or reference.')
param searchServiceName string = ''

@description('Resource group containing the existing Azure AI Search service when createSearchService is false.')
param searchServiceResourceGroup string = resourceGroup().name

@description('Create a new Azure Cosmos DB account when true. Set to false to reference an existing account.')
param createCosmosAccount bool = true

@description('Name of the Azure Cosmos DB account to create or reference.')
param cosmosAccountName string = ''

@description('Resource group containing the existing Azure Cosmos DB account when createCosmosAccount is false.')
param cosmosAccountResourceGroup string = resourceGroup().name

@description('Name of the Azure Cosmos DB SQL database to create when provisioning a new account.')
param cosmosDatabaseName string = 'viper'

@description('Name of the Azure Cosmos DB SQL container to create when provisioning a new account.')
param cosmosContainerName string = 'manifests'

@description('Partition key path used by the Azure Cosmos DB SQL container.')
param cosmosContainerPartitionKeyPath string = '/id'

@allowed([
  'Eventual'
  'ConsistentPrefix'
  'Session'
  'BoundedStaleness'
  'Strong'
])
@description('Default consistency level for the Cosmos DB account when created by this deployment.')
param cosmosAccountConsistency string = 'Session'

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

var logAnalyticsKeys = listKeys(logAnalytics.id, '2020-08-01')

var sanitizedResourceGroupName = toLower(replace(replace(resourceGroup().name, '-', ''), '_', ''))
var truncatedResourceGroupName = length(sanitizedResourceGroupName) >= 11 ? substring(sanitizedResourceGroupName, 0, 11) : sanitizedResourceGroupName
var storageNamePrefix = empty(truncatedResourceGroupName) ? 'viper' : truncatedResourceGroupName
var generatedStorageAccountName = toLower('${storageNamePrefix}${substring(uniqueString(resourceGroup().id, 'storage'), 0, 12)}')
var resolvedStorageAccountName = toLower(createStorageAccount ? (empty(storageAccountName) ? generatedStorageAccountName : storageAccountName) : storageAccountName)

var searchNamePrefix = empty(sanitizedResourceGroupName) ? 'vipersearch' : (length(sanitizedResourceGroupName) >= 20 ? substring(sanitizedResourceGroupName, 0, 20) : sanitizedResourceGroupName)
var generatedSearchServiceName = toLower('${searchNamePrefix}${substring(uniqueString(resourceGroup().id, 'search'), 0, 6)}')
var resolvedSearchServiceName = toLower(createSearchService ? (empty(searchServiceName) ? generatedSearchServiceName : searchServiceName) : searchServiceName)

var cosmosNamePrefix = empty(sanitizedResourceGroupName) ? 'vipercosmos' : (length(sanitizedResourceGroupName) >= 20 ? substring(sanitizedResourceGroupName, 0, 20) : sanitizedResourceGroupName)
var generatedCosmosAccountName = toLower('${cosmosNamePrefix}${substring(uniqueString(resourceGroup().id, 'cosmos'), 0, 8)}')
var resolvedCosmosAccountName = toLower(createCosmosAccount ? (empty(cosmosAccountName) ? generatedCosmosAccountName : cosmosAccountName) : cosmosAccountName)

var hasStorageAccount = createStorageAccount || !empty(resolvedStorageAccountName)
var hasSearchService = createSearchService || !empty(resolvedSearchServiceName)
var hasCosmosAccount = createCosmosAccount || !empty(resolvedCosmosAccountName)

var virtualNetworkId = resourceId(virtualNetworkResourceGroup, 'Microsoft.Network/virtualNetworks', virtualNetworkName)
var containerAppsSubnetIdGenerated = resourceId(virtualNetworkResourceGroup, 'Microsoft.Network/virtualNetworks/subnets', virtualNetworkName, containerAppsSubnetName)
var privateEndpointSubnetIdGenerated = resourceId(virtualNetworkResourceGroup, 'Microsoft.Network/virtualNetworks/subnets', virtualNetworkName, privateEndpointSubnetName)

var resolvedContainerAppsSubnetId = createVirtualNetwork ? containerAppsSubnetIdGenerated : containerAppsSubnetResourceId
var resolvedPrivateEndpointSubnetId = createVirtualNetwork ? privateEndpointSubnetIdGenerated : privateEndpointSubnetResourceId
var containerAppsWorkloadProfiles = enableDedicatedWorkloadProfile ? [
  {
    name: containerAppsWorkloadProfileName
    workloadProfileType: containerAppsWorkloadProfileType
    minimumCount: containerAppsWorkloadMinimumCount
    maximumCount: containerAppsWorkloadMaximumCount
  }
] : []

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2023-05-01' = if (createVirtualNetwork) {
  name: virtualNetworkName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        virtualNetworkAddressPrefix
      ]
    }
    subnets: [
      {
        name: containerAppsSubnetName
        properties: {
          addressPrefix: containerAppsSubnetPrefix
          delegations: [
            {
              name: 'container-apps-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: containerAppsWorkloadSubnetName
        properties: {
          addressPrefix: containerAppsWorkloadSubnetPrefix
        }
      }
      {
        name: privateEndpointSubnetName
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: managedEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalyticsKeys.primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: resolvedContainerAppsSubnetId
    }
    workloadProfiles: containerAppsWorkloadProfiles
  }
  dependsOn: createVirtualNetwork ? [
    virtualNetwork
  ] : []
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2022-09-01' = if (createStorageAccount) {
  name: resolvedStorageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}


resource searchService 'Microsoft.Search/searchServices@2020-08-01' = if (createSearchService) {
  name: resolvedSearchServiceName
  location: location
  sku: {
    name: 'standard'
  }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'default'
    publicNetworkAccess: 'disabled'
  }
}


resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2023-04-15' = if (createCosmosAccount) {
  name: resolvedCosmosAccountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    enableAutomaticFailover: false
    enableFreeTier: false
    enableAnalyticalStorage: false
    publicNetworkAccess: 'Disabled'
    enableMultipleWriteLocations: false
    disableKeyBasedMetadataWriteAccess: false
    minimalTlsVersion: 'Tls12'
    consistencyPolicy: {
      defaultConsistencyLevel: cosmosAccountConsistency
    }
    backupPolicy: {
      type: 'Periodic'
      periodicModeProperties: {
        backupIntervalInMinutes: 240
        backupRetentionIntervalInHours: 8
        backupStorageRedundancy: 'Geo'
      }
    }
    capabilities: []
  }
}


resource cosmosDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2023-04-15' = if (createCosmosAccount) {
  parent: cosmosAccount
  name: cosmosDatabaseName
  properties: {
    resource: {
      id: cosmosDatabaseName
    }
    options: {}
  }
}

resource cosmosContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2023-04-15' = if (createCosmosAccount) {
  parent: cosmosDatabase
  name: cosmosContainerName
  properties: {
    resource: {
      id: cosmosContainerName
      partitionKey: {
        paths: [
          cosmosContainerPartitionKeyPath
        ]
        kind: 'Hash'
      }
    }
    options: {}
  }
}

resource storagePrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (createStorageAccount) {
  name: 'privatelink.blob.${environment().suffixes.storage}'
  location: 'global'
}

resource storagePrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (createStorageAccount) {
  name: '${virtualNetworkName}-blob-link'
  parent: storagePrivateDnsZone
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetworkId
    }
  }
}

resource storagePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-05-01' = if (createStorageAccount) {
  name: '${resolvedStorageAccountName}-blob-pe'
  location: location
  properties: {
    subnet: {
      id: resolvedPrivateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${resolvedStorageAccountName}-blob-connection'
        properties: {
          privateLinkServiceId: storageAccount.id
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

resource storagePrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-05-01' = if (createStorageAccount) {
  name: '${resolvedStorageAccountName}-blob-dns'
  parent: storagePrivateEndpoint
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: storagePrivateDnsZone.id
        }
      }
    ]
  }
}

resource searchPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (createSearchService) {
  name: 'privatelink.search.windows.net'
  location: 'global'
}

resource searchPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (createSearchService) {
  name: '${virtualNetworkName}-search-link'
  parent: searchPrivateDnsZone
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetworkId
    }
  }
}

resource searchPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-05-01' = if (createSearchService) {
  name: '${resolvedSearchServiceName}-pe'
  location: location
  properties: {
    subnet: {
      id: resolvedPrivateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${resolvedSearchServiceName}-connection'
        properties: {
          privateLinkServiceId: searchService.id
          groupIds: [
            'searchService'
          ]
        }
      }
    ]
  }
}

resource searchPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-05-01' = if (createSearchService) {
  name: '${resolvedSearchServiceName}-dns'
  parent: searchPrivateEndpoint
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'search'
        properties: {
          privateDnsZoneId: searchPrivateDnsZone.id
        }
      }
    ]
  }
}

resource cosmosPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (createCosmosAccount) {
  name: 'privatelink.documents.azure.com'
  location: 'global'
}

resource cosmosPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (createCosmosAccount) {
  name: '${virtualNetworkName}-cosmos-link'
  parent: cosmosPrivateDnsZone
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetworkId
    }
  }
}

resource cosmosPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-05-01' = if (createCosmosAccount) {
  name: '${resolvedCosmosAccountName}-sql-pe'
  location: location
  properties: {
    subnet: {
      id: resolvedPrivateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${resolvedCosmosAccountName}-sql-connection'
        properties: {
          privateLinkServiceId: cosmosAccount.id
          groupIds: [
            'Sql'
          ]
        }
      }
    ]
  }
}

resource cosmosPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-05-01' = if (createCosmosAccount) {
  name: '${resolvedCosmosAccountName}-sql-dns'
  parent: cosmosPrivateEndpoint
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'cosmos'
        properties: {
          privateDnsZoneId: cosmosPrivateDnsZone.id
        }
      }
    ]
  }
}

var backendInternalUrl = format('https://{0}.internal.{1}', backendContainerAppName, managedEnvironment.properties.defaultDomain)
var resolvedBackendBaseUrl = empty(frontendBaseUrl) ? backendInternalUrl : frontendBaseUrl
var frontendPublicUrl = format('https://{0}.{1}', frontendContainerAppName, managedEnvironment.properties.defaultDomain)
var easyAuthSecretName = 'microsoft-provider-authentication-secret'
var resolvedEasyAuthIssuer = empty(frontendEasyAuthOpenIdIssuer) ? '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0' : frontendEasyAuthOpenIdIssuer

var backendEnv = [for envVar in items(backendEnvVars): {
  name: envVar.key
  value: string(envVar.value)
}]

var frontendBaseEnv = [
  {
    name: 'VIPER_BASE_URL'
    value: resolvedBackendBaseUrl
  }
  {
    name: 'VIPER_BACKEND_INTERNAL_URL'
    value: backendInternalUrl
  }
]

var frontendAdditionalEnv = [for envVar in items(frontendEnvVars): {
  name: envVar.key
  value: string(envVar.value)
}]

var frontendEnv = concat(frontendBaseEnv, frontendAdditionalEnv)
var configureFrontendEasyAuth = enableFrontend && frontendEasyAuthEnabled && !empty(frontendEasyAuthClientId) && !empty(frontendEasyAuthClientSecret)
var frontendSecrets = configureFrontendEasyAuth ? [
  {
    name: easyAuthSecretName
    value: frontendEasyAuthClientSecret
  }
] : []

var registryServer = '${acrName}.azurecr.io'
var containerAppRegistries = configureAcrRegistry ? [
  {
    server: registryServer
    identity: 'system'
  }
] : []
var acrPullRoleGuid = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var storageRoleGuid = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var searchRoleGuid = 'de139f84-1756-47ae-9be6-808fbbe84772'
var cosmosRoleGuid = 'db49f5e6-0bde-4f5e-8eaa-36847e330f73'

var storageRoleDefinitionId = hasStorageAccount ? subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageRoleGuid) : ''
var searchRoleDefinitionId = hasSearchService ? subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchRoleGuid) : ''
var cosmosRoleDefinitionId = hasCosmosAccount ? subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cosmosRoleGuid) : ''
var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleGuid)
var containerAppWorkloadProfile = enableDedicatedWorkloadProfile ? containerAppsWorkloadProfileName : 'Consumption'
var backendAppTags = union(tags, {
  'azd-service-name': 'backend'
})
var frontendAppTags = union(tags, {
  'azd-service-name': 'frontend'
})

resource backendApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: backendContainerAppName
  location: location
  tags: backendAppTags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    workloadProfileName: containerAppWorkloadProfile
    configuration: {
      ingress: {
        external: false
        targetPort: 8000
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: containerAppRegistries
    }
    template: {
      containers: [
        {
          name: 'backend'
          image: backendImage
          env: backendEnv
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource frontendApp 'Microsoft.App/containerApps@2024-03-01' = if (enableFrontend) {
  name: frontendContainerAppName
  location: location
  tags: frontendAppTags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    workloadProfileName: containerAppWorkloadProfile
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      secrets: frontendSecrets
      registries: containerAppRegistries
    }
    template: {
      containers: [
        {
          name: 'frontend'
          image: frontendImage
          env: frontendEnv
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource frontendAuthConfig 'Microsoft.App/containerApps/authConfigs@2024-03-01' = if (configureFrontendEasyAuth) {
  parent: frontendApp
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: frontendEasyAuthClientId
          clientSecretSettingName: easyAuthSecretName
          openIdIssuer: resolvedEasyAuthIssuer
        }
        validation: {
          allowedAudiences: [
            frontendEasyAuthClientId
          ]
        }
      }
    }
  }
}

resource backendAcrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, backendApp.name, acrPullRoleGuid)
  scope: acr
  properties: {
    principalId: backendApp.identity.principalId
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource frontendAcrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableFrontend) {
  name: guid(resourceGroup().id, frontendApp!.name, acrPullRoleGuid)
  scope: acr
  properties: {
    principalId: frontendApp!.identity.principalId
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

var backendStorageRoleAssignments = [
  {
    name: guid(resolvedStorageAccountName, backendApp.name, storageRoleGuid)
    principalId: backendApp.identity.principalId
    roleDefinitionId: storageRoleDefinitionId
  }
]

var frontendStorageRoleAssignments = enableFrontend ? [
  {
    name: guid(resolvedStorageAccountName, frontendApp!.name, storageRoleGuid)
    principalId: frontendApp!.identity.principalId
    roleDefinitionId: storageRoleDefinitionId
  }
] : []

var storageRoleAssignments = hasStorageAccount ? concat(backendStorageRoleAssignments, frontendStorageRoleAssignments) : []

var backendSearchRoleAssignments = [
  {
    name: guid(resolvedSearchServiceName, backendApp.name, searchRoleGuid)
    principalId: backendApp.identity.principalId
    roleDefinitionId: searchRoleDefinitionId
  }
]

var frontendSearchRoleAssignments = enableFrontend ? [
  {
    name: guid(resolvedSearchServiceName, frontendApp!.name, searchRoleGuid)
    principalId: frontendApp!.identity.principalId
    roleDefinitionId: searchRoleDefinitionId
  }
] : []

var searchRoleAssignments = hasSearchService ? concat(backendSearchRoleAssignments, frontendSearchRoleAssignments) : []

var backendCosmosRoleAssignments = [
  {
    name: guid(resolvedCosmosAccountName, backendApp.name, cosmosRoleGuid)
    principalId: backendApp.identity.principalId
    roleDefinitionId: cosmosRoleDefinitionId
  }
]

var frontendCosmosRoleAssignments = enableFrontend ? [
  {
    name: guid(resolvedCosmosAccountName, frontendApp!.name, cosmosRoleGuid)
    principalId: frontendApp!.identity.principalId
    roleDefinitionId: cosmosRoleDefinitionId
  }
] : []

var cosmosRoleAssignments = hasCosmosAccount ? concat(backendCosmosRoleAssignments, frontendCosmosRoleAssignments) : []

module storageRoleAssignmentsNew './modules/storageRoleAssignments.bicep' = if (createStorageAccount && hasStorageAccount) {
  name: 'storageRoleAssignmentsNew'
  params: {
    storageAccountName: resolvedStorageAccountName
    assignments: storageRoleAssignments
  }
  dependsOn: [
    storageAccount
  ]
}

module storageRoleAssignmentsExisting './modules/storageRoleAssignments.bicep' = if (!createStorageAccount && hasStorageAccount) {
  name: 'storageRoleAssignmentsExisting'
  scope: resourceGroup(storageAccountResourceGroup)
  params: {
    storageAccountName: resolvedStorageAccountName
    assignments: storageRoleAssignments
  }
}

module searchRoleAssignmentsNew './modules/searchRoleAssignments.bicep' = if (createSearchService && hasSearchService) {
  name: 'searchRoleAssignmentsNew'
  params: {
    searchServiceName: resolvedSearchServiceName
    assignments: searchRoleAssignments
  }
  dependsOn: [
    searchService
  ]
}

module searchRoleAssignmentsExisting './modules/searchRoleAssignments.bicep' = if (!createSearchService && hasSearchService) {
  name: 'searchRoleAssignmentsExisting'
  scope: resourceGroup(searchServiceResourceGroup)
  params: {
    searchServiceName: resolvedSearchServiceName
    assignments: searchRoleAssignments
  }
}

module cosmosRoleAssignmentsNew './modules/cosmosRoleAssignments.bicep' = if (createCosmosAccount && hasCosmosAccount) {
  name: 'cosmosRoleAssignmentsNew'
  params: {
    cosmosAccountName: resolvedCosmosAccountName
    assignments: cosmosRoleAssignments
  }
  dependsOn: [
    cosmosAccount
  ]
}

module cosmosRoleAssignmentsExisting './modules/cosmosRoleAssignments.bicep' = if (!createCosmosAccount && hasCosmosAccount) {
  name: 'cosmosRoleAssignmentsExisting'
  scope: resourceGroup(cosmosAccountResourceGroup)
  params: {
    cosmosAccountName: resolvedCosmosAccountName
    assignments: cosmosRoleAssignments
  }
}


output frontendUrl string = enableFrontend ? frontendPublicUrl : ''
output backendInternalUrl string = backendInternalUrl
output storageAccountOutput string = hasStorageAccount ? resolvedStorageAccountName : ''
output searchServiceOutput string = hasSearchService ? resolvedSearchServiceName : ''
output cosmosAccountOutput string = hasCosmosAccount ? resolvedCosmosAccountName : ''
