/**
 * ABI-driven action registry.
 *
 * Replaces the old hardcoded register() calls with dynamic generation from
 * manifest ABIs + domain overlays. All standard game actions are handled by
 * the ABI executor (Contract.populate + account.execute). The composite
 * "move_to" action is the only hand-written handler.
 */
import type { EternumClient } from "@bibliothecadao/client";
import type { ActionResult, GameAction, ActionDefinition } from "@bibliothecadao/game-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CallData, uint256, type Account } from "starknet";
import { generateActions, mergeCompositeActions } from "../abi/action-gen";
import { createABIExecutor, type ABIExecutor } from "../abi/executor";
import { ETERNUM_OVERLAYS, createHiddenOverlays, num } from "../abi/domain-overlay";
import type { Manifest, ActionRoute } from "../abi/types";
import { moveExplorer } from "./move-executor";
import { buildWorldState, type EternumWorldState } from "./world-state";

// ---------------------------------------------------------------------------
// Module state — populated by initializeActions()
// ---------------------------------------------------------------------------

let _executor: ABIExecutor | undefined;
let _actionDefs: ActionDefinition[] = [];
let _actionTypes = new Set<string>();
let _initialized = false;

/** Token addresses from world profile, used by approve_token action. */
export interface TokenConfig {
  feeToken?: string;
  entryToken?: string;
  worldAddress?: string;
}
let _tokenConfig: TokenConfig = {};

/** Blitz contract address — populated during initializeActions from routes. */
let _blitzAddress: string | undefined;
let _explorerMovementAddress: string | undefined;
let _explorerRewardAddress: string | undefined;

// ---------------------------------------------------------------------------
// Cached world state — updated every tick, used for pre-flight validation.
// ---------------------------------------------------------------------------

let _cachedWorldState: EternumWorldState | undefined;

/** Cache the latest world state for pre-flight validation in action handlers. */
export function setCachedWorldState(state: EternumWorldState) {
  _cachedWorldState = state;
}

type FailureCacheEntry = {
  stateFingerprint: string;
  reasonCode: string;
  error: string;
  at: number;
};

const _deterministicFailureCache = new Map<string, FailureCacheEntry>();
const DEDUPE_ENABLED = process.env.AGENT_DEDUPE_DETERMINISTIC_FAILURES !== "0";
const DEDUPE_TTL_MS = Number(process.env.AGENT_DEDUPE_TTL_MS ?? 30_000);
const DETERMINISTIC_CODES = new Set(["REVERTED_ONCHAIN", "REVERTED_DETERMINISTIC", "PRECHECK_FAILED"]);

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, stableNormalize(v)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function actionFingerprint(action: GameAction): string {
  return `${action.type}:${JSON.stringify(stableNormalize(action.params))}`;
}

function stateFingerprint(state?: EternumWorldState): string {
  if (!state) return "no-state";
  const entities = (state.entities ?? [])
    .map((e: any) => `${e.entityId}:${e.type}:${e.position?.x ?? ""}:${e.position?.y ?? ""}`)
    .sort();
  const resources = state.resources ? Array.from(state.resources.entries()).sort(([a], [b]) => a.localeCompare(b)) : [];
  return JSON.stringify({
    tick: state.tick,
    ts: state.timestamp,
    entityCount: state.entities?.length ?? 0,
    tileCount: state.tileMap?.size ?? 0,
    entities,
    resources,
  });
}

function computeStateDiff(before?: EternumWorldState, after?: EternumWorldState): Record<string, unknown> {
  if (!before || !after) {
    return { available: false };
  }
  const beforeById = new Map((before.entities ?? []).map((e: any) => [e.entityId, e]));
  const movedEntityIds: number[] = [];
  for (const entity of after.entities ?? []) {
    const prev = beforeById.get((entity as any).entityId) as any;
    if (!prev) continue;
    if (
      prev.position?.x !== (entity as any).position?.x ||
      prev.position?.y !== (entity as any).position?.y
    ) {
      movedEntityIds.push((entity as any).entityId);
    }
  }
  const resourceDeltas: Record<string, number> = {};
  const keys = new Set<string>([
    ...Array.from(before.resources?.keys() ?? []),
    ...Array.from(after.resources?.keys() ?? []),
  ]);
  for (const key of keys) {
    const b = before.resources?.get(key) ?? 0;
    const a = after.resources?.get(key) ?? 0;
    if (a !== b) resourceDeltas[key] = a - b;
  }
  return {
    available: true,
    tickBefore: before.tick,
    tickAfter: after.tick,
    entityCountBefore: before.entities?.length ?? 0,
    entityCountAfter: after.entities?.length ?? 0,
    tileCountBefore: before.tileMap?.size ?? 0,
    tileCountAfter: after.tileMap?.size ?? 0,
    movedEntityIds,
    resourceDeltas,
  };
}

