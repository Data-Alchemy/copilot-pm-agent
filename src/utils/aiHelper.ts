// src/utils/aiHelper.ts
// Uses VS Code's built-in vscode.lm API (GitHub Copilot) as the primary AI.
// Falls back to external providers (Anthropic, OpenAI, Azure OpenAI) only if
// the user explicitly configures one.

import * as vscode from 'vscode';

export type AiProvider = 'copilot' | 'anthropic' | 'openai' | 'azure-openai' | 'none';

export interface AiConfig {
  provider:  AiProvider;
  apiKey?:   string;
  azureUrl?: string;
  model?:    string;
}

export interface AiTicketEnhancement {
  title:              string;
  what:               string;
  why:                string;
  how:                string;
  effortPoints:       number;
  effortReasoning:    string;
  priority:           string;
  priorityReasoning:  string;
  clarifyingQuestion: string | null;
}

export interface AiCommentEnhancement {
  enhanced:    string;
  suggestions: string[];
}

export interface AiEstimateResult {
  points:    number;
  reasoning: string;
  breakdown: string;
  risks:     string;
}

// ── Core: call via vscode.lm (Copilot) ───────────────────────────────────────

/**
 * Call AI via a LanguageModelChat.
 * If the model family is "auto" (a virtual routing model that can't accept
 * requests directly), fall back to selectChatModels to get a real model.
 */
async function callCopilot(
  system: string,
  user:   string,
  model:  vscode.LanguageModelChat
): Promise<string> {
  // "auto" is Copilot's model router — it cannot accept sendRequest directly.
  // Resolve it to an actual model first.
  let resolvedModel = model;
  if (model.family === 'auto' || model.id === 'auto' || model.family === '') {
    const families = [
      { family: 'gpt-4o' },
      { family: 'claude-3.5-sonnet' },
      { family: 'claude-sonnet-4' },
      { family: 'gemini-1.5-pro' },
      {}  // any available model
    ];
    let found = false;
    for (const selector of families) {
      try {
        const models = await vscode.lm.selectChatModels(selector);
        if (models.length) { resolvedModel = models[0]; found = true; break; }
      } catch { /* try next */ }
    }
    if (!found) {
      throw new Error(
        'NO_COPILOT_MODEL: Could not resolve a usable model from "auto". ' +
        'Make sure GitHub Copilot is signed in and a model is available.'
      );
    }
  }

  // Always respond in English regardless of input language or system locale
  const systemWithLang = system + '\nIMPORTANT: Always respond in English only. Do not use any other language regardless of the input language.';

  const messages = [
    vscode.LanguageModelChatMessage.User(systemWithLang),
    vscode.LanguageModelChatMessage.Assistant('Understood. I will respond in English only with valid JSON.'),
    vscode.LanguageModelChatMessage.User(user)
  ];

  const response = await resolvedModel.sendRequest(
    messages,
    {},
    new vscode.CancellationTokenSource().token
  );

  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
  }
  return text.trim();
}

/**
 * Fallback: try selectChatModels when no request model is available
 * (e.g. for test/debug calls outside a chat request).
 */
async function selectFallbackModel(): Promise<vscode.LanguageModelChat> {
  const families = [
    { family: 'gpt-4o' },
    { family: 'claude-3.5-sonnet' },
    { family: 'gemini-1.5-pro' },
    {}
  ];
  for (const selector of families) {
    try {
      const models = await vscode.lm.selectChatModels(selector);
      if (models.length) { return models[0]; }
    } catch { /* try next */ }
  }
  throw new Error(
    'NO_COPILOT_MODEL: No AI model available. ' +
    'Make sure GitHub Copilot Chat is installed and you are signed in to GitHub in VS Code. ' +
    'You can also run @pm /setupai to configure an alternative AI provider (Anthropic, OpenAI, Azure).'
  );
}

// ── Core: call via external REST API ─────────────────────────────────────────

