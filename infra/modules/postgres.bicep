param name string
param location string
param tags object = {}

@description('PostgreSQL administrator login name.')
param administratorLogin string = 'viperadmin'

@secure()
@description('PostgreSQL administrator password.')
param administratorPassword string

@description('Application database name.')
param databaseName string = 'viper'

@description('PostgreSQL engine version.')
param postgresqlVersion string = '16'

@description('Flexible Server SKU name.')
param skuName string = 'Standard_B1ms'

@description('Flexible Server SKU tier.')
param skuTier string = 'Burstable'

@minValue(32)
@description('Storage size in GB.')
param storageSizeGB int = 32

@minValue(7)
@maxValue(35)
@description('Backup retention in days.')
param backupRetentionDays int = 7

@description('Allow Azure services to reach the PostgreSQL public endpoint. Use private networking for production deployments that require it.')
param allowAzureServices bool = true

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: postgresqlVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: storageSizeGB
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource azureServicesFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = if (allowAzureServices) {
  parent: server
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output host string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name

@secure()
output databaseUrl string = 'postgresql://${administratorLogin}:${administratorPassword}@${server.properties.fullyQualifiedDomainName}:5432/${database.name}?schema=public&sslmode=require'
