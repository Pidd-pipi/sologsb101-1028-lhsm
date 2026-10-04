/**
 * Take store：维护条次列表的评级 / 问题标签 / 时间码筛选，以及批量改评级。
 * 编辑走乐观锁修订保存：多标签同时改时由 db 层抛 RevisionConflictError，不写入新版本；
 * Take 起止时间码（或转移场次）变动会联动使其优选转入待复核，确认前不进剪接清单。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Take } from '@/types/take';
import { bulkUpdateGrade, putTake, removeTake, saveTakeRevisioned, type SaveOutcome } from '@/utils/db';
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
  /** 修订保存：baseRevision 为打开弹窗时读到的版本，落后则抛 RevisionConflictError */
  editTake: (id: string, patch: Partial<Take>, baseRevision: number) => Promise<SaveOutcome>;
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
  editTake: async (id, patch, baseRevision) => {
    return saveTakeRevisioned(id, patch, baseRevision);
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