async function callExternal(config: AiConfig, system: string, user: string): Promise<string> {
  if (!config.apiKey) { throw new Error('AI_DISABLED'); }

  let url: string;
  let headers: Record<string, string>;
  let body: string;

  if (config.provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = {
      'Content-Type':      'application/json',
      'x-api-key':         config.apiKey,
      'anthropic-version': '2023-06-01'
    };
    body = JSON.stringify({
      model:      config.model ?? 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: user }]
    });
  } else if (config.provider === 'azure-openai') {
    if (!config.azureUrl) { throw new Error('Azure OpenAI endpoint URL not configured.'); }
    url = config.azureUrl;
    headers = { 'Content-Type': 'application/json', 'api-key': config.apiKey };
    body = JSON.stringify({
      messages:   [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 1200, temperature: 0.3
    });
  } else {
    // openai
    url = 'https://api.openai.com/v1/chat/completions';
    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` };
    body = JSON.stringify({
      model:      config.model ?? 'gpt-4o',
      messages:   [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 1200, temperature: 0.3
    });
  }

  const res = await globalThis.fetch(url, { method: 'POST', headers, body });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json() as {
    content?: Array<{ type: string; text: string }>;
    choices?: Array<{ message: { content: string } }>;
  };

  if (config.provider === 'anthropic') {
    return data.content?.find(b => b.type === 'text')?.text ?? '';
  }
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Unified caller: Copilot first, external fallback ─────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callAi(config: AiConfig, system: string, user: string, requestModel?: vscode.LanguageModelChat): Promise<any> {
  let raw: string;

  if (config.provider === 'none' || config.provider === 'copilot') {
    if (!requestModel) {
      // No model available — caller decided AI is unavailable, skip cleanly
      throw new Error('AI_UNAVAILABLE: No language model available. Install GitHub Copilot or run @pm /setupai to configure an AI provider.');
    }
    try {
      raw = await callCopilot(system, user, requestModel);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`AI_UNAVAILABLE: ${msg}`);
    }
  } else {
    // External provider (Anthropic / OpenAI / Azure)
    raw = await callExternal(config, system, user);
  }

  // Strip markdown fences
  let clean = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    // Truncated JSON — try to repair
    // Find the last complete object/array element
    const lastBrace = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
    if (lastBrace > 0) {
      let repaired = clean.slice(0, lastBrace + 1);
      // Close any unclosed arrays/objects
      const opens = (repaired.match(/\[/g) ?? []).length;
      const closes = (repaired.match(/\]/g) ?? []).length;
      for (let i = 0; i < opens - closes; i++) { repaired += ']'; }
      const openBraces = (repaired.match(/\{/g) ?? []).length;
      const closeBraces = (repaired.match(/\}/g) ?? []).length;
      for (let i = 0; i < openBraces - closeBraces; i++) { repaired += '}'; }
      try { return JSON.parse(repaired); } catch { /* fall through */ }
    }
    // Extract any JSON array from the response
    const arrayMatch = clean.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try { return JSON.parse(arrayMatch[0]); } catch { /* fall through */ }
    }
    throw new Error(`Invalid JSON from AI: ${clean.slice(0, 100)}...`);
  }
}

// ── Public AI functions ───────────────────────────────────────────────────────

export async function enhanceTicket(
  config:        AiConfig,
  type:          string,
  title:         string,
  rawNotes:      string,
  platform:      string,
  requestModel?: vscode.LanguageModelChat
): Promise<AiTicketEnhancement> {
  const system =
    `You are a senior engineering project manager writing high-quality ${platform} work items. ` +
    `Always respond in English. Respond with ONLY valid JSON — no preamble, no markdown fences, no extra text.`;

  const user =
    `Work item type: ${type}\nTitle: ${title}\nNotes: ${rawNotes || '(none)'}\n\n` +
    `Return JSON with exactly these fields:\n` +
    `{\n` +
    `  "title": "improved actionable title (close to original but clear)",\n` +
    `  "what": "2-3 sentences: exactly what to build or fix",\n` +
    `  "why": "2-3 sentences: business value or user impact",\n` +
    `  "how": "For stories: 3-5 bullet acceptance criteria in Given/When/Then or plain bullet form. For bugs: numbered steps to reproduce + expected vs actual. For tasks: 3-5 bullet implementation checklist.",\n` +
    `  "effortPoints": <fibonacci: 1|2|3|5|8|13>,\n` +
    `  "effortReasoning": "1 sentence why this estimate",\n` +
    `  "priority": "Critical|High|Medium|Low",\n` +
    `  "priorityReasoning": "1 sentence",\n` +
    `  "clarifyingQuestion": "one specific question if key info is missing to make a good ticket, or null"\n` +
    `}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await callAi(config, system, user, requestModel) as any;
  // Normalise 'how' — AI sometimes returns an array instead of a string
  if (result && typeof result === 'object') {
    if (Array.isArray(result.how)) {
      result.how = result.how.map((item: unknown) =>
        typeof item === 'string' ? item : JSON.stringify(item)
      ).join('\n');
    } else if (result.how !== null && typeof result.how !== 'string') {
      result.how = JSON.stringify(result.how);
    }
    result.how = result.how ?? '';
    // Same for what / why
    if (Array.isArray(result.what)) { result.what = result.what.join(' '); }
    if (Array.isArray(result.why))  { result.why  = result.why.join(' '); }
    result.what = String(result.what ?? '');
    result.why  = String(result.why  ?? '');
    // Ensure clarifyingQuestion is null not undefined/missing
    if (!('clarifyingQuestion' in result)) { result.clarifyingQuestion = null; }
  }
  return result;
}

export async function enhanceComment(
  config:        AiConfig,
  itemKey:       string,
  itemTitle:     string,
  itemStatus:    string,
  userDraft:     string,
  requestModel?: vscode.LanguageModelChat
): Promise<AiCommentEnhancement> {
  const system =
    `You are a professional developer writing a clear, structured work item comment. ` +
    `Always respond in English. Respond with ONLY valid JSON — no preamble, no markdown fences.`;

  const user =
    `Work item: ${itemKey} — "${itemTitle}" [${itemStatus}]\n` +
    `User's draft: "${userDraft}"\n\n` +
    `Return JSON:\n` +
    `{\n` +
    `  "enhanced": "Professionally structured version. Keep the user's meaning. Structure as: what was done/investigated, what was found, next steps. 2-5 sentences. No markdown.",\n` +
    `  "suggestions": ["up to 2 short suggestions for additional useful info to add, e.g. link PR, attach screenshot — empty array if none"]\n` +
    `}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return callAi(config, system, user, requestModel) as Promise<any>;
}

export async function estimateEffort(
  config:        AiConfig,
  type:          string,
  title:         string,
  description:   string,
  requestModel?: vscode.LanguageModelChat
): Promise<AiEstimateResult> {
  const system =
    `You are a senior software engineer estimating story points using Fibonacci (1,2,3,5,8,13). ` +
    `Always respond in English. Respond with ONLY valid JSON — no preamble, no markdown fences.`;

  const user =
    `${type}: "${title}"\nDescription: ${description || '(none)'}\n\n` +
    `Return JSON:\n` +
    `{\n` +
    `  "points": <1|2|3|5|8|13>,\n` +
    `  "reasoning": "1-2 sentences why",\n` +
    `  "breakdown": "e.g. Design: 0.5, Backend: 2, Frontend: 1, Testing: 0.5",\n` +
    `  "risks": "unknowns that could increase scope, or None identified"\n` +
    `}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return callAi(config, system, user, requestModel) as Promise<any>;
}

// ── Test connection ───────────────────────────────────────────────────────────

export async function testAiConnection(config: AiConfig): Promise<{
  ok: boolean;
  provider: string;
  modelName: string;
  error?: string;
}> {
  // Check external provider first if explicitly configured
  if (config.provider !== 'none' && config.provider !== 'copilot' && config.apiKey) {
    try {
      await callExternal(config, 'Respond with ONLY valid JSON, no other text.', 'Return {"ok":true}');
      return { ok: true, provider: config.provider, modelName: config.model ?? config.provider };
    } catch (e: unknown) {
      return {
        ok: false, provider: config.provider,
        modelName: config.model ?? config.provider,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }

  // Try Copilot — but never throw, always return a result
  try {
    const models = await Promise.race([
      vscode.lm.selectChatModels({}),
      new Promise<vscode.LanguageModelChat[]>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3000)
      )
    ]);
    if (models.length > 0) {
      const names = models.map(m => `${m.family} (${m.vendor})`).join(', ');
      return { ok: true, provider: 'GitHub Copilot', modelName: names };
    }
    return {
      ok: false, provider: 'GitHub Copilot', modelName: 'none',
      error: 'No models available — install "GitHub Copilot" extension (not just Copilot Chat) and sign in to GitHub'
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = msg === 'timeout'
      ? 'Copilot check timed out — GitHub Copilot engine may not be installed'
      : msg;
    return { ok: false, provider: 'GitHub Copilot', modelName: 'none', error: hint };
  }
}

/** List available Copilot models — always returns an array, never throws */
export async function listCopilotModels(): Promise<string[]> {
  try {
    const models = await Promise.race([
      vscode.lm.selectChatModels({}),
      new Promise<vscode.LanguageModelChat[]>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3000)
      )
    ]);
    return models.map(m => `${m.family} (${m.vendor})`);
  } catch {
    return [];
  }
}

