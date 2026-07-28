/**
 * Per-tool MCP permission resolution.
 *
 * `mcp_servers.data.tool_permissions` is keyed on the BARE tool name exactly as
 * the MCP server advertises it (`create_pull_request`). Every agent SDK exposes
 * that tool to the model under a server-qualified name, and each one qualifies
 * differently:
 *
 * - Claude Code: `mcp__<server>__<tool>` (see `canUseTool` in permission-hooks)
 * - Gemini CLI:  bare `<tool>`, promoted to `<server>__<tool>` only when two
 *                servers advertise the same tool name
 * - Codex:       per-server `disabled_tools`, so bare names are used directly
 *
 * The index below closes that gap: it is built from the resolved MCP server
 * list and answers "what did the user configure for the tool the SDK just
 * named?" for any of those shapes.
 */

import type { MCPServer, ToolPermission } from '@agor/core/types';

const SEPARATOR = '__';
const CLAUDE_MCP_PREFIX = `mcp${SEPARATOR}`;

/**
 * Permissions a handler with no interactive approval flow must refuse.
 *
 * Codex and Gemini run headless — there is no channel to surface a prompt on —
 * so `ask` degrades to a refusal there rather than silently becoming `allow`.
 */
export const PERMISSIONS_BLOCKED_WITHOUT_PROMPT: readonly ToolPermission[] = ['deny', 'ask'];

/**
 * Ranked most-permissive-first. When a bare tool name is ambiguous across
 * servers the most restrictive configured value wins.
 */
const RESTRICTIVENESS: Record<ToolPermission, number> = { allow: 0, ask: 1, deny: 2 };

export interface McpToolPermissionIndex {
  /** Server name (raw and SDK-sanitized) → bare tool name → permission. */
  readonly byServer: ReadonlyMap<string, ReadonlyMap<string, ToolPermission>>;
  /** Bare tool name → most restrictive permission configured on any server. */
  readonly byTool: ReadonlyMap<string, ToolPermission>;
}

export const EMPTY_MCP_TOOL_PERMISSION_INDEX: McpToolPermissionIndex = {
  byServer: new Map(),
  byTool: new Map(),
};

/**
 * SDKs rewrite server names into their own identifier alphabets before
 * embedding them in a tool name. Indexing the sanitized form alongside the raw
 * one keeps lookups working for servers named e.g. "preset sdx".
 */
function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** Bare tool names on `server` whose configured permission is one of `permissions`. */
export function listMcpToolsWithPermission(
  server: MCPServer,
  permissions: readonly ToolPermission[]
): string[] {
  const configured = server.tool_permissions;
  if (!configured) return [];

  return Object.entries(configured)
    .filter(([, permission]) => permissions.includes(permission))
    .map(([toolName]) => toolName);
}

export function buildMcpToolPermissionIndex(servers: MCPServer[]): McpToolPermissionIndex {
  const byServer = new Map<string, Map<string, ToolPermission>>();
  const byTool = new Map<string, ToolPermission>();

  for (const server of servers) {
    const configured = server.tool_permissions;
    if (!configured || Object.keys(configured).length === 0) continue;

    const tools = new Map<string, ToolPermission>(Object.entries(configured));
    for (const alias of new Set([server.name, sanitizeServerName(server.name)])) {
      byServer.set(alias, tools);
    }

    for (const [toolName, permission] of tools) {
      const current = byTool.get(toolName);
      if (!current || RESTRICTIVENESS[permission] > RESTRICTIVENESS[current]) {
        byTool.set(toolName, permission);
      }
    }
  }

  return { byServer, byTool };
}

/**
 * Resolve the configured permission for a tool name as an SDK surfaced it.
 *
 * Returns `undefined` when nothing is configured — callers must treat that as
 * "unchanged behaviour", never as an implicit allow or deny.
 */
export function resolveMcpToolPermission(
  index: McpToolPermissionIndex,
  sdkToolName: string
): ToolPermission | undefined {
  const qualified = sdkToolName.startsWith(CLAUDE_MCP_PREFIX)
    ? sdkToolName.slice(CLAUDE_MCP_PREFIX.length)
    : sdkToolName;

  // Longest prefix wins so a server named "github" can't shadow "github_enterprise".
  let matchedServerName: string | undefined;
  for (const serverName of index.byServer.keys()) {
    if (!qualified.startsWith(`${serverName}${SEPARATOR}`)) continue;
    if (!matchedServerName || serverName.length > matchedServerName.length) {
      matchedServerName = serverName;
    }
  }

  if (matchedServerName) {
    const bareName = qualified.slice(matchedServerName.length + SEPARATOR.length);
    return index.byServer.get(matchedServerName)?.get(bareName);
  }

  return index.byTool.get(qualified);
}
