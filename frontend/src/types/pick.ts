/** 优选用途 */
export type PickUsage = '主歌' | '副歌' | '独奏' | '全曲';
/** 优选确认状态：待复核的条次不进入剪接清单 */
export type PickConfirmState = '待复核' | '已确认';

/** 优选 Take：从可用条次中挑选出的剪接素材 */
export interface Pick {
  id: string;
  /** 被优选的 Take */
  takeId: string;
  /** 用途 */
  usage: PickUsage;
  /** 剪接清单中的顺序 */
  order: number;
  /** 备注 */
  note: string;
  /** 确认状态：Take 时间码 / 棚号变动后立即转为「待复核」，确认前不进入剪接清单 */
  confirmState: PickConfirmState;
  /**
   * 确认基准（签名）：确认时所依据的 Take 起止时间码与棚号。
   * 与当前 Take / 场次实际值不一致即视为失效，需重新确认。
   */
  basis: string;
}

export const PICK_USAGES: PickUsage[] = ['主歌', '副歌', '独奏', '全曲'];
export const PICK_CONFIRM_STATES: PickConfirmState[] = ['待复核', '已确认'];

export function createEmptyPick(): Omit<Pick, 'id' | 'order' | 'confirmState' | 'basis'> {
  return { takeId: '', usage: '主歌', note: '' };
}
