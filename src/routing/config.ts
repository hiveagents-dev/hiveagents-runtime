import { snapshotAgentOptions } from '../public/agent-options.js';
import type { AgentOptions, ModelInfo } from '../public/types.js';
import type { Runtime } from '../core/runtime.js';
import { agentMemory } from '../session/memory.js';
import { digest, hash, identifier, jsonClone, object, strings, snapshot, ownObject } from '../shared/json.js';
import type { AutoModelSelection, RoutingAgentDefinition, RoutingTask } from './types.js';
// `memory` takes only `false` (the opt-out of a Runtime default): a provider object is code, and has no digest.
const optionKeys = ['model', 'tools', 'cwd', 'instructions', 'effort', 'transport', 'context', 'permissions', 'environment', 'capabilities', 'providerOptions', 'requireAuth', 'memory'];
const capabilityKeys = ['interactiveApprovals', 'userInputDuringTurn', 'steering', 'inProcessTools', 'processPersistence', 'messageDeltas', 'tokenDeltas', 'dynamicPermissions', 'sessionInspection', 'checkpointOrRollback', 'subagentLifecycle', 'subagentMessages', 'subagentDeltas', 'refusalDetection', 'forkWithPrompt', 'forkWithoutPrompt', 'images', 'files'];
function enumValue(value: unknown, values: readonly unknown[]): void { if (!values.includes(value)) throw new TypeError('Invalid option value'); }
function optionalEnum(value: Record<string, unknown>, key: string, choices: readonly unknown[]): void { if (key in value) enumValue(value[key], choices); }
function textFields(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) if (key in value && typeof value[key] !== 'string') throw new TypeError(`Invalid ${key}`);
}
function validateOptions(value: Record<string, unknown>): void {
  object(value, optionKeys); textFields(value, ['cwd', 'instructions', 'effort']);
  optionalEnum(value, 'transport', ['exec', 'control', 'auto']); optionalEnum(value, 'requireAuth', ['any', 'subscription']); optionalEnum(value, 'memory', [false]);
  if ('context' in value) {
    object(value.context, ['profile', 'memory']); optionalEnum(value.context, 'profile', ['native', 'project', 'clean']); optionalEnum(value.context, 'memory', ['inherit', 'off', 'read-only']);
  }
  if ('permissions' in value) {
    object(value.permissions, ['mode', 'network', 'additionalDirectories', 'minimumEnforcement', 'strict']);
    enumValue(value.permissions.mode, ['analyze', 'respond', 'edit', 'unrestricted']); optionalEnum(value.permissions, 'network', ['allow', 'deny']);
    optionalEnum(value.permissions, 'minimumEnforcement', ['harness', 'sandbox', 'external']); optionalEnum(value.permissions, 'strict', [true, false]);
    if ('additionalDirectories' in value.permissions) strings(value.permissions.additionalDirectories, 1024);
  }
  if ('environment' in value) {
    object(value.environment, ['mode', 'variables', 'passthrough']); enumValue(value.environment.mode, ['inherit', 'minimal', 'explicit']);
    if ('variables' in value.environment) { object(value.environment.variables); textFields(value.environment.variables, Object.keys(value.environment.variables)); }
    if ('passthrough' in value.environment) strings(value.environment.passthrough, 1024);
  }
  if ('capabilities' in value) { object(value.capabilities, capabilityKeys); for (const entry of Object.values(value.capabilities)) enumValue(entry, [true, false, 'required', 'preferred']); }
  if ('providerOptions' in value) {
    const p = value.providerOptions; object(p, ['external', 'claude', 'codex', 'experimentalControl', 'experimentalApi']);
    optionalEnum(p, 'experimentalControl', [true, false]); optionalEnum(p, 'experimentalApi', [true, false]);
    if ('external' in p) { object(p.external); for (const entry of Object.values(p.external)) object(entry); }
    if ('claude' in p) {
      object(p.claude, ['systemPromptMode', 'settings', 'mcpConfigs', 'tools', 'strictMcpConfig']);
      optionalEnum(p.claude, 'systemPromptMode', ['append', 'replace']); optionalEnum(p.claude, 'strictMcpConfig', [true, false]);
      if ('settings' in p.claude && typeof p.claude.settings !== 'string') object(p.claude.settings);
      for (const key of ['mcpConfigs', 'tools']) if (key in p.claude) strings(p.claude[key], 1024);
    }
    if ('codex' in p) {
      object(p.codex, ['config', 'skipGitRepoCheck', 'ignoreUserConfig', 'ignoreRules', 'ephemeral']);
      for (const key of ['skipGitRepoCheck', 'ignoreUserConfig', 'ignoreRules', 'ephemeral']) optionalEnum(p.codex, key, [true, false]);
      if ('config' in p.codex) object(p.codex.config);
    }
  }
  if ('tools' in value) {
    if (!Array.isArray(value.tools)) throw new TypeError('Expected tools array');
    for (const tool of value.tools) object(tool, ['name', 'description', 'inputSchema', 'timeoutMs', 'maxOutputBytes', 'authorize', 'execute']);
  }
}
export interface NormalizedSelection {
  options: Readonly<Omit<AgentOptions, 'model'>>; models: ModelInfo[]; auto?: AutoModelSelection;
  primary: string[]; fallback?: string; ruleId?: string; configDigest: string; taskDigest: string;
}
export function normalize(definition: RoutingAgentDefinition, runtime: Runtime, task?: RoutingTask): NormalizedSelection {
  definition = snapshot(definition, true); object(definition); validateOptions(definition);
  if (task !== undefined) {
    task = jsonClone(task); object(task, ['id', 'version', 'inputDigest', 'tags']); identifier(task.id); identifier(task.version); hash(task.inputDigest);
    if (task.tags !== undefined) { strings(task.tags, 32); task.tags.forEach(identifier); }
    task = jsonClone(task);
  }
  const fixed = typeof definition.model === 'string'; let auto: AutoModelSelection | undefined;
  const resolve = (name: string): ModelInfo => {
    if (typeof name !== 'string' || !name.trim() || name.length > 512) throw new TypeError('Invalid model');
    const model = runtime.resolveModel(name);
    if (!['available', 'unavailable', 'unverified'].includes(model.availability)) throw new TypeError('Invalid model availability');
    if (`${model.provider}/${model.id}`.length > 512) throw new TypeError('Invalid canonical model'); return model;
  };
  let models: ModelInfo[];
  if (fixed) models = [resolve(definition.model as string)];
  else {
    const raw = definition.model; object(raw, ['mode', 'candidates', 'providers', 'allowUnverifiedModels', 'allowUnknownAuth', 'rules', 'fallback']);
    if (raw.mode !== 'auto') throw new TypeError('Invalid selection mode');
    optionalEnum(raw, 'allowUnverifiedModels', [true, false]); optionalEnum(raw, 'allowUnknownAuth', [true, false]);
    if (raw.providers !== undefined) { strings(raw.providers, 64); for (const provider of raw.providers) runtime.registration(provider); }
    if (raw.candidates !== undefined) { strings(raw.candidates, 64); models = raw.candidates.map(resolve); }
    else {
      models = runtime.providers().flatMap(provider => {
        try { return [...runtime.registration(provider).modelCatalog].map(model => resolve(`${provider}/${model.id}`)); }
        catch (error) { if ((error as { code?: string }).code === 'UNKNOWN_PROVIDER') return []; throw error; }
      });
    }
    auto = jsonClone(raw) as unknown as AutoModelSelection;
  }
  const names = models.map(model => `${model.provider}/${model.id}`);
  if (models.length > 64 || new Set(names).size !== names.length) throw new TypeError('Too many or duplicate canonical candidates');
  let fallback: string | undefined; let ruleId: string | undefined; let primary = [...names];
  if (auto) {
    const member = (value: string): string => { const model = resolve(value); const name = `${model.provider}/${model.id}`; if (!names.includes(name)) throw new TypeError('Model reference outside candidate universe'); return name; };
    if (auto.fallback !== undefined) fallback = member(auto.fallback);
    if (auto.rules !== undefined) {
      if (!Array.isArray(auto.rules) || auto.rules.length > 64) throw new TypeError('Invalid rules');
      const ids = new Set<string>(); const normalizedRules = auto.rules.map(rule => {
        object(rule, ['id', 'allTags', 'models']); identifier(rule.id);
        if (ids.has(rule.id)) throw new TypeError('Duplicate rule ID'); ids.add(rule.id);
        strings(rule.allTags, 32, true); rule.allTags.forEach(identifier); strings(rule.models, 64, true);
        const ruleModels = rule.models.map(member);
        if (new Set(ruleModels).size !== ruleModels.length) throw new TypeError('Duplicate canonical rule models');
        return { id: rule.id as string, allTags: rule.allTags as string[], models: ruleModels };
      });
      const rule = normalizedRules.find(rule => rule.allTags.every(tag => task?.tags?.includes(tag)));
      primary = rule?.models ?? []; ruleId = rule?.id; auto = jsonClone({ ...auto, rules: normalizedRules });
    }
    auto = { ...auto, candidates: names, ...(fallback === undefined ? {} : { fallback }), allowUnknownAuth: auto.allowUnknownAuth ?? false, allowUnverifiedModels: auto.allowUnverifiedModels ?? false };
  }
  primary = primary.filter(name => name !== fallback);
  const { model: _model, ...rawRest } = definition;
  const rest = ownObject(rawRest, optionKeys);
  const options = snapshot(snapshotAgentOptions({ ...rest, ...((rest.tools?.length ?? 0) > 0 ? { capabilities: rest.capabilities ?? {} } : {}), model: names[0] ?? '', ...(!fixed && rest.transport === undefined ? { transport: 'exec' } : {}) }), true);
  const { model: _ignore, tools, memory: _memory, ...metadata } = options;
  const safeTools = tools?.map(({ authorize: _a, execute: _e, ...tool }) => tool);
  const memory = memoryDigest(options, runtime, models);
  return { options, models, ...(auto === undefined ? {} : { auto }), primary,
    ...(fallback === undefined ? {} : { fallback }), ...(ruleId === undefined ? {} : { ruleId }),
    configDigest: digest({ ...metadata, model: auto ?? names[0], ...(safeTools === undefined ? {} : { tools: safeTools }), ...(memory === undefined ? {} : { memory }) }), taskDigest: digest(task ?? null) };
}

/**
 * The memory each candidate's Agent gets (the Runtime default unless `memory: false`), as the
 * config digest records it: the provider id and the scope for each candidate, never a function.
 * Undefined without memory, so the digest of a definition without memory is unchanged.
 */
function memoryDigest(options: Readonly<Omit<AgentOptions, 'model'>>, runtime: Runtime, models: readonly ModelInfo[]) {
  const fallback = options.memory === false ? undefined : runtime.memoryDefault();
  if (fallback === undefined) return undefined;
  const identities = models.map((model) => agentMemory(undefined, fallback, { model: structuredClone(model), ...(options.cwd === undefined ? {} : { cwd: options.cwd }) })!.identity);
  return identities.length === 0 ? undefined : { provider: identities[0]!.provider, scopes: identities.map(({ scope }) => scope) };
}
