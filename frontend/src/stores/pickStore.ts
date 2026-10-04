/**
 * 优选 store：维护优选顺序、剪接清单派生与备注。
 * - 新建优选时以当前 Take 时间码 / 棚号为确认基准，直接作为已确认生效
 * - 编辑 / 确认走乐观锁修订保存；Take 时间码或棚号变动后由 Take / 场次保存联动转入待复核
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Pick, PickUsage } from '@/types/pick';
import {
  computePickBasis,
  confirmPickRevisioned,
  nextPickOrder,
  putPick,
  removePick,
  reorderPicks,
  savePickRevisioned
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export const PICK_FILTER_KEYS = ['usages'];

interface PickState {
  filters: FilterModel;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  createPick: (payload: { takeId: string; usage: PickUsage; note: string }) => Promise<string>;
  /** 修订保存：baseRevision 为打开弹窗时读到的版本，落后则抛 RevisionConflictError */
  editPick: (
    id: string,
    patch: Partial<Omit<Pick, 'confirmState' | 'basis'>>,
    baseRevision: number
  ) => Promise<void>;
  /** 复核确认：重算确认基准；版本落后抛 RevisionConflictError */
  confirmPick: (id: string, baseRevision: number) => Promise<void>;
  deletePick: (id: string) => Promise<void>;
  move: (list: Pick[], from: number, to: number) => Promise<void>;
}

export const usePickStore = create<PickState>()((set) => ({
  filters: { keyword: '', usages: [] },
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', usages: [] } }),
  createPick: async (payload) => {
    const basis = await computePickBasis(payload.takeId);
    if (!basis) throw new Error('所选条次不存在或其场次已删除，无法加入优选');
    const order = await nextPickOrder();
    const row = buildRow({ ...payload, order, confirmState: '已确认' as const, basis }, 'pick');
    await putPick(row);
    return row.id;
  },
  editPick: async (id, patch, baseRevision) => {
    await savePickRevisioned(id, patch, baseRevision);
  },
  confirmPick: async (id, baseRevision) => {
    await confirmPickRevisioned(id, baseRevision);
  },
  deletePick: async (id) => {
    await removePick(id);
  },
  move: async (list, from, to) => {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await reorderPicks(next.map((item) => item.id));
  }
}));
