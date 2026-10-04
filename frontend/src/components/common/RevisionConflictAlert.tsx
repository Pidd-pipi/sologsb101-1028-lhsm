/**
 * 修订保存冲突提示：保存前比对已读版本发现落后时展示。
 * 保留用户在表单里的输入不关闭弹窗，并逐字段并列「我的输入 / 最新值」。
 */
import { Alert, Button, Space, Table, Tag, Typography } from 'antd';
import type { RevisionConflictField } from '@/types/revision';

interface Props {
  /** 数据库最新版本号 */
  latestVersion: number;
  /** 逐字段差异（可能为空，例如复核确认 / 排序时的版本落后） */
  fields: RevisionConflictField[];
  /** 载入最新值：放弃当前输入并用库内最新行回填表单 */
  onLoadLatest: () => void;
  /** id 类字段（如曲目 / 条次）的 id → 可读名称映射，命中则展示名称并附带 id */
  idLabels?: Record<string, string>;
}

function renderValue(value: string, idLabels?: Record<string, string>): string {
  if (idLabels && idLabels[value]) return `${idLabels[value]}（${value}）`;
  return value;
}

export default function RevisionConflictAlert({ latestVersion, fields, onLoadLatest, idLabels }: Props) {
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 12 }}
      message={`保存被拦截：该记录已被其他标签页更新到 v${latestVersion}，你的输入已保留`}
      description={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            请核对下列冲突字段：继续保存仍会被拒绝，可载入最新值后重做修改，或调整后再试。
          </Typography.Text>
          {fields.length > 0 ? (
            <Table
              size="small"
              rowKey="label"
              pagination={false}
              dataSource={fields}
              columns={[
                { title: '字段', dataIndex: 'label', width: 110 },
                {
                  title: '已读值',
                  dataIndex: 'base',
                  render: (value: string) => <Tag>{renderValue(value, idLabels)}</Tag>
                },
                {
                  title: '我的输入（保留）',
                  dataIndex: 'mine',
                  render: (value: string) => <Tag color="orange">{renderValue(value, idLabels)}</Tag>
                },
                {
                  title: '数据库最新值',
                  dataIndex: 'latest',
                  render: (value: string) => <Tag color="blue">{renderValue(value, idLabels)}</Tag>
                }
              ]}
            />
          ) : null}
          <Button size="small" onClick={onLoadLatest}>
            载入最新值到表单
          </Button>
        </Space>
      }
    />
  );
}
