/**
 * 端到端逻辑验证（不入产物、不进 tsc include）：
 * v1→v2 升级、乐观锁冲突、优选联动失效与复核重算、旧备份导入。
 * 经 esbuild bundle 后由 node 执行：node scripts/run-verify.mjs
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {
  db,
  DB_SCHEMA_VERSION,
  RevisionConflictError,
  computePickBasis,
  confirmPickRevisioned,
  importSnapshot,
  listPicks,
  listSessions,
  putPick,
  putPick as _putPick,
  saveSessionRevisioned,
  saveTakeRevisioned,
  savePickRevisioned
} from '../src/utils/db';

void _putPick;

let pass = 0;
let fail = 0;
function check(desc: string, cond: boolean): void {
  if (cond) {
    pass += 1;
    console.log('  ✓', desc);
  } else {
    fail += 1;
    console.error('  ✗', desc);
  }
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/* ---------- 1. v1 旧库 → v2 升级 ---------- */
console.log('1) v1 旧库升级到 v2');
{
  const legacy = new Dexie('gbstudiotake-db');
  legacy.version(1).stores({
    projects: 'id, name, client, state, startDate, updatedAt',
    songs: 'id, projectId, title, arrangement, state, updatedAt',
    sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
    takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
    picks: 'id, takeId, usage, order, updatedAt',
    retakes: 'id, songId, planDate, state, updatedAt'
  });
  await legacy.projects.put({
    id: 'p1', name: '旧项目', client: 'c', startDate: '2024-01-01', deliverDate: '', state: '录制中'
  });
  await legacy.songs.put({
    id: 's1', projectId: 'p1', title: '旧曲', durationSec: 10, arrangement: '乐队', state: '录制中'
  });
  await legacy.sessions.put({
    id: 'ss1', songId: 's1', date: '2024-03-01', period: '上午', engineer: '赵鸣',
    roomNo: 'A 棚', musicians: '', state: '已完成'
  });
  await legacy.takes.put({
    id: 't1', sessionId: 'ss1', takeNo: 'T01', startTc: '00:00:10:00', endTc: '00:01:00:00',
    grade: '可用', issues: ['无']
  });
  await legacy.picks.put({ id: 'pk1', takeId: 't1', usage: '主歌', order: 1, note: '旧优选' });
  await legacy.retakes.put({ id: 'r1', songId: 's1', reason: 'x', planDate: '2024-03-02', state: '待安排' });
  legacy.close();

  check('结构版本号为 2', DB_SCHEMA_VERSION === 2);
  await db.open();
  check('db.verno === 2', db.verno === 2);
  const sessions = await listSessions();
  check('旧场次补齐 revision=1', sessions[0].revision === 1);
  check('旧场次补齐时间戳', typeof sessions[0].createdAt === 'number');
  const picks = await listPicks();
  check('旧优选进入待复核区', picks[0].confirmState === '待复核');
  check('旧优选补确认基准签名', picks[0].basis === '00:00:10:00→00:01:00:00@A 棚');
  check('旧优选补 revision=1', picks[0].revision === 1);
  db.close();
  await deleteDb('gbstudiotake-db');
}

