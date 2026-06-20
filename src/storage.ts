import { Config } from './config';
import { AttendanceStore } from './types';
import { JsonStore } from './store';
import { PgStore } from './pgStore';

/** Pick the storage backend from config (STORAGE_DRIVER). */
export function createStore(config: Config): AttendanceStore {
  if (config.storageDriver === 'postgres') {
    return new PgStore(config);
  }
  return new JsonStore(config.storeFile, config.stateFile);
}
