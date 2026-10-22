import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { WithTransaction } from '../db/transaction';
import { chatgptModels } from '../inflex/runtime';
import { listAvailableModelsRoute } from '../routes/modelRoutes';

/** Chat slim list (mounted at /api/v1/models) — mirrors GET /api/v1/skills. */
export function createModelsRouter<TTransaction>(deps: {
  resolveModelProviderStore: (c: Context) => IModelProviderStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
}) {
  const router = new OpenAPIHono();
  router.openapi(listAvailableModelsRoute, async c => {
    const store = deps.resolveModelProviderStore(c);
    const requestContext = deps.resolveRequestContext(c);
    const configured = await store.listModels({ tenant_id: requestContext.tenant_id });
    const local = configuration.STANDALONE ? await chatgptModels() : [];
    return c.json({ data: [...local, ...configured] }, 200);
  });
  return router;
}
