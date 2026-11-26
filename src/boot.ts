/* Entry point: bring localStorage back from the durable copy (if WebKit lost or
   rolled back its data) before the app reads any of it, then start the app. */
import { restoreState, startMirroring } from './durable';

restoreState()
  .catch(err => console.warn('restore failed; starting with what localStorage has', err))
  .finally(() => {
    startMirroring();
    void import('./main');
  });
