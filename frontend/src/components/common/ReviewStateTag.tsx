/**
 * 复核状态标签：待复核数据进复核区，确认前不参与剪接清单。
 */
import { Tag, Tooltip } from 'antd';
import type { ReviewState } from '@/types/revision';

interface Props {
  state: ReviewState;
  reason?: string;
}

export default function ReviewStateTag({ state, reason }: Props) {
  if (state === '已确认') return <Tag color="green">已确认</Tag>;
  return (
    <Tooltip title={reason || '待复核：确认后才生效'}>
      <Tag color="gold">待复核</Tag>
    </Tooltip>
  );
}