function classifyFallback(error?: string): { reasonCode: string; retryable: boolean } {
  const msg = (error ?? "").toLowerCase();
  if (
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("temporar")
  ) {
    return { reasonCode: "TRANSPORT_ERROR", retryable: true };
  }
  if (
    msg.includes("already explored") ||
    msg.includes("occupied") ||
    msg.includes("insufficient") ||
    msg.includes("revert")
  ) {
    return { reasonCode: "REVERTED_DETERMINISTIC", retryable: false };
  }
  return { reasonCode: "ACTION_FAILED", retryable: false };
}

function mergeActionData(existing: unknown, extra: Record<string, unknown>): unknown {
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return { ...(existing as Record<string, unknown>), ...extra };
  }
  if (existing === undefined) return extra;
  return { previousData: existing, ...extra };
}

async function refreshAndAnnotateResult(
  client: EternumClient,
  action: GameAction,
  result: ActionResult,
  beforeState: EternumWorldState | undefined,
): Promise<ActionResult> {
  const beforeFp = stateFingerprint(beforeState);
  let afterState: EternumWorldState | undefined;
  let refreshError: string | undefined;
  if (_worldStateProvider) {
    try {
      afterState = await _worldStateProvider(client);
      setCachedWorldState(afterState);
    } catch (err: any) {
      refreshError = err?.message ?? String(err);
    }
  }
  const afterFp = stateFingerprint(afterState ?? beforeState);
  const changed = beforeFp !== afterFp;
  if (changed) {
    _deterministicFailureCache.clear();
  }
  const stateDiff = computeStateDiff(beforeState, afterState);
  const meta: Record<string, unknown> = {
    stateFingerprintBefore: beforeFp,
    stateFingerprintAfter: afterFp,
    stateChanged: changed,
    stateDiff,
  };
  if (refreshError) meta.stateRefreshError = refreshError;

  const normalized = {
    ...result,
    reasonCode: result.reasonCode ?? (result.success ? "OK" : classifyFallback(result.error).reasonCode),
    retryable: result.retryable ?? (result.success ? false : classifyFallback(result.error).retryable),
  };
  return {
    ...normalized,
    data: mergeActionData(normalized.data, meta),
  };
}

// ---------------------------------------------------------------------------
// World state provider for move_to
// ---------------------------------------------------------------------------

let _worldStateProvider: ((client: EternumClient) => Promise<EternumWorldState>) | undefined;

/**
 * Set the world state provider so move_to can fetch current tile map.
 * Call once during adapter initialization with the account address.
 */
export function setWorldStateProvider(accountAddress: string) {
  _worldStateProvider = (client: EternumClient) => buildWorldState(client, accountAddress);
}

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

function logAction(actionType: string, result: ActionResult) {
  try {
    const debugPath = join(
      process.env.AGENT_DATA_DIR || join(process.env.HOME || "/tmp", ".eternum-agent", "data"),
      "debug",
      "actions.log",
    );
    mkdirSync(dirname(debugPath), { recursive: true });
    const ts = new Date().toISOString();
    const status = result.success ? `OK tx=${result.txHash}` : `FAIL: ${result.error}`;
    writeFileSync(debugPath, `[${ts}] ${actionType} => ${status}\n`, { flag: "a" });
  } catch (_) {}
}

