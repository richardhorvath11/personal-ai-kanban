import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEntry, Status, Task } from '../core/types.ts';
import { STATUSES, STATUS_LABEL } from '../core/types.ts';
import { api, ApiError } from './api.ts';
import type { Context } from './api.ts';

type View = 'board' | 'next' | 'attention' | 'changes' | 'archive';

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function deadlineText(t: Task): string | null {
  if (!t.deadline) return null;
  const d = t.deadline.length === 10 ? t.deadline : new Date(t.deadline).toLocaleString();
  return `${t.deadlineKind === 'firm' ? 'Due' : 'Target'} ${d}${t.deadlineLabel ? ` · ${t.deadlineLabel}` : ''}`;
}

export function App() {
  const [health, setHealth] = useState<any>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState(() => localStorage.getItem('kanban.project') || '');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('board');
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const features: string[] = health?.features ?? [];

  const notify = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const q: Record<string, string> = {};
      if (project) q.project = project;
      if (query) q.q = query;
      if (view === 'archive') q.archived = 'only';
      const [t, p] = await Promise.all([api.tasks(q), api.projects()]);
      setTasks(t.tasks);
      setProjects(p.projects);
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message);
    }
    try { setHealth(await api.health()); setHealthErr(null); } catch (e) { setHealthErr((e as Error).message); }
  }, [project, query, view]);

  useEffect(() => { void refresh(); const t = window.setInterval(refresh, 5000); return () => window.clearInterval(t); }, [refresh]);
  useEffect(() => { localStorage.setItem('kanban.project', project); }, [project]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') { if (openId) setOpenId(null); else if (creating) setCreating(false); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'n') { e.preventDefault(); setCreating(true); }
      else if (e.key === '?') notify('Keys: n new · / search · arrows move focus · Shift+←/→ move card · Enter open · Esc close · 1-5 views');
      else if ('12345'.includes(e.key)) setView((['board', 'next', 'attention', 'changes', 'archive'] as View[])[Number(e.key) - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, creating, notify]);

  const move = async (t: Task, status: Status) => {
    if (status === t.status) return;
    let extra: Record<string, unknown> = {};
    let patch: Partial<Task> = { status };
    if (status === 'done') {
      const conds = t.completionConditions.length ? `\n\nCompletion conditions:\n- ${t.completionConditions.join('\n- ')}` : '';
      if (!window.confirm(`Mark "${t.title}" as Done?${conds}`)) return;
      extra = { confirmDone: true };
    }
    if (status === 'waiting' && !t.waitingReason) {
      const reason = window.prompt('What is this waiting on?');
      if (!reason) return;
      patch = { status, waitingReason: reason };
    }
    try {
      await api.edit(t.id, t.revision, patch, extra);
      notify(`${t.id} → ${STATUS_LABEL[status]}`);
    } catch (e) { notify((e as Error).message, 'err'); }
    void refresh();
  };

  const tabs: { id: View; label: string; feature?: string }[] = [
    { id: 'board', label: 'Board' },
    { id: 'next', label: 'Pick up next', feature: 'attention' },
    { id: 'attention', label: 'Needs your attention', feature: 'attention' },
    { id: 'changes', label: 'Changed since last visit' },
    { id: 'archive', label: 'Archive' },
  ];

  return (
    <div className="app">
      <header>
        <h1>Personal AI Kanban {health?.mode === 'demo' && <span className="badge demo" title="Demo data lives in a separate database">DEMO DATA</span>}</h1>
        <nav role="tablist" aria-label="Views">
          {tabs.filter((t) => !t.feature || features.includes(t.feature)).map((t, i) => (
            <button key={t.id} role="tab" aria-selected={view === t.id} className={view === t.id ? 'tab active' : 'tab'} onClick={() => setView(t.id)} title={`Key ${i + 1}`}>{t.label}</button>
          ))}
        </nav>
        <div className="filters">
          <label>Project <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project filter">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select></label>
          <input ref={searchRef} type="search" placeholder="Search (/)" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tasks" />
          <button className="primary" onClick={() => setCreating(true)} title="Key n">+ New task</button>
        </div>
      </header>
      <SyncBar health={health} error={healthErr} onRetry={async () => {
        try { const r = await api.post('/api/sync/retry', {}); notify(`Retry: applied ${r.applied}, still pending ${r.pending}`); } catch (e) { notify((e as Error).message, 'err'); }
        void refresh();
      }} />
      {loadErr && <div className="error-state" role="alert"><strong>Board unavailable.</strong> {loadErr}</div>}
      <main>
        {view === 'board' && <BoardView tasks={tasks} onOpen={setOpenId} onMove={move} filtered={!!(project || query)} onCreate={() => setCreating(true)} />}
        {view === 'archive' && <ListView tasks={tasks} onOpen={setOpenId} empty="Nothing archived." />}
        {view === 'next' && <NextView project={project} onOpen={setOpenId} />}
        {view === 'attention' && <AttentionView project={project} onOpen={setOpenId} notify={notify} />}
        {view === 'changes' && <ChangesView onOpen={setOpenId} />}
      </main>
      {creating && <CreateDialog projects={projects} defaultProject={project} onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); notify(`Created ${t.id}`); void refresh(); setOpenId(t.id); }} />}
      {openId && <DetailPanel id={openId} allTasks={tasks} onClose={() => setOpenId(null)} onChanged={refresh} notify={notify} />}
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  );
}

