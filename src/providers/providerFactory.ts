// src/providers/providerFactory.ts
// Registry-based provider factory. Adding a new provider:
// 1. Create myProvider.ts implementing IProvider
// 2. Register it here with registerProvider()
// 3. Add credentials to ApiCredentials in types.ts
// 4. The rest of the codebase uses IProvider — no other changes needed.

import { ApiCredentials, Platform } from '../types';
import { IProvider } from './IProvider';
import { JiraProvider } from './jiraProvider';
import { AdoProvider } from './adoProvider';
import { GitHubProvider } from './githubProvider';

export type AnyProvider = IProvider;

type ProviderConstructor = (creds: ApiCredentials) => IProvider;

const registry = new Map<Platform, ProviderConstructor>();

/** Register a provider for a platform. */
export function registerProvider(platform: Platform, ctor: ProviderConstructor): void {
  registry.set(platform, ctor);
}

/** Create a provider for the given credentials. */
export function createProvider(creds: ApiCredentials): IProvider {
  const ctor = registry.get(creds.platform);
  if (!ctor) {
    throw new Error(`No provider registered for platform "${creds.platform}". Available: ${[...registry.keys()].join(', ')}`);
  }
  return ctor(creds);
}

/** Get all registered platform names. */
export function getRegisteredPlatforms(): Platform[] {
  return [...registry.keys()];
}

// ── Built-in registrations ───────────────────────────────────────────────
registerProvider('jira',         (c) => new JiraProvider(c));
registerProvider('azuredevops',  (c) => new AdoProvider(c));
registerProvider('github',       (c) => new GitHubProvider(c));
