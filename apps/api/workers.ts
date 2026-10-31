/**
 * Background work inside the API process: campaign sending every 10 s, alert checks every hour.
 * Each loop skips a tick while the previous one is still running. For several API servers, run only one with workers
 * (set WORKERS=0 on the others) so a campaign is never sent twice.
 */
import { processCampaigns } from './campaigns.js';
import { runDueAlerts } from './alerts.js';

function loop(name: string, everyMs: number, fn: () => Promise<void>, firstDelayMs = 5000) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(`[${name}]`, e instanceof Error ? e.message : e); } finally { busy = false; }
  };
  setTimeout(() => { void tick(); setInterval(() => void tick(), everyMs); }, firstDelayMs);
}

export function startWorkers() {
  if (process.env.WORKERS === '0') return;
  loop('campaigns', 10_000, processCampaigns);
  loop('alerts', 3_600_000, runDueAlerts, 30_000);
}
