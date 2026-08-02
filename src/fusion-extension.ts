import type { Usage } from '@earendil-works/pi-ai';
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { BorderedLoader, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import {
  CURRENT_MODEL_SELECTION,
  fusionModelConfigPath,
  loadFusionModelConfig,
  resolveFusionModels,
  saveFusionModelConfig,
} from './core/fusion/config.js';
import {
  FUSION_BRAINSTORM_TOOL_NAME,
  buildFusionCanonicalInput,
  normalizeFusionCommandRequest,
} from './core/fusion/context.js';
import {
  FUSION_BRAINSTORM_WORKFLOW,
  FUSION_VALIDATE_TOOL_NAME,
  FUSION_VALIDATE_WORKFLOW,
  type FusionWorkflowProfile,
} from './core/fusion/workflows.js';
import type { JsonObject } from './core/common.js';
import { FusionOrchestrator } from './core/fusion/orchestrator.js';
import {
  FUSION_CAPABILITY_VALUES,
  FUSION_DEFAULT_CAPABILITY,
  FUSION_RESULT_SCHEMA_VERSION,
  FusionError,
  cloneFusionUsage,
  type FusionCapability,
  type FusionModelConfigV1,
  type FusionModelSelection,
  type FusionProgressEvent,
  type FusionResultDetails,
  type FusionRunResult,
} from './core/fusion/types.js';
import {
  FusionModelSelector,
  type FusionModelChoice,
  type FusionModelSelectorResult,
} from './ui/fusion-model-selector.js';

const FUSION_STATUS_KEY = 'fusion';
const FUSION_RESULT_MESSAGE_TYPE = 'fusion-result';
const FUSION_REQUEST_MESSAGE_TYPE = 'fusion-request';
const FUSION_PROGRESS_SCHEMA_VERSION = 'pi-background-tasks.fusion-progress.v1';
const FUSION_REQUEST_SCHEMA_VERSION = 'pi-background-tasks.fusion-request.v1';
const FUSION_COMMAND_USAGE =
  'Usage: /fusion <prompt> (or run /fusion with no arguments to open the multiline editor).';
const FUSION_MODEL_COMMAND_NAME = 'fusion-models';

type FusionToolDetails = FusionResultDetails | FusionProgressDetails;
type FusionToolResultWithUsage = AgentToolResult<FusionToolDetails> & {
  usage: Usage;
};

type CommandDialogResult =
  | { type: 'completed'; result: FusionRunResult }
  | { type: 'failed'; error: unknown };

interface FusionProgressDetails {
  schema_version: typeof FUSION_PROGRESS_SCHEMA_VERSION;
  status: string;
  event: FusionProgressEvent;
}

interface ActiveFusionRun {
  controller: AbortController;
  settled: Promise<void>;
}

interface FusionRunRequest {
  source: 'command' | 'tool';
  ctx: ExtensionContext;
  request: string;
  profile?: FusionWorkflowProfile | undefined;
  capability?: FusionCapability | undefined;
  signal?: AbortSignal | undefined;
  toolCallId?: string | undefined;
  onProgress?: ((event: FusionProgressEvent) => void) | undefined;
}

interface FusionRequestDetails {
  schema_version: typeof FUSION_REQUEST_SCHEMA_VERSION;
  run_id: string;
  source: 'command';
}

export const FusionBrainstormParams = Type.Object(
  {
    prompt: Type.String({ description: 'Prompt to run through the five-model fusion workflow.' }),
    capability: Type.Optional(
      Type.Union([Type.Literal('reason'), Type.Literal('inspect'), Type.Literal('research')], {
        description:
          "Optional candidate-child capability: 'reason' uses no tools; 'inspect' enables read-only file inspection; 'research' enables read-only file inspection plus fusion_web_fetch.",
      }),
    ),
  },
  { additionalProperties: false },
);

type FusionBrainstormParamsValue = Static<typeof FusionBrainstormParams>;

function textContent(text: string) {
  return [{ type: 'text' as const, text }];
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contextMode(ctx: object): string | undefined {
  const mode = Reflect.get(ctx, 'mode');
  return typeof mode === 'string' ? mode : undefined;
}

function isTuiContext(ctx: ExtensionContext): boolean {
  const mode = contextMode(ctx);
  if (mode === undefined) return ctx.hasUI && ctx.ui.custom.length > 0;
  return mode === 'tui';
}

function qualifiedModelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorArtifactSuffix(error: unknown): string {
  return error instanceof FusionError && error.artifactDir !== undefined
    ? `\nArtifacts: ${error.artifactDir}`
    : '';
}

function toolFailureMessage(error: unknown): string {
  const coordinates: string[] = [];
  if (error instanceof FusionError) {
    const budget = error.budget;
    if (budget !== undefined) coordinates.push(`stage=${budget.budget_stage}`);
    else if (error.stage !== undefined) coordinates.push(`stage=${error.stage}`);
    if (error.slot !== undefined) coordinates.push(`slot=${String(error.slot)}`);
    if (error.attempt !== undefined) coordinates.push(`attempt=${String(error.attempt)}`);
  }
  const location = coordinates.length === 0 ? '' : ` (${coordinates.join(', ')})`;
  return `Fusion failed${location}: ${errorMessage(error)}${errorArtifactSuffix(error)}`;
}

function progressText(event: FusionProgressEvent, label = FUSION_BRAINSTORM_WORKFLOW.label): string {
  if (event.type === 'state') return `${label}: ${event.state.replace(/_/g, ' ')}`;
  if (event.type === 'candidate_started')
    return `${label}: candidate ${String(event.slot)} starting`;
  if (event.type === 'candidate_completed')
    return `${label}: candidates ${String(event.completed)}/${String(event.total)} complete`;
  if (event.type === 'evaluation_started')
    return event.repair
      ? `${label}: repairing evaluator JSON`
      : `${label}: evaluating candidates`;
  if (event.type === 'evaluation_retry')
    return `${label}: evaluator schema retry (${String(event.errors.length)} issue${event.errors.length === 1 ? '' : 's'})`;
  if (event.type === 'budget_warning')
    return `${label}: budget warning (${String(event.warnings.length)} stage${event.warnings.length === 1 ? '' : 's'} at or above 80%)`;
  if (event.type === 'calibration_warning')
    return `${label}: calibration warning (${String(event.warning.under_forecast_tokens)} tokens under forecast)`;
  if (event.type === 'merge_started') return `${label}: merging final answer`;
  if (event.type === 'completed') return `${label}: completed`;
  if (event.type === 'cancelled') return `${label}: cancelled (${event.reason})`;
  return `${label}: failed (${event.error})`;
}

function makeProgressDetails(
  event: FusionProgressEvent,
  label = FUSION_BRAINSTORM_WORKFLOW.label,
): FusionProgressDetails {
  return {
    schema_version: FUSION_PROGRESS_SCHEMA_VERSION,
    status: progressText(event, label),
    event,
  };
}

function usageSummary(details: FusionResultDetails): string {
  const tokens = details.usage.totalTokens;
  const cost = ` · $${details.usage.cost.total.toFixed(4)}`;
  return `${String(tokens)} tokens${cost}`;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string'
        ? part['text']
        : '',
    )
    .join('');
}

function renderFusionResultText(
  mergedText: string,
  details: FusionResultDetails,
  options: ToolRenderResultOptions,
  theme: Theme,
  label = FUSION_BRAINSTORM_WORKFLOW.label,
) {
  if (options.expanded) {
    const container = new Container();
    container.addChild(
      new Text(
        `${theme.fg('success', `✓ ${label} complete`)} ${theme.fg('dim', details.run_id)}\n${theme.fg('dim', `Artifacts: ${details.artifact_dir} · ${usageSummary(details)}`)}`,
        0,
        0,
      ),
    );
    container.addChild(new Markdown(mergedText, 0, 0, getMarkdownTheme()));
    return container;
  }
  const preview = mergedText.replace(/\s+/g, ' ').trim();
  return new Text(
    `${theme.fg('success', `✓ ${label}`)} ${theme.fg('dim', details.run_id)} ${theme.fg('muted', usageSummary(details))}\n${preview}`,
    0,
    0,
  );
}

function renderProgressResult(details: FusionProgressDetails, theme: Theme) {
  return new Text(theme.fg('warning', details.status), 0, 0);
}

function isFusionResultDetails(value: unknown): value is FusionResultDetails {
  if (!isRecord(value)) return false;
  return (
    value['schema_version'] === FUSION_RESULT_SCHEMA_VERSION &&
    typeof value['run_id'] === 'string' &&
    (value['workflow'] === 'brainstorm' || value['workflow'] === 'validate') &&
    (value['source'] === 'command' || value['source'] === 'tool') &&
    value['status'] === 'completed' &&
    typeof value['artifact_dir'] === 'string' &&
    isRecord(value['models']) &&
    typeof value['evaluator_attempts'] === 'number' &&
    isRecord(value['usage'])
  );
}

function isFusionProgressDetails(value: unknown): value is FusionProgressDetails {
  return (
    isRecord(value) &&
    value['schema_version'] === FUSION_PROGRESS_SCHEMA_VERSION &&
    typeof value['status'] === 'string'
  );
}

function choicesForSelector(
  ctx: ExtensionContext,
  config: FusionModelConfigV1,
): FusionModelChoice[] {
  const choices: FusionModelChoice[] = [];
  const current = ctx.model === undefined ? undefined : qualifiedModelKey(ctx.model);
  choices.push({
    value: CURRENT_MODEL_SELECTION,
    label: CURRENT_MODEL_SELECTION,
    description: current === undefined ? 'no current model selected' : `currently ${current}`,
    available: current !== undefined,
  });
  const seen = new Set<FusionModelSelection>([CURRENT_MODEL_SELECTION]);
  const available = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({ key: qualifiedModelKey(model), name: model.name }))
    .sort((left, right) => left.key.localeCompare(right.key));
  for (const model of available) {
    if (seen.has(model.key)) continue;
    seen.add(model.key);
    choices.push({ value: model.key, label: model.key, description: model.name, available: true });
  }
  for (const selection of [...config.candidates, config.evaluator, config.merger]) {
    if (seen.has(selection)) continue;
    seen.add(selection);
    choices.push({
      value: selection,
      label: selection,
      description: 'configured but not currently available',
      available: false,
    });
  }
  return choices;
}

