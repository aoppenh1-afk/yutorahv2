import { after } from 'vinext/shims/server';
import { createCatalogService } from './catalog-service';
let service: Promise<ReturnType<typeof createCatalogService>> | undefined;
export function getCatalogService() {
  return (service ??= (async () => {
    // Public browsing remains usable without a search binding, including CLI
    // rendering. Configured deployments use the shared durable database.
    try {
      const { searchDatabase } = await import('./search-db');
      const db = searchDatabase();
      return createCatalogService({ database: () => db });
    } catch {
      return createCatalogService();
    }
  })());
}
/** The runtime owns background refreshes after the response is sent. */
export const deferCatalogWork = (task: () => Promise<unknown>) => {
  try {
    after(task);
  } catch {
    // CLI readers have no response lifecycle. Scheduled maintenance can refresh
    // retained snapshots; never start untracked work after a request ends.
  }
};
