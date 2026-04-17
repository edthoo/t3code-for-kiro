/**
 * KiroProviderLive - Provider status layer for Kiro CLI.
 *
 * Detects `kiro-cli` installation, version, and authentication status.
 * Exposes built-in models and wires into the managed provider lifecycle.
 *
 * @module KiroProviderLive
 */
import type {
  KiroSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderState,
} from "@t3tools/contracts";
import { ServerSettingsError } from "@t3tools/contracts";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { KiroProvider } from "../Services/KiroProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "kiro" as const;

const DEFAULT_KIRO_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProvider["models"][number]> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: DEFAULT_KIRO_MODEL_CAPABILITIES,
  },
];

interface KiroCliModel {
  readonly model_name: string;
  readonly description: string;
  readonly model_id: string;
  readonly context_window_tokens: number;
}

interface KiroCliModelsResponse {
  readonly models: ReadonlyArray<KiroCliModel>;
  readonly default_model: string;
}

function kiroCliModelToServerModel(
  model: KiroCliModel,
): ServerProvider["models"][number] {
  return {
    slug: model.model_id,
    name: model.model_name,
    isCustom: false,
    capabilities: DEFAULT_KIRO_MODEL_CAPABILITIES,
  };
}

function parseKiroModelsOutput(
  result: CommandResult,
): ReadonlyArray<ServerProvider["models"][number]> | null {
  try {
    const parsed: KiroCliModelsResponse = JSON.parse(result.stdout);
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) return null;
    return parsed.models.map(kiroCliModelToServerModel);
  } catch {
    return null;
  }
}

export function getKiroModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_KIRO_MODEL_CAPABILITIES
  );
}

export function parseKiroAuthFromOutput(result: CommandResult): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status">;
  readonly message?: string;
} {
  const lower = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (lower.includes("not logged in") || lower.includes("not authenticated")) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Kiro CLI is not authenticated. Run `kiro-cli login` and try again.",
    };
  }

  if (result.code === 0) {
    return { status: "ready", auth: { status: "authenticated" } };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    auth: { status: "unknown" },
    message: detail
      ? `Could not verify Kiro authentication status. ${detail}`
      : "Could not verify Kiro authentication status.",
  };
}

const runKiroCommand = Effect.fn("runKiroCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const kiroSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.kiro),
  );
  const command = ChildProcess.make(kiroSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(kiroSettings.binaryPath, command);
});

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const kiroSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.kiro),
    );
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      kiroSettings.customModels,
      DEFAULT_KIRO_MODEL_CAPABILITIES,
    );

    if (!kiroSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kiro is disabled in T3 Code settings.",
        },
      });
    }

    // Check version
    const versionProbe = yield* runKiroCommand(["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
            : `Failed to execute Kiro CLI health check: ${error.message}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Kiro CLI is installed but timed out while checking version.",
        },
      });
    }

    const version = versionProbe.success.value;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: { status: "unknown" },
          message: detail
            ? `Kiro CLI is installed but failed to run. ${detail}`
            : "Kiro CLI is installed but failed to run.",
        },
      });
    }

    // kiro-cli does not expose an `auth` subcommand — treat a successful
    // version check as ready/authenticated.

    // Fetch models dynamically from kiro-cli
    const modelsProbe = yield* runKiroCommand(["chat", "--list-models", "--format", "json-pretty"]).pipe(
      Effect.timeoutOption(10_000),
      Effect.result,
    );

    let dynamicModels: ReadonlyArray<ServerProvider["models"][number]> | null = null;
    if (Result.isSuccess(modelsProbe) && Option.isSome(modelsProbe.success)) {
      dynamicModels = parseKiroModelsOutput(modelsProbe.success.value);
    }
    yield* Effect.logInfo(
      `[kiro-provider] modelsProbe success=${Result.isSuccess(modelsProbe)} dynamicModels=${dynamicModels?.length ?? "null"}`,
    );

    const finalModels = providerModelsFromSettings(
      dynamicModels ?? BUILT_IN_MODELS,
      PROVIDER,
      kiroSettings.customModels,
      DEFAULT_KIRO_MODEL_CAPABILITIES,
    );

    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: finalModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "ready",
        auth: { status: "authenticated" },
      },
    });
  },
);

const makePendingKiroProvider = (kiroSettings: KiroSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    kiroSettings.customModels,
    DEFAULT_KIRO_MODEL_CAPABILITIES,
  );

  if (!kiroSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kiro is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Kiro provider status has not been checked in this session yet.",
    },
  });
};

export const KiroProviderLive = Layer.effect(
  KiroProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkKiroProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<KiroSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.kiro),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.kiro),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingKiroProvider,
      checkProvider,
    });
  }),
);
