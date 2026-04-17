// test/panels.test.ts
// Tests that verify webview HTML output is correct — CSP present,
// no retainContextWhenHidden, no emoji, proper template interpolation.

import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = path.join(__dirname, '..', 'out', 'panels');

function readPanel(name: string): string {
  return fs.readFileSync(path.join(OUT_DIR, `${name}.js`), 'utf8');
}

describe('panel compiled output', () => {
  const panels = ['chatPanel', 'setupWizardPanel', 'sidebarViewProvider', 'workItemPanel'];

  describe.each(panels)('%s', (panelName) => {
    let source: string;

    beforeAll(() => {
      source = readPanel(panelName);
    });

    it('exists as a compiled JS file', () => {
      expect(source).toBeTruthy();
      expect(source.length).toBeGreaterThan(100);
    });

    it('has Content-Security-Policy meta tag', () => {
      expect(source).toContain('Content-Security-Policy');
    });

    it('has enableScripts: true', () => {
      expect(source).toContain('enableScripts');
    });

    it('does NOT use retainContextWhenHidden in runtime code (except panels that need state persistence)', () => {
      // chatPanel: has a WebviewPanelSerializer
      // setupWizardPanel: needs to retain type mappings and field defaults UI state
      if (panelName === 'chatPanel' || panelName === 'setupWizardPanel') { return; }
      const noComments = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(noComments).not.toContain('retainContextWhenHidden: true');
    });

    it('contains no unicode emoji characters', () => {
      // Match common emoji ranges
      const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]/u;
      expect(emojiRegex.test(source)).toBe(false);
    });

    it('contains no HTML entity emoji (&#128xxx)', () => {
      // &#127xxx and &#128xxx are emoji ranges
      expect(source).not.toMatch(/&#12[789]\d{3};/);
      expect(source).not.toMatch(/&#128\d{3};/);
    });

    it('has <!DOCTYPE html> in the HTML template', () => {
      expect(source).toContain('<!DOCTYPE html>');
    });

    it('exports the expected class', () => {
      const exportMap: Record<string, string> = {
        chatPanel: 'ChatPanel',
        setupWizardPanel: 'SetupWizardPanel',
        sidebarViewProvider: 'SidebarViewProvider',
        workItemPanel: 'WorkItemPanel',
      };
      expect(source).toContain(exportMap[panelName]);
    });
  });
});

describe('setupWizardPanel template interpolation', () => {
  it('injects safeJson via string concatenation (not template literal)', () => {
    const source = readPanel('setupWizardPanel');
    // safeJson is now passed as a parameter to getScript() and concatenated
    expect(source).toContain('getScript(safeJson)');
    // The script should contain: 'var pre = ' + safeJson + ';'
    expect(source).toContain("+ safeJson +");
  });
});

describe('sidebarViewProvider', () => {
  it('has viewType matching package.json', () => {
    const source = readPanel('sidebarViewProvider');
    expect(source).toContain("pm-agent.workItemView");
  });

  it('implements resolveWebviewView', () => {
    const source = readPanel('sidebarViewProvider');
    expect(source).toContain('resolveWebviewView');
  });
});

describe('chatPanel', () => {
  it('has a static restore method', () => {
    const source = readPanel('chatPanel');
    expect(source).toMatch(/restore/);
  });

  it('has no raw backticks inside the HTML script block', () => {
    const source = readPanel('chatPanel');
    // The script is now built via getScript() using single-quoted strings,
    // so the template literal in getHtml should NOT contain any script code.
    // Verify getScript method exists and uses single-quoted string array
    expect(source).toContain('getScript()');
    expect(source).toContain(".join('\\n')");
    // The getScript method body should have zero backticks
    const getScriptBlock = source.match(/getScript\(\)\s*\{[\s\S]*?\.join\(/);
    expect(getScriptBlock).toBeTruthy();
    const backticks = (getScriptBlock![0].match(/`/g) || []).length;
    expect(backticks).toBe(0);
  });

  it('has viewType pmAgent.chat', () => {
    const source = readPanel('chatPanel');
    expect(source).toContain("pmAgent.chat");
  });

  it('handles __setup__ chip command', () => {
    const source = readPanel('chatPanel');
    expect(source).toContain('__setup__');
  });

  it('handles __ai__ chip command', () => {
    const source = readPanel('chatPanel');
    expect(source).toContain('__ai__');
  });

  it('handles __user__ chip command', () => {
    const source = readPanel('chatPanel');
    expect(source).toContain('__user__');
  });
});

describe('retainContextWhenHidden usage', () => {
  it('chatPanel uses retainContextWhenHidden (has serializer)', () => {
    const source = readPanel('chatPanel');
    expect(source).toContain('retainContextWhenHidden: true');
  });

  it('setupWizardPanel uses retainContextWhenHidden (needs state persistence)', () => {
    const source = readPanel('setupWizardPanel');
    expect(source).toContain('retainContextWhenHidden: true');
  });

  it('workItemPanel does NOT use retainContextWhenHidden', () => {
    const source = readPanel('workItemPanel');
    const noComments = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noComments).not.toContain('retainContextWhenHidden: true');
  });
});

describe('security checks', () => {
  const allPanels = ['chatPanel', 'setupWizardPanel', 'sidebarViewProvider', 'workItemPanel'];

  it.each(allPanels)('%s has Content-Security-Policy', (name) => {
    const source = readPanel(name);
    expect(source).toContain('Content-Security-Policy');
  });

  it.each(allPanels)('%s has no eval() or new Function()', (name) => {
    const source = readPanel(name);
    const noStrings = source.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
    expect(noStrings).not.toMatch(/\beval\s*\(/);
    expect(noStrings).not.toMatch(/new\s+Function\s*\(/);
  });

  it('setupWizardPanel does not embed actual tokens in webview pre object', () => {
    const source = readPanel('setupWizardPanel');
    // The pre object serialized into the webview should use boolean flags, not actual tokens
    // Look for the getScript/safeJson pattern — tokens should only appear in the extension host
    // message handlers (case 'save'), never in the HTML/JS template
    expect(source).toContain('_hasJiraToken');
    expect(source).toContain('_hasAdoToken');
    expect(source).toContain('_hasGithubToken');
    // The getHtml function should pass pre which contains _hasXxxToken booleans
    // but NOT jiraToken/adoToken/githubToken string values
    const getHtmlBlock = source.match(/function getHtml[\s\S]*?return \[/);
    if (getHtmlBlock) {
      expect(getHtmlBlock[0]).not.toContain('creds.jiraToken');
      expect(getHtmlBlock[0]).not.toContain('creds.adoToken');
      expect(getHtmlBlock[0]).not.toContain('creds.githubToken');
    }
  });

  it('setupWizardPanel tokenStatus uses HTML escaping', () => {
    const source = readPanel('setupWizardPanel');
    // The safe() function should escape HTML before inserting into innerHTML
    expect(source).toContain('replace(/&/g');
    expect(source).toContain('replace(/</g');
  });

  it('chatPanel validates URLs before openExternal', () => {
    const source = readPanel('chatPanel');
    expect(source).toContain("startsWith('https://')");
  });

  it('sidebarViewProvider validates URLs before openExternal', () => {
    const source = readPanel('sidebarViewProvider');
    expect(source).toContain("startsWith('https://')");
  });

  it('setupWizardPanel uses ALLOWED_URLS whitelist for openExternal', () => {
    const source = readPanel('setupWizardPanel');
    expect(source).toContain('ALLOWED_URLS');
    expect(source).toContain('isWhitelisted');
  });
});
