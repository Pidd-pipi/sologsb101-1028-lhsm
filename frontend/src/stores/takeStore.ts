/**
 * Take store：维护条次列表的评级 / 问题标签 / 时间码筛选，以及批量改评级。
 * 编辑走修订保存（editVersion 乐观锁），时间码或棚号变化级联失效受影响优选。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Take } from '@/types/take';
import {
  bulkUpdateGrade,
  confirmTakeRevision,
  putTake,
  removeTake,
  saveTakeRevision,
  type TakeRow
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export const TAKE_FILTER_KEYS = ['grades', 'issues', 'sessionIds', 'minTc', 'maxTc'];

interface TakeState {
  filters: FilterModel;
  selectedIds: string[];
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  createTake: (payload: Omit<Take, 'id'>) => Promise<string>;
  /**
   * 修订保存 Take。
   * @param base 打开编辑框时读到的整行（携带已读 editVersion）
   * @returns 级联失效的优选条数
   */
  editTake: (id: string, values: Omit<Take, 'id'>, base: TakeRow) => Promise<{ invalidatedPicks: number }>;
  /** 复核确认 Take */
  confirmTake: (id: string, baseVersion: number) => Promise<void>;
  deleteTake: (id: string) => Promise<void>;
  batchGrade: (ids: string[], grade: Take['grade']) => Promise<void>;
}

export const useTakeStore = create<TakeState>()((set, get) => ({
  filters: { keyword: '', grades: [], issues: [], sessionIds: [], minTc: '', maxTc: '' },
  selectedIds: [],
  setFilters: (next) => set({ filters: next }),
  resetFilters: () =>
    set({ filters: { keyword: '', grades: [], issues: [], sessionIds: [], minTc: '', maxTc: '' } }),
  toggleSelected: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((item) => item !== id)
        : [...state.selectedIds, id]
    })),
  setSelected: (ids) => set({ selectedIds: ids }),
  createTake: async (payload) => {
    const row = buildRow(payload, 'take');
    await putTake(row);
    return row.id;
  },
  editTake: async (id, values, base) => saveTakeRevision(id, values, base),
  confirmTake: async (id, baseVersion) => {
    await confirmTakeRevision(id, baseVersion);
  },
  deleteTake: async (id) => {
    await removeTake(id);
    set((state) => ({ selectedIds: state.selectedIds.filter((item) => item !== id) }));
  },
  batchGrade: async (ids, grade) => {
    await bulkUpdateGrade(ids, grade);
    set({ selectedIds: [] });
    void get();
  }
}));
