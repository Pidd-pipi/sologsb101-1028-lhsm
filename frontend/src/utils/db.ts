/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbstudiotake-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 项目 / 曲目 / 场次 / Take / 优选 / 补录 六张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 场次 / Take / 优选走「修订保存」：editVersion 乐观锁 + 复核状态，
 *   Take 时间码或棚号变化在同一事务内级联失效受影响优选
 */
import Dexie, { type Table } from 'dexie';
import type { Project } from '../types/project';
import type { Song } from '../types/song';
import type { Session } from '../types/session';
import type { Take } from '../types/take';
import type { Pick } from '../types/pick';
import type { Retake } from '../types/retake';
import type { RevisionFields } from '../types/revision';
import { nowIso, createId } from './uuid';
import { seedDatabase } from './seed';
import { ROW_REVISION } from './revision';
import { RevisionConflictError, diffConflict } from './concurrency';

/** 数据库名 */
export const DB_NAME = 'gbstudiotake-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号（定义在叶子模块 ./revision，避免与 ./seed 形成循环依赖） */
export { ROW_REVISION };

export interface Revisioned {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 优选行上的派生快照：确认优选时记录被选 Take 的时间码与所属场次棚号。
 * 之后只要快照与最新来源不一致，就说明优选依据已变（Take 改时间码 / 换棚 / 换场次）。
 */
export interface PickSnapshotFields {
  srcStartTc: string;
  srcEndTc: string;
  srcRoomNo: string;
  srcSessionId: string;
}

export type ProjectRow = Project & Revisioned;
export type SongRow = Song & Revisioned;
export type SessionRow = Session & Revisioned & RevisionFields;
export type TakeRow = Take & Revisioned & RevisionFields;
export type PickRow = Pick & Revisioned & RevisionFields & PickSnapshotFields;
export type RetakeRow = Retake & Revisioned;

export class GbStudioTakeDatabase extends Dexie {
  projects!: Table<ProjectRow, string>;
  songs!: Table<SongRow, string>;
  sessions!: Table<SessionRow, string>;
  takes!: Table<TakeRow, string>;
  picks!: Table<PickRow, string>;
  retakes!: Table<RetakeRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史库保留原声明，Dexie 按版本顺序逐级升级）
    this.version(1).stores({
      projects: 'id, name, client, state, startDate, updatedAt',
      songs: 'id, projectId, title, arrangement, state, updatedAt',
      sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
      takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
      picks: 'id, takeId, usage, order, updatedAt',
      retakes: 'id, songId, planDate, state, updatedAt'
    });

    // v2：场次 / Take / 优选接入修订保存（editVersion 乐观锁 + reviewState 复核区 + 优选来源快照）
    this.version(2)
      .stores({
        sessions: 'id, songId, date, period, roomNo, engineer, state, reviewState, updatedAt',
        takes: 'id, sessionId, takeNo, grade, reviewState, startTc, updatedAt',
        picks: 'id, takeId, usage, order, reviewState, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const plainTables = ['projects', 'songs', 'retakes'];
        for (const name of plainTables) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }

        // 旧业务数据升级：补修订版本号并进「待复核区」，原有页面仍可查看编辑
        const upgradeReviewed = async (
          tableName: 'sessions' | 'takes',
          reason: string
        ): Promise<void> => {
          await tx
            .table<SessionRow | TakeRow, string>(tableName)
            .toCollection()
            .modify((row) => {
              row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              row.updatedAt = Date.now();
              row.editVersion = 1;
              row.reviewState = '待复核';
              row.reviewReason = reason;
            });
        };
        await upgradeReviewed('sessions', '旧数据升级：场次信息需复核后再用于次日排期');
        await upgradeReviewed('takes', '旧数据升级：Take 时间码与评级需复核确认');

        // 优选补齐来源快照与复核状态；快照依据当时的 Take / 场次现取
        const sessionRows = await tx.table<SessionRow, string>('sessions').toArray();
        const takeRows = await tx.table<TakeRow, string>('takes').toArray();
        await tx
          .table<PickRow, string>('picks')
          .toCollection()
          .modify((pick) => {
            pick.revision = ROW_REVISION;
            if (typeof pick.createdAt !== 'number') pick.createdAt = Date.now();
            pick.updatedAt = Date.now();
            pick.editVersion = 1;
            const take = takeRows.find((item) => item.id === pick.takeId);
            const session = take ? sessionRows.find((item) => item.id === take.sessionId) : undefined;
            pick.srcStartTc = take?.startTc ?? '';
            pick.srcEndTc = take?.endTc ?? '';
            pick.srcRoomNo = session?.roomNo ?? '';
            pick.srcSessionId = take?.sessionId ?? '';
            pick.reviewState = '待复核';
            pick.reviewReason = '旧数据升级：优选依据需复核确认后才进入剪接清单';
          });
      });
  }
}