function normalizeToolPrompt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('fusion_brainstorm requires prompt string');
  const prompt = value.trim();
  if (prompt.length === 0) throw new Error('fusion_brainstorm prompt must not be blank');
  return prompt;
}

function normalizeFusionCapability(value: unknown): FusionCapability {
  if (value === undefined) return FUSION_DEFAULT_CAPABILITY;
  if (typeof value !== 'string') {
    throw new Error(
      `fusion_brainstorm capability must be one of: ${FUSION_CAPABILITY_VALUES.join(', ')}`,
    );
  }
  if (FUSION_CAPABILITY_VALUES.includes(value as FusionCapability)) return value as FusionCapability;
  throw new Error(
    `fusion_brainstorm capability ${JSON.stringify(value)} is not supported; allowed values: ${FUSION_CAPABILITY_VALUES.join(', ')}`,
  );
}

export function prepareFusionArguments(args: unknown): FusionBrainstormParamsValue {
  if (!isRecord(args)) throw new Error('fusion_brainstorm arguments must be an object');
  const keys = Object.keys(args);
  const unknown = keys.filter((key) => key !== 'prompt' && key !== 'capability');
  if (unknown.length > 0 || !keys.includes('prompt')) {
    throw new Error('fusion_brainstorm arguments must contain prompt and optional capability only');
  }
  return {
    prompt: normalizeToolPrompt(args['prompt']),
    capability: normalizeFusionCapability(args['capability']),
  };
}

