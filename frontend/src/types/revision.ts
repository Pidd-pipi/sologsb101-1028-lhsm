/**
 * 修订保存（乐观并发控制）相关类型。
 *
 * 场景：棚务统筹会同时开多个标签页处理同一场录制，多标签同时编辑
 * 场次 / Take / 优选时，保存前必须比对「已读版本」：
 * - 版本一致才允许写入并 +1；
 * - 版本落后则保留输入并列出字段冲突，不能写新版本。
 */

/** 复核状态：旧数据升级、派生数据失效后先进待复核区，确认后才生效 */
export type ReviewState = '已确认' | '待复核';

export const REVIEW_STATES: ReviewState[] = ['已确认', '待复核'];

/** 挂在参与修订保存的行（场次 / Take / 优选）上的修订字段 */
export interface RevisionFields {
  /** 编辑版本号（乐观锁）：每成功保存一次 +1，落后保存会被拦截 */
  editVersion: number;
  /** 复核状态：待复核的数据不进入剪接清单，且在复核区集中处理 */
  reviewState: ReviewState;
  /** 待复核原因（失效来源 / 旧数据升级说明），已确认时为空 */
  reviewReason: string;
}

/** 优选保存时用于乐观锁的字段差异 */
export interface RevisionConflictField {
  /** 字段名（中文标签） */
  label: string;
  /** 编辑者打开编辑框时已读版本上的值 */
  base: string;
  /** 编辑者本次要保存的值（输入保留，不丢失） */
  mine: string;
  /** 数据库当前最新值 */
  latest: string;
}