export const db = new GbStudioTakeDatabase();

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.projects.count()) === 0) {
    await seedDatabase(db);
  }
}

/* ------------------------------ 项目 ------------------------------ */

export async function listProjects(): Promise<ProjectRow[]> {
  const rows = await db.projects.toArray();
  return rows.sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export async function putProject(row: ProjectRow): Promise<void> {
  await db.projects.put(row);
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<void> {
  await db.projects.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 删除项目：级联删除曲目、场次、Take、优选与补录 */
export async function removeProject(id: string): Promise<void> {
  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    const songs = await db.songs.where('projectId').equals(id).toArray();
    for (const song of songs) {
      await cascadeRemoveSong(song.id);
    }
    await db.projects.delete(id);
  });
}

/* ------------------------------ 曲目 ------------------------------ */

export async function listSongs(): Promise<SongRow[]> {
  const rows = await db.songs.toArray();
  return rows.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

export async function putSong(row: SongRow): Promise<void> {
  await db.songs.put(row);
}

export async function updateSong(id: string, patch: Partial<Song>): Promise<void> {
  await db.songs.update(id, { ...patch, updatedAt: Date.now() } as never);
}

async function cascadeRemoveSong(songId: string): Promise<void> {
  const sessions = await db.sessions.where('songId').equals(songId).toArray();
  const sessionIds = sessions.map((item) => item.id);
  if (sessionIds.length > 0) {
    const takes = await db.takes.where('sessionId').anyOf(sessionIds).toArray();
    const takeIds = takes.map((item) => item.id);
    if (takeIds.length > 0) {
      await db.picks.where('takeId').anyOf(takeIds).delete();
    }
    await db.takes.where('sessionId').anyOf(sessionIds).delete();
    await db.sessions.where('songId').equals(songId).delete();
  }
  await db.retakes.where('songId').equals(songId).delete();
  await db.songs.delete(songId);
}

export async function removeSong(id: string): Promise<void> {
  await db.transaction('rw', [db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await cascadeRemoveSong(id);
  });
}

/* ------------------------------ 场次 ------------------------------ */

export async function listSessions(): Promise<SessionRow[]> {
  const rows = await db.sessions.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putSession(row: SessionRow): Promise<void> {
  await db.sessions.put(row);
}

/** 场次参与乐观锁比对的业务字段 */
const SESSION_DIFF_KEYS: Array<{ key: keyof Session; label: string }> = [
  { key: 'songId', label: '曲目' },
  { key: 'date', label: '日期' },
  { key: 'period', label: '时段' },
  { key: 'roomNo', label: '棚号' },
  { key: 'engineer', label: '录音师' },
  { key: 'musicians', label: '参与乐手' },
  { key: 'state', label: '状态' }
];

/**
 * 修订保存场次：保存前比对已读版本，落后则抛 RevisionConflictError（整笔回滚、不写新版本）。
 * 棚号变化时，该场次下全部 Take 的优选立即失效重算，确认前不进入剪接清单。
 * @returns 本次保存级联失效的优选条数
 */
export async function saveSessionRevision(
  id: string,
  values: Omit<Session, 'id'>,
  base: SessionRow
): Promise<{ invalidatedPicks: number }> {
  return db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const current = await db.sessions.get(id);
    if (!current) throw new Error('场次不存在或已被其他标签页删除');
    if (current.editVersion !== base.editVersion) {
      throw new RevisionConflictError(
        id,
        current.editVersion,
        diffConflict(current, base, values, SESSION_DIFF_KEYS)
      );
    }

    let invalidatedPicks = 0;
    if (values.roomNo !== current.roomNo) {
      const takes = await db.takes.where('sessionId').equals(id).toArray();
      for (const take of takes) {
        const affected = await invalidatePicksOfTake(
          { id: take.id },
          `所属场次棚号由 ${current.roomNo} 改为 ${values.roomNo}`,
          { srcRoomNo: values.roomNo, srcSessionId: id }
        );
        invalidatedPicks += affected;
      }
    }

    const now = Date.now();
    await db.sessions.put({
      ...current,
      ...values,
      editVersion: current.editVersion + 1,
      updatedAt: now
    });
    return { invalidatedPicks };
  });
}

/** 复核确认场次（同样走乐观锁，防止确认的是别人正在改的旧版本） */
export async function confirmSessionRevision(id: string, baseVersion: number): Promise<void> {
  await confirmReviewedRow(db.sessions, id, baseVersion);
}

/**
 * 校验棚号时段冲突：同一棚号同一日期同一时段只能有一场（已取消的除外）
 * @param selfId 编辑自身时排除
 */
export async function findRoomConflict(
  roomNo: string,
  date: string,
  period: string,
  selfId: string | null
): Promise<SessionRow | null> {
  const rows = await db.sessions
    .where('roomNo')
    .equals(roomNo)
    .filter((item) => item.date === date && item.period === period && item.state !== '已取消' && item.id !== selfId)
    .toArray();
  return rows[0] ?? null;
}

/** 删除场次：级联删除其 Take 与对应优选 */
export async function removeSession(id: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const takes = await db.takes.where('sessionId').equals(id).toArray();
    const takeIds = takes.map((item) => item.id);
    if (takeIds.length > 0) {
      await db.picks.where('takeId').anyOf(takeIds).delete();
    }
    await db.takes.where('sessionId').equals(id).delete();
    await db.sessions.delete(id);
  });
}

