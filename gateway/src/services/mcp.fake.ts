/**
 * Test helper: an in-process MCP server (the official SDK's Server) reached
 * through the SDK's in-memory transport, wrapped as an McpClientFactory.
 * No network. Used only by tests.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpCallResult, McpClientFactory, McpTarget, RemoteTool } from './mcp.js';

export interface FakeMcp {
  factory: McpClientFactory;
  /** The tools the server lists. Change it and refresh to see new tools. */
  tools: RemoteTool[];
  /** What a tool call returns (or throws). */
  onCall: (name: string, args: Record<string, unknown>) => McpCallResult | Promise<McpCallResult>;
  /** Every tool call that reached the server. */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Every target the factory was asked to connect to. */
  targets: McpTarget[];
  opened: number;
  closed: number;
  /** Return true to make connecting to this target fail. */
  failConnect: (target: McpTarget) => boolean;
  /** Fail this many upcoming callTool requests in the transport (before the server sees them). */
  dropCalls: number;
  /** Error thrown for a dropped call. */
  dropError: (target: McpTarget) => unknown;
}

export function createFakeMcp(tools: RemoteTool[] = []): FakeMcp {
  const fake: FakeMcp = {
    tools,
    onCall: (name, args) => ({ content: [{ type: 'text', text: `${name} ok ${JSON.stringify(args)}` }] }),
    calls: [],
    targets: [],
    opened: 0,
    closed: 0,
    failConnect: () => false,
    dropCalls: 0,
    dropError: target => new Error(`socket hang up talking to ${target.url}`),
    factory: async (target) => {
      fake.targets.push(target);
      // The message deliberately contains the secret URL: callers must not leak it.
      if (fake.failConnect(target)) throw new Error(`connect ECONNREFUSED ${target.url} (token ${target.token ?? 'none'})`);
      const server = new Server({ name: 'fake-connector', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: fake.tools.map(t => ({ inputSchema: { type: 'object' as const }, ...t })) as any,
      }));
      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const args = (req.params.arguments ?? {}) as Record<string, unknown>;
        fake.calls.push({ name: req.params.name, args });
        return (await fake.onCall(req.params.name, args)) as any;
      });
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'fibb-test', version: '1.0.0' });
      await client.connect(clientSide);
      fake.opened++;
      return {
        listTools: async (cursor?: string) => {
          const r = await client.listTools(cursor ? { cursor } : undefined);
          return { tools: r.tools as unknown as RemoteTool[], nextCursor: r.nextCursor };
        },
        callTool: async (name, args) => {
          if (fake.dropCalls > 0) { fake.dropCalls--; throw fake.dropError(target); }
          return (await client.callTool({ name, arguments: args })) as McpCallResult;
        },
        close: async () => { fake.closed++; await client.close(); await server.close(); },
      };
    },
  };
  return fake;
}

/** In-memory vault for tests: never the real vault. */
export class FakeVault {
  store = new Map<string, string>();
  async get(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  async set(k: string, v: string) { this.store.set(k, v); }
  async delete(k: string) { return this.store.delete(k); }
}

/** DNS for tests: names containing "internal" resolve to a private address. */
export const fakeLookup = async (hostname: string) =>
  [{ address: hostname.includes('internal') ? '10.0.0.5' : '93.184.216.34', family: 4 }];
