# Changelog

All notable changes to PM Agent are documented in this file.

This project follows [Semantic Versioning](https://semver.org/) and the format is based on [Keep a Changelog](https://keepachangelog.com/).

Release changelogs are auto-generated from pull request labels via GitHub Actions.

---


## [0.6.0] - 2026-04-13

### Features

- migrate child items with parent linking and type mapping

## [0.2.2] - 2026-03-29

See [release notes](https://github.com/Data-Alchemy/copilot-pm-agent/releases/tag/v0.2.2).

## [0.2.1] - 2026-03-29

See [release notes](https://github.com/Data-Alchemy/copilot-pm-agent/releases/tag/v0.2.1).

## [0.5.0] - 2026-03-28

### Added
- Sidebar chat panel — full chat interface in the activity bar, works without Copilot
- WebviewPanelSerializers — prevents service worker errors on VS Code restart
- Story point dropdown with Fibonacci scale (1, 2, 3, 5, 8, 13) and effort descriptions
- `/migrate` command in chat — copy tickets between Jira and Azure DevOps
- `/parent` and `/setupai` commands in chat
- Unit test suite — 169 tests covering intent parsing, formatting, extension activation, panel integrity, and package.json validation
- GitHub Actions CI/CD pipeline with build, test, package, and release automation
- Professional SVG/PNG extension icon
- Comprehensive README with three usage modes documented

### Fixed
- Service worker error — "Failed to register a ServiceWorker: The document is in an invalid state" caused by missing WebviewViewProvider, stale caches, and retainContextWhenHidden
- Chat panel not responding to commands — backtick characters in template literal broke all JavaScript event handlers
- Configure Platform form blank — template interpolation escaping issue
- Jira project dropdown not clickable — inline onclick attributes replaced with addEventListener
- Jira project dropdown not collapsing after selection
- ADO create error TF401320 — Description field now always populated
- Token persistence — stored API tokens now survive wizard re-opens and VS Code restarts
- Duplicate extension conflict — publisher ID standardized

### Changed
- All panels compile from TypeScript source (no pre-built injection)
- Sidebar converted from button panel to full chat interface
- Script blocks in webviews built via string arrays to avoid template literal escaping issues
- Publisher changed to DataAlchemy

## [0.4.1] - 2026-03-24

### Added
- Standalone chat panel (works without GitHub Copilot)
- Azure DevOps and Jira project auto-loading in setup wizard
- AI-powered ticket enhancement (Copilot, Anthropic, OpenAI, Azure OpenAI)
- Sprint management and work item migration between platforms

## [0.3.0] - 2026-03-15

### Added
- Command palette mode for all actions
- Work item detail panel
- Status bar shortcut

## [0.2.0] - 2026-03-01

### Added
- Setup wizard with persistent webview panel
- Jira and Azure DevOps provider implementations

## [0.1.0] - 2026-02-15

### Added
- Initial release with GitHub Copilot chat participant
- Natural language intent parsing
- Jira and Azure DevOps support