/* ------------------------------ Take ------------------------------ */

export async function listTakes(): Promise<TakeRow[]> {
  return db.takes.toArray();
}

export async function putTake(row: TakeRow): Promise<void> {
  await db.takes.put(row);
}

/** Take 参与乐观锁比对的业务字段 */
const TAKE_DIFF_KEYS: Array<{ key: keyof Take; label: string }> = [
  { key: 'sessionId', label: '所属场次' },
  { key: 'takeNo', label: 'Take 号' },
  { key: 'startTc', label: '起始时间码' },
  { key: 'endTc', label: '结束时间码' },
  { key: 'grade', label: '评级' },
  { key: 'issues', label: '问题标签' }
];

/**
 * 修订保存 Take：保存前比对已读版本，落后则抛 RevisionConflictError（整笔回滚、不写新版本）。
 * 时间码或棚号（跨场次移动 / 新场次棚号不同）一变，引用该 Take 的优选立即失效重算，
 * 确认前不进入剪接清单。
 * @returns 本次保存级联失效的优选条数
 */
export async function saveTakeRevision(
  id: string,
  values: Omit<Take, 'id'>,
  base: TakeRow
): Promise<{ invalidatedPicks: number }> {
  return db.transaction('rw', [db.takes, db.picks, db.sessions], async () => {
    const current = await db.takes.get(id);
    if (!current) throw new Error('条次不存在或已被其他标签页删除');
    if (current.editVersion !== base.editVersion) {
      throw new RevisionConflictError(
        id,
        current.editVersion,
        diffConflict(current, base, values, TAKE_DIFF_KEYS)
      );
    }

    let invalidatedPicks = 0;
    const oldSession = await db.sessions.get(current.sessionId);
    const newSession = await db.sessions.get(values.sessionId);
    const reasons: string[] = [];
    if (values.startTc !== current.startTc) {
      reasons.push(`起始时间码由 ${current.startTc} 改为 ${values.startTc}`);
    }
    if (values.endTc !== current.endTc) {
      reasons.push(`结束时间码由 ${current.endTc} 改为 ${values.endTc}`);
    }
    const oldRoomNo = oldSession?.roomNo ?? '';
    const newRoomNo = newSession?.roomNo ?? '';
    if (oldRoomNo !== newRoomNo) {
      reasons.push(`棚号由 ${oldRoomNo || '未知'} 改为 ${newRoomNo || '未知'}`);
    }
    if (reasons.length > 0) {
      invalidatedPicks = await invalidatePicksOfTake(
        { id, ...values },
        `Take 时间码或棚号变化：${reasons.join('；')}`,
        { srcRoomNo: newRoomNo, srcSessionId: values.sessionId }
      );
    }

    const now = Date.now();
    await db.takes.put({
      ...current,
      ...values,
      editVersion: current.editVersion + 1,
      updatedAt: now
    });
    return { invalidatedPicks };
  });
}