/* ---------- 2. 乐观锁冲突 + Take 时间码变更联动失效 ---------- */
console.log('2) 乐观锁保存与优选联动');
{
  await db.open();
  await db.projects.put({
    id: 'p1', name: 'x', client: 'c', startDate: '2024-04-01', deliverDate: '', state: '录制中',
    revision: 1, createdAt: 1, updatedAt: 1
  });
  await db.songs.put({
    id: 's1', projectId: 'p1', title: '曲', durationSec: 1, arrangement: '乐队', state: '录制中',
    revision: 1, createdAt: 1, updatedAt: 1
  });
  await db.sessions.put({
    id: 'ss1', songId: 's1', date: '2024-04-02', period: '上午', engineer: '赵鸣',
    roomNo: 'A 棚', musicians: '', state: '已排期', revision: 1, createdAt: 1, updatedAt: 1
  });
  await db.takes.put({
    id: 't1', sessionId: 'ss1', takeNo: 'T01', startTc: '00:00:01:00', endTc: '00:00:05:00',
    grade: '可用', issues: ['无'], revision: 1, createdAt: 1, updatedAt: 1
  });
  const basis = await computePickBasis('t1');
  await putPick({
    id: 'pk1', takeId: 't1', usage: '主歌', order: 1, note: '',
    confirmState: '已确认', basis: basis ?? '', revision: 1, createdAt: 1, updatedAt: 1
  });

  // 标签 B 先基于 rev=1 保存成功
  await saveTakeRevisioned('t1', { endTc: '00:00:06:00' }, 1);
  const afterB = await db.takes.get('t1');
  check('B 保存成功后 revision=2', afterB?.revision === 2);

  // 标签 A 仍基于旧 rev=1 保存 → 冲突，不写入
  let conflictErr: unknown = null;
  try {
    await saveTakeRevisioned('t1', { endTc: '00:00:09:00' }, 1);
  } catch (e) {
    conflictErr = e;
  }
  check('A 基于旧版本保存抛 RevisionConflictError', conflictErr instanceof RevisionConflictError);
  const afterConflict = await db.takes.get('t1');
  check('冲突时不写入（endTc 仍是 B 的值）', afterConflict?.endTc === '00:00:06:00');
  check('冲突时不推进版本', afterConflict?.revision === 2);

  let picksNow = await listPicks();
  check('时间码变更后关联优选立即失效转待复核', picksNow[0].confirmState === '待复核');
  check('失效优选保留旧 basis 供比对', picksNow[0].basis === '00:00:01:00→00:00:05:00@A 棚');

  // A 用最新版本 rev=2 重试：优选仍待复核
  await saveTakeRevisioned('t1', { endTc: '00:00:09:00' }, 2);
  picksNow = await listPicks();
  check('再次保存时间码，优选仍处于待复核', picksNow[0].confirmState === '待复核');

  // 复核确认：重算基准后转已确认，版本推进
  const stalePick = await db.picks.get('pk1');
  await confirmPickRevisioned('pk1', stalePick!.revision);
  let confirmed = await db.picks.get('pk1');
  check('复核后已确认', confirmed?.confirmState === '已确认');
  check('复核后 basis 按现值重算', confirmed?.basis === '00:00:01:00→00:00:09:00@A 棚');
  check('复核推进优选版本', confirmed?.revision === (stalePick?.revision ?? 0) + 1);

  // 优选自身的乐观锁：再用旧版本保存应冲突
  let pickConflict: unknown = null;
  try {
    await savePickRevisioned('pk1', { note: 'A 的备注' }, stalePick!.revision);
  } catch (e) {
    pickConflict = e;
  }
  check('优选旧版本保存同样冲突', pickConflict instanceof RevisionConflictError);

  /* ---------- 3. 棚号变更联动（通过场次保存） ---------- */
  console.log('3) 棚号变更联动失效');
  const outcome = await saveSessionRevisioned('ss1', { roomNo: 'B 棚' }, 1);
  check('棚号变更返回受影响优选条数=1', outcome.invalidatedPicks === 1);
  confirmed = await db.picks.get('pk1');
  check('棚号变更后优选转待复核', confirmed?.confirmState === '待复核');
  const sess = await db.sessions.get('ss1');
  check('场次保存推进版本', sess?.revision === 2);

  await db.sessions.put({
    id: 'ss2', songId: 's1', date: '2024-04-02', period: '上午', engineer: '何笙',
    roomNo: 'C 棚', musicians: '', state: '已排期', revision: 1, createdAt: 1, updatedAt: 1
  });
  let blocked = false;
  try {
    await saveSessionRevisioned('ss2', { roomNo: 'B 棚' }, 1);
  } catch (e) {
    blocked = e instanceof Error && /已被场次占用/.test(e.message);
  }
  check('同棚同时段冲突被拦截', blocked);
  const ss2 = await db.sessions.get('ss2');
  check('冲突时 ss2 未改动棚号', ss2?.roomNo === 'C 棚');

  /* ---------- 4. 不改时间码/棚号时优选不失效 ---------- */
  console.log('4) 无关字段不联动');
  await confirmPickRevisioned('pk1', confirmed!.revision);
  const revTake = (await db.takes.get('t1'))!.revision;
  await saveTakeRevisioned('t1', { issues: ['噪声'] }, revTake);
  const p = await db.picks.get('pk1');
  check('仅改问题标签，优选保持已确认', p?.confirmState === '已确认');

  db.close();
  await deleteDb('gbstudiotake-db');
}