function resolveRouteByEntrypoint(
  routes: Map<string, ActionRoute>,
  entrypoint: string,
  preferredTagFragment?: string,
): ActionRoute | undefined {
  const matches = Array.from(routes.values()).filter((route) => route.entrypoint === entrypoint);
  if (matches.length === 0) return undefined;
  if (!preferredTagFragment) return matches[0];
  return matches.find((route) => route.contractTag.includes(preferredTagFragment)) ?? matches[0];
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the ABI-driven action registry from a manifest.
 *
 * Must be called before getActionDefinitions() or executeAction().
 * Typically called from EternumGameAdapter constructor.
 */
export function initializeActions(
  manifest: Manifest,
  account: Account,
  options: { gameName?: string; tokenConfig?: TokenConfig } = {},
) {
  _deterministicFailureCache.clear();
  _tokenConfig = options.tokenConfig ?? {};

  // Build overlays (domain enrichments + hidden admin entrypoints)
  const hiddenOverlays = createHiddenOverlays(manifest);
  const overlays = { ...ETERNUM_OVERLAYS, ...hiddenOverlays };

  // Generate action definitions and routing table from manifest ABIs
  const generated = generateActions(manifest, {
    overlays,
    gameName: options.gameName,
  });

  // Look up the blitz contract address from routes for composite actions
  const blitzRoute = generated.routes.get("obtain_entry_token");
  const blitzAddress = blitzRoute?.contractAddress;
  _blitzAddress = blitzAddress;
  const explorerMoveRoute =
    generated.routes.get("move_explorer") ?? resolveRouteByEntrypoint(generated.routes, "explorer_move", "troop_movement_systems");
  const explorerRewardRoute = resolveRouteByEntrypoint(
    generated.routes,
    "explorer_extract_reward",
    "troop_movement_systems",
  );
  _explorerMovementAddress = explorerMoveRoute?.contractAddress;
  _explorerRewardAddress = explorerRewardRoute?.contractAddress;

  // Build dynamic description for approve_token with known addresses
  let approveDesc =
    "Approve a spender to transfer ERC-20 tokens on your behalf. " +
    "Required before Blitz registration: approve the fee token for the blitz contract, then call obtain_entry_token.";
  if (_tokenConfig.feeToken) approveDesc += ` Fee token: ${_tokenConfig.feeToken}.`;
  if (_tokenConfig.entryToken) approveDesc += ` Entry token: ${_tokenConfig.entryToken}.`;
  if (blitzAddress) approveDesc += ` Blitz contract (spender): ${blitzAddress}.`;

  // Build dynamic description for lock_entry_token with known addresses
  let lockDesc =
    "Lock an entry token NFT before registering for a Blitz game. " +
    "Call AFTER obtain_entry_token and BEFORE register. " +
    "You must know the token_id (minted by obtain_entry_token) and the lock_id (from blitz config).";
  if (_tokenConfig.entryToken) lockDesc += ` Entry token contract: ${_tokenConfig.entryToken}.`;

  // Add composite actions that orchestrate multiple base actions
  const withComposites = mergeCompositeActions(generated, [
    {
      definition: {
        type: "move_to",
        description:
          "Move an explorer to a target coordinate using A* pathfinding. Automatically computes the optimal path, " +
          "batches travel/explore actions, and executes them sequentially. Stops on first failure.",
        params: [
          { name: "explorerId", type: "number", description: "Explorer entity ID to move", required: true },
          { name: "targetCol", type: "number", description: "Target column (x coordinate)", required: true },
          { name: "targetRow", type: "number", description: "Target row (y coordinate)", required: true },
        ],
      },
    },
    {
      definition: {
        type: "explore",
        description:
          "Explore one adjacent unexplored tile. Automatically wraps VRF pre/post requests, explorer_move(explore=true), and explorer_extract_reward.",
        params: [
          { name: "explorer_id", type: "number", description: "Explorer entity ID", required: true },
          {
            name: "direction",
            type: "number",
            description: "Single hex direction (0=E, 1=NE, 2=NW, 3=W, 4=SW, 5=SE)",
            required: true,
          },
        ],
      },
    },
    {
      definition: {
        type: "approve_token",
        description: approveDesc,
        params: [
          { name: "token_address", type: "string", description: "Token contract address to approve", required: true },
          {
            name: "spender",
            type: "string",
            description: "Contract address allowed to spend your tokens",
            required: true,
          },
          {
            name: "amount",
            type: "string",
            description:
              "Amount to approve in base units (wei). Use '340282366920938463463374607431768211455' for max u128 approval.",
            required: true,
          },
        ],
      },
    },
    {
      definition: {
        type: "lock_entry_token",
        description: lockDesc,
        params: [
          {
            name: "token_id",
            type: "number",
            description: "Entry token ID to lock (obtained from obtain_entry_token)",
            required: true,
          },
          {
            name: "lock_id",
            type: "number",
            description: "Lock ID from blitz registration config (query via inspect_sql if unknown)",
            required: true,
          },
          {
            name: "token_address",
            type: "string",
            description: "Entry token contract address (auto-filled from config if omitted)",
            required: false,
          },
        ],
      },
    },
    {
      definition: {
        type: "settle_blitz_realm",
        description:
          "Settle your realm(s) after registration. Bundles VRF randomness request, realm position assignment, " +
          "and realm creation into a single atomic multicall. Call AFTER register.",
        params: [
          {
            name: "settlement_count",
            type: "number",
            description: "Number of realms to settle (default: 1)",
            required: false,
          },
        ],
      },
    },
  ]);

  _actionDefs = withComposites.definitions;
  _actionTypes = new Set(withComposites.routes.keys());
  _actionTypes.add("move_to"); // Not in routes (composite)
  _actionTypes.add("explore"); // Not in routes (composite)
  _actionTypes.add("approve_token"); // Not in routes (composite)
  _actionTypes.add("lock_entry_token"); // Not in routes (composite)
  _actionTypes.add("settle_blitz_realm"); // Not in routes (composite)

  // Create ABI executor for standard actions
  _executor = createABIExecutor(manifest, account, {
    routes: withComposites.routes,
    cachedStateProvider: () => _cachedWorldState,
  });

  _initialized = true;
}

// ---------------------------------------------------------------------------
// move_to handler (composite action)
// ---------------------------------------------------------------------------

async function handleMoveTo(
  client: EternumClient,
  signer: Account,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  if (!_worldStateProvider) {
    return { success: false, error: "World state provider not initialized. Call setWorldStateProvider first." };
  }

  const worldState = await _worldStateProvider(client);

  const result = await moveExplorer(
    client,
    signer,
    {
      explorerId: num(params.explorerId),
      targetCol: num(params.targetCol),
      targetRow: num(params.targetRow),
    },
    worldState,
  );

  if (!result.success) {
    return { success: false, error: result.summary };
  }

  return {
    success: true,
    data: {
      summary: result.summary,
      stepsExecuted: result.steps.length,
      totalCost: result.pathResult.totalCost,
      txHashes: result.steps.map((s) => s.result.txHash).filter(Boolean),
    },
  };
}

// ---------------------------------------------------------------------------
// approve_token handler (composite action)
// ---------------------------------------------------------------------------

async function handleApproveToken(signer: Account, params: Record<string, unknown>): Promise<ActionResult> {
  const tokenAddress = String(params.token_address ?? params.tokenAddress ?? "");
  const spender = String(params.spender ?? "");
  const rawAmount = BigInt(String(params.amount ?? "0"));

  if (!tokenAddress || !spender) {
    return { success: false, error: "token_address and spender are required" };
  }

  // Split into uint256 (low, high) for starknet calldata
  const low = (rawAmount & ((1n << 128n) - 1n)).toString();
  const high = (rawAmount >> 128n).toString();

  try {
    const result = await signer.execute({
      contractAddress: tokenAddress,
      entrypoint: "approve",
      calldata: [spender, low, high],
    });
    const txHash = result?.transaction_hash ?? (result as any)?.transactionHash;
    return { success: true, txHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// lock_entry_token handler (composite action)
// ---------------------------------------------------------------------------

async function handleLockEntryToken(signer: Account, params: Record<string, unknown>): Promise<ActionResult> {
  const tokenAddress = String(params.token_address ?? params.tokenAddress ?? _tokenConfig.entryToken ?? "");
  const requestedTokenIdRaw = params.token_id ?? params.tokenId;
  const requestedTokenId = requestedTokenIdRaw !== undefined ? BigInt(String(requestedTokenIdRaw)) : 0n;
  const lockId = BigInt(String(params.lock_id ?? params.lockId ?? "69"));

  if (!tokenAddress) {
    return { success: false, error: "token_address is required (or set via entryToken config)" };
  }
  if (lockId === 0n) {
    return { success: false, error: "lock_id is required and must be non-zero" };
  }

  let tokenId = requestedTokenId;
  if (tokenId === 0n) {
    try {
      const owner = signer.address;
      const balanceRaw = await (signer as any).callContract({
        contractAddress: tokenAddress,
        entrypoint: "balance_of",
        calldata: CallData.compile([owner]),
      });
      const [balLow, balHigh] = Array.isArray(balanceRaw) ? balanceRaw : [0, 0];
      const balance = BigInt(String(balLow ?? 0)) + (BigInt(String(balHigh ?? 0)) << 128n);
      if (balance <= 0n) {
        return { success: false, error: "No entry tokens found for account. Run obtain_entry_token first." };
      }

      const lastIndex = balance - 1n;
      const idx = uint256.bnToUint256(lastIndex);
      const tokenRaw = await (signer as any).callContract({
        contractAddress: tokenAddress,
        entrypoint: "token_of_owner_by_index",
        calldata: CallData.compile([owner, idx.low, idx.high]),
      });
      const [lowRaw, highRaw] = Array.isArray(tokenRaw) ? tokenRaw : [0, 0];
      tokenId = BigInt(String(lowRaw ?? 0)) + (BigInt(String(highRaw ?? 0)) << 128n);
      if (tokenId === 0n) {
        return { success: false, error: "Failed to resolve entry token_id from token_of_owner_by_index." };
      }
    } catch (err: any) {
      return { success: false, error: `Failed to auto-discover token_id: ${err?.message ?? String(err)}` };
    }
  }

  // token_id is u256 (low, high), lock_id is felt252
  const low = (tokenId & ((1n << 128n) - 1n)).toString();
  const high = (tokenId >> 128n).toString();

  try {
    const result = await signer.execute({
      contractAddress: tokenAddress,
      entrypoint: "token_lock",
      calldata: [low, high, lockId.toString()],
    });
    const txHash = result?.transaction_hash ?? (result as any)?.transactionHash;
    return { success: true, txHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// settle_blitz_realm handler (composite action)
// ---------------------------------------------------------------------------

const VRF_PROVIDER_ADDRESS = "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f";

async function handleSettleBlitzRealm(signer: Account, params: Record<string, unknown>): Promise<ActionResult> {
  const blitzAddress = _blitzAddress;
  if (!blitzAddress) {
    return { success: false, error: "Blitz contract address not found in manifest routes" };
  }

  const settlementCount = Number(params.settlement_count ?? params.settlementCount ?? 1);
  if (settlementCount < 1) {
    return { success: false, error: "settlement_count must be at least 1" };
  }

  // Build multicall: VRF request_random + assign_realm_positions + settle_realms
  const calls = [
    {
      contractAddress: VRF_PROVIDER_ADDRESS,
      entrypoint: "request_random",
      calldata: [blitzAddress, "0", signer.address],
    },
    {
      contractAddress: blitzAddress,
      entrypoint: "assign_realm_positions",
      calldata: [],
    },
    {
      contractAddress: blitzAddress,
      entrypoint: "settle_realms",
      calldata: [settlementCount.toString()],
    },
  ];

  try {
    const result = await signer.execute(calls);
    const txHash = result?.transaction_hash ?? (result as any)?.transactionHash;
    return { success: true, txHash, data: { settlementCount } };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes" || v === "on";
  }
  return false;
}

function normalizeDirectionParam(params: Record<string, unknown>): number | null {
  if (params.direction !== undefined) return num(params.direction);
  const dirs = params.directions;
  if (Array.isArray(dirs) && dirs.length > 0) return num(dirs[0]);
  return null;
}

async function handleExplore(
  signer: Account,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const explorerId = num(params.explorer_id ?? params.explorerId);
  const direction = normalizeDirectionParam(params);

  if (!explorerId || explorerId <= 0) {
    return { success: false, error: "explorer_id is required", reasonCode: "PRECHECK_FAILED", retryable: false };
  }
  if (direction === null || direction < 0 || direction > 5) {
    return { success: false, error: "direction is required (0..5)", reasonCode: "PRECHECK_FAILED", retryable: false };
  }
  if (!_explorerMovementAddress) {
    return {
      success: false,
      error: "Explorer movement route not initialized.",
      reasonCode: "NOT_INITIALIZED",
      retryable: false,
    };
  }

  const calls: Array<{ contractAddress: string; entrypoint: string; calldata: unknown[] }> = [];

  if (VRF_PROVIDER_ADDRESS && Number(VRF_PROVIDER_ADDRESS) !== 0) {
    calls.push({
      contractAddress: VRF_PROVIDER_ADDRESS,
      entrypoint: "request_random",
      calldata: [_explorerMovementAddress, 0, signer.address],
    });
  }

  calls.push({
    contractAddress: _explorerMovementAddress,
    entrypoint: "explorer_move",
    calldata: [explorerId, [direction], 1],
  });

  if (_explorerRewardAddress) {
    if (VRF_PROVIDER_ADDRESS && Number(VRF_PROVIDER_ADDRESS) !== 0) {
      calls.push({
        contractAddress: VRF_PROVIDER_ADDRESS,
        entrypoint: "request_random",
        calldata: [_explorerMovementAddress, 0, signer.address],
      });
    }

    calls.push({
      contractAddress: _explorerRewardAddress,
      entrypoint: "explorer_extract_reward",
      calldata: [explorerId],
    });
  }

  try {
    const result = await signer.execute(calls as any);
    const txHash = result?.transaction_hash ?? (result as any)?.transactionHash;
    return {
      success: true,
      txHash,
      reasonCode: "OK",
      retryable: false,
      data: {
        mode: _explorerRewardAddress ? "explore" : "explore_no_reward_extract",
        calls: calls.map((c) => c.entrypoint),
      },
    };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const classified = classifyFallback(message);
    return {
      success: false,
      error: message,
      reasonCode: classified.reasonCode,
      retryable: classified.retryable,
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all action definitions (type + description + param schemas).
 * Used to build enriched tool descriptions for the LLM.
 */
export function getActionDefinitions(): ActionDefinition[] {
  return _actionDefs;
}

/**
 * Return the list of all registered action type strings.
 */
export function getAvailableActions(): string[] {
  return Array.from(_actionTypes);
}

/**
 * Look up a registered action handler by its type string.
 * @deprecated Use executeAction() instead.
 */
export function getActionHandler(
  type: string,
): ((client: EternumClient, signer: Account, params: Record<string, unknown>) => Promise<ActionResult>) | undefined {
  if (!_actionTypes.has(type)) return undefined;
  // Return a function that delegates to executeAction
  return (client, signer, params) => executeAction(client, signer, { type, params });
}

/**
 * Execute a GameAction by dispatching to the ABI executor or composite handler.
 * Returns a failed ActionResult if the action type is unknown.
 */
export async function executeAction(client: EternumClient, signer: Account, action: GameAction): Promise<ActionResult> {
  const beforeState = _cachedWorldState;
  const beforeFp = stateFingerprint(beforeState);
  const key = actionFingerprint(action);

  if (DEDUPE_ENABLED) {
    const cached = _deterministicFailureCache.get(key);
    if (cached && cached.stateFingerprint === beforeFp && Date.now() - cached.at <= DEDUPE_TTL_MS) {
      const blocked: ActionResult = {
        success: false,
        error: `Blocked repeat deterministic failure (${cached.reasonCode}): ${cached.error}`,
        reasonCode: "DETERMINISTIC_REPEAT_BLOCKED",
        retryable: false,
      };
      const annotated = await refreshAndAnnotateResult(client, action, blocked, beforeState);
      logAction(action.type, annotated);
      return annotated;
    }
  }

  let result: ActionResult;
  // Composite actions handled specially
  if (action.type === "move_to") {
    result = await handleMoveTo(client, signer, action.params);
  } else if (action.type === "explore") {
    result = await handleExplore(signer, action.params);
  } else if (action.type === "approve_token") {
    result = await handleApproveToken(signer, action.params);
  } else if (action.type === "lock_entry_token") {
    result = await handleLockEntryToken(signer, action.params);
  } else if (action.type === "settle_blitz_realm") {
    result = await handleSettleBlitzRealm(signer, action.params);
  } else {
    // Standard ABI actions
    if (!_executor) {
      return {
        success: false,
        error: "Action registry not initialized. Call initializeActions() first.",
        reasonCode: "NOT_INITIALIZED",
        retryable: false,
      };
    }
    // Backward compatibility: legacy move_explorer+explore=true now maps to explore composite.
    if (action.type === "move_explorer" && asBool(action.params.explore)) {
      const direction = normalizeDirectionParam(action.params);
      if (direction === null) {
        result = {
          success: false,
          error: "Explore mode requires exactly one direction. Use `explore` action with `direction`.",
          reasonCode: "PRECHECK_FAILED",
          retryable: false,
        };
      } else {
        result = await handleExplore(signer, {
          explorer_id: action.params.explorer_id ?? action.params.explorerId,
          direction,
        });
      }
    } else {
      result = await _executor.execute(action);
    }
  }

  const annotated = await refreshAndAnnotateResult(client, action, result, beforeState);

  if (DEDUPE_ENABLED) {
    if (
      !annotated.success &&
      annotated.reasonCode &&
      DETERMINISTIC_CODES.has(annotated.reasonCode) &&
      !annotated.retryable
    ) {
      _deterministicFailureCache.set(key, {
        stateFingerprint: beforeFp,
        reasonCode: annotated.reasonCode,
        error: annotated.error ?? "unknown error",
        at: Date.now(),
      });
    } else {
      _deterministicFailureCache.delete(key);
    }
  }

  logAction(action.type, annotated);
  return annotated;
}