export const FusionValidateParams = Type.Object(
  {
    prompt: Type.String({
      description:
        'What was done and what must hold true about it. Reviewers read the repository themselves.',
    }),
  },
  { additionalProperties: false },
);

type FusionValidateParamsValue = Static<typeof FusionValidateParams>;

/**
 * `fusion_validate` takes no capability.
 *
 * A caller-supplied capability is rejected rather than ignored: silently dropping
 * `capability:'reason'` would run a review whose children never read the code,
 * which is the one outcome this tool exists to prevent.
 */
export function prepareFusionValidateArguments(args: unknown): FusionValidateParamsValue {
  if (!isRecord(args)) throw new Error('fusion_validate arguments must be an object');
  const keys = Object.keys(args);
  if (keys.includes('capability')) {
    throw new Error(
      'fusion_validate does not accept capability; validation always runs candidates with read-only inspect access',
    );
  }
  const unknown = keys.filter((key) => key !== 'prompt');
  if (unknown.length > 0 || !keys.includes('prompt')) {
    throw new Error('fusion_validate arguments must contain prompt only');
  }
  return { prompt: normalizeToolPrompt(args['prompt']) };
}

function linkSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (source === undefined) return () => undefined;
  if (source.aborted) {
    target.abort();
    return () => undefined;
  }
  const listener = () => {
    target.abort();
  };
  source.addEventListener('abort', listener, { once: true });
  return () => {
    source.removeEventListener('abort', listener);
  };
}

