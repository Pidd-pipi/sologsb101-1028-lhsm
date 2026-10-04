/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbstudiotake-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 项目 / 曲目 / 场次 / Take / 优选 / 补录 六张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 场次 / Take / 优选采用乐观锁修订保存：保存前比对已读 revision，
 *   落后即抛 RevisionConflictError 且不写入；Take 时间码或棚号变动时关联优选立即失效
 */
import Dexie, { type Table } from 'dexie';
import type { Project } from '../types/project';
import type { Song } from '../types/song';
import type { Session } from '../types/session';
import type { Take } from '../types/take';
import type { Pick, PickConfirmState } from '../types/pick';
import type { Retake } from '../types/retake';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';
import { ROW_REVISION } from './revision';
import { pickBasisSignature } from './pickBasis';

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

export type ProjectRow = Project & Revisioned;
export type SongRow = Song & Revisioned;
export type SessionRow = Session & Revisioned;
export type TakeRow = Take & Revisioned;
export type PickRow = Pick & Revisioned;
export type RetakeRow = Retake & Revisioned;

/** 保存结果：返回本次受影响（转入待复核）的优选条数 */
export interface SaveOutcome {
  invalidatedPicks: number;
}

/**
 * 修订冲突：已读版本落后于库内最新版本（多标签同时编辑）。
 * 调用方捕获后保留用户输入、并列展示冲突，由用户决定采用最新值还是放弃，不会写入新版本。
 */
export class RevisionConflictError extends Error {
  readonly kind = 'revision-conflict' as const;
  constructor(readonly latest: Revisioned) {
    super('数据已被其他页面修改（版本落后），请核对冲突后再保存');
    this.name = 'RevisionConflictError';
  }
}

export function isRevisionConflict(error: unknown): error is RevisionConflictError {
  return error instanceof RevisionConflictError;
}

export class GbStudioTakeDatabase extends Dexie {
  projects!: Table<ProjectRow, string>;
  songs!: Table<SongRow, string>;
  sessions!: Table<SessionRow, string>;
  takes!: Table<TakeRow, string>;
  picks!: Table<PickRow, string>;
  retakes!: Table<RetakeRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版六表结构
    this.version(1).stores({
      projects: 'id, name, client, state, startDate, updatedAt',
      songs: 'id, projectId, title, arrangement, state, updatedAt',
      sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
      takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
      picks: 'id, takeId, usage, order, updatedAt',
      retakes: 'id, songId, planDate, state, updatedAt'
    });

