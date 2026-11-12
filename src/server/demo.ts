// Demo data. Only ever written into a database stamped mode=demo (see db.ts), so it cannot reach real tasks.
import type { Plugin } from './service.ts';
import { KanbanError } from '../core/errors.ts';
import type { Board } from '../core/board.ts';

export function seedDemo(board: Board) {
  if (board.listTasks({ includeArchived: true, limit: 1 }).length) return { seeded: false, reason: 'board not empty' };
  const ctx = { actor: 'user' as const, sourceNote: 'demo seed' };
  const fri = nextWeekday(5);
  const api = board.createTask({ title: 'Export API: add /export endpoint', project: 'acme-app', status: 'in_progress', outcome: 'Large exports work via the API', completionConditions: ['Endpoint returns CSV for any account size', 'Integration tests pass'], summary: 'API implementation complete. Integration tests passing. Large-export pagination is unresolved.', nextAction: 'Fix pagination, then connect the frontend', priority: 'high' }, ctx).task;
  board.createTask({ title: 'Export button in frontend', project: 'acme-app', status: 'ready', dependsOn: [api.id], deadline: fri, deadlineKind: 'firm', deadlineLabel: "Friday's demo", completionConditions: ['Demo-able end to end'], nextAction: 'Wire the button to /export once the API is ready' }, ctx);
  board.createTask({ title: 'Investigate intermittent test failures', project: 'acme-app', status: 'inbox', priorityContext: '"I should investigate those" (not committed yet)' }, ctx);
  board.createTask({ title: 'Vendor reply on SSO pricing', project: 'ops', status: 'waiting', waitingReason: 'Waiting for vendor quote', waitingOn: 'person', followUpAt: new Date().toISOString().slice(0, 10) }, ctx);
  board.createTask({ title: 'Write release notes', project: 'acme-app', status: 'review', summary: 'Draft ready for your read-through' }, ctx);
  return { seeded: true };
}

function nextWeekday(dow: number): string {
  const d = new Date();
  const add = ((dow - d.getDay() + 7) % 7) || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

export const demoPlugin = (seedOnStart: boolean): Plugin => (svc) => {
  if (svc.config.mode === 'demo') svc.features.push('demo');
  if (seedOnStart) {
    if (svc.config.mode !== 'demo') throw new Error('--seed-demo is only allowed with KANBAN_MODE=demo');
    seedDemo(svc.board);
  }
  return [{
    method: 'POST', pattern: /^\/api\/demo\/seed$/, handler: () => {
      if (svc.config.mode !== 'demo') throw new KanbanError('forbidden', 'Demo data can only be seeded into the demo board (npm run demo). Real tasks are never mixed with demo data.');
      return seedDemo(svc.board);
    },
  }];
};
