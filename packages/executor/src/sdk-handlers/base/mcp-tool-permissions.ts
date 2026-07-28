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
 * What a handler can actually do about `tool_permissions`.
 *
 * Required at the resolution boundary rather than assumed, because the way this
 * control failed the first time was silent: six handlers resolve MCP servers,
 * three enforced, and the other three kept reporting success while ignoring
 * every `deny`.
 */
export interface HandlerPermissionCapabilities {
  /**
   * - `exclude`: can name tools to drop (Claude, Gemini, Codex)
   * - `include`: can name the tools to keep, so it needs a discovered tool list
   *   to express "all but these" (Copilot)
   * - `none`: no per-tool control at all (Cursor, OpenCode)
   */
  toolFiltering: 'exclude' | 'include' | 'none';
  /** Whether the handler can put an approval prompt in front of a human. */
  interactiveApproval: boolean;
}

/**
 * Whether `server`'s configured permissions can be honoured under `caps`.
 *
 * A handler that cannot honour them must not be handed the server at all —
 * attaching it anyway would expose exactly the tools someone switched off.
 */
export function canEnforceMcpToolPermissions(
  server: MCPServer,
  caps: HandlerPermissionCapabilities
): boolean {
  const gated = listMcpToolsWithPermission(server, PERMISSIONS_BLOCKED_WITHOUT_PROMPT);
  if (gated.length === 0) return true;

  switch (caps.toolFiltering) {
    case 'exclude':
      return true;
    // An include-list has to enumerate what stays, which is impossible before
    // the server's tools have been discovered.
    case 'include':
      return (server.tools?.length ?? 0) > 0;
    case 'none':
      return false;
  }
}

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
 * embedding them in a tool name. Indexing the rewritten forms alongside the raw
 * one keeps lookups working for servers named e.g. "preset sdx" or "my.server".
 *
 * The alphabet is the tool-name one (`[a-zA-Z0-9_-]`), deliberately narrower
 * than any single SDK's: a character we leave in but the SDK rewrites would
 * make the index miss, and a miss reads as "unconfigured", i.e. allow. Codex
 * also lowercases, so that variant is indexed too.
 */
function serverNameAliases(name: string): string[] {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return [name, sanitized, sanitized.toLowerCase()];
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
    for (const alias of new Set(serverNameAliases(server.name))) {
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
