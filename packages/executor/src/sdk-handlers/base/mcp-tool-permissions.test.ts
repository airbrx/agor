import type { MCPServer, ToolPermission } from '@agor/core/types';
import { describe, expect, it } from 'vitest';

import {
  buildMcpToolPermissionIndex,
  EMPTY_MCP_TOOL_PERMISSION_INDEX,
  listMcpToolsWithPermission,
  PERMISSIONS_BLOCKED_WITHOUT_PROMPT,
  resolveMcpToolPermission,
} from './mcp-tool-permissions.js';

function server(name: string, toolPermissions?: Record<string, ToolPermission>): MCPServer {
  return { name, tool_permissions: toolPermissions } as MCPServer;
}

describe('listMcpToolsWithPermission', () => {
  const github = server('github', {
    create_pull_request: 'deny',
    merge_pull_request: 'ask',
    list_issues: 'allow',
  });

  it('selects only the requested permissions', () => {
    expect(listMcpToolsWithPermission(github, ['deny'])).toEqual(['create_pull_request']);
    expect(listMcpToolsWithPermission(github, ['allow'])).toEqual(['list_issues']);
    expect(listMcpToolsWithPermission(github, PERMISSIONS_BLOCKED_WITHOUT_PROMPT)).toEqual([
      'create_pull_request',
      'merge_pull_request',
    ]);
  });

  it('returns nothing for a server with no tool_permissions', () => {
    expect(listMcpToolsWithPermission(server('plain'), ['deny', 'ask', 'allow'])).toEqual([]);
  });
});

describe('resolveMcpToolPermission', () => {
  const index = buildMcpToolPermissionIndex([
    server('github', { create_pull_request: 'deny', merge_pull_request: 'ask' }),
    server('linear', { create_issue: 'allow' }),
  ]);

  it('maps a Claude-namespaced tool name onto the bare key it is stored under', () => {
    // tool_permissions is keyed on `create_pull_request`; the SDK asks about
    // `mcp__github__create_pull_request`. Bridging the two IS the feature.
    expect(resolveMcpToolPermission(index, 'mcp__github__create_pull_request')).toBe('deny');
    expect(resolveMcpToolPermission(index, 'mcp__github__merge_pull_request')).toBe('ask');
    expect(resolveMcpToolPermission(index, 'mcp__linear__create_issue')).toBe('allow');
  });

  it('maps a Gemini bare tool name', () => {
    expect(resolveMcpToolPermission(index, 'create_pull_request')).toBe('deny');
    expect(resolveMcpToolPermission(index, 'create_issue')).toBe('allow');
  });

  it('maps a Gemini server-qualified tool name', () => {
    expect(resolveMcpToolPermission(index, 'github__create_pull_request')).toBe('deny');
  });

  it('returns undefined for tools with no configured entry', () => {
    expect(resolveMcpToolPermission(index, 'mcp__github__list_issues')).toBeUndefined();
    expect(resolveMcpToolPermission(index, 'mcp__unknown__create_pull_request')).toBeUndefined();
    expect(resolveMcpToolPermission(index, 'Bash')).toBeUndefined();
    expect(resolveMcpToolPermission(EMPTY_MCP_TOOL_PERMISSION_INDEX, 'mcp__github__x')).toBe(
      undefined
    );
  });

  it('keeps the underscores inside a tool name intact', () => {
    const withUnderscores = buildMcpToolPermissionIndex([
      server('gh', { create__pull__request: 'deny' }),
    ]);

    expect(resolveMcpToolPermission(withUnderscores, 'mcp__gh__create__pull__request')).toBe(
      'deny'
    );
  });

  it('prefers the longest matching server prefix', () => {
    const overlapping = buildMcpToolPermissionIndex([
      server('gh', { enterprise__deploy: 'allow' }),
      server('gh__enterprise', { deploy: 'deny' }),
    ]);

    expect(resolveMcpToolPermission(overlapping, 'mcp__gh__enterprise__deploy')).toBe('deny');
  });

  it('matches servers whose names the SDK had to sanitize', () => {
    const spaced = buildMcpToolPermissionIndex([server('preset sdx', { run_query: 'deny' })]);

    expect(resolveMcpToolPermission(spaced, 'mcp__preset_sdx__run_query')).toBe('deny');
    expect(resolveMcpToolPermission(spaced, 'mcp__preset sdx__run_query')).toBe('deny');
  });

  it('takes the most restrictive value when a bare name is ambiguous across servers', () => {
    const ambiguous = buildMcpToolPermissionIndex([
      server('a', { search: 'allow' }),
      server('b', { search: 'deny' }),
      server('c', { search: 'ask' }),
    ]);

    expect(resolveMcpToolPermission(ambiguous, 'search')).toBe('deny');
    // Server-qualified lookups stay exact — restrictiveness only breaks ties.
    expect(resolveMcpToolPermission(ambiguous, 'mcp__a__search')).toBe('allow');
  });
});
