import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeAction,
  getActionHandler,
  getAvailableActions,
  initializeActions,
  setCachedWorldState,
} from "../../src/adapter/action-registry";
import { createMockClient, mockSigner } from "../utils/mock-client";
import { initializeTestActionRegistry, testManifest } from "../utils/init-action-registry";

describe("action-registry (ABI executor)", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    initializeTestActionRegistry();
    client = createMockClient();
    vi.mocked(mockSigner.execute).mockReset();
    vi.mocked(mockSigner.execute).mockResolvedValue({ transaction_hash: "0xabc123" });
    delete (mockSigner as any).callContract;
  });

  it("lists current action types including aliases and composites", () => {
    const actions = getAvailableActions();
    expect(actions).toContain("send_resources");
    expect(actions).toContain("move_explorer");
    expect(actions).toContain("explore");
    expect(actions).toContain("create_trade");
    expect(actions).toContain("approve_token");
    expect(actions).toContain("lock_entry_token");
    expect(actions).toContain("settle_blitz_realm");
  });

  it("returns handlers for known types", () => {
    expect(getActionHandler("send_resources")).toBeTypeOf("function");
    expect(getActionHandler("leave_guild")).toBeTypeOf("function");
    expect(getActionHandler("nonexistent_action")).toBeUndefined();
  });

  it("returns unknown-action error for missing routes", async () => {
    const result = await executeAction(client as any, mockSigner, {
      type: "does_not_exist",
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Unknown action type: does_not_exist");
  });

  it("executes send_resources via signer.execute", async () => {
    const result = await executeAction(client as any, mockSigner, {
      type: "send_resources",
      params: {
        sender_structure_id: 10,
        recipient_structure_id: 20,
        resources: [{ resourceType: 1, amount: 5 }],
      },
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xabc123");
    expect(mockSigner.execute).toHaveBeenCalledOnce();
    const call = vi.mocked(mockSigner.execute).mock.calls[0][0] as any;
    expect(call.entrypoint).toBe("send");
  });

  it("routes legacy move_explorer explore=true through explore multicall", async () => {
    const result = await executeAction(client as any, mockSigner, {
      type: "move_explorer",
      params: {
        explorer_id: 42,
        directions: [1],
        explore: true,
      },
    });

    expect(result.success).toBe(true);
    const call = vi.mocked(mockSigner.execute).mock.calls[0][0] as any[];
    expect(Array.isArray(call)).toBe(true);
    expect(call[0].entrypoint).toBe("request_random");
    expect(call[1].entrypoint).toBe("explorer_move");
  });

  it("executes explore composite action", async () => {
    const result = await executeAction(client as any, mockSigner, {
      type: "explore",
      params: {
        explorer_id: 42,
        direction: 0,
      },
    });

    expect(result.success).toBe(true);
    const call = vi.mocked(mockSigner.execute).mock.calls[0][0] as any[];
    expect(Array.isArray(call)).toBe(true);
    expect(call[1].entrypoint).toBe("explorer_move");
  });

  it("skips explorer_extract_reward call when reward route is missing", async () => {
    const manifestWithoutReward = JSON.parse(JSON.stringify(testManifest));
    for (const contract of manifestWithoutReward.contracts ?? []) {
      if (!Array.isArray(contract?.abi)) continue;
      contract.abi = contract.abi.filter((item: any) => item?.name !== "explorer_extract_reward");
    }
    initializeActions(manifestWithoutReward, mockSigner, { gameName: "eternum" });

    const result = await executeAction(client as any, mockSigner, {
      type: "explore",
      params: {
        explorer_id: 42,
        direction: 0,
      },
    });

    expect(result.success).toBe(true);
    const call = vi.mocked(mockSigner.execute).mock.calls[0][0] as any[];
    expect(call.some((c) => c.entrypoint === "explorer_extract_reward")).toBe(false);
  });

  it("executes create_trade alias through create_order route", async () => {
    const result = await executeAction(client as any, mockSigner, {
      type: "create_trade",
      params: {
        maker_id: 1,
        taker_id: 0,
        maker_gives_resource_type: 1,
        taker_pays_resource_type: 2,
        maker_gives_min_resource_amount: 100,
        maker_gives_max_count: 5,
        taker_pays_min_resource_amount: 200,
        expires_at: 9999999,
      },
    });

    expect(result.success).toBe(true);
    const call = vi.mocked(mockSigner.execute).mock.calls[0][0] as any;
    expect(call.entrypoint).toBe("create_order");
  });

  it("executes leave_guild without params", async () => {
    const result = await executeAction(client as any, mockSigner, {
      type: "leave_guild",
      params: {},
    });

    expect(result.success).toBe(true);
    const call = vi.mocked(mockSigner.execute).mock.calls[0][0] as any;
    expect(call.entrypoint).toBe("leave_guild");
  });

  it("surfaces signer execution errors", async () => {
    vi.mocked(mockSigner.execute).mockRejectedValueOnce(new Error("tx reverted"));

    const result = await executeAction(client as any, mockSigner, {
      type: "send_resources",
      params: {
        sender_structure_id: 1,
        recipient_structure_id: 2,
        resources: [{ resourceType: 1, amount: 1 }],
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("tx reverted");
  });

  it("auto-discovers token_id and defaults lock_id=69 for lock_entry_token", async () => {
    const callContract = vi.fn()
      // balance_of(owner) -> 2
      .mockResolvedValueOnce(["2", "0"])
      // token_of_owner_by_index(owner, 1) -> token_id 123
      .mockResolvedValueOnce(["123", "0"]);
    (mockSigner as any).callContract = callContract;

    const result = await executeAction(client as any, mockSigner, {
      type: "lock_entry_token",
      params: { token_address: "0xentry" },
    });

    expect(result.success).toBe(true);
    expect(callContract).toHaveBeenCalledTimes(2);
    const txCall = vi.mocked(mockSigner.execute).mock.calls[0][0] as any;
    expect(txCall.entrypoint).toBe("token_lock");
    expect(txCall.calldata[0]).toBe("123");
    expect(txCall.calldata[1]).toBe("0");
    expect(txCall.calldata[2]).toBe("69");
  });

  it("fails lock_entry_token when auto-discovery finds no tokens", async () => {
    const callContract = vi.fn()
      // balance_of(owner) -> 0
      .mockResolvedValueOnce(["0", "0"]);
    (mockSigner as any).callContract = callContract;

    const result = await executeAction(client as any, mockSigner, {
      type: "lock_entry_token",
      params: { token_address: "0xentry" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No entry tokens found");
    expect(mockSigner.execute).not.toHaveBeenCalled();
  });

  it("blocks immediate deterministic repeats for unchanged state", async () => {
    setCachedWorldState({
      tick: 1,
      timestamp: 1000,
      entities: [],
      tileMap: new Map(),
    } as any);

    vi.mocked(mockSigner.execute).mockRejectedValue(new Error("execution reverted: tile is already explored"));

    const first = await executeAction(client as any, mockSigner, {
      type: "move_explorer",
      params: {
        explorer_id: 42,
        directions: [0],
        explore: true,
      },
    });

    const second = await executeAction(client as any, mockSigner, {
      type: "move_explorer",
      params: {
        explorer_id: 42,
        directions: [0],
        explore: true,
      },
    });

    expect(first.success).toBe(false);
    expect(first.reasonCode).toBeDefined();
    expect(second.success).toBe(false);
    expect(second.reasonCode).toBe("DETERMINISTIC_REPEAT_BLOCKED");
    expect(vi.mocked(mockSigner.execute)).toHaveBeenCalledTimes(1);
  });
});
