import { agentEnv } from "./agent";

export interface ModelOption {
  /** Value passed to the agent as `model` (an id like "claude-opus-5-5", or an alias like "opus" that tracks the newest) */
  id: string;
  /** e.g. "Opus 5.5" */
  name: string;
  description: string;
  /** Concrete model id an alias currently points at */
  resolved?: string;
}

/**
 * Models the signed-in Claude account can use, as reported by Claude Code itself, so new releases show up
 * without a code change. Starts an idle agent session (no prompt is sent, nothing is billed) and asks it.
 */
export async function listModels(opts: { useSubscription: boolean; cwd: string; timeoutMs?: number }): Promise<ModelOption[]> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abort = new AbortController();
  let release!: () => void;
  const idle = new Promise<void>((r) => (release = r));
  // Streaming input that never sends a message: the session starts, answers control requests, and is closed.
  const prompt = (async function* () {
    await idle;
  })();
  const q = query({ prompt, options: { cwd: opts.cwd, env: agentEnv(opts.useSubscription), settingSources: [], abortController: abort } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out listing models")), opts.timeoutMs ?? 90_000))),
    ]);
    return models
      .filter((m) => m.value !== "default") // "Default (recommended)" duplicates the model it points at
      .map((m) => ({ id: m.value, name: m.displayName, description: m.description, resolved: m.resolvedModel !== m.value ? m.resolvedModel : undefined }));
  } finally {
    clearTimeout(timer);
    release();
    abort.abort();
  }
}
