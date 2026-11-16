/**
 * U153 D2 pin: the all-worktrees `session.tabs.subscribeAll` stream applies snapshots with no
 * apply options, so a cloud session never follows the host's active tab. Per-worktree
 * `session.tabs.subscribe` resolves `hostActiveAuthoritative` via
 * `resolveHostActiveApplyOptions`; the global path must do the same (and must still stand down
 * for a pending local gesture or a non-cloud session).
 */
import type { PublicKnownRuntimeEnvironment } from "../../../../shared/runtime-environments";
import type { RuntimeMobileSessionTabsResult } from "../../../../shared/runtime-types";
import type { VisibilityResumeCoordinator } from "./visibility-resume-coordinator";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { applySpy, peekFocusSpy } = vi.hoisted(() => ({
  applySpy: vi.fn<(options?: { hostActiveAuthoritative?: boolean }) => void>(),
  peekFocusSpy: vi.fn<() => { hostTabId: string } | null>(() => null),
}));
const { mockState } = vi.hoisted(
  (): {
    mockState: { runtimeEnvironments: PublicKnownRuntimeEnvironment[] };
  } => ({
    mockState: { runtimeEnvironments: [] },
  }),
);

vi.mock("../../store", () => ({
  useAppStore: { getState: () => mockState, setState: vi.fn() },
}));
vi.mock("../web-runtime-session-environment", () => ({
  captureWebSessionIntentOwner: (environmentId: string) => ({ environmentId }),
}));
vi.mock("../web-session-focus-intent", () => ({
  peekWebSessionFocusIntent: peekFocusSpy,
}));
vi.mock("../web-session-terminal-orphan-recovery", () => ({
  recoverWebSessionTerminalOrphansBeforeApply: vi.fn(
    async (_state: unknown, frame: RuntimeMobileSessionTabsResult) => frame,
  ),
}));
vi.mock("./tracking", () => ({
  recordReceivedWebSessionTabsSnapshot: vi.fn(() => 1),
  sessionTabsFreshnessKey: vi.fn(
    (environmentId: string, worktreeId: string) =>
      `${environmentId}\u0000${worktreeId}`,
  ),
  shouldApplyRecoveredWebSessionTabsSnapshot: vi.fn(() => true),
}));
vi.mock("./tracking-decisions", () => ({
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true })),
}));
vi.mock("./tracking-lifecycle", () => ({
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
}));
vi.mock("./publisher-identity-fences", () => ({
  acceptSessionTabsRuntimeId: vi.fn(() => true),
  getSessionTabsRuntimeIdFromResponse: vi.fn(() => undefined),
  isRetiredSessionTabsPublicationEpoch: vi.fn(() => false),
}));
vi.mock("./retired-epoch-census", () => ({
  scheduleRetiredEpochCensus: vi.fn(),
}));
vi.mock("./store-patch", () => ({
  applyWebSessionTabsStorePatch: vi.fn((build: (state: unknown) => unknown) => {
    build({});
    return null;
  }),
}));
vi.mock("./snapshot-api", () => ({
  applyWebSessionTabsSnapshot: vi.fn(
    (
      _state: unknown,
      _snapshot: unknown,
      _env: unknown,
      _now: unknown,
      options?: { hostActiveAuthoritative?: boolean },
    ) => {
      applySpy(options);
      return {};
    },
  ),
}));

import { handleGlobalSessionEvent } from "./global-session-events";

const ENV = "cloud-u153";
const WT = "repo::/u153-worktree";

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

function nativeEnvironment(): PublicKnownRuntimeEnvironment {
  return {
    id: ENV,
    name: "paired desktop host",
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
  };
}

function snapshot(): RuntimeMobileSessionTabsResult & { type: "snapshot" } {
  return {
    type: "snapshot",
    worktree: WT,
    publicationEpoch: "epoch-1",
    snapshotVersion: 2,
    activeGroupId: "group-1",
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
        status: "ready",
        terminal: "terminal-1",
      },
    ],
  };
}

function feedGlobalFrame(): void {
  const event = snapshot();
  handleGlobalSessionEvent({
    environmentId: ENV,
    expectedEnvironmentConnectionGeneration: 1,
    expectedEnvironmentPairingRevision: 1,
    expectedTrackingGeneration: 1,
    visibilityGeneration: 0,
    isCurrent: () => true,
    event,
    response: {
      id: "u153-d2",
      ok: true,
      result: event,
      _meta: { runtimeId: "runtime-u153" },
    },
    awaitingVisibilityResumeInventory: { value: false },
    // SAFETY: the handler only calls these three coordinator methods; a full coordinator needs live wiring.
    coordinator: {
      recordSnapshotReceipt: vi.fn(),
      shouldApplySnapshot: () => true,
      recordSnapshot: vi.fn(),
    } as unknown as VisibilityResumeCoordinator,
  });
}

function lastOptions(): { hostActiveAuthoritative?: boolean } | undefined {
  return applySpy.mock.calls.at(-1)?.[0];
}

describe("U153 D2: global subscribeAll applies with host-active authority", () => {
  beforeEach(() => {
    applySpy.mockReset();
    peekFocusSpy.mockReset();
    peekFocusSpy.mockReturnValue(null);
    mockState.runtimeEnvironments = [cloudEnvironment()];
  });

  it.fails(
    "pins D2: a cloud session global snapshot apply carries hostActiveAuthoritative:true",
    async () => {
      feedGlobalFrame();
      await vi.waitFor(() => expect(applySpy).toHaveBeenCalled());

      expect(
        lastOptions()?.hostActiveAuthoritative,
        "U153 D2: global session.tabs.subscribeAll apply must resolve hostActiveAuthoritative for a cloud session",
      ).toBe(true);
    },
  );

  it("stands down while a local gesture intent is pending (negative control)", async () => {
    peekFocusSpy.mockReturnValue({ hostTabId: "host-tab-1" });

    feedGlobalFrame();
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalled());

    expect(lastOptions()?.hostActiveAuthoritative).not.toBe(true);
  });

  it("does not grant host authority to a non-cloud session (negative control)", async () => {
    mockState.runtimeEnvironments = [nativeEnvironment()];

    feedGlobalFrame();
    await vi.waitFor(() => expect(applySpy).toHaveBeenCalled());

    expect(lastOptions()?.hostActiveAuthoritative).not.toBe(true);
  });
});
