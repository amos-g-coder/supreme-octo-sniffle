import { ToolSelectorPolicy } from '../../../src/core/mcp/ToolSelectorPolicy';

const catalog = [
  { name: 'read', preload: true, inputSchema: { type: 'object' as const }, annotations: { readOnlyHint: true } },
  { name: 'unknown', preload: true, inputSchema: { type: 'object' as const } },
  { name: 'write', preload: true, inputSchema: { type: 'object' as const }, annotations: { readOnlyHint: false } },
];

it('applies conservative Inflex approvals through the common policy while preserving upstream defaults', () => {
  const selectors = { enableTools: ['@all'], disableTools: [], preloadTools: [] };
  const upstream = new ToolSelectorPolicy({ selectors, preload: true });
  const inflex = new ToolSelectorPolicy({ selectors: { ...selectors, unannotatedIsWrite: true }, preload: true });
  expect(upstream.requiresApproval('unknown', undefined)).toBe(false);
  expect(inflex.requiresApproval('unknown', undefined)).toBe(true);
  expect(inflex.requiresApproval('read', { readOnlyHint: true })).toBe(false);
  expect(inflex.filterAndAnnotate(catalog).find(tool => tool.name === 'unknown')?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
});

it('intersects read-only child permissions with the existing selectors before and after catalog loading', async () => {
  const policy = new ToolSelectorPolicy({
    selectors: {
      enableTools: ['@all'],
      disableTools: ['read'],
      preloadTools: [],
      unannotatedIsWrite: true,
      readOnlyOnly: true,
    },
    preload: true,
  });
  expect(policy.allowedNamesForSandbox()).toEqual([]);
  expect(await policy.isAllowed('unknown', () => Promise.resolve(undefined))).toBe(false);
  expect(await policy.isAllowed('read', () => Promise.resolve({ readOnlyHint: true }))).toBe(false);
  expect(policy.filterAndAnnotate(catalog)).toEqual([]);
  expect(await policy.isAllowed('write', () => Promise.resolve({ readOnlyHint: true }))).toBe(false);
});
