/**
 * 优选 store：维护优选顺序、剪接清单派生与备注。
 * 编辑与拖拽排序都走修订保存（editVersion 乐观锁）；待复核优选不进入剪接清单。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Pick } from '@/types/pick';
import {
  confirmPickRevision,
  insertPick,
  nextPickOrder,
  removePick,
  reorderPicksRevision,
  savePickRevision,
  type PickRow
} from '@/utils/db';

export const PICK_FILTER_KEYS = ['usages'];

/** 拖拽 / 上下移的单条移动指令（携带编辑者已读版本） */
export interface PickMoveEntry {
  id: string;
  baseVersion: number;
  order: number;
}

interface PickState {
  filters: FilterModel;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  createPick: (payload: Omit<Pick, 'id' | 'order'>) => Promise<string>;
  /**
   * 修订保存优选。
   * @param base 打开编辑框时读到的整行（携带已读 editVersion / order）
   */
  editPick: (id: string, values: Pick, base: PickRow) => Promise<void>;
  /** 复核确认优选（按最新 Take / 场次重算快照后进入剪接清单） */
  confirmPick: (id: string, baseVersion: number) => Promise<void>;
  deletePick: (id: string) => Promise<void>;
  /** 按新顺序批量写回；任一条版本落后即整体回滚 */
  reorder: (entries: PickMoveEntry[]) => Promise<void>;
}

export const usePickStore = create<PickState>()((set) => ({
  filters: { keyword: '', usages: [] },
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', usages: [] } }),
  createPick: async (payload) => {
    const order = await nextPickOrder();
    return insertPick({ ...payload, order });
  },
  editPick: async (id, values, base) => savePickRevision(id, values, base),
  confirmPick: async (id, baseVersion) => confirmPickRevision(id, baseVersion),
  deletePick: async (id) => removePick(id),
  reorder: async (entries) => reorderPicksRevision(entries)
}));
