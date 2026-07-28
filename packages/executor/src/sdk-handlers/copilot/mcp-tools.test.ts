import type { MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';

import { resolveCopilotServerTools } from './prompt-service.js';

function server(tools: string[], toolPermissions?: MCPServer['tool_permissions']): MCPServer {
  return {
    name: 'github',
    tools: tools.map((name) => ({ name, description: '' })),
    tool_permissions: toolPermissions,
  } as MCPServer;
}

describe('resolveCopilotServerTools', () => {
  it('keeps the wildcard when nothing is gated', () => {
    expect(resolveCopilotServerTools(server(['a', 'b']))).toEqual(['*']);
    expect(resolveCopilotServerTools(server(['a'], { a: 'allow' }))).toEqual(['*']);
  });

  it('names the survivors and drops both deny and ask', () => {
    // Copilot's list is an INCLUDE list — inverting this would expose
    // precisely the tools that were switched off.
    const tools = resolveCopilotServerTools(
      server(['create_pr', 'merge_pr', 'list_issues'], {
        create_pr: 'deny',
        merge_pr: 'ask',
      })
    );

    expect(tools).toEqual(['list_issues']);
    expect(tools).not.toContain('create_pr');
    expect(tools).not.toContain('merge_pr');
  });

  it('yields an empty list when every tool is gated', () => {
    expect(resolveCopilotServerTools(server(['a'], { a: 'deny' }))).toEqual([]);
  });
});
