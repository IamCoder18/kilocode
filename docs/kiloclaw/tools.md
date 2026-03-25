# Tools

## 1Password Integration for KiloClaw

Connect your KiloClaw agent to 1Password to securely manage credentials and automate vault lookups without exposing sensitive keys in plain text.

> ⚠️ **Warning:** This integration grants your agent read/write access to the vaults you specify. We strongly recommend creating a dedicated vault containing only the specific credentials your agent requires.

### Setup Instructions

#### 1. Create a Service Account

Visit the [1Password Developer Portal](https://developer.1password.com/) and create a new Service Account. This provides the secure bridge between 1Password and KiloClaw.

#### 2. Scope to a Dedicated Vault

Grant the Service Account access to a specific "Agent" vault. Do not use your primary personal or team vault. Ensure only the necessary items (API keys, passwords, etc.) are stored here.

#### 3. Copy the Token

Copy the generated Service Account token (it will begin with `ops_`). Navigate to your **KiloClaw Settings** and paste this token into the **1Password configuration** field.

#### 4. Save and Upgrade

After saving the token, select **Upgrade to latest** (do not use **Redeploy**) to activate the integration.

### Usage

Once active, your agent can interact with the vault using the `op` CLI. Example command:

```bash
op item get "My Login"
```