function SyncBar({ health, error, onRetry }: { health: any; error: string | null; onRetry: () => void }) {
  if (error) return <div className="sync bad" role="alert">Board service unreachable: {error}. Claude hooks queue updates locally and retry when it returns.</div>;
  const s = health?.sync;
  if (!s) return null;
  const bad = s.failed > 0 || s.pending > 0 || s.lastError;
  return (
    <div className={`sync ${bad ? 'warn' : 'good'}`} aria-live="polite">
      <span>Sync: {s.pending} pending · {s.failed} need attention · last applied {ago(s.lastAppliedAt)}{s.lastError ? ` · last error: ${s.lastError}` : ''}</span>
      {s.sessions && <span> · {s.sessions.active} active Claude session(s), last checkpoint {ago(s.sessions.lastCheckpointAt)}</span>}
      {bad && <button onClick={onRetry}>Retry now</button>}
    </div>
  );
}

function Card({ t, onOpen, onMove, focusKey }: { t: Task; onOpen: (id: string) => void; onMove: (t: Task, s: Status) => void; focusKey: string }) {
  const idx = STATUSES.indexOf(t.status);
  const dl = deadlineText(t);
  return (
    <article
      className={`card ${t.pinned ? 'pinned' : ''}`}
      tabIndex={0}
      draggable
      data-focus={focusKey}
      data-task-id={t.id}
      aria-label={`${t.id} ${t.title}, ${STATUS_LABEL[t.status]}`}
      onDragStart={(e) => e.dataTransfer.setData('text/task-id', t.id)}
      onClick={() => onOpen(t.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onOpen(t.id); }
        else if (e.shiftKey && e.key === 'ArrowRight' && idx < STATUSES.length - 1) { e.preventDefault(); onMove(t, STATUSES[idx + 1]); }
        else if (e.shiftKey && e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); onMove(t, STATUSES[idx - 1]); }
      }}
    >
      <div className="card-top"><span className="tid">{t.id}</span>{t.pinned && <span className="pin" title="Pinned by you">📌</span>}{t.project && <span className="tag">{t.project}</span>}{t.priority === 'high' && <span className="tag hi">high</span>}</div>
      <h3>{t.title}</h3>
      {t.nextAction && <p className="next"><b>Next:</b> {t.nextAction}</p>}
      {t.status === 'waiting' && t.waitingReason && <p className="waiting"><b>Waiting:</b> {t.waitingReason}{t.followUpAt ? ` (check ${t.followUpAt.slice(0, 10)})` : ''}</p>}
      {dl && <p className={`deadline ${t.deadlineKind}`}>{dl}</p>}
      {t.checklist.length > 0 && <p className="muted">{t.checklist.filter((c) => c.done).length}/{t.checklist.length} checklist</p>}
      <p className="fresh">progress {ago(t.lastMeaningfulAt)}</p>
    </article>
  );
}