/* ---------- 5. 排序 / 批量评级不改变确认状态，但推进版本 ---------- */
console.log('5) 排序与批量评级');
{
  const { reorderPicks, bulkUpdateGrade, listPicks } = await import('../src/utils/db');
  await db.open();
  await db.projects.put({
    id: 'p1', name: 'x', client: 'c', startDate: '2024-04-01', deliverDate: '', state: '录制中',
    revision: 1, createdAt: 1, updatedAt: 1
  });
  await db.songs.put({
    id: 's1', projectId: 'p1', title: '曲', durationSec: 1, arrangement: '乐队', state: '录制中',
    revision: 1, createdAt: 1, updatedAt: 1
  });
  await db.sessions.put({
    id: 'ss1', songId: 's1', date: '2024-04-02', period: '上午', engineer: '赵鸣',
    roomNo: 'A 棚', musicians: '', state: '已排期', revision: 1, createdAt: 1, updatedAt: 1
  });
  await db.takes.bulkPut([
    { id: 't1', sessionId: 'ss1', takeNo: 'T01', startTc: '00:00:01:00', endTc: '00:00:05:00', grade: '可用', issues: ['无'], revision: 1, createdAt: 1, updatedAt: 1 },
    { id: 't2', sessionId: 'ss1', takeNo: 'T02', startTc: '00:00:06:00', endTc: '00:00:10:00', grade: '待定', issues: ['无'], revision: 1, createdAt: 1, updatedAt: 1 }
  ]);
  await db.picks.bulkPut([
    { id: 'pk1', takeId: 't1', usage: '主歌', order: 1, note: '', confirmState: '已确认', basis: '00:00:01:00→00:00:05:00@A 棚', revision: 1, createdAt: 1, updatedAt: 1 },
    { id: 'pk2', takeId: 't2', usage: '副歌', order: 2, note: '', confirmState: '待复核', basis: '', revision: 1, createdAt: 1, updatedAt: 1 }
  ]);
  await reorderPicks(['pk2', 'pk1']);
  const afterReorder = await listPicks();
  const pk2 = afterReorder.find((item) => item.id === 'pk2');
  const pk1 = afterReorder.find((item) => item.id === 'pk1');
  check('排序后 pk2 排到 order=1', pk2?.order === 1 && pk1?.order === 2);
  check('排序不改变确认状态', pk2?.confirmState === '待复核' && pk1?.confirmState === '已确认');
  check('排序推进 revision', pk2?.revision === 2 && pk1?.revision === 2);

  await bulkUpdateGrade(['t1', 't2'], '废');
  const t1 = await db.takes.get('t1');
  check('批量改评级生效且推进 revision', t1?.grade === '废' && t1?.revision === 2);
  const pkAfterGrade = await db.picks.get('pk1');
  check('批量改评级不动优选确认状态（评级由候选筛选控制）', pkAfterGrade?.confirmState === '已确认');

  db.close();
  await deleteDb('gbstudiotake-db');
}
/* ---------- 6. 旧备份导入：优选进待复核 ---------- */
console.log('6) 旧版备份导入');
{
  await db.open();
  await importSnapshot({
    name: 'gbstudiotake-db',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    projects: [{ id: 'p1', name: 'x', client: 'c', startDate: '2024-04-01', deliverDate: '', state: '录制中' }],
    songs: [{ id: 's1', projectId: 'p1', title: '曲', durationSec: 1, arrangement: '乐队', state: '录制中' }],
    sessions: [
      {
        id: 'ss1', songId: 's1', date: '2024-04-02', period: '上午', engineer: '赵鸣',
        roomNo: 'A 棚', musicians: '', state: '已排期'
      }
    ],
    takes: [
      {
        id: 't1', sessionId: 'ss1', takeNo: 'T01', startTc: '00:00:01:00', endTc: '00:00:05:00',
        grade: '可用', issues: ['无']
      }
    ],
    picks: [{ id: 'pk1', takeId: 't1', usage: '主歌', order: 1, note: '' }],
    retakes: []
  });
  const picks = await listPicks();
  check('旧备份优选进待复核区', picks[0].confirmState === '待复核');
  check('旧备份优选补 basis', picks[0].basis === '00:00:01:00→00:00:05:00@A 棚');
  check('导入行补 revision=1', picks[0].revision === 1);
  db.close();
  await deleteDb('gbstudiotake-db');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
