type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = ORDER.info;

export function setLevel(level: string): void {
  const l = level.toLowerCase() as Level;
  if (l in ORDER) threshold = ORDER[l];
}

function emit(level: Level, message: string, meta?: unknown): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] ${message}`;
  if (level === 'error') {
    meta !== undefined ? console.error(line, meta) : console.error(line);
  } else {
    meta !== undefined ? console.log(line, meta) : console.log(line);
  }
}

export const log = {
  debug: (m: string, meta?: unknown) => emit('debug', m, meta),
  info: (m: string, meta?: unknown) => emit('info', m, meta),
  warn: (m: string, meta?: unknown) => emit('warn', m, meta),
  error: (m: string, meta?: unknown) => emit('error', m, meta),
};