function BoardView({ tasks, onOpen, onMove, filtered, onCreate }: { tasks: Task[]; onOpen: (id: string) => void; onMove: (t: Task, s: Status) => void; filtered: boolean; onCreate: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  if (!tasks.length) {
    return <div className="empty"><h2>{filtered ? 'No tasks match this filter.' : 'Your board is empty.'}</h2>
      <p>{filtered ? 'Clear the project filter or search to see everything.' : 'Capture a task with the button below (or press n), or tell Claude about your work in a session with the kanban integration installed.'}</p>
      {!filtered && <button className="primary" onClick={onCreate}>+ New task</button>}</div>;
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.shiftKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const el = document.activeElement as HTMLElement | null;
    const key = el?.dataset.focus;
    if (!key) return;
    const [c, r] = key.split(':').map(Number);
    const tryFocus = (col: number, row: number) => {
      const cards = ref.current?.querySelectorAll<HTMLElement>(`[data-focus^="${col}:"]`);
      if (!cards || !cards.length) return false;
      cards[Math.max(0, Math.min(row, cards.length - 1))].focus();
      return true;
    };
    e.preventDefault();
    if (e.key === 'ArrowDown') tryFocus(c, r + 1);
    else if (e.key === 'ArrowUp') tryFocus(c, r - 1);
    else {
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      for (let col = c + dir; col >= 0 && col < STATUSES.length; col += dir) if (tryFocus(col, r)) break;
    }
  };
  return (
    <div className="board" ref={ref} onKeyDown={onKeyDown}>
      {STATUSES.map((s, ci) => {
        const col = tasks.filter((t) => t.status === s);
        return (
          <section key={s} className="column" aria-label={STATUS_LABEL[s]}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { const id = e.dataTransfer.getData('text/task-id'); const t = tasks.find((x) => x.id === id); if (t) onMove(t, s); }}>
            <h2>{STATUS_LABEL[s]} <span className="count">{col.length}</span></h2>
            {col.map((t, ri) => <Card key={t.id} t={t} onOpen={onOpen} onMove={onMove} focusKey={`${ci}:${ri}`} />)}
            {!col.length && <p className="muted col-empty">—</p>}
          </section>
        );
      })}
    </div>
  );
}

function ListView({ tasks, onOpen, empty }: { tasks: Task[]; onOpen: (id: string) => void; empty: string }) {
  if (!tasks.length) return <div className="empty"><p>{empty}</p></div>;
  return <ul className="list">{tasks.map((t) => <li key={t.id}><button className="link" onClick={() => onOpen(t.id)}>{t.id} · {t.title}</button> <span className="muted">{STATUS_LABEL[t.status]} · {t.project || 'no project'} · updated {ago(t.updatedAt)}</span></li>)}</ul>;
}

function NextView({ project, onOpen }: { project: string; onOpen: (id: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.get(`/api/next?${new URLSearchParams(project ? { project } : {})}`).then(setData, (e) => setErr(e.message)); }, [project]);
  if (err) return <div className="error-state">{err}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="panel-list">
      <h2>What should I pick up next?</h2>
      {data.note && <p className="note">{data.note}</p>}
      {data.conflicts?.map((c: any, i: number) => <p key={i} className="conflict">⚠ {c.message}</p>)}
      {!data.recommendations.length && <div className="empty"><p>No ready or in-progress work that can start right now.</p></div>}
      <ol>{data.recommendations.map((r: any) => (
        <li key={r.task.id}><button className="link" onClick={() => onOpen(r.task.id)}><b>{r.task.id}</b> {r.task.title}</button>
          <div className="why">{r.headline}</div>
          <ul className="reasons">{r.reasons.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></li>
      ))}</ol>
      {data.blocked?.length > 0 && <><h3>Blocked (not recommended as executable)</h3><ul>{data.blocked.map((b: any) => <li key={b.task.id}><button className="link" onClick={() => onOpen(b.task.id)}>{b.task.id} {b.task.title}</button> — {b.reason}</li>)}</ul></>}
    </div>
  );
}

function AttentionView({ project, onOpen, notify }: { project: string; onOpen: (id: string) => void; notify: (t: string, k?: 'ok' | 'err') => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api.get(`/api/attention?${new URLSearchParams(project ? { project } : {})}`).then(setData, (e) => setErr(e.message)), [project]);
  useEffect(() => { void load(); }, [load]);
  if (err) return <div className="error-state">{err}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="panel-list">
      <h2>Needs your attention</h2>
      <p className="muted">Background review last ran {ago(data.lastReviewAt)}. Follow-ups are reminders to check — nothing is sent to anyone automatically.</p>
      {!data.items.length && <div className="empty"><p>Nothing needs your attention right now.</p></div>}
      <ul>{data.items.map((a: any) => (
        <li key={a.id} className={`alert ${a.kind}`}>
          <span className="kind">{a.kindLabel}</span> <button className="link" onClick={() => onOpen(a.taskId)}>{a.taskId}</button> {a.message}
          {a.count > 1 && <span className="muted"> (seen {a.count}×)</span>}
          <button className="small" onClick={async () => { try { await api.post(`/api/alerts/${a.id}/snooze`, { hours: 24 }); notify('Snoozed for 24h'); void load(); } catch (e) { notify((e as Error).message, 'err'); } }}>Snooze 1 day</button>
        </li>
      ))}</ul>
    </div>
  );
}

