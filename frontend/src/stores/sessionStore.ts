/**
 * 场次 store：维护场次排期、棚号占用校验与筛选条件。
 * 编辑走乐观锁修订保存：多标签同时改时由 db 层抛 RevisionConflictError，不写入新版本；
 * 棚号变更会联动使该场次下优选转入待复核。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Session } from '@/types/session';
import { putSession, removeSession, saveSessionRevisioned, type SaveOutcome } from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export const SESSION_FILTER_KEYS = ['rooms', 'periods', 'states'];

interface SessionState {
  filters: FilterModel;
  currentSessionId: string | null;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  selectSession: (id: string | null) => void;
  createSession: (payload: Omit<Session, 'id'>) => Promise<string>;
  /** 修订保存：baseRevision 为打开弹窗时读到的版本，落后则抛 RevisionConflictError */
  editSession: (id: string, patch: Partial<Session>, baseRevision: number) => Promise<SaveOutcome>;
  deleteSession: (id: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  filters: { keyword: '', rooms: [], periods: [], states: [] },
  currentSessionId: null,
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', rooms: [], periods: [], states: [] } }),
  selectSession: (id) => set({ currentSessionId: id }),
  createSession: async (payload) => {
    const row = buildRow(payload, 'session');
    await putSession(row);
    set({ currentSessionId: row.id });
    return row.id;
  },
  editSession: async (id, patch, baseRevision) => {
    // 棚号时段占用在修订保存事务内统一校验（避免保存前校验、保存时已被他页占用）
    return saveSessionRevisioned(id, patch, baseRevision);
  },
  deleteSession: async (id) => {
    await removeSession(id);
    if (get().currentSessionId === id) set({ currentSessionId: null });
  }
}));