/** 复核确认 Take */
export async function confirmTakeRevision(id: string, baseVersion: number): Promise<void> {
  await confirmReviewedRow(db.takes, id, baseVersion);
}

/** 批量改评级（逐条推进 editVersion，保持修订号语义一致；不改时间码/棚号，不级联优选） */
export async function bulkUpdateGrade(ids: string[], grade: Take['grade']): Promise<void> {
  await db.transaction('rw', [db.takes], async () => {
    const now = Date.now();
    for (const id of ids) {
      const current = await db.takes.get(id);
      if (!current) continue;
      await db.takes.put({ ...current, grade, editVersion: current.editVersion + 1, updatedAt: now });
    }
  });
}

export async function removeTake(id: string): Promise<void> {
  await db.transaction('rw', [db.takes, db.picks], async () => {
    await db.picks.where('takeId').equals(id).delete();
    await db.takes.delete(id);
  });
}

/* ------------------------------ 优选 ------------------------------ */

/** 依据 Take 与所属场次现取优选来源快照；Take / 场次缺失时返回 null */
async function buildPickSnapshot(takeId: string): Promise<PickSnapshotFields | null> {
  const take = await db.takes.get(takeId);
  if (!take) return null;
  const session = await db.sessions.get(take.sessionId);
  return {
    srcStartTc: take.startTc,
    srcEndTc: take.endTc,
    srcRoomNo: session?.roomNo ?? '',
    srcSessionId: take.sessionId
  };
}

/** invalidatePicksOfTake 的入参：完整 Take（带最新时间码）或只带 id 的引用均可 */
type PickRef = { id: string } | (Take & { id: string });

/**
 * 把引用某条 Take 的优选立即置为「待复核」并重算派生快照。
 * 必须在调用方的 rw 事务内执行（Dexie 自动复用当前事务）。
 * @param snapshotPatch 来源已变的字段；时间码未显式给出时从传入的 Take 上取
 * @returns 失效的优选条数
 */
async function invalidatePicksOfTake(
  take: PickRef,
  reason: string,
  snapshotPatch: Partial<PickSnapshotFields>
): Promise<number> {
  const rows = await db.picks.where('takeId').equals(take.id).toArray();
  const now = Date.now();
  const startTc = 'startTc' in take ? take.startTc : undefined;
  const endTc = 'endTc' in take ? take.endTc : undefined;
  for (const pick of rows) {
    await db.picks.put({
      ...pick,
      srcStartTc: startTc ?? pick.srcStartTc,
      srcEndTc: endTc ?? pick.srcEndTc,
      ...snapshotPatch,
      reviewState: '待复核',
      reviewReason: reason,
      editVersion: pick.editVersion + 1,
      updatedAt: now
    });
  }
  return rows.length;
}

/** 通用复核确认：场次 / Take 复用（优选另有重算快照逻辑） */
async function confirmReviewedRow<T extends SessionRow | TakeRow>(
  table: Table<T, string>,
  id: string,
  baseVersion: number
): Promise<void> {
  await db.transaction('rw', [table], async () => {
    const current = await table.get(id);
    if (!current) throw new Error('记录不存在或已被其他标签页删除');
    if (current.editVersion !== baseVersion) {
      throw new RevisionConflictError(id, current.editVersion, []);
    }
    if (current.reviewState === '已确认') return;
    await table.put({
      ...current,
      reviewState: '已确认',
      reviewReason: '',
      editVersion: current.editVersion + 1,
      updatedAt: Date.now()
    });
  });
}

export async function listPicks(): Promise<PickRow[]> {
  const rows = await db.picks.toArray();
  return rows.sort((a, b) => a.order - b.order);
}

export async function putPick(row: PickRow): Promise<void> {
  await db.picks.put(row);
}

/** 新建优选：写入即确认，并固化当时的 Take 时间码 / 场次棚号快照 */
export async function insertPick(payload: Omit<Pick, 'id' | 'order'> & { order: number }): Promise<string> {
  return db.transaction('rw', [db.picks, db.takes, db.sessions], async () => {
    const snapshot = await buildPickSnapshot(payload.takeId);
    if (!snapshot) throw new Error('被优选的条次不存在');
    const now = Date.now();
    const row: PickRow = {
      ...payload,
      id: createId('pick'),
      ...snapshot,
      revision: ROW_REVISION,
      editVersion: 1,
      reviewState: '已确认',
      reviewReason: '',
      createdAt: now,
      updatedAt: now
    };
    await db.picks.put(row);
    return row.id;
  });
}