function ChangesView({ onOpen }: { onOpen: (id: string) => void }) {
  const [since] = useState(() => localStorage.getItem('kanban.lastVisit') || new Date(Date.now() - 86400_000).toISOString());
  const [items, setItems] = useState<ActivityEntry[] | null>(null);
  useEffect(() => {
    api.activity(since).then((r) => setItems(r.activity), () => setItems([]));
    return () => localStorage.setItem('kanban.lastVisit', new Date().toISOString());
  }, [since]);
  if (!items) return <p className="muted">Loading…</p>;
  const byTask = new Map<string, ActivityEntry[]>();
  for (const a of items) byTask.set(a.taskId, [...(byTask.get(a.taskId) ?? []), a]);
  return (
    <div className="panel-list">
      <h2>Changed since your last visit <span className="muted">({new Date(since).toLocaleString()})</span></h2>
      {!items.length && <div className="empty"><p>No changes since then.</p></div>}
      <ul>{[...byTask].map(([id, list]) => (
        <li key={id}><button className="link" onClick={() => onOpen(id)}>{id}</button> — {list.length} change(s)
          <ul>{list.slice(0, 5).map((a) => <li key={a.id}><span className="muted">{ago(a.at)} · {a.actor}{a.sessionId ? ` (${a.sessionId.slice(0, 8)})` : ''}</span> {a.kind === 'checkpoint' ? '✔ ' : ''}{a.summary}</li>)}</ul></li>
      ))}</ul>
    </div>
  );
}

