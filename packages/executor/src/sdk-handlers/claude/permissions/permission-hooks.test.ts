import type { MCPServer, SessionID, TaskID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildMcpToolPermissionIndex,
  EMPTY_MCP_TOOL_PERMISSION_INDEX,
} from '../../base/mcp-tool-permissions.js';

vi.mock('@agor/core', () => ({
  generateId: vi.fn(() => 'test-generated-id'),
  // shortId is used in log lines inside permission-hooks; a passthrough
  // mock keeps test output legible without depending on real ID shape.
  shortId: vi.fn((id: string) => id),
}));

import { createCanUseToolCallback } from './permission-hooks.js';

/**
 * Coverage for the post-#1177 `canUseTool` callback.
 *
 * The AskUserQuestion intercept and the bypass-mode workaround were both
 * removed when #1177 disallowed `AskUserQuestion` at the SDK layer. What
 * remains is the MCP auto-approve fast-path and the permission-request UI
 * flow — both worth direct tests so future refactors don't quietly regress.
 */
describe('createCanUseToolCallback', () => {
  const sessionId = 'test-session' as SessionID;
  const taskId = 'test-task' as TaskID;
  const noopOptions = {
    signal: new AbortController().signal,
  };

  function createBaseDeps() {
    return {
      permissionService: {
        emitRequest: vi.fn(),
        waitForDecision: vi.fn(),
        cancelPendingRequests: vi.fn(),
      } as any,
      tasksService: {
        patch: vi.fn().mockResolvedValue(undefined),
      } as any,
      messagesRepo: {
        findBySessionId: vi.fn().mockResolvedValue([]),
      } as any,
      messagesService: {
        create: vi.fn().mockResolvedValue(undefined),
        patch: vi.fn().mockResolvedValue(undefined),
      } as any,
      sessionsService: {
        patch: vi.fn().mockResolvedValue(undefined),
      } as any,
      permissionLocks: new Map<SessionID, Promise<void>>(),
      mcpServerRepo: {
        findById: vi.fn(),
      } as any,
      sessionMCPRepo: {
        findBySessionId: vi.fn().mockResolvedValue([]),
        listServers: vi.fn().mockResolvedValue([]),
      } as any,
      mcpToolPermissions: EMPTY_MCP_TOOL_PERMISSION_INDEX,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('MCP auto-approve', () => {
    it('auto-allows tools from the built-in "agor" server without consulting the DB', async () => {
      const deps = createBaseDeps();
      const callback = createCanUseToolCallback(sessionId, taskId, deps);

      const toolInput = { sessionId };
      const result = await callback('mcp__agor__agor_sessions_get_current', toolInput, noopOptions);

      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual(toolInput);
      expect(result.updatedPermissions?.[0]?.behavior).toBe('allow');
      expect(result.updatedPermissions?.[0]?.destination).toBe('session');
      // The agor server is added dynamically — should NOT round-trip through the DB.
      expect(deps.sessionMCPRepo.findBySessionId).not.toHaveBeenCalled();
      expect(deps.sessionMCPRepo.listServers).not.toHaveBeenCalled();
      expect(deps.mcpServerRepo.findById).not.toHaveBeenCalled();
      // No permission UI involved.
      expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
    });

    it('auto-allows tools from MCP servers that ARE attached to the session', async () => {
      const deps = createBaseDeps();
      deps.sessionMCPRepo.listServers.mockResolvedValue([{ name: 'shortcut' }]);

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('mcp__shortcut__list_stories', {}, noopOptions);

      expect(result.behavior).toBe('allow');
      expect(deps.sessionMCPRepo.listServers).toHaveBeenCalledWith(sessionId, true);
      expect(deps.sessionMCPRepo.findBySessionId).not.toHaveBeenCalled();
      expect(deps.mcpServerRepo.findById).not.toHaveBeenCalled();
      expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
    });

    it('falls through to permission flow when an MCP server is NOT attached', async () => {
      const deps = createBaseDeps();
      deps.sessionMCPRepo.listServers.mockResolvedValue([]); // no attached servers
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: false,
        timedOut: false,
        remember: false,
        decidedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('mcp__random__do_thing', {}, noopOptions);

      // The MCP fast-path didn't match — the permission UI was consulted.
      expect(deps.permissionService.emitRequest).toHaveBeenCalledTimes(1);
      expect(result.behavior).toBe('deny');
    });
  });

  describe('MCP tool_permissions enforcement', () => {
    const githubServer = {
      name: 'github',
      tool_permissions: {
        create_pull_request: 'deny',
        merge_pull_request: 'ask',
        list_issues: 'allow',
      },
    } as unknown as MCPServer;

    function createGithubDeps() {
      const deps = createBaseDeps();
      // The server IS attached — without tool_permissions every tool below
      // would take the auto-approve fast path.
      deps.sessionMCPRepo.listServers.mockResolvedValue([{ name: 'github' }]);
      deps.mcpToolPermissions = buildMcpToolPermissionIndex([githubServer]);
      return deps;
    }

    /**
     * Stand-in for the SDK's dispatch step: the SDK only forwards a tool call
     * to the MCP server when `canUseTool` answers `allow`. Routing the test
     * through it asserts on the dispatch boundary rather than on the returned
     * error object — a deny that still dispatched would fail here.
     */
    async function dispatch(
      callback: ReturnType<typeof createCanUseToolCallback>,
      toolName: string,
      toolInput: Record<string, unknown>,
      sendToMcpServer: ReturnType<typeof vi.fn>
    ) {
      const decision = await callback(toolName, toolInput, noopOptions);
      if (decision.behavior === 'allow') {
        sendToMcpServer(toolName, decision.updatedInput);
      }
      return decision;
    }

    it('never dispatches a denied tool to the MCP server', async () => {
      const deps = createGithubDeps();
      const sendToMcpServer = vi.fn();

      const decision = await dispatch(
        createCanUseToolCallback(sessionId, taskId, deps),
        'mcp__github__create_pull_request',
        { title: 'nope' },
        sendToMcpServer
      );

      expect(sendToMcpServer).not.toHaveBeenCalled();
      expect(decision.behavior).toBe('deny');
      // Denial is unconditional — the user is never given a chance to override.
      expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
      expect(deps.permissionService.waitForDecision).not.toHaveBeenCalled();
    });

    it('routes an "ask" tool through the permission prompt instead of auto-approving', async () => {
      const deps = createGithubDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: true,
        timedOut: false,
        remember: false,
        decidedBy: 'test-user',
      });
      const sendToMcpServer = vi.fn();

      const decision = await dispatch(
        createCanUseToolCallback(sessionId, taskId, deps),
        'mcp__github__merge_pull_request',
        { number: 7 },
        sendToMcpServer
      );

      expect(deps.permissionService.emitRequest).toHaveBeenCalledTimes(1);
      expect(decision.behavior).toBe('allow');
      expect(sendToMcpServer).toHaveBeenCalledWith('mcp__github__merge_pull_request', {
        number: 7,
      });
    });

    it('blocks an "ask" tool when the user declines', async () => {
      const deps = createGithubDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: false,
        timedOut: false,
        remember: false,
        decidedBy: 'test-user',
      });
      const sendToMcpServer = vi.fn();

      await dispatch(
        createCanUseToolCallback(sessionId, taskId, deps),
        'mcp__github__merge_pull_request',
        {},
        sendToMcpServer
      );

      expect(sendToMcpServer).not.toHaveBeenCalled();
    });

    it('auto-approves an "allow" tool without prompting', async () => {
      const deps = createGithubDeps();
      const sendToMcpServer = vi.fn();

      const decision = await dispatch(
        createCanUseToolCallback(sessionId, taskId, deps),
        'mcp__github__list_issues',
        {},
        sendToMcpServer
      );

      expect(decision.behavior).toBe('allow');
      expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
      expect(sendToMcpServer).toHaveBeenCalledTimes(1);
    });

    it('leaves unlisted tools on the existing attached-server fast path', async () => {
      const deps = createGithubDeps();
      const sendToMcpServer = vi.fn();

      const decision = await dispatch(
        createCanUseToolCallback(sessionId, taskId, deps),
        'mcp__github__list_commits',
        {},
        sendToMcpServer
      );

      expect(decision.behavior).toBe('allow');
      expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
      expect(sendToMcpServer).toHaveBeenCalledTimes(1);
    });

    it('does not let one server\'s "deny" leak onto a same-named tool on another server', async () => {
      const deps = createBaseDeps();
      deps.sessionMCPRepo.listServers.mockResolvedValue([{ name: 'gitlab' }]);
      deps.mcpToolPermissions = buildMcpToolPermissionIndex([githubServer]);
      const sendToMcpServer = vi.fn();

      const decision = await dispatch(
        createCanUseToolCallback(sessionId, taskId, deps),
        'mcp__gitlab__create_pull_request',
        {},
        sendToMcpServer
      );

      expect(decision.behavior).toBe('allow');
      expect(sendToMcpServer).toHaveBeenCalledTimes(1);
    });

    it('denies before the built-in "agor" fast path can auto-approve', async () => {
      const deps = createBaseDeps();
      deps.mcpToolPermissions = buildMcpToolPermissionIndex([
        {
          name: 'agor',
          tool_permissions: { agor_sessions_prompt: 'deny' },
        } as unknown as MCPServer,
      ]);
      const sendToMcpServer = vi.fn();

      const decision = await dispatch(
        createCanUseToolCallback(sessionId, taskId, deps),
        'mcp__agor__agor_sessions_prompt',
        {},
        sendToMcpServer
      );

      expect(decision.behavior).toBe('deny');
      expect(sendToMcpServer).not.toHaveBeenCalled();
    });
  });

  describe('Permission request flow', () => {
    it('approves a tool when the UI returns allow', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: true,
        timedOut: false,
        remember: false,
        decidedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual({ command: 'ls' });
      // No persistence rule emitted when remember=false.
      expect(result.updatedPermissions).toBeUndefined();
      expect(deps.tasksService.patch).toHaveBeenNthCalledWith(1, taskId, {
        status: 'awaiting_permission',
      });
      expect(deps.tasksService.patch).toHaveBeenNthCalledWith(2, taskId, {
        status: 'running',
      });
      // Lock was acquired AND released.
      expect(deps.permissionLocks.size).toBe(0);
    });

    it('emits an SDK persistence rule when the user picks "remember"', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: true,
        timedOut: false,
        remember: true,
        scope: 'project',
        decidedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('allow');
      expect(result.updatedPermissions).toEqual([
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'projectSettings',
        },
      ]);
    });

    it('denies the tool and cancels pending requests when the UI returns deny', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: false,
        timedOut: false,
        remember: false,
        decidedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('Bash');
      expect(deps.permissionService.cancelPendingRequests).toHaveBeenCalledWith(sessionId);
      // Session driven back to idle so the user can re-prompt.
      expect(deps.sessionsService.patch).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ status: 'idle' })
      );
    });

    it('marks task and session timed_out when the permission request times out', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: false,
        timedOut: true,
        remember: false,
        decidedBy: 'system',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('deny');
      expect(result.message).toMatch(/timed out/i);
      expect(deps.tasksService.patch).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({ status: 'timed_out' })
      );
      expect(deps.sessionsService.patch).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ status: 'timed_out', ready_for_prompt: true })
      );
    });

    it('always releases the per-session permission lock, even on timeout', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: false,
        timedOut: true,
        remember: false,
        decidedBy: 'system',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      await callback('Bash', { command: 'ls' }, noopOptions);

      // Lock is removed from the map after the callback completes — without
      // this guarantee, every subsequent tool call on the same session would
      // wait forever for a never-resolving promise.
      expect(deps.permissionLocks.has(sessionId)).toBe(false);
    });
  });
});
