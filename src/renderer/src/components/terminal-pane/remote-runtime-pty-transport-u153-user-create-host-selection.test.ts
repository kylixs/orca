/**
 * U153 D1 pin: a quick "New Terminal" in a cloud session is a client-owned tab. Its pane
 * spawns through `terminal.create`, so the completion is the first point where the client
 * holds the host tabId/leafId. The user gesture must then be replayed as a tap-semantics
 * `session.tabs.activate` (no `materializeOnly`) and recorded as a focus intent, or the host
 * keeps the previous tab selected forever. Passive mirror attach stays materializeOnly
 * (U138 phase 9 negative control).
 */
import type { PublicKnownRuntimeEnvironment } from "../../../../shared/runtime-environments";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks,
} from "./remote-runtime-pty-transport-test-harness";

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null;
let resolvedPaneHandle = "terminal-1";

const { runtimeCall, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks;
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle;
    },
  });

const ENV = "cloud-u153";
const WORKTREE = "wt-1";
const LOCAL_TAB_ID = "7c27ddf0-5e0a-4769-8cc5-ac4eefa8eed8";
const LOCAL_LEAF_ID = "3c224bda-5e6f-4f57-bce8-fd5872a80bbc";
const CREATED_HOST_TAB_ID = "u153-host-tab";
const CREATED_HOST_LEAF_ID = "u153-host-leaf";

function cloudEnvironment(): PublicKnownRuntimeEnvironment {
  return {
    id: ENV,
    name: "zhangsan-demo (cloud session)",
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: "ws-1",
        kind: "websocket",
        label: "WebSocket",
        endpoint: "ws://host",
      },
    ],
    preferredEndpointId: "ws-1",
    cloudProject: {
      projectId: "proj-u153",
      projectKey: "zhangsan-demo",
      hostId: "host-u153",
      registeredAt: 1,
    },
  };
}

function activationParams(): Record<string, unknown>[] {
  return runtimeCall.mock.calls
    .filter((call) => call[0]?.method === "session.tabs.activate")
    .map((call) => call[0]?.params ?? {});
}

function pendingHostSessionSnapshot(): unknown {
  return {
    ok: true,
    result: {
      worktree: "id:wt-1",
      publicationEpoch: "epoch-1",
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: "host-tab-1::leaf-1",
      activeTabType: "terminal",
      tabs: [
        {
          type: "terminal",
          id: "host-tab-1::leaf-1",
          parentTabId: "host-tab-1",
          leafId: "leaf-1",
          title: "Terminal 1",
          isActive: true,
          status: "pending-handle",
          terminal: null,
        },
      ],
    },
  };
}

describe("U153 D1: user-created cloud tab selects itself on the host", () => {
  beforeEach(async () => {
    resetRemoteRuntimeTransport();
    // The transport's product path resolves the worktree owner; seed the cloud row so a
    // cloud-gated implementation and a flag-gated one both exercise the same behaviour.
    const { useAppStore } = await import("@/store");
    useAppStore.setState({ runtimeEnvironments: [cloudEnvironment()] });
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === "terminal.create") {
        return {
          ok: true,
          result: {
            terminal: {
              handle: "remote-pty-u153",
              tabId: CREATED_HOST_TAB_ID,
              leafId: CREATED_HOST_LEAF_ID,
            },
          },
        };
      }
      return { ok: true, result: {} };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.fails(
    "pins D1: user-gesture cloud tab creation sends a tap-semantics activate and records focus intent",
    async () => {
      const { createRemoteRuntimePtyTransport } =
        await import("./remote-runtime-pty-transport");
      const { peekWebSessionFocusIntent } =
        await import("@/runtime/web-session-focus-intent");
      const transport = createRemoteRuntimePtyTransport(ENV, {
        worktreeId: WORKTREE,
        tabId: LOCAL_TAB_ID,
        leafId: LOCAL_LEAF_ID,
        // The pane was mounted because the user just created and showed this tab.
        activate: true,
      });

      await transport.connect({ url: "", callbacks: {} });
      // Let a fix's post-create replay land before judging the outbound queue.
      await vi
        .waitFor(() => expect(activationParams().length).toBeGreaterThan(0), {
          timeout: 1_000,
        })
        .catch(() => {});

      const activations = activationParams();
      expect(
        activations.length,
        "U153 D1: user-created cloud tab completion must send session.tabs.activate",
      ).toBeGreaterThan(0);
      const tapActivation = activations.find(
        (params) => params.materializeOnly !== true,
      );
      expect(
        tapActivation,
        "U153 D1: the user-gesture activate must NOT carry materializeOnly:true (host would only project)",
      ).toBeDefined();
      expect(
        tapActivation,
        "U153 D1: activate must address the host tab/leaf the create returned",
      ).toMatchObject({
        tabId: CREATED_HOST_TAB_ID,
        leafId: CREATED_HOST_LEAF_ID,
        intent: "user",
        navigation: "caller",
        notifyClients: false,
      });
      expect(
        tapActivation?.materializeOnly,
        "U153 D1: materializeOnly must be absent or false on the user-gesture activate",
      ).not.toBe(true);

      const intent = peekWebSessionFocusIntent(
        { environmentId: ENV },
        WORKTREE,
      );
      expect(
        intent?.hostTabId,
        "U153 D1: user-gesture create must record recordWebSessionFocusIntent for the new host tab",
      ).toBe(CREATED_HOST_TAB_ID);
    },
  );

  it("keeps passive mirror-attach activations materializeOnly (U138 phase 9 negative control)", async () => {
    vi.useFakeTimers();
    runtimeCall.mockImplementation((request: { method: string }) =>
      Promise.resolve(
        request.method === "session.tabs.activate" ||
          request.method === "session.tabs.list"
          ? pendingHostSessionSnapshot()
          : { ok: true, result: {} },
      ),
    );
    const { createRemoteRuntimePtyTransport } =
      await import("./remote-runtime-pty-transport");
    const transport = createRemoteRuntimePtyTransport(ENV, {
      worktreeId: WORKTREE,
      tabId: "web-terminal-host-tab-1",
      leafId: "leaf-1",
    });

    const connect = transport.connect({ url: "", callbacks: {} });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(connect).resolves.toBeUndefined();

    const activations = activationParams();
    expect(activations.length).toBeGreaterThan(0);
    for (const params of activations) {
      expect(
        params.materializeOnly,
        "U138 negative control: mount/attach is a projection",
      ).toBe(true);
      expect(params.navigation).toBe("caller");
      expect(params.notifyClients).toBe(false);
    }
  });
});
