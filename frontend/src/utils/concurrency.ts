/**
 * 修订保存（乐观并发控制）的冲突比对工具（叶子模块）。
 *
 * 保存流程统一走 utils/db.ts 中的 saveXxxRevision 事务函数：
 * 1. 事务内重新读出当前行；
 * 2. 比对编辑者打开编辑框时读到的 editVersion（baseVersion）；
 * 3. 落后则抛出 RevisionConflictError（携带逐字段差异），整笔事务回滚、不写新版本；
 * 4. 页面捕获后保留用户输入并并列展示冲突，由用户决定载入最新值还是调整后重试。
 */
import type { RevisionConflictField } from '@/types/revision';

/** 保存前发现已读版本落后：保留输入、列出冲突、不允许写新版本 */
export class RevisionConflictError extends Error {
  /** 冲突行 id */
  readonly rowId: string;
  /** 冲突时数据库中的最新版本号 */
  readonly latestVersion: number;
  /** 逐字段差异（仅包含两边不一致的字段） */
  readonly fields: RevisionConflictField[];

  constructor(rowId: string, latestVersion: number, fields: RevisionConflictField[]) {
    super(`内容已被其他标签页更新（最新版本 v${latestVersion}），请核对冲突字段后再保存`);
    this.name = 'RevisionConflictError';
    this.rowId = rowId;
    this.latestVersion = latestVersion;
    this.fields = fields;
  }
}

export function isRevisionConflict(error: unknown): error is RevisionConflictError {
  return error instanceof RevisionConflictError;
}

/** 值转展示文本：数组用顿号连接，空值显示「（空）」 */
function toText(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '（空）';
  if (value === undefined || value === null || value === '') return '（空）';
  return String(value);
}

/**
 * 比对编辑者已读快照与数据库最新行，逐字段列出差异。
 * @param latest    数据库当前行
 * @param base      编辑者打开编辑框时读到的行（已读版本快照）
 * @param wanted    本次保存要写入的完整值
 * @param labels    需要比对的业务字段：key + 中文标签
 */
export function diffConflict<T extends object>(
  latest: T,
  base: Partial<T>,
  wanted: Partial<T>,
  labels: Array<{ key: keyof T; label: string }>
): RevisionConflictField[] {
  const conflicts: RevisionConflictField[] = [];
  for (const { key, label } of labels) {
    const latestValue = latest[key];
    const baseValue = base[key];
    // 最新库值与编辑者已读值一致 → 这个字段没有被别人改过，不构成冲突
    if (toText(latestValue) === toText(baseValue)) continue;
    conflicts.push({ label, base: toText(baseValue), mine: toText(wanted[key]), latest: toText(latestValue) });
  }
  return conflicts;
}
