import { promises as fs } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { AttendanceRecord } from './types';
import { timeInTz } from './time';
import { evaluateBreaks, breakActualMin, breakOverStatedMin, BreakEvaluation } from './breaks';
import { Config } from './config';

const EXCEEDED_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFC7CE' }, // light red
};

function hoursBetween(loginAt: string | null, logoutAt: string | null): number | null {
  if (!loginAt || !logoutAt) return null;
  const ms = new Date(logoutAt).getTime() - new Date(loginAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Number((ms / 3_600_000).toFixed(2));
}

function evalFor(record: AttendanceRecord, config: Config): BreakEvaluation {
  return evaluateBreaks(
    record.breaks,
    config.breakAllowanceMin,
    config.urgentCountsTowardAllowance,
    config.breakGraceMin,
  );
}

/** Rebuild the whole workbook from the current records (cheap; data set is small). */
export async function exportExcel(
  filePath: string,
  records: AttendanceRecord[],
  config: Config,
): Promise<void> {
  const tz = config.timezone;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Staff Attendance Bot';

  // ── Sheet 1: one row per staff member per day (attendance + break tally) ────
  const logSheet = wb.addWorksheet('Attendance Log');
  logSheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Username', key: 'username', width: 18 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'User ID', key: 'userId', width: 14 },
    { header: 'Login (stated)', key: 'loginStated', width: 15 },
    { header: 'Login (recorded)', key: 'loginRecorded', width: 16 },
    { header: 'Logout (stated)', key: 'logoutStated', width: 15 },
    { header: 'Logout (recorded)', key: 'logoutRecorded', width: 16 },
    { header: 'Hours', key: 'hours', width: 8 },
    { header: 'Net Hours', key: 'netHours', width: 10 },
    { header: 'Breaks', key: 'breakCount', width: 8 },
    { header: 'Break Min', key: 'breakMin', width: 10 },
    { header: 'Allowance', key: 'allowance', width: 10 },
    { header: 'Over (min)', key: 'overMin', width: 10 },
    { header: 'Late (min)', key: 'overStatedMin', width: 12 },
    { header: 'Break Status', key: 'breakStatus', width: 30 },
    { header: 'Break Detail', key: 'breakDetail', width: 28 },
  ];

  for (const r of records) {
    const ev = evalFor(r, config);
    const hours = hoursBetween(r.loginAt, r.logoutAt);
    const netHours = hours != null ? Number((hours - ev.countedMin / 60).toFixed(2)) : null;
    const hasBreaks = r.breaks.length > 0;

    const row = logSheet.addRow({
      date: r.date,
      username: r.username ? '@' + r.username : '',
      name: r.displayName,
      userId: r.userId,
      loginStated: r.loginStated ?? '',
      loginRecorded: r.loginAt ? timeInTz(new Date(r.loginAt), tz) : '',
      logoutStated: r.logoutStated ?? '',
      logoutRecorded: r.logoutAt ? timeInTz(new Date(r.logoutAt), tz) : '',
      hours: hours ?? '',
      netHours: netHours ?? '',
      breakCount: r.breaks.length,
      breakMin: ev.countedMin,
      allowance: ev.allowanceMin,
      overMin: ev.overMin || '',
      overStatedMin: ev.overStatedMin || '',
      breakStatus: hasBreaks ? ev.status : '',
      breakDetail: ev.detail,
    });
    if (hasBreaks && (ev.exceeded || ev.anyOverStated)) {
      row.getCell('breakStatus').fill = EXCEEDED_FILL;
    }
    if (ev.overStatedMin > 0) {
      row.getCell('overStatedMin').fill = EXCEEDED_FILL;
    }
  }
  logSheet.getRow(1).font = { bold: true };
  logSheet.views = [{ state: 'frozen', ySplit: 1 }];
  logSheet.autoFilter = `A1:${logSheet.getColumn(logSheet.columns.length).letter}1`;

  // ── Sheet 2: every individual break ─────────────────────────────────────────
  const breakSheet = wb.addWorksheet('Breaks');
  breakSheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Username', key: 'username', width: 18 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Start', key: 'time', width: 12 },
    { header: 'Returned', key: 'returned', width: 12 },
    { header: 'Stated (min)', key: 'stated', width: 12 },
    { header: 'Actual (min)', key: 'actual', width: 12 },
    { header: 'Late (min)', key: 'overStated', width: 12 },
    { header: 'Type', key: 'type', width: 10 },
    { header: 'Group', key: 'group', width: 18 },
    { header: 'Message', key: 'raw', width: 30 },
  ];
  for (const r of records) {
    for (const b of r.breaks) {
      const actual = breakActualMin(b);
      const over = breakOverStatedMin(b, config.breakGraceMin);
      const row = breakSheet.addRow({
        date: r.date,
        username: r.username ? '@' + r.username : '',
        name: r.displayName,
        time: timeInTz(new Date(b.at), tz),
        returned: b.returnedAt ? timeInTz(new Date(b.returnedAt), tz) : '— still out —',
        stated: b.durationMin,
        actual: actual ?? '',
        overStated: over || '',
        type: b.urgent ? 'urgent' : 'regular',
        group: b.groupId,
        raw: b.raw,
      });
      if (over > 0) {
        row.getCell('overStated').fill = EXCEEDED_FILL;
        row.getCell('actual').fill = EXCEEDED_FILL;
      }
    }
  }
  breakSheet.getRow(1).font = { bold: true };
  breakSheet.views = [{ state: 'frozen', ySplit: 1 }];
  breakSheet.autoFilter = `A1:${breakSheet.getColumn(breakSheet.columns.length).letter}1`;

  // ── Sheet 3: long-term per-staff summary ────────────────────────────────────
  const summary = wb.addWorksheet('Staff Summary');
  summary.columns = [
    { header: 'Username', key: 'username', width: 18 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'User ID', key: 'userId', width: 14 },
    { header: 'Days Present', key: 'days', width: 14 },
    { header: 'Days Completed', key: 'completed', width: 16 },
    { header: 'First Day', key: 'first', width: 12 },
    { header: 'Last Day', key: 'last', width: 12 },
    { header: 'Total Hours', key: 'totalHours', width: 12 },
    { header: 'Total Break Min', key: 'totalBreakMin', width: 16 },
    { header: 'Excess Min', key: 'excessMin', width: 12 },
    { header: 'Late Min', key: 'overStatedMin', width: 12 },
  ];
  const byUser = new Map<string, AttendanceRecord[]>();
  for (const r of records) {
    const list = byUser.get(r.userId) ?? [];
    list.push(r);
    byUser.set(r.userId, list);
  }
  for (const list of byUser.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last = list[list.length - 1];
    const present = list.filter((r) => r.loginAt).length;
    const completed = list.filter((r) => r.loginAt && r.logoutAt).length;
    const totalHours = list.reduce((sum, r) => sum + (hoursBetween(r.loginAt, r.logoutAt) ?? 0), 0);
    const totalBreakMin = list.reduce((sum, r) => sum + evalFor(r, config).countedMin, 0);
    const excessMin = list.reduce((sum, r) => sum + evalFor(r, config).overMin, 0);
    const overStatedMin = list.reduce((sum, r) => sum + evalFor(r, config).overStatedMin, 0);
    const row = summary.addRow({
      username: last.username ? '@' + last.username : '',
      name: last.displayName,
      userId: last.userId,
      days: present,
      completed,
      first: list[0].date,
      last: last.date,
      totalHours: Number(totalHours.toFixed(2)),
      totalBreakMin,
      excessMin,
      overStatedMin,
    });
    if (excessMin > 0) {
      row.getCell('excessMin').fill = EXCEEDED_FILL;
    }
    if (overStatedMin > 0) {
      row.getCell('overStatedMin').fill = EXCEEDED_FILL;
    }
  }
  summary.getRow(1).font = { bold: true };
  summary.views = [{ state: 'frozen', ySplit: 1 }];
  summary.autoFilter = `A1:${summary.getColumn(summary.columns.length).letter}1`;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await wb.xlsx.writeFile(filePath);
}