/** 优选参与乐观锁比对的业务字段 */
const PICK_DIFF_KEYS: Array<{ key: keyof Pick; label: string }> = [
  { key: 'takeId', label: '条次' },
  { key: 'usage', label: '用途' },
  { key: 'order', label: '顺序' },
  { key: 'note', label: '备注' }
];

/**
 * 修订保存优选：保存前比对已读版本，落后则抛 RevisionConflictError（整笔回滚、不写新版本）。
 * 换到别的 Take 时按新来源重算快照并直接确认；只改用途 / 备注不改变复核状态。
 */
export async function savePickRevision(id: string, values: Pick, base: PickRow): Promise<void> {
  await db.transaction('rw', [db.picks, db.takes, db.sessions], async () => {
    const current = await db.picks.get(id);
    if (!current) throw new Error('优选记录不存在或已被其他标签页删除');
    if (current.editVersion !== base.editVersion) {
      throw new RevisionConflictError(id, current.editVersion, diffConflict(current, base, values, PICK_DIFF_KEYS));
    }

    let next: PickRow = {
      ...current,
      takeId: values.takeId,
      usage: values.usage,
      order: values.order,
      note: values.note,
      editVersion: current.editVersion + 1,
      updatedAt: Date.now()
    };
    if (values.takeId !== current.takeId) {
      const snapshot = await buildPickSnapshot(values.takeId);
      if (!snapshot) throw new Error('被优选的条次不存在');
      next = { ...next, ...snapshot, reviewState: '已确认', reviewReason: '' };
    }
    await db.picks.put(next);
  });
}

/**
 * 复核确认优选：按最新 Take / 场次重算快照后确认，确认后才进入剪接清单。
 * 走乐观锁：失效后又被别的标签页改过会返回冲突，需刷新后重试。
 */
export async function confirmPickRevision(id: string, baseVersion: number): Promise<void> {
  await db.transaction('rw', [db.picks, db.takes, db.sessions], async () => {
    const current = await db.picks.get(id);
    if (!current) throw new Error('优选记录不存在或已被其他标签页删除');
    if (current.editVersion !== baseVersion) {
      throw new RevisionConflictError(id, current.editVersion, []);
    }
    if (current.reviewState === '已确认') return;
    const snapshot = await buildPickSnapshot(current.takeId);
    if (!snapshot) throw new Error('被优选的条次已删除，请先移出该优选');
    await db.picks.put({
      ...current,
      ...snapshot,
      reviewState: '已确认',
      reviewReason: '',
      editVersion: current.editVersion + 1,
      updatedAt: Date.now()
    });
  });
}

/**
 * 拖拽 / 上下移后按新顺序批量写回（修订保存）：
 * 任一所拖优选的已读版本落后即整体回滚、不写新版本。
 * @param entries 本次参与移动的优选 id + 编辑者已读的 editVersion + 新顺序
 */
export async function reorderPicksRevision(
  entries: Array<{ id: string; baseVersion: number; order: number }>
): Promise<void> {
  await db.transaction('rw', [db.picks], async () => {
    const now = Date.now();
    for (const entry of entries) {
      const current = await db.picks.get(entry.id);
      if (!current) throw new Error('优选记录不存在或已被其他标签页删除');
      if (current.editVersion !== entry.baseVersion) {
        throw new RevisionConflictError(entry.id, current.editVersion, [
          { label: '顺序', base: `v${entry.baseVersion}`, mine: String(entry.order), latest: String(current.order) }
        ]);
      }
      await db.picks.put({ ...current, order: entry.order, editVersion: current.editVersion + 1, updatedAt: now });
    }
  });
}

export async function nextPickOrder(): Promise<number> {
  const rows = await db.picks.toArray();
  return rows.reduce((max, row) => Math.max(max, row.order), 0) + 1;
}

export async function removePick(id: string): Promise<void> {
  await db.picks.delete(id);
}

/* ------------------------------ 补录 ------------------------------ */