function CreateDialog({ projects, defaultProject, onClose, onCreated }: { projects: string[]; defaultProject: string; onClose: () => void; onCreated: (t: Task) => void }) {
  const [title, setTitle] = useState('');
  const [proj, setProj] = useState(defaultProject);
  const [status, setStatus] = useState<Status>('inbox');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try { const r = await api.create({ title, project: proj, status }); onCreated(r.task); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="New task">
      <form onSubmit={submit}>
        <h2>New task</h2>
        <label>Title <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Project <input list="projects" value={proj} onChange={(e) => setProj(e.target.value)} /></label>
        <datalist id="projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
        <label>Status <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>{STATUSES.filter((s) => s !== 'done' && s !== 'waiting').map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
        {err && <p className="err">{err}</p>}
        <div className="row"><button type="submit" className="primary">Create</button><button type="button" onClick={onClose}>Cancel (Esc)</button></div>
      </form>
    </div>
  );
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function DetailPanel({ id, allTasks, onClose, onChanged, notify }: { id: string; allTasks: Task[]; onClose: () => void; onChanged: () => void; notify: (t: string, k?: 'ok' | 'err') => void }) {
  const [ctx, setCtx] = useState<Context | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Task> & { completionText?: string }>({});
  const [conflict, setConflict] = useState<string | null>(null);
  const [newFinding, setNewFinding] = useState('');
  const [newCheck, setNewCheck] = useState('');
  const [newLink, setNewLink] = useState('');
  const load = useCallback(async () => {
    try { const c = await api.context(id); setCtx(c); setErr(null); } catch (e) { setErr((e as Error).message); }
  }, [id]);
  useEffect(() => { setDraft({}); setConflict(null); void load(); }, [load]);
  const t = ctx?.task;
  const dirty = Object.keys(draft).length > 0;
  const val = <K extends keyof Task>(k: K): Task[K] => (k in draft ? (draft as Task)[k] : t![k]);

  const save = async (patch: Partial<Task>, extra: Record<string, unknown> = {}, msg = 'Saved') => {
    if (!t) return;
    try {
      await api.edit(t.id, t.revision, patch, extra);
      setDraft({}); setConflict(null); notify(msg); await load(); onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') setConflict(e.message);
      else notify((e as Error).message, 'err');
    }
  };
  const saveDraft = () => {
    const { completionText, ...patch } = draft;
    if (completionText !== undefined) (patch as Partial<Task>).completionConditions = lines(completionText);
    const extra: Record<string, unknown> = {};
    if (patch.status === 'done') { if (!window.confirm('Mark as Done? Check the completion conditions are satisfied.')) return; extra.confirmDone = true; }
    return save(patch, extra);
  };

  if (err) return <aside className="detail" aria-label="Task detail"><button className="close" onClick={onClose}>✕</button><p className="err">{err}</p></aside>;
  if (!t || !ctx) return <aside className="detail" aria-label="Task detail"><p className="muted">Loading…</p></aside>;
  const set = (k: keyof Task | 'completionText') => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <aside className="detail" aria-label={`Task ${t.id} detail`} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && dirty) { e.preventDefault(); void saveDraft(); } }}>
      <div className="detail-head">
        <span className="tid">{t.id} · rev {t.revision}</span>
        <button className="close" onClick={onClose} aria-label="Close detail (Esc)">✕</button>
      </div>
      {conflict && <div className="conflict" role="alert">{conflict} <button onClick={() => { setDraft({}); setConflict(null); void load(); }}>Load latest (discard my edits)</button></div>}
      {t.archived && <div className="note">Archived. <button onClick={() => save({ archived: false }, {}, 'Restored')}>Restore</button></div>}
      <label className="title-edit">Title <input value={val('title')} onChange={set('title')} /></label>
      <div className="grid2">
        <label>Status <select value={val('status')} onChange={set('status')}>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
        <label>Project <input value={val('project')} onChange={set('project')} /></label>
        <label>Priority <select value={val('priority')} onChange={set('priority')}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
        <label className="check"><input type="checkbox" checked={val('pinned')} onChange={(e) => setDraft((d) => ({ ...d, pinned: e.target.checked }))} /> Pinned (my explicit priority)</label>
        <label>Deadline <input type="date" value={(val('deadline') || '').slice(0, 10)} onChange={(e) => setDraft((d) => ({ ...d, deadline: e.target.value || null }))} /></label>
        <label>Deadline type <select value={val('deadlineKind') || ''} onChange={(e) => setDraft((d) => ({ ...d, deadlineKind: (e.target.value || null) as Task['deadlineKind'] }))}><option value="">—</option><option value="firm">Firm</option><option value="flexible">Flexible</option></select></label>
        <label>Deadline label <input value={val('deadlineLabel')} onChange={set('deadlineLabel')} placeholder="e.g. Friday demo" /></label>
        <label>Follow-up date <input type="date" value={(val('followUpAt') || '').slice(0, 10)} onChange={(e) => setDraft((d) => ({ ...d, followUpAt: e.target.value || null }))} /></label>
      </div>
      {t.deadlineTz && <p className="muted">Deadline time zone: {t.deadlineTz}</p>}
      <label>Next action <input value={val('nextAction')} onChange={set('nextAction')} /></label>
      <label>Current summary <textarea rows={3} value={val('summary')} onChange={set('summary')} /></label>
      <label>Desired outcome <textarea rows={2} value={val('outcome')} onChange={set('outcome')} /></label>
      <label>Completion conditions (one per line) <textarea rows={3} value={draft.completionText ?? t.completionConditions.join('\n')} onChange={set('completionText')} /></label>
      <label>Priority context <input value={val('priorityContext')} onChange={set('priorityContext')} /></label>
      {(val('status') === 'waiting' || t.waitingReason) && <div className="grid2">
        <label>Waiting reason <input value={val('waitingReason')} onChange={set('waitingReason')} /></label>
        <label>Waiting on <select value={val('waitingOn')} onChange={set('waitingOn')}><option value="">—</option><option value="dependency">Dependency</option><option value="person">Person</option><option value="external">External event</option></select></label>
      </div>}
      <div className="row sticky">
        <button className="primary" disabled={!dirty} onClick={() => void saveDraft()}>Save (Ctrl+Enter)</button>
        {dirty && <button onClick={() => setDraft({})}>Discard</button>}
        {!t.archived && <button onClick={() => save({ archived: true }, {}, 'Archived — restore from Archive view or undo')}>Archive</button>}
      </div>

      <h3>Checklist</h3>
      <ul className="checklist">{t.checklist.map((c) => (
        <li key={c.id}><label className="check"><input type="checkbox" checked={c.done} onChange={() => save({ checklist: t.checklist.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)) })} /> {c.text}</label>
          <button className="small" aria-label={`Remove checklist item ${c.text}`} onClick={() => save({ checklist: t.checklist.filter((x) => x.id !== c.id) })}>✕</button></li>
      ))}</ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (newCheck.trim()) { void save({ checklist: [...t.checklist, { id: '', text: newCheck.trim(), done: false }] }); setNewCheck(''); } }}>
        <input placeholder="Add checklist item" value={newCheck} onChange={(e) => setNewCheck(e.target.value)} aria-label="New checklist item" /><button type="submit">Add</button>
      </form>

      <h3>Findings</h3>
      <ul className="findings">{t.findings.map((f) => (
        <li key={f.id}>{f.text} <span className="muted">— {f.actor}{f.sessionId ? ` ${f.sessionId.slice(0, 8)}` : ''}, {ago(f.at)}</span>
          <button className="small" aria-label="Remove finding" onClick={() => save({}, { removeFindingIds: [f.id] }, 'Finding removed (undo available)')}>✕</button></li>
      ))}</ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (newFinding.trim()) { void save({}, { addFindings: [newFinding.trim()] }, 'Finding added'); setNewFinding(''); } }}>
        <input placeholder="Add a finding / manual note" value={newFinding} onChange={(e) => setNewFinding(e.target.value)} aria-label="New finding" /><button type="submit">Add</button>
      </form>

      <h3>Links</h3>
      <ul>{t.links.map((l) => <li key={l.id}><a href={l.url} target="_blank" rel="noreferrer noopener">{l.label || l.url}</a> <button className="small" onClick={() => save({ links: t.links.filter((x) => x.id !== l.id) })}>✕</button></li>)}</ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (newLink.trim()) { void save({ links: [...t.links, { id: '', url: newLink.trim(), label: '' }] }); setNewLink(''); } }}>
        <input placeholder="PR / artifact URL" value={newLink} onChange={(e) => setNewLink(e.target.value)} aria-label="New link" /><button type="submit">Add</button>
      </form>

      <h3>Dependencies</h3>
      <ul>{ctx.dependencies.map((d) => <li key={d.id}>{d.done ? '✅' : '⏳'} {d.id} {d.title} <span className="muted">({d.status ? STATUS_LABEL[d.status as Status] : 'missing'})</span> <button className="small" onClick={() => save({ dependsOn: t.dependsOn.filter((x) => x !== d.id) })}>✕</button></li>)}</ul>
      {ctx.dependents.length > 0 && <p className="muted">Unblocks: {ctx.dependents.map((d) => `${d.id} ${d.title}`).join(', ')}</p>}
      <select aria-label="Add dependency" value="" onChange={(e) => e.target.value && save({ dependsOn: [...t.dependsOn, e.target.value] })}>
        <option value="">+ Depends on…</option>
        {allTasks.filter((x) => x.id !== t.id && !t.dependsOn.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.id} {x.title}</option>)}
      </select>

      <details className="activity" open>
        <summary>Activity history ({ctx.recentActivity.length})</summary>
        <ul>{ctx.recentActivity.map((a) => (
          <li key={a.id} className={a.undoneBy ? 'undone' : ''}>
            <span className="muted">#{a.id} {new Date(a.at).toLocaleString()} · {a.actor}{a.sessionId ? ` · session ${a.sessionId.slice(0, 8)}` : ''}</span>
            <div>{a.kind === 'checkpoint' ? '✔ Checkpoint: ' : ''}{a.summary}{a.sourceNote ? <em> — “{a.sourceNote}”</em> : null}</div>
            {a.undoneBy ? <span className="muted">undone by #{a.undoneBy}</span> : a.kind !== 'undo' && (a.changes.length > 0 || a.kind === 'created') && (
              <button className="small" onClick={async () => {
                try { const r = await api.undo(t.id, a.id); notify(`Undid #${a.id}: ${r.reverted.join(', ')}${r.skipped.length ? `; kept newer ${r.skipped.map((s) => s.field).join(', ')}` : ''}`); await load(); onChanged(); }
                catch (e) { notify((e as Error).message, 'err'); }
              }}>Undo</button>
            )}
          </li>
        ))}</ul>
      </details>
      <p className="muted">Created {new Date(t.createdAt).toLocaleString()} · last meaningful progress {ago(t.lastMeaningfulAt)} · last sync {ago(t.lastSyncedAt)}</p>
    </aside>
  );
}
