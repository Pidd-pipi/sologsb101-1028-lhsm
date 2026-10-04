/**
 * 修订保存 / 级联失效 / v1→v2 迁移的逻辑验证（fake-indexeddb 内存库，不进构建产物）。
 * 运行：npx tsx scripts/verify-revision.ts
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {
  db,
  DB_NAME,
  saveTakeRevision,
  saveSessionRevision,
  savePickRevision,
  confirmPickRevision,
  insertPick,
  reorderPicksRevision,
  type SessionRow,
  type TakeRow,
  type PickRow
} from '../src/utils/db';
import { isRevisionConflict } from '../src/utils/concurrency';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function seedV1Database(): Promise<void> {
  // 用独立 Dexie 实例造一个 v1 旧库（无 editVersion / reviewState）
  const legacy = new Dexie(DB_NAME);
  legacy.version(1).stores({
    projects: 'id, name, client, state, startDate, updatedAt',
    songs: 'id, projectId, title, arrangement, state, updatedAt',
    sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
    takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
    picks: 'id, takeId, usage, order, updatedAt',
    retakes: 'id, songId, planDate, state, updatedAt'
  });
  await legacy.table('projects').put({
    id: 'p1',
    name: '旧项目',
    client: 'c',
    startDate: '2024-01-01',
    deliverDate: '2024-02-01',
    state: '录制中',
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  });
  await legacy.table('songs').put({
    id: 's1',
    projectId: 'p1',
    title: '旧曲',
    durationSec: 100,
    arrangement: '乐队',
    state: '录制中',
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  });
  await legacy.table('sessions').put({
    id: 'ss1',
    songId: 's1',
    date: '2024-03-12',
    period: '上午',
    engineer: '赵鸣',
    roomNo: 'A 棚',
    musicians: '',
    state: '已排期',
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  });
  await legacy.table('takes').put({
    id: 'tk1',
    sessionId: 'ss1',
    takeNo: 'T01',
    startTc: '00:00:10:00',
    endTc: '00:01:00:00',
    grade: '可用',
    issues: ['无'],
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  });
  await legacy.table('picks').put({
    id: 'pk1',
    takeId: 'tk1',
    usage: '主歌',
    order: 1,
    note: '',
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  });
  await legacy.close();
}

async function main(): Promise<void> {
  console.log('① v1→v2 升级：旧数据补版本并进待复核区');
  await seedV1Database();
  await db.open();

  const session = (await db.sessions.get('ss1')) as SessionRow;
  const take = (await db.takes.get('tk1')) as TakeRow;
  const pick = (await db.picks.get('pk1')) as PickRow;
  assert(session.editVersion === 1, '场次 editVersion=1');
  assert(session.reviewState === '待复核', '旧场次进待复核区');
  assert(take.reviewState === '待复核', '旧 Take 进待复核区');
  assert(pick.reviewState === '待复核', '旧优选进待复核区');
  assert(pick.srcStartTc === '00:00:10:00', '旧优选水合来源起始时间码快照');
  assert(pick.srcRoomNo === 'A 棚', '旧优选水合来源棚号快照');

  console.log('② 待复核优选确认前不进入剪接清单（页面派生规则：仅已确认纳入）');
  const confirmedOnly = (await db.picks.toArray()).filter((row) => row.reviewState === '已确认');
  assert(confirmedOnly.length === 0, '确认前剪接清单为空');
  await confirmPickRevision('pk1', 1);
  const pickAfter = (await db.picks.get('pk1')) as PickRow;
  assert(pickAfter.reviewState === '已确认', '确认后优选已确认');
  assert(pickAfter.editVersion === 2, '确认推进 editVersion → 2');

  console.log('③ Take 时间码变化：受影响优选立即失效重算');
  const { invalidatedPicks } = await saveTakeRevision(
    'tk1',
    {
      sessionId: 'ss1',
      takeNo: 'T01',
      startTc: '00:00:20:00',
      endTc: '00:01:10:00',
      grade: '可用',
      issues: ['无']
    },
    take
  );
  assert(invalidatedPicks === 1, '级联失效 1 条优选');
  const pickInvalid = (await db.picks.get('pk1')) as PickRow;
  assert(pickInvalid.reviewState === '待复核', '优选回到待复核');
  assert(pickInvalid.srcStartTc === '00:00:20:00', '优选快照已按最新 Take 重算');
  assert(pickInvalid.reviewReason.includes('起始时间码'), '失效原因记录时间码变化');
  const takeV2 = (await db.takes.get('tk1')) as TakeRow;
  assert(takeV2.editVersion === 2, 'Take editVersion → 2');

  console.log('④ 乐观锁：用落后已读版本保存被拦截，不写新版本');
  let blocked = false;
  try {
    await saveTakeRevision(
      'tk1',
      {
        sessionId: 'ss1',
        takeNo: 'T77',
        startTc: '00:00:20:00',
        endTc: '00:01:10:00',
        grade: '废',
        issues: ['无']
      },
      take // v1 快照
    );
  } catch (error) {
    blocked = isRevisionConflict(error);
    if (isRevisionConflict(error)) {
      assert(error.latestVersion === 2, '冲突携带最新版本号 v2');
      const fields = error.fields;
      const labels = fields.map((field) => field.label);
      assert(labels.includes('起始时间码'), '冲突字段含被别人改过的起始时间码');
      assert(labels.includes('结束时间码'), '冲突字段含被别人改过的结束时间码');
      assert(!labels.includes('Take 号'), '只被我自己改的 Take 号不产生冲突行（输入由弹窗保留）');
      const startField = fields.find((field) => field.label === '起始时间码');
      assert(
        startField?.base === '00:00:10:00' && startField.mine === '00:00:20:00' && startField.latest === '00:00:20:00',
        '冲突行三方并列：已读 v1 值 / 我的输入 / 最新值'
      );
      assert(!labels.includes('评级'), '评级双方一致，不算冲突');
    }
  }
  assert(blocked, '落后版本保存抛 RevisionConflictError');
  const takeUnchanged = (await db.takes.get('tk1')) as TakeRow;
  assert(takeUnchanged.takeNo === 'T01' && takeUnchanged.grade === '可用', '被拦截后库内数据未被覆盖');
  assert(takeUnchanged.editVersion === 2, '版本号未推进');

  console.log('⑤ 场次棚号变化：该场次全部 Take 的优选失效');
  // 先重新确认优选
  await confirmPickRevision('pk1', (await db.picks.get('pk1')).editVersion);
  const sessionResult = await saveSessionRevision(
    'ss1',
    {
      songId: 's1',
      date: '2024-03-12',
      period: '上午',
      engineer: '赵鸣',
      roomNo: 'B 棚',
      musicians: '',
      state: '已排期'
    },
    session
  );
  assert(sessionResult.invalidatedPicks === 1, '场次棚号变化失效 1 条优选');
  const pickByRoom = (await db.picks.get('pk1')) as PickRow;
  assert(pickByRoom.reviewState === '待复核', '优选因棚号变化待复核');
  assert(pickByRoom.srcRoomNo === 'B 棚', '优选棚号快照重算为 B 棚');
  assert(pickByRoom.reviewReason.includes('棚号'), '失效原因记录棚号变化');

  console.log('⑥ 新建优选写入即确认；拖拽排序走乐观锁');
  await db.takes.put({
    id: 'tk2',
    sessionId: 'ss1',
    takeNo: 'T02',
    startTc: '00:02:00:00',
    endTc: '00:03:00:00',
    grade: '可用',
    issues: ['无'],
    revision: 2,
    editVersion: 1,
    reviewState: '已确认',
    reviewReason: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  const newId = await insertPick({ takeId: 'tk2', usage: '副歌', note: 'x', order: 2 });
  const newPick = (await db.picks.get(newId)) as PickRow;
  assert(newPick.reviewState === '已确认', '新优选直接已确认');
  assert(newPick.srcStartTc === '00:02:00:00', '新优选快照来自最新 Take');

  // pk1 当前待复核；把两条排序：用最新版本应成功
  const pk1Version = (await db.picks.get('pk1')).editVersion;
  await reorderPicksRevision([
    { id: 'pk1', baseVersion: pk1Version, order: 2 },
    { id: newId, baseVersion: 1, order: 1 }
  ]);
  assert((await db.picks.get(newId)).order === 1, 'tk2 优选顺序提到 1');

  // 用落后版本重排，整体回滚
  let reorderBlocked = false;
  try {
    await reorderPicksRevision([
      { id: 'pk1', baseVersion: 1, order: 9 },
      { id: newId, baseVersion: 2, order: 8 }
    ]);
  } catch (error) {
    reorderBlocked = isRevisionConflict(error);
  }
  assert(reorderBlocked, '落后版本排序被拦截');
  assert((await db.picks.get(newId)).order === 1, '排序拦截后顺序保持不变');

  console.log('⑦ 优选换条次：重算快照并直接确认；改备注不改变复核状态');
  const pk1Latest = (await db.picks.get('pk1')) as PickRow;
  await savePickRevision(
    'pk1',
    { id: 'pk1', takeId: 'tk2', usage: '全曲', order: pk1Latest.order, note: '换到 T02' },
    pk1Latest
  );
  const switched = (await db.picks.get('pk1')) as PickRow;
  assert(switched.takeId === 'tk2', '优选已换到 tk2');
  assert(switched.reviewState === '已确认', '换条次后重算快照并确认');
  assert(switched.srcStartTc === '00:02:00:00', '换条次后快照刷新');

  console.log('\n全部通过 ✅');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
