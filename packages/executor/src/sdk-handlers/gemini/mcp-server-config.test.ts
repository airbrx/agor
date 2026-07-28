import { describe, expect, it, vi } from 'vitest';

/**
 * `@google/gemini-cli-core` can't be loaded under vitest (its OpenTelemetry
 * dependency uses unsupported directory imports), so this mirrors the real
 * `MCPServerConfig` constructor signature from the SDK's type declarations.
 * The positional order is the thing under test — `tsc` covers the arity and
 * types against the real class, this covers which slot each value lands in.
 */
vi.mock('@agor/core/sdk', () => ({
  Gemini: {
    MCPServerConfig: class {
      constructor(
        readonly command?: string,
        readonly args?: string[],
        readonly env?: Record<string, string>,
        readonly cwd?: string,
        readonly url?: string,
        readonly httpUrl?: string,
        readonly headers?: Record<string, string>,
        readonly tcp?: string,
        readonly type?: string,
        readonly timeout?: number,
        readonly trust?: boolean,
        readonly description?: string,
        readonly includeTools?: string[],
        readonly excludeTools?: string[]
      ) {}
    },
  },
}));

import { buildGeminiMcpServerConfig } from './mcp-server-config.js';

describe('buildGeminiMcpServerConfig', () => {
  it('lands excludeTools on the SDK field, not a neighbouring positional slot', () => {
    const config = buildGeminiMcpServerConfig({
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { GITHUB_TOKEN: 'x' },
      cwd: '/branch',
      excludeTools: ['create_pull_request', 'merge_pull_request'],
    });

    expect(config.excludeTools).toEqual(['create_pull_request', 'merge_pull_request']);
    // Everything Agor never sets must stay unset — a shifted argument would
    // silently populate one of these instead.
    expect(config.includeTools).toBeUndefined();
    expect(config.trust).toBeUndefined();
    expect(config.description).toBeUndefined();
    expect(config.timeout).toBeUndefined();
    expect(config.tcp).toBeUndefined();
  });

  it('preserves the transport fields for each shape Agor builds', () => {
    const stdio = buildGeminiMcpServerConfig({
      command: 'npx',
      args: ['-y', 'server-github'],
      env: {},
      cwd: '/branch',
      excludeTools: [],
    });
    expect(stdio).toMatchObject({ command: 'npx', args: ['-y', 'server-github'], cwd: '/branch' });

    const http = buildGeminiMcpServerConfig({
      env: {},
      httpUrl: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
      excludeTools: [],
    });
    expect(http).toMatchObject({
      httpUrl: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    });
    expect(http.url).toBeUndefined();

    const sse = buildGeminiMcpServerConfig({
      env: {},
      url: 'https://example.com/sse',
      excludeTools: [],
    });
    expect(sse).toMatchObject({ url: 'https://example.com/sse' });
    expect(sse.httpUrl).toBeUndefined();
  });

  it('leaves excludeTools unset when nothing is gated', () => {
    const config = buildGeminiMcpServerConfig({ command: 'npx', env: {}, excludeTools: [] });

    expect(config.excludeTools).toBeUndefined();
  });
});