export function registerFusionExtension(pi: ExtensionAPI): void {
  const orchestrator = new FusionOrchestrator();
  const activeRuns = new Set<ActiveFusionRun>();
  let shuttingDown = false;
  let lifecycleGeneration = 0;

  async function runFusion(request: FusionRunRequest): Promise<FusionRunResult> {
    if (shuttingDown) throw new Error('fusion extension is shutting down');
    const generation = lifecycleGeneration;
    const controller = new AbortController();
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const active: ActiveFusionRun = { controller, settled };
    activeRuns.add(active);
    const unlink = linkSignal(request.signal, controller);
    const assertActive = () => {
      if (controller.signal.aborted)
        throw new FusionError('fusion run cancelled before child launch', {
          code: 'child_cancelled',
          childCreated: false,
        });
      if (shuttingDown || lifecycleGeneration !== generation)
        throw new Error('fusion extension is shutting down');
    };
    const profile = request.profile ?? FUSION_BRAINSTORM_WORKFLOW;
    try {
      assertActive();
      const contextOptions =
        request.toolCallId === undefined
          ? {
              source: request.source,
              request: request.request,
              toolName: profile.toolName,
            }
          : {
              source: request.source,
              request: request.request,
              toolCallId: request.toolCallId,
              toolName: profile.toolName,
            };
      const built = buildFusionCanonicalInput(request.ctx, contextOptions);
      const cwd = request.ctx.cwd;
      const sessionId = request.ctx.sessionManager.getSessionId();
      const modelRegistry = request.ctx.modelRegistry;
      const currentModel = request.ctx.model;
      const thinkingLevel = pi.getThinkingLevel();
      const loaded = await loadFusionModelConfig();
      assertActive();
      const models = resolveFusionModels({
        config: loaded.config,
        modelRegistry,
        currentModel,
        thinkingLevel,
      });
      assertActive();
      return await orchestrator.run({
        source: request.source,
        cwd,
        sessionId,
        canonicalInput: built.input,
        canonicalInputSerialized: built.serialized,
        contextLedger: built.ledger,
        config: loaded.config,
        models,
        profile,
        candidateCapability: request.capability,
        signal: controller.signal,
        onProgress: request.onProgress,
      });
    } finally {
      unlink();
      activeRuns.delete(active);
      resolveSettled();
    }
  }

  function publishCommandResult(piRequest: string, result: FusionRunResult): void {
    const requestDetails: FusionRequestDetails = {
      schema_version: FUSION_REQUEST_SCHEMA_VERSION,
      run_id: result.details.run_id,
      source: 'command',
    };
    pi.sendMessage(
      {
        customType: FUSION_REQUEST_MESSAGE_TYPE,
        content: piRequest,
        display: false,
        details: requestDetails,
      },
      { triggerTurn: false },
    );
    pi.sendMessage(
      {
        customType: FUSION_RESULT_MESSAGE_TYPE,
        content: result.mergedText,
        display: true,
        details: result.details,
      },
      { triggerTurn: false },
    );
  }

  async function promptFromCommandArgs(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<string | undefined> {
    const direct = normalizeFusionCommandRequest(args);
    if (direct.length > 0) return direct;
    if (!ctx.hasUI) throw new Error(FUSION_COMMAND_USAGE);
    const edited = await ctx.ui.editor('Fusion prompt', '');
    if (edited === undefined) return undefined;
    const prompt = edited.trim();
    return prompt.length > 0 ? prompt : undefined;
  }

  function commandProgress(ctx: ExtensionCommandContext): (event: FusionProgressEvent) => void {
    return (event) => {
      if (ctx.hasUI) ctx.ui.setStatus(FUSION_STATUS_KEY, progressText(event));
    };
  }

  async function runCommandWithoutLoader(
    ctx: ExtensionCommandContext,
    request: string,
    onProgress: (event: FusionProgressEvent) => void,
  ): Promise<FusionRunResult> {
    return runFusion({ source: 'command', ctx, request, onProgress });
  }

  async function runCommandWithLoader(
    ctx: ExtensionCommandContext,
    request: string,
    onProgress: (event: FusionProgressEvent) => void,
  ): Promise<FusionRunResult> {
    if (!ctx.hasUI || !isTuiContext(ctx)) return runCommandWithoutLoader(ctx, request, onProgress);
    const dialog = await ctx.ui.custom<CommandDialogResult>(
      (tui, theme, _keybindings, done) => {
        const controller = new AbortController();
        const loader = new BorderedLoader(tui, theme, 'Fusion is running…', { cancellable: true });
        loader.onAbort = () => {
          controller.abort();
        };
        void runFusion({ source: 'command', ctx, request, signal: controller.signal, onProgress })
          .then((result) => {
            done({ type: 'completed', result });
          })
          .catch((error: unknown) => {
            done({ type: 'failed', error });
          });
        return loader;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: 'center',
          width: '70%',
          minWidth: 48,
          maxHeight: '40%',
        },
      },
    );
    if (dialog.type === 'completed') return dialog.result;
    throw dialog.error;
  }

  pi.registerMessageRenderer<FusionResultDetails>(
    FUSION_RESULT_MESSAGE_TYPE,
    (message, options, theme) => {
      if (!isFusionResultDetails(message.details)) {
        return new Text(theme.fg('error', 'Invalid fusion result details'), 0, 0);
      }
      return renderFusionResultText(
        extractMessageText(message.content),
        message.details,
        { expanded: options.expanded, isPartial: false },
        theme,
      );
    },
  );

  pi.registerCommand('fusion', {
    description: 'Run a five-model fusion workflow and append the merged result directly.',
    handler: async (args, ctx) => {
      let request: string | undefined;
      try {
        request = await promptFromCommandArgs(args, ctx);
        if (request === undefined) return;
        await ctx.waitForIdle();
        const onProgress = commandProgress(ctx);
        if (ctx.hasUI) ctx.ui.setStatus(FUSION_STATUS_KEY, 'fusion: starting');
        const result = await runCommandWithLoader(ctx, request, onProgress);
        publishCommandResult(request, result);
      } catch (error) {
        const message = `Fusion failed: ${errorMessage(error)}${errorArtifactSuffix(error)}`;
        if (!ctx.hasUI) throw new Error(message);
        ctx.ui.notify(message, 'error');
      } finally {
        if (ctx.hasUI) ctx.ui.setStatus(FUSION_STATUS_KEY, undefined);
      }
    },
  });

  pi.registerCommand(FUSION_MODEL_COMMAND_NAME, {
    description: 'Open the five-slot global fusion model selector.',
    handler: async (_args, ctx) => {
      const modeError =
        '/fusion-models requires Pi TUI mode; it is unavailable in RPC, JSON, and print modes.';
      if (!ctx.hasUI) throw new Error(modeError);
      if (!isTuiContext(ctx)) {
        ctx.ui.notify(modeError, 'error');
        return;
      }
      const path = fusionModelConfigPath();
      let loaded: Awaited<ReturnType<typeof loadFusionModelConfig>>;
      try {
        loaded = await loadFusionModelConfig(path);
      } catch (error) {
        ctx.ui.notify(`Cannot open ${path}: ${errorMessage(error)}`, 'error');
        return;
      }
      const choices = choicesForSelector(ctx, loaded.config);
      const result = await ctx.ui.custom<FusionModelSelectorResult>(
        (tui, theme, _keybindings, done) =>
          new FusionModelSelector({
            initialConfig: loaded.config,
            choices,
            theme,
            onSave: async (config) => {
              await saveFusionModelConfig(path, config, loaded.revision);
            },
            onDone: done,
            onRenderRequest: () => {
              tui.requestRender();
            },
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: 'center',
            width: '82%',
            minWidth: 64,
            maxHeight: '75%',
          },
        },
      );
      if (result.type === 'saved')
        ctx.ui.notify(`Saved fusion model configuration to ${path}`, 'info');
    },
  });

  pi.registerTool<typeof FusionBrainstormParams, FusionToolDetails>({
    name: FUSION_BRAINSTORM_TOOL_NAME,
    label: 'Fusion Brainstorm',
    description:
      "Run a five-model fusion workflow for a prompt and return the merged answer. Optional capability:'inspect' lets candidate children use read-only file tools; capability:'research' also enables fusion_web_fetch.",
    promptSnippet:
      'Use fusion_brainstorm to get a merged answer from the five-model fusion workflow',
    promptGuidelines: [
      "fusion_brainstorm is always available; call fusion_brainstorm({prompt}) for no-tool reasoning, fusion_brainstorm({prompt, capability:'inspect'}) when candidate children need read-only file inspection, or fusion_brainstorm({prompt, capability:'research'}) when they also need to fetch a specific public URL.",
      "Use capability:'inspect' only when the answer benefits from reading/searching/listing repository files; use capability:'research' only when public web fetching is required. Evaluator and merger remain no-tools by policy.",
    ],
    parameters: FusionBrainstormParams,
    prepareArguments: prepareFusionArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const prompt = normalizeToolPrompt(params.prompt);
      let result: FusionRunResult;
      try {
        result = await runFusion({
          source: 'tool',
          ctx,
          request: prompt,
          capability: params.capability ?? FUSION_DEFAULT_CAPABILITY,
          signal,
          toolCallId,
          onProgress: (event) => {
            onUpdate?.({
              content: textContent(progressText(event)),
              details: makeProgressDetails(event),
            });
          },
        });
      } catch (error) {
        throw new Error(toolFailureMessage(error), { cause: error });
      }
      const toolResult: FusionToolResultWithUsage = {
        content: textContent(result.mergedText),
        details: result.details,
        usage: cloneFusionUsage(result.details.usage),
      };
      return toolResult;
    },
    renderCall(args, theme) {
      const preview = args.prompt.replace(/\s+/g, ' ').trim();
      return new Text(
        `${theme.fg('toolTitle', theme.bold('fusion_brainstorm '))}${theme.fg('muted', preview)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      if (isFusionProgressDetails(result.details))
        return renderProgressResult(result.details, theme);
      if (!isFusionResultDetails(result.details))
        return new Text(theme.fg('error', 'Invalid fusion tool details'), 0, 0);
      const mergedText = result.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      return renderFusionResultText(mergedText, result.details, options, theme);
    },
  });

  pi.registerTool<typeof FusionValidateParams, FusionToolDetails>({
    name: FUSION_VALIDATE_TOOL_NAME,
    label: 'Fusion Validate',
    description:
      'Run a five-model fusion validation review of completed work and return the merged review. Reviewers always have read-only repository access; there is no capability argument.',
    promptSnippet:
      'Use fusion_validate to get a merged multi-model review of work that was just completed',
    promptGuidelines: [
      'Call fusion_validate({prompt}) after work is complete to get an independent multi-model review. It always runs with read-only repository inspection and takes no capability argument.',
      'State in the prompt what was done, where it lives, and what must hold true. Reviewers read the repository themselves, but facts that exist only inside omitted tool output are not available to them; restate those in the prompt.',
      'fusion_validate returns a prose review whose findings are classified critical, high, or minor. It never modifies files and is not a substitute for running tests or builds.',
    ],
    parameters: FusionValidateParams,
    prepareArguments: prepareFusionValidateArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const prompt = normalizeToolPrompt(params.prompt);
      const label = FUSION_VALIDATE_WORKFLOW.label;
      let result: FusionRunResult;
      try {
        result = await runFusion({
          source: 'tool',
          ctx,
          request: prompt,
          profile: FUSION_VALIDATE_WORKFLOW,
          // Workflow policy, not caller input: the fixed capability is resolved by the
          // workflow itself, so no caller-selected value can reach this launch.
          signal,
          toolCallId,
          onProgress: (event) => {
            onUpdate?.({
              content: textContent(progressText(event, label)),
              details: makeProgressDetails(event, label),
            });
          },
        });
      } catch (error) {
        throw new Error(toolFailureMessage(error), { cause: error });
      }
      const toolResult: FusionToolResultWithUsage = {
        content: textContent(result.mergedText),
        details: result.details,
        usage: cloneFusionUsage(result.details.usage),
      };
      return toolResult;
    },
    renderCall(args, theme) {
      const preview = args.prompt.replace(/\s+/g, ' ').trim();
      return new Text(
        `${theme.fg('toolTitle', theme.bold('fusion_validate '))}${theme.fg('muted', preview)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      if (isFusionProgressDetails(result.details))
        return renderProgressResult(result.details, theme);
      if (!isFusionResultDetails(result.details))
        return new Text(theme.fg('error', 'Invalid fusion tool details'), 0, 0);
      const mergedText = result.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      return renderFusionResultText(
        mergedText,
        result.details,
        options,
        theme,
        FUSION_VALIDATE_WORKFLOW.label,
      );
    },
  });

  pi.on('session_start', () => {
    shuttingDown = false;
    lifecycleGeneration += 1;
    const active = pi.getActiveTools();
    const missing = [FUSION_BRAINSTORM_TOOL_NAME, FUSION_VALIDATE_TOOL_NAME].filter(
      (name) => !active.includes(name),
    );
    if (missing.length > 0) {
      pi.setActiveTools([...active, ...missing]);
    }
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    shuttingDown = true;
    lifecycleGeneration += 1;
    const runs = [...activeRuns];
    for (const run of runs) run.controller.abort();
    const settled = await Promise.allSettled(runs.map((run) => run.settled));
    const failures = settled.flatMap((result) =>
      result.status === 'rejected' ? [errorMessage(result.reason)] : [],
    );
    activeRuns.clear();
    if (failures.length > 0) {
      const message = `Fusion shutdown cleanup failed:\n${failures.join('\n')}`;
      console.error(`[fusion] ${message}`);
      if (ctx.hasUI) ctx.ui.notify(message, 'error');
    }
  });
}

export default registerFusionExtension;
