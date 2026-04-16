# PM Agent — Jira & Azure DevOps for VS Code

[![CI](https://github.com/Data-Alchemy/copilot-pm-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Data-Alchemy/copilot-pm-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

With the PM Agent extension, you can manage Jira and Azure DevOps work items directly from Visual Studio Code. Create tickets, update statuses, assign tasks, track sprints, and migrate work items between platforms — all without leaving your editor. PM Agent streamlines your development workflow by keeping project management in the same application you use to write code.

PM Agent works in **three modes**, so you can choose what fits your workflow:

- **Sidebar Chat** — A dedicated chat panel in the activity bar (like Copilot Chat) where you can type commands and see results inline while you code.
- **Copilot Chat Participant** — Type `@pm` in the GitHub Copilot chat panel to use PM Agent alongside your AI coding assistant.
- **Command Palette** — Run any PM Agent action from `Ctrl+Shift+P` / `Cmd+Shift+P` without needing Copilot or the chat UI.

PM Agent supports Visual Studio Code, Visual Studio Code Insiders, Cursor, and Windsurf. The extension requires VS Code version 1.95 or later.

---

## Why PM Agent?

Developers spend a significant amount of time context-switching between their editor, browser tabs for Jira or Azure DevOps, and chat tools. Every switch breaks focus and costs minutes of productivity.

PM Agent eliminates that friction by bringing your project management workflow into VS Code:

- **Stay in flow** — Check your assigned tickets, update statuses, and add comments without opening a browser.
- **Works without Copilot** — The sidebar chat and command palette modes work entirely standalone. No GitHub Copilot subscription required.
- **Supports both platforms** — Manage Jira Cloud/Server and Azure DevOps from a single interface. Migrate tickets between them.
- **AI-enhanced ticket creation** — When connected to an AI provider (Copilot, Anthropic, OpenAI, or Azure OpenAI), PM Agent can auto-generate structured descriptions, acceptance criteria, and effort estimates from a short title.
- **Natural language** — Type commands in plain English. PM Agent understands intent and routes to the right action.
- **Secure** — API tokens are stored in VS Code's SecretStorage, backed by your OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret). Tokens are never transmitted anywhere except directly to your Jira or Azure DevOps instance.

---

## Prerequisites

Before you begin, configure the following:

- **Jira users** — You need your Jira base URL (e.g. `https://yourorg.atlassian.net`), your account email, and an API token. Generate a token at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
- **Azure DevOps users** — You need your organisation URL (e.g. `https://dev.azure.com/yourorg`), your project name, and a Personal Access Token (PAT) with **Work Items: Read & Write** and **Project and Team: Read** scope.
- **AI enhancement (optional)** — To use AI-powered ticket creation, configure one of: GitHub Copilot (no extra key needed), Anthropic Claude, OpenAI, or Azure OpenAI.

---

## Getting Started

### Install the Extension

Install from a VSIX file:

```bash
code --install-extension copilot-pm-agent.vsix --force
```

On first install, PM Agent will show a notification prompting you to configure your platform. You can also click the PM Agent icon in the activity bar to open the sidebar chat.

### Configure Your Platform

1. Click **Configure Platform** in the welcome notification, or open the Command Palette (`Cmd+Shift+P`) and run **PM Agent: Configure Platform**.
2. Select **Jira** or **Azure DevOps**.
3. Enter your credentials and click **Load Projects** to verify the connection.
4. Select a default project and click **Save and Connect**.

Your API tokens are stored securely in VS Code's SecretStorage and persist across sessions. When you re-open the setup wizard, stored tokens are preserved — you only need to re-enter them if you want to change them.

### Configure AI Provider (Optional)

Open the Command Palette and run **PM Agent: Configure AI Provider** to enable AI-enhanced ticket creation. Choose from:

- **GitHub Copilot** — Uses your existing Copilot subscription. No extra API key needed.
- **Anthropic Claude** — Requires an Anthropic API key.
- **OpenAI** — Requires an OpenAI API key.
- **Azure OpenAI** — Requires your Azure deployment URL and key.

---

## Three Ways to Use PM Agent

### 1. Sidebar Chat (No Copilot Required)

Click the **PM Agent icon** in the activity bar to open the sidebar chat. This is a dedicated chat panel that stays open while you code — similar to the Copilot Chat panel.

Type commands directly:

```
/list
/open ENG-123
/sprint
/create
/migrate
```

The sidebar shows results inline with clickable links, action chips, and a scrollable message history that persists during your session.

### 2. Copilot Chat Participant

If you have GitHub Copilot installed, type `@pm` in the Copilot chat panel:

```
@pm /list my bugs
@pm show me ENG-123
@pm create a story called "Add dark mode"
@pm what's in the current sprint?
```

PM Agent responds directly in the Copilot chat alongside your other AI conversations.

### 3. Command Palette

Every PM Agent action is available from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

- **PM Agent: List My Work Items**
- **PM Agent: Open Work Item**
- **PM Agent: Create Work Item**
- **PM Agent: Change Status**
- **PM Agent: Add Comment**
- **PM Agent: Assign Work Item**
- **PM Agent: Set Story Points**
- **PM Agent: Move to Sprint**
- **PM Agent: Migrate Ticket (ADO / Jira)**
- **PM Agent: Show Current Sprint**
- **PM Agent: Set Parent**
- **PM Agent: Debug Connection**
- **PM Agent: Configure Platform**
- **PM Agent: Configure AI Provider**
- **PM Agent: Set Default User**

---

## Features

### Work Item Management

| Command | What it does |
|---------|-------------|
| `/list` | List work items assigned to you |
| `/open #1234` or `/open ENG-42` | View full work item details |
| `/create` | Create a new story, task, bug, or epic with guided prompts |
| `/status` | Change the status of a work item |
| `/comment` | Add a comment to a work item |
| `/assign` | Assign a work item to a team member |
| `/estimate` | Set story points or effort with a Fibonacci scale dropdown |
| `/move` | Move a work item to a different sprint |
| `/parent` | Set or change the parent of a work item |

### Sprint Tracking

| Command | What it does |
|---------|-------------|
| `/sprint` | View the active sprint with your assigned items |

### Cross-Platform Migration

| Command | What it does |
|---------|-------------|
| `/migrate` | Copy work items between Jira and Azure DevOps |

Migration supports copying title, description, acceptance criteria, story points, priority, labels, assignee (matched by email), and comments. You can select multiple items and choose which fields to include.

### Configuration

| Command | What it does |
|---------|-------------|
| `/debug` | Run connectivity diagnostics |
| `/setuser` | Set the default user for queries |
| `/setupai` | Configure AI provider |

### Natural Language

PM Agent understands plain English alongside slash commands:

```
show me all open bugs assigned to me
create a high priority story called "User profile page"
assign ENG-123 to Jane Smith
close ENG-42
set story points on ENG-55 to 5
move ENG-99 to the next sprint
summarize my workload
test connection
```

---

## Settings

You can also configure PM Agent through VS Code settings (`settings.json`):

```json
{
  "pmAgent.platform": "jira",
  "pmAgent.jira.baseUrl": "https://yourorg.atlassian.net",
  "pmAgent.jira.email": "you@example.com",
  "pmAgent.jira.defaultProject": "ENG",
  "pmAgent.azureDevOps.orgUrl": "https://dev.azure.com/yourorg",
  "pmAgent.azureDevOps.project": "MyProject",
  "pmAgent.ai.provider": "copilot"
}
```

API tokens are never stored in settings — they are kept in VS Code's SecretStorage (OS keychain).

---

## Privacy & Security

- API tokens are stored in **VS Code SecretStorage**, backed by the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret).
- Tokens are only transmitted directly to your configured Jira or Azure DevOps instance over HTTPS.
- No telemetry, analytics, or data collection of any kind.
- When AI enhancement is enabled, ticket content is sent to your chosen AI provider (Copilot, Anthropic, OpenAI, or Azure OpenAI) for structuring. No data is sent if AI is disabled.

---

## Troubleshooting

### "Configuration required" message

Run **PM Agent: Configure Platform** from the Command Palette or click **Configure Platform** in the sidebar chat.

### Commands not responding

Make sure your API token is valid and your Jira/ADO instance is reachable. Run `/debug` in the sidebar chat to test connectivity.

### "Error loading webview" on startup

This can happen if VS Code's webview cache becomes corrupted. Close VS Code, delete the cache directories, and reopen:

```bash
# macOS
rm -rf ~/Library/Application\ Support/Code/Service\ Worker
rm -rf ~/Library/Application\ Support/Code/Webview
rm -rf ~/Library/Caches/com.microsoft.VSCode
```

Then reinstall the extension with `code --install-extension copilot-pm-agent.vsix --force`.

---

## Share Feedback

To report a bug or request a feature:

1. Visit [github.com/Data-Alchemy/copilot-pm-agent/issues](https://github.com/Data-Alchemy/copilot-pm-agent/issues)
2. Click **New Issue** and select Bug Report or Feature Request.
3. Enter the details and submit.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