export async function listRetakes(): Promise<RetakeRow[]> {
  const rows = await db.retakes.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putRetake(row: RetakeRow): Promise<void> {
  await db.retakes.put(row);
}

export async function updateRetake(id: string, patch: Partial<Retake>): Promise<void> {
  await db.retakes.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 补录完成：联动曲目状态 */
export async function completeRetake(id: string): Promise<void> {
  await db.transaction('rw', [db.retakes, db.songs], async () => {
    const retake = await db.retakes.get(id);
    if (!retake) throw new Error('补录条目不存在');
    await db.retakes.update(id, { state: '已完成', updatedAt: Date.now() } as never);
    const pending = await db.retakes
      .where('songId')
      .equals(retake.songId)
      .filter((item) => item.state !== '已完成' && item.id !== id)
      .count();
    await db.songs.update(retake.songId, { state: pending === 0 ? '已完成' : '录制中', updatedAt: Date.now() } as never);
  });
}

export async function removeRetake(id: string): Promise<void> {
  await db.retakes.delete(id);
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  projects: Project[];
  songs: Song[];
  sessions: Session[];
  takes: Take[];
  picks: Pick[];
  retakes: Retake[];
}

/** 导出时剥离的行内修订字段（结构号 / 乐观锁版本 / 复核区 / 优选来源快照） */
const STRIP_KEYS = ['revision', 'createdAt', 'updatedAt', 'editVersion', 'reviewState', 'reviewReason', 'srcStartTc', 'srcEndTc', 'srcRoomNo', 'srcSessionId'];

function stripRow<T>(row: T): T {
  const copy = { ...row } as Record<string, unknown>;
  STRIP_KEYS.forEach((key) => delete copy[key]);
  return copy as T;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [projects, songs, sessions, takes, picks, retakes] = await Promise.all([
    db.projects.toArray(),
    db.songs.toArray(),
    db.sessions.toArray(),
    db.takes.toArray(),
    db.picks.toArray(),
    db.retakes.toArray()
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    projects: projects.map(stripRow),
    songs: songs.map(stripRow),
    sessions: sessions.map(stripRow),
    takes: takes.map(stripRow),
    picks: picks.map(stripRow),
    retakes: retakes.map(stripRow)
  };
}

function stampPlain<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

/** 导入的场次 / Take：作为已复核的新版本落库 */
function stampReviewed<T>(row: T): T & Revisioned & RevisionFields {
  const now = Date.now();
  return {
    ...row,
    revision: ROW_REVISION,
    editVersion: 1,
    reviewState: '已确认',
    reviewReason: '',
    createdAt: now,
    updatedAt: now
  };
}

/** 导入的优选：依据快照中的 Take / 场次水合来源快照后，作为已确认数据落库 */
function stampPick(
  pick: Pick,
  takes: Take[],
  sessions: Session[]
): PickRow {
  const take = takes.find((item) => item.id === pick.takeId);
  const session = take ? sessions.find((item) => item.id === take.sessionId) : undefined;
  const now = Date.now();
  return {
    ...pick,
    revision: ROW_REVISION,
    editVersion: 1,
    reviewState: '已确认',
    reviewReason: '',
    srcStartTc: take?.startTc ?? '',
    srcEndTc: take?.endTc ?? '',
    srcRoomNo: session?.roomNo ?? '',
    srcSessionId: take?.sessionId ?? '',
    createdAt: now,
    updatedAt: now
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await Promise.all([
      db.projects.clear(),
      db.songs.clear(),
      db.sessions.clear(),
      db.takes.clear(),
      db.picks.clear(),
      db.retakes.clear()
    ]);
    await db.projects.bulkPut(snapshot.projects.map(stampPlain));
    await db.songs.bulkPut(snapshot.songs.map(stampPlain));
    await db.sessions.bulkPut(snapshot.sessions.map(stampReviewed));
    await db.takes.bulkPut(snapshot.takes.map(stampReviewed));
    await db.picks.bulkPut(snapshot.picks.map((pick) => stampPick(pick, snapshot.takes, snapshot.sessions)));
    await db.retakes.bulkPut(snapshot.retakes.map(stampPlain));
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await Promise.all([
      db.projects.clear(),
      db.songs.clear(),
      db.sessions.clear(),
      db.takes.clear(),
      db.picks.clear(),
      db.retakes.clear()
    ]);
  });
  await seedDatabase(db);
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [projects, songs, sessions, takes, picks, retakes] = await Promise.all([
    db.projects.count(),
    db.songs.count(),
    db.sessions.count(),
    db.takes.count(),
    db.picks.count(),
    db.retakes.count()
  ]);
  return { projects, songs, sessions, takes, picks, retakes };
}
