import type { FastifyInstance } from 'fastify';
import { registerUserRoutes } from './users.routes.js';
import { registerCompanyRoutes } from './company.routes.js';
import { registerAccountingRoutes } from './accounting/routes.js';
import { registerIntegrationRoutes } from './accounting/integration.routes.js';
import { registerSubledgerRoutes } from './accounting/subledger.routes.js';
import { registerBankRoutes } from './banks/routes.js';
import { registerPayrollRoutes } from './payroll/routes.js';
import { registerReceivedRoutes } from './received/routes.js';
import { registerFiscalRoutes } from './fiscal/routes.js';
import { registerImportRoutes } from './imports/routes.js';
import { registerAssetRoutes } from './assets/routes.js';
import { registerCompraAdjuntosRoutes } from './compra-adjuntos.routes.js';

/**
 * Módulos ERP sobre la base multi-tenant: usuarios, contabilidad, CxC/CxP,
 * bancos, planillas, fiscal y activos fijos. Cada módulo es un plugin
 * encapsulado con su propia autenticación (ver http.ts).
 */
export async function registerErpModules(app: FastifyInstance): Promise<void> {
  await registerUserRoutes(app);
  await registerCompanyRoutes(app);
  await registerAccountingRoutes(app);
  await registerIntegrationRoutes(app);
  await registerSubledgerRoutes(app);
  await registerBankRoutes(app);
  await registerPayrollRoutes(app);
  await registerReceivedRoutes(app);
  await registerFiscalRoutes(app);
  await registerImportRoutes(app);
  await registerAssetRoutes(app);
  await registerCompraAdjuntosRoutes(app);
}
