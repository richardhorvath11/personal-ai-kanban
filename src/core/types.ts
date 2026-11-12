export const STATUSES = ['inbox', 'ready', 'in_progress', 'waiting', 'review', 'done'] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = {
  inbox: 'Inbox', ready: 'Ready', in_progress: 'In progress', waiting: 'Waiting', review: 'Review', done: 'Done',
};
export type Actor = 'user' | 'claude' | 'system' | 'hook';

export interface ChecklistItem { id: string; text: string; done: boolean }
export interface Finding { id: string; text: string; at: string; actor: Actor; sessionId?: string | null }
export interface LinkItem { id: string; url: string; label: string }

export interface Task {
  id: string;
  title: string;
  project: string;
  status: Status;
  outcome: string;
  completionConditions: string[];
  summary: string;
  nextAction: string;
  checklist: ChecklistItem[];
  findings: Finding[];
  links: LinkItem[];
  dependsOn: string[];
  deadline: string | null; // YYYY-MM-DD (date-only) or full ISO datetime
  deadlineKind: 'firm' | 'flexible' | null;
  deadlineTz: string | null;
  deadlineLabel: string;
  priority: 'high' | 'normal' | 'low';
  priorityContext: string;
  pinned: boolean;
  position: number;
  waitingReason: string;
  waitingOn: '' | 'dependency' | 'person' | 'external';
  followUpAt: string | null;
  followUpCondition: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastMeaningfulAt: string;
  lastSyncedAt: string | null;
  revision: number;
}

export interface ActivityEntry {
  id: number;
  taskId: string;
  at: string;
  actor: Actor;
  sessionId: string | null;
  kind: string;
  summary: string;
  changes: Change[];
  sourceNote: string;
  opId: string | null;
  undoOf: number | null;
  undoneBy: number | null;
}

export type Change =
  | { field: string; before: unknown; after: unknown }
  | { field: string; added: unknown[]; removed: unknown[]; modified: { before: unknown; after: unknown }[] };

export interface OpContext {
  actor: Actor;
  sessionId?: string | null;
  sourceNote?: string;
  opId?: string;
}
