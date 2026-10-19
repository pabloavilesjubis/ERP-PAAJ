import type { FastifyInstance } from 'fastify';
import { registerUserRoutes } from './users.routes.js';
import { registerAccountingRoutes } from './accounting/routes.js';

/**
 * Módulos ERP sobre la base multi-tenant: usuarios, contabilidad, CxC/CxP,
 * bancos, planillas, fiscal y activos fijos. Cada módulo es un plugin
 * encapsulado con su propia autenticación (ver http.ts).
 */
export async function registerErpModules(app: FastifyInstance): Promise<void> {
  await registerUserRoutes(app);
  await registerAccountingRoutes(app);
}