    // v2：优选增加确认状态；场次 / Take / 优选启用乐观锁编辑版本
    this.version(DB_SCHEMA_VERSION)
      .stores({
        projects: 'id, name, client, state, startDate, updatedAt',
        songs: 'id, projectId, title, arrangement, state, updatedAt',
        sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
        takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
        picks: 'id, takeId, usage, order, confirmState, updatedAt',
        retakes: 'id, songId, planDate, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐编辑版本号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['projects', 'songs', 'sessions', 'takes', 'picks', 'retakes'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.revision !== 'number') row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }

        // 旧优选补确认状态与确认基准，全部进入待复核区（确认前不进剪接清单）
        const takeRows = await tx.table<{ id: string; sessionId: string; startTc: string; endTc: string }>('takes').toArray();
        const sessionRows = await tx
          .table<{ id: string; roomNo: string }>('sessions')
          .toArray();
        const takeById = new Map(takeRows.map((item) => [item.id, item]));
        const roomBySession = new Map(sessionRows.map((item) => [item.id, item.roomNo]));
        await tx
          .table('picks')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.basis !== 'string' || row.basis.length === 0) {
              const take = typeof row.takeId === 'string' ? takeById.get(row.takeId) : undefined;
              const roomNo = take ? roomBySession.get(take.sessionId) ?? '' : '';
              row.basis = take ? pickBasisSignature({ startTc: take.startTc, endTc: take.endTc, roomNo }) : '';
            }
            // 历史优选一律进待复核区；仅当已带合法确认状态（来自更新版本）时尊重原值
            row.confirmState = row.confirmState === '已确认' || row.confirmState === '待复核' ? row.confirmState : '待复核';
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

/** 计算优选当前应有的确认基准（Take 时间码 + 场次棚号）；条次 / 场次缺失返回 null */
export async function computePickBasis(takeId: string): Promise<string | null> {
  const take = await db.takes.get(takeId);
  if (!take) return null;
  const session = await db.sessions.get(take.sessionId);
  if (!session) return null;
  return pickBasisSignature({ startTc: take.startTc, endTc: take.endTc, roomNo: session.roomNo });
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
  await db.transaction('rw', [db.sessions], async () => {
    const conflict = await findRoomConflict(row.roomNo, row.date, row.period, null);
    if (conflict) {
      throw new Error(`${row.roomNo} 在 ${row.date} ${row.period} 已被场次占用（场次 ${conflict.id}），请换棚或换时段`);
    }
    await db.sessions.put(row);
  });
}

/**
 * 修订保存场次（乐观锁）。
 * - 保存前比对已读 baseRevision，落后抛 RevisionConflictError，不写入
 * - 棚号变更时，该场次下全部优选立即失效（转待复核），确认前不进入剪接清单
 */
export async function saveSessionRevisioned(
  id: string,
  patch: Partial<Session>,
  baseRevision: number
): Promise<SaveOutcome> {
  return db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const current = await db.sessions.get(id);
    if (!current) throw new Error('场次不存在或已被删除');
    if (current.revision !== baseRevision) throw new RevisionConflictError(current);

    const nextRoomNo = patch.roomNo ?? current.roomNo;
    const nextDate = patch.date ?? current.date;
    const nextPeriod = patch.period ?? current.period;
    const conflict = await findRoomConflict(nextRoomNo, nextDate, nextPeriod, id);
    if (conflict) {
      throw new Error(`${nextRoomNo} 在 ${nextDate} ${nextPeriod} 已被场次占用（场次 ${conflict.id}），请换棚或换时段`);
    }

    const roomChanged = patch.roomNo !== undefined && patch.roomNo !== current.roomNo;
    const now = Date.now();
    await db.sessions.update(id, { ...patch, revision: current.revision + 1, updatedAt: now } as never);

    let invalidatedPicks = 0;
    if (roomChanged) {
      const affected = await db.picks
        .where('takeId')
        .anyOf(await db.takes.where('sessionId').equals(id).primaryKeys())
        .toArray();
      if (affected.length > 0) {
        await db.picks
          .where('takeId')
          .anyOf(affected.map((item) => item.takeId))
          .modify({ confirmState: '待复核', updatedAt: now } as never);
        invalidatedPicks = affected.length;
      }
    }
    return { invalidatedPicks };
  });
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

/**
 * 修订保存 Take（乐观锁）。
 * - 保存前比对已读 baseRevision，落后抛 RevisionConflictError，不写入
 * - 起止时间码变动（或转移场次导致棚号变化）时，该 Take 的优选立即失效转待复核
 */
export async function saveTakeRevisioned(
  id: string,
  patch: Partial<Take>,
  baseRevision: number
): Promise<SaveOutcome> {
  return db.transaction('rw', [db.takes, db.sessions, db.picks], async () => {
    const current = await db.takes.get(id);
    if (!current) throw new Error('条次不存在或已被删除');
    if (current.revision !== baseRevision) throw new RevisionConflictError(current);

    const timeChanged =
      (patch.startTc !== undefined && patch.startTc !== current.startTc) ||
      (patch.endTc !== undefined && patch.endTc !== current.endTc) ||
      (patch.sessionId !== undefined && patch.sessionId !== current.sessionId);

    const now = Date.now();
    await db.takes.update(id, { ...patch, revision: current.revision + 1, updatedAt: now } as never);

    let invalidatedPicks = 0;
    if (timeChanged) {
      const affected = await db.picks.where('takeId').equals(id).toArray();
      if (affected.length > 0) {
        await db.picks
          .where('takeId')
          .equals(id)
          .modify({ confirmState: '待复核', updatedAt: now } as never);
        invalidatedPicks = affected.length;
      }
    }
    return { invalidatedPicks };
  });
}

/** 批量改评级（同步推进编辑版本，避免后续保存基于过期版本） */
export async function bulkUpdateGrade(ids: string[], grade: Take['grade']): Promise<void> {
  await db.transaction('rw', [db.takes], async () => {
    const now = Date.now();
    await db.takes
      .where('id')
      .anyOf(ids)
      .modify((row: TakeRow) => {
        row.grade = grade;
        row.revision += 1;
        row.updatedAt = now;
      });
  });
}

export async function removeTake(id: string): Promise<void> {
  await db.transaction('rw', [db.takes, db.picks], async () => {
    await db.picks.where('takeId').equals(id).delete();
    await db.takes.delete(id);
  });
}

/* ------------------------------ 优选 ------------------------------ */

export async function listPicks(): Promise<PickRow[]> {
  const rows = await db.picks.toArray();
  return rows.sort((a, b) => a.order - b.order);
}

export async function putPick(row: PickRow): Promise<void> {
  await db.picks.put(row);
}

/**
 * 修订保存优选（乐观锁）。保存前比对已读 baseRevision，落后抛 RevisionConflictError。
 * 重新指定被优选 Take 时，以新 Take 的当前时间码 / 棚号为确认基准，直接作为已确认生效。
 */
export async function savePickRevisioned(
  id: string,
  patch: Partial<Omit<Pick, 'confirmState' | 'basis'>>,
  baseRevision: number
): Promise<void> {
  await db.transaction('rw', [db.picks, db.takes, db.sessions], async () => {
    const current = await db.picks.get(id);
    if (!current) throw new Error('优选记录不存在或已被删除');
    if (current.revision !== baseRevision) throw new RevisionConflictError(current);

    const now = Date.now();
    if (patch.takeId !== undefined && patch.takeId !== current.takeId) {
      const basis = await computePickBasis(patch.takeId);
      if (!basis) throw new Error('所选条次不存在或其场次已删除，无法优选');
      await db.picks.update(id, {
        ...patch,
        confirmState: '已确认' satisfies PickConfirmState,
        basis,
        revision: current.revision + 1,
        updatedAt: now
      } as never);
      return;
    }
    await db.picks.update(id, { ...patch, revision: current.revision + 1, updatedAt: now } as never);
  });
}

/**
 * 复核确认优选（乐观锁）：按当前 Take 时间码 / 棚号重算确认基准并置为已确认。
 * 已读版本落后抛 RevisionConflictError，不写入。确认后才进入剪接清单。
 */
export async function confirmPickRevisioned(id: string, baseRevision: number): Promise<void> {
  await db.transaction('rw', [db.picks, db.takes, db.sessions], async () => {
    const current = await db.picks.get(id);
    if (!current) throw new Error('优选记录不存在或已被删除');
    if (current.revision !== baseRevision) throw new RevisionConflictError(current);
    const basis = await computePickBasis(current.takeId);
    if (!basis) throw new Error('条次或场次已删除，无法确认优选');
    const now = Date.now();
    await db.picks.update(id, {
      confirmState: '已确认' satisfies PickConfirmState,
      basis,
      revision: current.revision + 1,
      updatedAt: now
    } as never);
  });
}

/** 拖拽 / 上下移后按新顺序批量写回（同步推进编辑版本） */
export async function reorderPicks(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', [db.picks], async () => {
    const rows = await db.picks.where('id').anyOf(orderedIds).toArray();
    const revisionById = new Map(rows.map((row) => [row.id, row.revision]));
    const now = Date.now();
    for (let index = 0; index < orderedIds.length; index += 1) {
      const baseRevision = revisionById.get(orderedIds[index]);
      if (baseRevision === undefined) continue;
      await db.picks.update(orderedIds[index], {
        order: index + 1,
        revision: baseRevision + 1,
        updatedAt: now
      } as never);
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

/** 备份中的优选：旧版本备份可能没有确认状态 / 确认基准字段 */
export type SnapshotPick = Omit<Pick, 'confirmState' | 'basis'> & Partial<Pick>;

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  projects: Project[];
  songs: Song[];
  sessions: Session[];
  takes: Take[];
  picks: SnapshotPick[];
  retakes: Retake[];
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
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
    picks: picks.map(stripRow) as SnapshotPick[],
    retakes: retakes.map(stripRow)
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const takeById = new Map(snapshot.takes.map((item) => [item.id, item]));
  const roomBySession = new Map(snapshot.sessions.map((item) => [item.id, item.roomNo]));

  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await Promise.all([
      db.projects.clear(),
      db.songs.clear(),
      db.sessions.clear(),
      db.takes.clear(),
      db.picks.clear(),
      db.retakes.clear()
    ]);
    await db.projects.bulkPut(snapshot.projects.map(stamp));
    await db.songs.bulkPut(snapshot.songs.map(stamp));
    await db.sessions.bulkPut(snapshot.sessions.map(stamp));
    await db.takes.bulkPut(snapshot.takes.map(stamp));
    // 旧备份优选缺少确认状态：补基准并进待复核区，与结构升级保持一致
    const stampedPicks: PickRow[] = snapshot.picks.map((raw) => {
      const base = stamp(raw);
      const take = takeById.get(raw.takeId);
      const roomNo = take ? roomBySession.get(take.sessionId) ?? '' : '';
      const fallbackBasis = take
        ? pickBasisSignature({ startTc: take.startTc, endTc: take.endTc, roomNo })
        : '';
      const confirmState: PickConfirmState = raw.confirmState === '已确认' ? '已确认' : '待复核';
      return {
        ...base,
        confirmState,
        basis: typeof raw.basis === 'string' && raw.basis.length > 0 ? raw.basis : fallbackBasis
      };
    });
    await db.picks.bulkPut(stampedPicks);
    await db.retakes.bulkPut(snapshot.retakes.map(stamp));
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
