# Azure Container Instance Setup

This document explains how to configure Azure Container Instances (ACI) for PromoraAI assessments.

## Prerequisites

1. Azure account with active subscription
2. Azure CLI installed (`az --version`)
3. Azure Container Registry (ACR) created
4. Docker image built and pushed to ACR

## Environment Variables

Add these to your `backend/.env` file:

```bash
# Azure Subscription ID (found in Azure Portal → Subscriptions)
AZURE_SUBSCRIPTION_ID=your-subscription-id-here

# Azure Resource Group name (e.g., "Promoraai")
AZURE_RESOURCE_GROUP=Promoraai

# Azure Container Registry name (e.g., "promoraacr")
AZURE_ACR_NAME=promoraacr

# Azure ACR password (get from: az acr credential show --name promoraacr --query passwords[0].value)
# Required only when using your ACR image (see AZURE_USE_ACR_IMAGE below).
AZURE_ACR_PASSWORD=your-acr-password-here

# Azure region (e.g., "eastus", "westus2")
AZURE_LOCATION=eastus

# Optional: set to "true" to use your ACR image (promoraacr.azurecr.io/promora-assessment:latest).
# Omit or leave false to use a public Microsoft image so /test-assessment works without building an image.
# AZURE_USE_ACR_IMAGE=true
```

## Getting Azure Credentials

Use **one** of these. Service Principal works without installing Azure CLI.

### Option 1: Service Principal (works without Azure CLI)

1. Create a service principal (run in Azure Cloud Shell or a machine with `az` installed):

```bash
az ad sp create-for-rbac --name promora-backend --role contributor --scopes /subscriptions/<your-subscription-id>
```

2. Add the output to `backend/.env`:

```bash
AZURE_CLIENT_ID=<appId from output>
AZURE_CLIENT_SECRET=<password from output>
AZURE_TENANT_ID=<tenant from output>
```

The backend uses these when all three are set; no `az login` or Azure CLI on the server is required.

### Option 2: Azure CLI Login (local development)

```bash
az login
az account set --subscription <your-subscription-id>
```

If `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` are **not** set, the backend uses DefaultAzureCredential (e.g. Azure CLI). Install Azure CLI from https://aka.ms/azure-cli and run `az login` first.

## Building and Pushing Docker Image

1. **Build your assessment Docker image** (example Dockerfile in `backend/Dockerfile.assessment`):

```bash
cd backend
docker build -f Dockerfile.assessment -t promora-assessment:latest .
```

2. **Tag for ACR**:

```bash
docker tag promora-assessment:latest promoraacr.azurecr.io/promora-assessment:latest
```

3. **Login to ACR**:

```bash
az acr login --name promoraacr
```

4. **Push image**:

```bash
docker push promoraacr.azurecr.io/promora-assessment:latest
```

## Testing

1. Start the backend server
2. Navigate to `/test-assessment` in the frontend
3. The page will automatically provision an Azure Container Instance
4. The container URL will be displayed in an iframe

## API Endpoints

- `POST /api/containers/provision/:sessionId` - Create container for session
- `GET /api/containers/status/:sessionId` - Get container status
- `DELETE /api/containers/:sessionId` - Delete container

## Container Lifecycle

- Containers are automatically provisioned when a session starts
- Container info is stored in the `Session` table (`containerId`, `containerUrl`)
- Containers are deleted when sessions end (manual cleanup recommended)

## Troubleshooting

### Container fails to provision

- Check Azure credentials: `az account show`
- Verify ACR image exists: `az acr repository list --name promoraacr`
- Check resource group: `az group list`
- Review backend logs for detailed error messages

### Container URL not accessible

- Ensure container has public IP enabled
- Check DNS name label is unique
- Verify port 8080 is exposed in container configuration

### Authentication errors

- Ensure Azure CLI is logged in: `az login`
- Or set service principal credentials in `.env`
- Verify subscription ID is correct
