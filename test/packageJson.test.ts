// test/packageJson.test.ts
// Validates package.json declarations match actual code — prevents the
// service worker error caused by declared-but-unregistered webview views.

import * as fs from 'fs';
import * as path from 'path';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const extSrc = fs.readFileSync(path.join(__dirname, '..', 'out', 'extension.js'), 'utf8');

describe('package.json integrity', () => {
  it('has publisher set to DataAlchemy', () => {
    expect(pkg.publisher).toBe('DataAlchemy');
  });

  it('has a valid version', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('main points to out/extension.js', () => {
    expect(pkg.main).toBe('./out/extension.js');
  });

  describe('views', () => {
    const views = pkg.contributes?.views ?? {};

    it('all declared webview views have a registered provider in extension.js', () => {
      for (const [container, viewList] of Object.entries(views) as [string, any[]][]) {
        for (const view of viewList) {
          if (view.type === 'webview') {
            // Check that extension.js registers a provider for this view ID
            expect(extSrc).toContain(view.id);
            expect(extSrc).toContain('registerWebviewViewProvider');
          }
        }
      }
    });

    it('view containers are declared for every view container used', () => {
      const containers = pkg.contributes?.viewsContainers?.activitybar ?? [];
      const containerIds = containers.map((c: any) => c.id);
      for (const containerId of Object.keys(views)) {
        expect(containerIds).toContain(containerId);
      }
    });
  });

  describe('commands', () => {
    const declaredCommands = (pkg.contributes?.commands ?? []).map((c: any) => c.command);

    it('all declared commands are registered in extension.js', () => {
      for (const cmd of declaredCommands) {
        expect(extSrc).toContain(cmd);
      }
    });

    it('has no duplicate command IDs', () => {
      const unique = new Set(declaredCommands);
      expect(unique.size).toBe(declaredCommands.length);
    });
  });

  describe('activation events', () => {
    it('uses onStartupFinished', () => {
      expect(pkg.activationEvents).toContain('onStartupFinished');
    });
  });

  describe('configuration properties', () => {
    const props = pkg.contributes?.configuration?.properties ?? {};

    it('defines pmAgent.platform', () => {
      expect(props['pmAgent.platform']).toBeDefined();
      expect(props['pmAgent.platform'].enum).toContain('jira');
      expect(props['pmAgent.platform'].enum).toContain('azuredevops');
    });

    it('defines Jira config properties', () => {
      expect(props['pmAgent.jira.baseUrl']).toBeDefined();
      expect(props['pmAgent.jira.email']).toBeDefined();
      expect(props['pmAgent.jira.defaultProject']).toBeDefined();
    });

    it('defines ADO config properties', () => {
      expect(props['pmAgent.azureDevOps.orgUrl']).toBeDefined();
      expect(props['pmAgent.azureDevOps.project']).toBeDefined();
    });

    it('defines AI provider properties', () => {
      expect(props['pmAgent.ai.provider']).toBeDefined();
      expect(props['pmAgent.ai.provider'].enum).toContain('copilot');
      expect(props['pmAgent.ai.provider'].enum).toContain('anthropic');
    });
  });
});

describe('languageModelTools contribution (agent interoperability)', () => {
  const pkg = require('../package.json');

  it('declares the pm_* tools so Copilot agent mode + other extensions can discover them', () => {
    const tools = pkg.contributes.languageModelTools;
    expect(Array.isArray(tools)).toBe(true);
    const names = tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'pm_listWorkItems', 'pm_getWorkItem', 'pm_createWorkItem',
      'pm_updateWorkItem', 'pm_transitionWorkItem', 'pm_addComment',
      'pm_listProjectMembers', 'pm_getSprints', 'pm_listProjects', 'pm_getWorkItemTypes'
    ]));
  });

  it('every tool has a modelDescription and inputSchema (required for model selection)', () => {
    for (const t of pkg.contributes.languageModelTools) {
      expect(typeof t.modelDescription).toBe('string');
      expect(t.modelDescription.length).toBeGreaterThan(10);
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('exposes the /agent slash command on the participant', () => {
    const main = pkg.contributes.chatParticipants.find((c: any) => c.id === 'pm-agent.main');
    const cmds = main.commands.map((c: any) => c.name);
    expect(cmds).toContain('agent');
  });
});
