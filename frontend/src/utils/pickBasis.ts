/**
 * 优选确认基准（basis）签名：叶子模块，不 import utils/db，避免循环依赖。
 * 优选确认时记录所依据的 Take 起止时间码与所在场次棚号；
 * Take 时间码一旦修改，或场次棚号一旦调整，基准签名立即与现值不符，优选转入待复核。
 */

/** 参与签名的最小结构：Take 时间码 + 场次棚号 */
export interface PickBasisInput {
  startTc: string;
  endTc: string;
  roomNo: string;
}

/** 计算优选确认基准签名 */
export function pickBasisSignature(input: PickBasisInput): string {
  return `${input.startTc}→${input.endTc}@${input.roomNo}`;
}

/** 判断优选基准是否仍与当前 Take / 场次一致 */
export function isPickBasisFresh(pick: { basis: string }, current: PickBasisInput): boolean {
  return pick.basis === pickBasisSignature(current);
}
