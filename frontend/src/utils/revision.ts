/**
 * 行初始修订号（叶子模块）
 * 定义在此处而不是 utils/db.ts，是为了让 utils/seed.ts 无需在运行期 import utils/db.ts，
 * 从而切断 utils/db.ts ⇄ utils/seed.ts 的循环依赖（db 负责建表、seed 负责灌数）。
 *
 * revision 是乐观锁编辑版本号：新建行初始为 ROW_REVISION，此后每次修订保存成功 +1；
 * 多标签同时编辑时，保存前比对已读版本，落后即抛 RevisionConflictError，不写入新版本。
 * 旧数据升级（schema v2）时为缺号的历史行补 ROW_REVISION。
 */
export const ROW_REVISION = 1;
