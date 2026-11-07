import { localDate, type RecordEvent } from '@workbench/contracts';
import type { Line, Period, Risk } from '../../../packages/contracts/src/management.js';
import { monthCompletion, progressLabels, progressState, riskLevelLabels, type MonthSummary } from '../../../packages/contracts/src/production.js';

export function monthEndSummary(line: Line, month: string, periods: Period[], history: RecordEvent[]): MonthSummary {
  let historyComplete = true;
  const statuses = periods.filter(p => localDate(new Date(p.createdAt)).slice(0, 7) <= month).flatMap(period => {
    const events = history.filter(e => e.resourceId === period.id && localDate(new Date(e.at)).slice(0, 7) <= month).reverse();
    let snapshot: Partial<Period> | undefined;
    for (const event of events) {
      if (event.kind === 'period.created') snapshot = event.details.record as Period;
      if (event.kind === 'period.carried') snapshot = event.details.record as Period | undefined;
      if (event.kind === 'period.updated' && snapshot) {
        const changes = event.details.changes as Record<string, { after: unknown }>;
        snapshot = { ...snapshot, ...Object.fromEntries(Object.entries(changes ?? {}).map(([key, value]) => [key, value.after])) };
      }
    }
    const candidate = snapshot ?? period;
    // A legacy carry without its initial record cannot establish historical ownership or cycle.
    // Flag the affected line even when today's fields place the priority in another month.
    if (!snapshot && period.kind === 'month' && (period.lineId === line.id || history.some(e => {
      const change = (e.details.changes as { lineId?: { before?: string; after?: string } } | undefined)?.lineId;
      return e.resourceId === period.id && (change?.before === line.id || change?.after === line.id);
    }))) historyComplete = false;
    if (candidate.lineId !== line.id || candidate.kind !== 'month' || candidate.start?.slice(0, 7) !== month) return [];
    return [{ status: candidate.status ?? period.status }];
  });
  return { lineId: line.id, lineName: line.name, month, ...monthCompletion(statuses), historyComplete, capturedAt: new Date().toISOString() };
}

export function productionReport(lines: Line[], periods: Period[], risks: Risk[], history: RecordEvent[], start: string, end: string) {
  const periodIds = new Set<string>(); const riskIds = new Set<string>(); const blocks: string[] = [];
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
  for (const line of lines.filter(l => !l.archived)) {
    const weekly = periods.filter(p => p.lineId === line.id && p.kind === 'week' && p.start <= end && p.end >= start && p.status !== 'cancelled');
    const changes: string[] = [];
    for (const risk of risks.filter(r => r.lineIds.includes(line.id))) {
      const events = history.filter(e => e.resourceId === risk.id && localDate(new Date(e.at)) >= start && localDate(new Date(e.at)) <= end);
      if (events.some(e => e.kind === 'risk.created')) { changes.push(`新增：${oneLine(risk.title)}（${riskLevelLabels[risk.level ?? 'medium']}）`); riskIds.add(risk.id); }
      if (events.some(e => e.kind === 'risk.updated' && (e.details.changes as { status?: { after?: string } } | undefined)?.status?.after === 'closed' || e.kind === 'risk.created' && (e.details.record as Risk | undefined)?.status === 'closed')) {
        changes.push(`闭环：${oneLine(risk.title)}`); riskIds.add(risk.id);
      }
    }
    const completed = weekly.filter(p => progressState(p) === 'done').length;
    const rows = weekly.map(p => { periodIds.add(p.id); return `- ${oneLine(p.title)}：${progressLabels[progressState(p)]}${p.actual ? `；${oneLine(p.actual)}` : ''}`; });
    const exceptions = weekly.filter(p => ['blocked', 'at_risk'].includes(progressState(p))).map(p => oneLine(p.title));
    blocks.push(`${oneLine(line.name)}：本周重点完成 ${completed}/${weekly.length}\n${rows.join('\n') || '- 暂无本周重点'}\n受阻／有风险项：${exceptions.join('、') || '无'}\n风险变化：${changes.join('；') || '本期无新增／闭环记录'}`);
  }
  return { text: blocks.length ? `## 产线进展\n\n${blocks.join('\n\n')}` : '', periodIds: [...periodIds], riskIds: [...riskIds] };
}
