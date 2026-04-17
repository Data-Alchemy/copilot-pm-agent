// test/__mocks__/vscode.ts
// Comprehensive VS Code API mock for unit testing

export const Uri = {
  joinPath: jest.fn((...args: any[]) => args.join('/')),
  parse: jest.fn((s: string) => s),
};

export const ViewColumn = { One: 1, Two: 2, Three: 3 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

// Track all registered commands, providers, serializers
export const _registered = {
  commands: new Map<string, Function>(),
  viewProviders: new Map<string, any>(),
  serializers: new Map<string, any>(),
  statusBarItems: [] as any[],
};

export function _reset() {
  _registered.commands.clear();
  _registered.viewProviders.clear();
  _registered.serializers.clear();
  _registered.statusBarItems.length = 0;
  (window as any)._showInfoArgs = undefined;
}

export const commands = {
  registerCommand: jest.fn((id: string, fn: Function) => {
    _registered.commands.set(id, fn);
    return { dispose: jest.fn() };
  }),
  executeCommand: jest.fn(() => Promise.resolve()),
};

export const window = {
  createWebviewPanel: jest.fn((_viewType: string, _title: string, _col: any, opts: any) => ({
    viewType: _viewType,
    webview: {
      html: '',
      options: opts,
      onDidReceiveMessage: jest.fn(() => ({ dispose: jest.fn() })),
      postMessage: jest.fn(),
    },
    onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
    reveal: jest.fn(),
    dispose: jest.fn(),
  })),
  registerWebviewViewProvider: jest.fn((id: string, provider: any, opts?: any) => {
    _registered.viewProviders.set(id, { provider, opts });
    return { dispose: jest.fn() };
  }),
  registerWebviewPanelSerializer: jest.fn((viewType: string, serializer: any) => {
    _registered.serializers.set(viewType, serializer);
    return { dispose: jest.fn() };
  }),
  createStatusBarItem: jest.fn(() => {
    const item = { show: jest.fn(), hide: jest.fn(), dispose: jest.fn(), text: '', tooltip: '', command: '' };
    _registered.statusBarItems.push(item);
    return item;
  }),
  showInformationMessage: jest.fn((...args: any[]) => {
    (window as any)._showInfoArgs = args;
    return Promise.resolve(undefined);
  }),
  showErrorMessage: jest.fn(() => Promise.resolve()),
  showQuickPick: jest.fn(() => Promise.resolve()),
  showInputBox: jest.fn(() => Promise.resolve()),
  activeTextEditor: undefined,
};

export const workspace = {
  getConfiguration: jest.fn(() => ({
    get: jest.fn((_key: string, defaultVal?: any) => defaultVal),
    update: jest.fn(() => Promise.resolve()),
  })),
};

export const env = {
  openExternal: jest.fn(() => Promise.resolve()),
};

export const chat = undefined; // Copilot not available by default

// Helper to create a mock ExtensionContext
export function createMockContext(overrides: Record<string, any> = {}): any {
  return {
    extensionUri: '/mock/extension',
    secrets: {
      get: jest.fn(() => Promise.resolve(undefined)),
      store: jest.fn(() => Promise.resolve()),
      delete: jest.fn(() => Promise.resolve()),
    },
    globalState: {
      get: jest.fn((_key: string) => undefined),
      update: jest.fn(() => Promise.resolve()),
    },
    workspaceState: {
      get: jest.fn(() => undefined),
      update: jest.fn(() => Promise.resolve()),
    },
    subscriptions: [],
    ...overrides,
  };
}
