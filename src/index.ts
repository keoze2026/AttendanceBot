import { promises as fs } from 'node:fs';
import { Bot } from 'grammy';
import type { Chat, Message } from 'grammy/types';
import { loadConfig } from './config';
import { log } from './logger';
import { createStore } from './storage';
import { handleAttendanceMessage, handleBreakMessage, IncomingMessage } from './handler';
import { exportExcel } from './excel';

function normalizeId(value: string): string {
  return value.replace(/^-100/, '').replace(/^-/, '');
}

async function main(): Promise<void> {
  const config = loadConfig();
  await fs.mkdir(config.dataDir, { recursive: true });

  const store = createStore(config);
  await store.load();
  log.info(`Storage backend: ${config.storageDriver}.`);

  // Debounced Excel export so a burst of messages triggers a single rewrite.
  let excelTimer: NodeJS.Timeout | null = null;
  const scheduleExcel = (): void => {
    if (excelTimer) clearTimeout(excelTimer);
    excelTimer = setTimeout(() => {
      store
        .all()
        .then((records) => exportExcel(config.excelPath, records, config))
        .then(() => log.info(`Excel updated: ${config.excelPath}`))
        .catch((e) => log.error('Excel export failed', e));
    }, config.excelDebounceMs);
  };

  const mainId = normalizeId(config.mainGroup);
  const breakIds = new Set(config.breakGroups.map(normalizeId));

  const groupKind = (chat: Chat): 'main' | 'break' | null => {
    if (chat.type !== 'group' && chat.type !== 'supergroup') return null;
    const id = normalizeId(String(chat.id));
    if (id === mainId) return 'main';
    if (breakIds.has(id)) return 'break';
    return null;
  };

  const bot = new Bot(config.botToken);

  const processMessage = async (m: Message, chat: Chat): Promise<void> => {
    try {
      const kind = groupKind(chat);
      if (!kind) return;

      const incoming: IncomingMessage = {
        messageId: m.message_id,
        text: m.text ?? '',
        dateUnix: m.date,
        chatId: String(chat.id),
        from: m.from
          ? {
              id: m.from.id,
              username: m.from.username,
              firstName: m.from.first_name,
              lastName: m.from.last_name,
            }
          : undefined,
      };

      const changed =
        kind === 'main'
          ? await handleAttendanceMessage(incoming, store, config)
          : await handleBreakMessage(incoming, store, config);

      await store.setLastProcessed(new Date(m.date * 1000).toISOString());
      if (changed) {
        await store.saveStore();
        scheduleExcel();
      }
      await store.saveState();
    } catch (e) {
      log.error('Error handling message', e);
    }
  };

  bot.on('message:text', (ctx) => processMessage(ctx.message, ctx.chat));
  // Count corrected messages too (e.g. someone fixes their login time or break).
  bot.on('edited_message:text', (ctx) => processMessage(ctx.editedMessage, ctx.chat));

  bot.catch((err) => log.error('Bot error', err));

  const stop = async (signal: string): Promise<void> => {
    log.info(`Received ${signal}, shutting down...`);
    try {
      await bot.stop();
      await store.saveStore();
      await store.saveState();
      await exportExcel(config.excelPath, await store.all(), config);
      await store.close();
    } catch (e) {
      log.error('Error during shutdown', e);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));

  const me = await bot.api.getMe();
  log.info(
    `Bot @${me.username} ready. Recording from ${config.recordFromDate}. ` +
      `Main group: ${config.mainGroup}; break groups: ${config.breakGroups.join(', ') || 'none'}. ` +
      `Break allowance: ${config.breakAllowanceMin}m per day.`,
  );

  // Write an initial workbook from whatever is already stored.
  await exportExcel(config.excelPath, await store.all(), config);

  // Long polling: no public URL/webhook needed. drop_pending_updates is false so
  // messages sent while the bot was briefly offline (Telegram keeps them ~24h)
  // are caught up automatically on restart.
  await bot.start({
    drop_pending_updates: false,
    allowed_updates: ['message', 'edited_message'],
    onStart: (info) =>
      log.info(`@${info.username} is live, listening silently across all groups (never posts).`),
  });
}

main().catch((e) => {
  log.error('Fatal error', e);
  process.exit(1);
});
