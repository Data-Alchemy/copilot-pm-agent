# Changelog

All notable changes to Copilot PM Agent are documented in this file.

This project follows [Semantic Versioning](https://semver.org/) and uses [Conventional Commits](https://www.conventionalcommits.org/). Release changelogs are auto-generated from commit messages via GitHub Actions.

---

## [1.0.0] - 2026-04-17

### Breaking Changes

- add GitHub Projects as third platform provider

### Features

- add GitHub Projects as third platform provider

### Bug Fixes

- add explicit types for strict mode compliance

### Other Changes

- Merge branch 'main' of https://github.com/Data-Alchemy/copilot-pm-agent

## [Unreleased]

### Features
- **Jira required field defaults** — Configure Platform scans all required fields for each issue type via Jira's createmeta API. Users set default values (dropdowns for constrained fields, text inputs for free-form). Defaults auto-fill during ticket creation across all interfaces.
- **Token validation** — Validate button on each token field in Configure Platform. Shows status indicator (valid with username, or error with details). Auto-validates stored tokens when the panel opens.
- **Persistent config panel** — Configure Platform stays open after saving. Switch between Jira and ADO tabs without re-entering credentials. Done button closes the panel when finished.
- **Verbose auth errors** — Migrate and other commands show descriptive error messages when tokens are expired or invalid, with a "Configure Platform" button to fix immediately.
- **Migrate type mapping** — Always prompts user to confirm or change the destination type for each source type during migration. Auto-matched type shown first with option to override.
- **Migrate type and status filter** — Filter source items by type and status before selecting. Shows counts per category, all checked by default.
- **Migrate scope picker** — Choose between "My assigned items" or "All project items" when loading items for migration.
- **Recursive child migration** — Migrates child/subtask hierarchies up to 5 levels deep with parent linking in the destination.
- **Child assignee preservation** — Child items maintain their original assignee during migration, matched by email.
- **Type and status filter on all interfaces** — Available on `/list`, `/status`, `/comment`, `/assign`, `/estimate`, `/parent`, `/move`, and `/migrate`.
- **Clickable links in chat** — Links in sidebar and panel chat open in browser via `vscode.env.openExternal`.
- **Migrate results with hyperlinks** — Shows clickable links for source and destination tickets with indented tree view for child items.
- **Command palette migration output** — Opens dedicated output channel with full migration results.

### Bug Fixes
- **Jira issue type error on migrate** — `rawTypeName` bypasses hardcoded type map. Fixes Jira 400 "invalid issue type" error.
- **ADO-to-Jira child linking** — Tries 4 linking methods: parent field (key/id), issueLink (Hierarchy/Parent-Child). Also sets `parentId` during creation.
- **ADO child item discovery** — Relations API with WIQL fallback. Uses numeric ID for API calls.
- **Description HTML entities** — `stripHtml` decodes `&nbsp;`, `&amp;`, `&lt;`, `&gt;` after stripping tags.
- **Webview disposed error** — Guards all `postMessage` calls with disposed/null checks.
- **Expired token silent failure** — Shows auth error with "Configure Platform" button instead of empty results.

## [0.5.1] - 2026-03-29

### Features
- **Automated semver release** — Determines version bump from conventional commits, publishes to Marketplace, creates GitHub Release with categorized notes, updates CHANGELOG.
- **Preview artifacts** — CI uploads `pm-agent-preview` with automatic old artifact cleanup.
- **Commit-based release notes** — Categorizes commits into Features, Bug Fixes, and Other Changes.

### Bug Fixes
- **Version 0.5.0 conflict** — Release pipeline skips past published versions automatically.
- **CI badge failed** — Separated CI and Release workflows.
- **CHANGELOG sed error** — Uses `node -e` instead of `sed` for URL-safe string operations.

### Changed
- Publisher: `DataAlchemy`, name: `copilot-pm-agent`, display: "Copilot PM Agent"
- Dynamic version badge via `shields.io/github/v/release`
- Install scripts use glob patterns instead of hardcoded versions

## [0.5.0] - 2026-03-28

### Features
- **Sidebar chat** — Full chat in the activity bar with message history, input bar, quick chips, typing indicators. Works without Copilot.
- **WebviewPanelSerializers** — Prevents service worker errors on restart.
- **Story point dropdown** — Fibonacci scale (1, 2, 3, 5, 8, 13) with effort descriptions.
- **`/migrate` in chat** — Copy tickets between Jira and ADO with field mapping and assignee matching.
- **`/parent` and `/setupai` commands** — Available in all chat interfaces.
- **169 unit tests** — Intent parsing, formatting, activation, panel integrity, package.json validation.
- **CI/CD pipeline** — Node 18/20 matrix, build, test, package.
- **Extension icon** — Professional SVG/PNG.

### Bug Fixes
- **Service worker error** — Missing WebviewViewProvider, stale caches, retainContextWhenHidden.
- **Chat panel unresponsive** — Backtick in template literal broke script block. Moved to string arrays.
- **Configure Platform blank** — Template interpolation escaping. Rewrote with string concatenation.
- **Jira dropdown not clickable** — Replaced `onclick` attributes with `addEventListener`.
- **Jira dropdown not collapsing** — Collapse parameter for user vs programmatic selection.
- **ADO create TF401320** — Description falls back to title when empty.
- **Token persistence** — Reads from SecretStorage, passes boolean flags to webview.
- **Token leakage** — Replaced actual tokens with boolean flags in webview HTML.
- **XSS via project names** — Sanitized before innerHTML insertion.
- **Story points not setting** — Fallback to 4 common custom field IDs.

### Changed
- All panels compile from TypeScript source
- Sidebar converted from buttons to full chat
- Script blocks via string arrays
- Removed `retainContextWhenHidden` from panels

## [0.4.1] - 2026-03-24

### Features
- Standalone chat panel (no Copilot required)
- Jira and ADO project auto-loading in setup wizard
- AI-powered ticket enhancement (Copilot, Anthropic, OpenAI, Azure OpenAI)
- Sprint management and cross-platform migration

## [0.3.0] - 2026-03-15

### Features
- Command palette mode for all actions
- Work item detail panel
- Status bar shortcut

## [0.2.0] - 2026-03-01

### Features
- Setup wizard with persistent webview panel
- Jira and Azure DevOps provider implementations

## [0.1.0] - 2026-02-15

### Features
- Initial release with GitHub Copilot chat participant (`@pm`)
- Natural language intent parsing
- Jira Cloud/Server and Azure DevOps support
