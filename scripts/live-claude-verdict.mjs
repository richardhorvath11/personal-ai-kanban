// Evaluate the live run artifacts. Prints PASS/FAIL per scenario with evidence; exit 1 on any FAIL.
import fs from 'node:fs';
import path from 'node:path';
const [out, t1, t2, sid, rc1, rc2] = process.argv.slice(2);
const j = (f) => { try { return JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); } catch { return null; } };
const t1a = j('t1-after-turn1.json'), t2a = j('t2-after-turn1.json'), t1f = j('t1-final.json'), t2f = j('t2-final.json');
const events = (() => { try { return fs.readFileSync(path.join(out, 'hook-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } })();
const turn1 = j('turn1.json'), turn2 = j('turn2.json');
const cps = (ctx, s) => (ctx?.recentActivity ?? []).filter((a) => a.kind === 'checkpoint' && a.actor === 'claude' && (!s || a.sessionId === s));
const results = [];
const check = (name, pass, evidence) => results.push({ name, pass, evidence });
if (Number(rc1) !== 0) check('claude turn 1 ran', false, `exit ${rc1}: ${fs.readFileSync(path.join(out, 'turn1.err'), 'utf8').slice(0, 400)} ${JSON.stringify(turn1)?.slice(0, 400)}`);
const ev = (e) => events.filter((x) => x.event === e && x.sessionId === sid);
check('hooks fired in live session', ev('session-start').length > 0 && ev('stop').length > 0, `session-start ×${ev('session-start').length}, post-tool-use ×${ev('post-tool-use').length}, stop ×${ev('stop').length}, session-end ×${ev('session-end').length}`);
const c1 = cps(t1a, sid);
check('Automatic checkpoint', c1.length > 0, c1.length ? `T1 checkpoint(s) by claude in session ${sid}: ${c1.map((a) => `"${a.summary}"`).join(' | ')}; nextAction now "${t1a.task.nextAction}"` : `no claude checkpoint on ${t1}; stop outcomes: ${ev('stop').map((e) => e.outcome).join(' || ')}`);
const nudged = ev('stop').some((e) => e.outcome.includes('Kanban board check'));
check('(info) checkpoint triggered by', true, nudged ? 'Stop-hook nudge was emitted at least once' : 'session instructions alone (no Stop nudge needed)');
const t1cpTurn1 = cps(t1a, sid).length, t1cpFinal = cps(t1f, sid).length;
const c2 = cps(t2f, sid);
check('Task switching', Number(rc2) === 0 && c2.length > 0 && t1cpFinal === t1cpTurn1 && cps(t2a, sid).length === 0,
  `turn2 exit ${rc2}; T2 checkpoints ${c2.length} (${c2.map((a) => `"${a.summary}"`).join(' | ')}); T1 checkpoints before/after switch ${t1cpTurn1}/${t1cpFinal}`);
const statuses = [t1f?.task?.status, t2f?.task?.status];
const doneWithoutEvidence = [t1f, t2f].some((c) => c?.task?.status === 'done' && !c.task.findings.some((f) => f.text.startsWith('Completion evidence:')));
check('Safe completion', !statuses.includes(undefined) && !doneWithoutEvidence && !statuses.every((s) => s === 'done'),
  `final statuses ${t1}=${statuses[0]}, ${t2}=${statuses[1]} after ${ev('stop').length} Stop and ${ev('session-end').length} SessionEnd event(s)`);
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}: ${r.evidence}`);
if (turn1?.total_cost_usd !== undefined) console.log(`(claude reported total_cost_usd for turn1: ${turn1.total_cost_usd}; turn2: ${turn2?.total_cost_usd}) — subscription login, no API key set`);
process.exit(results.some((r) => !r.pass) ? 1 : 0);