// ── HTML conversion for ADO descriptions ─────────────────────────────────────

export function markdownToAdoHtml(input: unknown): string {
  // Defensive: AI may return an array, object, or non-string — coerce to string first
  let md: string;
  if (typeof input === 'string') {
    md = input;
  } else if (Array.isArray(input)) {
    // e.g. AI returned ["- criterion 1", "- criterion 2"]
    md = input.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
  } else if (input && typeof input === 'object') {
    // e.g. AI returned { criteria: [...] }
    md = JSON.stringify(input);
  } else {
    md = String(input ?? '');
  }

  const lines  = md.split('\n');
  const html: string[] = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) { html.push('</ul>'); inList = false; }
      continue;
    }
    // Bold-only lines → heading
    if (/^\*\*[^*]+\*\*$/.test(trimmed)) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h3>${trimmed.replace(/\*\*/g, '')}</h3>`);
    // Bullet / numbered list
    } else if (/^[-*•]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      if (!inList) { html.push('<ul>'); inList = true; }
      const text = trimmed
        .replace(/^[-*•]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html.push(`<li>${text}</li>`);
    // Regular paragraph
    } else {
      if (inList) { html.push('</ul>'); inList = false; }
      const text = trimmed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html.push(`<p>${text}</p>`);
    }
  }
  if (inList) { html.push('</ul>'); }
  return html.join('');
}

// ── Task generation ───────────────────────────────────────────────────────────

export interface GeneratedTask {
  title:         string;
  description:   string;
  effortPoints:  number;
  area:          string;    // e.g. "Backend", "Frontend", "Testing", "DevOps"
  suggestedType: string;    // best matching ADO work item type name
}

export async function generateTasksForStory(
  config:             AiConfig,
  storyTitle:         string,
  storyWhat:          string,
  storyHow:           string,
  platform:           string,
  availableTaskTypes: string[],
  workItemType:       string = 'story',
  requestModel?:      vscode.LanguageModelChat
): Promise<GeneratedTask[]> {
  const system =
    `You are a senior software engineer breaking work items into concrete, specific implementation tasks. ` +
    `Each task must be a real piece of engineering work — code to write, a component to build, a config to change. ` +
    `Do NOT default to QA or testing tasks unless the story is specifically about testing. ` +
    `Always respond in English. Respond with ONLY a valid JSON array — no preamble, no markdown fences, no explanation.`;

  const typeGuide: Record<string, string> = {
    bug:     'Focus on: root cause investigation, the specific code fix, regression test for the fix. Do NOT add generic QA tasks.',
    story:   'Focus on the actual implementation work: backend logic, API changes, frontend UI, data model changes. Add a testing task only if explicit testing acceptance criteria exist.',
    feature: 'Focus on design, implementation across relevant layers (API, UI, DB), and integration. Only add a testing task if it is a significant new surface area.',
    epic:    'Break into major implementation workstreams. Each task should represent a meaningful deliverable.',
    task:    'Break into specific sub-steps. Be concrete about what code/config needs changing.'
  };

  const guide = typeGuide[workItemType.toLowerCase()] ?? typeGuide['story'];

  const typeListStr = availableTaskTypes.length
    ? `\nAvailable work item types in this project: ${availableTaskTypes.join(', ')}\nFor each task pick the BEST matching type from that list. Use "Task" for most things. Only use "Bug" for defect-fix tasks. Only use types that match the actual work.`
    : '';

  const user =
    `Work item type: ${workItemType}\n` +
    `Title: "${storyTitle}"\n` +
    `What needs to be done: ${storyWhat || '(see title)'}\n` +
    `Acceptance criteria: ${storyHow || '(none specified)'}\n` +
    `${typeListStr}\n\n` +
    `RULES:\n` +
    `- ${guide}\n` +
    `- Generate 3-5 tasks. Only add a 6th if truly necessary.\n` +
    `- Every task must have a SPECIFIC title — not "Implement feature" but "Add POST /api/export endpoint"\n` +
    `- Tasks must reflect what the story is actually about — backend story = backend tasks, UI story = UI tasks\n` +
    `- DO NOT add generic tasks like "Write unit tests", "QA testing", "Code review" unless the story is specifically about those things\n` +
    `- Effort should be realistic: most tasks are 1-3 pts\n\n` +
    `Return a JSON array (include suggestedType field):\n` +
    `[{ "title": "...", "description": "1-2 sentences of exactly what to implement", "effortPoints": <1|2|3|5>, "area": "Backend|Frontend|Database|DevOps|Design|Documentation", "suggestedType": "<best matching type from the available list, default to Task>" }]`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await callAi(config, system, user, requestModel) as any;
  // Handle both array response and {tasks: [...]} shape
  const tasks: GeneratedTask[] = Array.isArray(result) ? result : (result.tasks ?? []);
  // Normalise each task — AI may return objects/arrays for description
  return tasks.map(t => ({
    title:        typeof t.title       === 'string' ? t.title       : String(t.title ?? ''),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    description:  typeof t.description === 'string' ? t.description : (Array.isArray(t.description as any) ? (t.description as any[]).join(' ') : String(t.description ?? '')),
    effortPoints: typeof t.effortPoints === 'number' ? t.effortPoints : parseInt(String(t.effortPoints ?? '2'), 10) || 2,
    area:          typeof t.area          === 'string' ? t.area          : String(t.area          ?? 'Development'),
    suggestedType: typeof t.suggestedType === 'string' ? t.suggestedType : String(t.suggestedType ?? 'Task')
  }));
}
