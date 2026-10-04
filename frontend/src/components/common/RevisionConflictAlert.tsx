/**
 * 修订冲突提示：多标签同时编辑、已读版本落后时展示。
 * - 保留用户当前输入，逐字段与库内最新值并列对比
 * - 可逐字段「采用」或一键「全部采用最新值」；采用后以最新版本为基准重新保存
 * 被场次页、Take 标记台与优选汇总页共同消费。
 */
import { Alert, Button, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

export interface RevisionConflictField<F extends string = string> {
  /** 表单字段名（回填到 Form） */
  fieldName: F;
  /** 字段中文标签 */
  label: string;
  /** 弹窗里保留的用户输入 */
  inputValue: string | number;
  /** 库内最新值（其他标签 / 页面已保存） */
  latestValue: string | number;
}

interface RevisionConflictAlertProps<F extends string = string> {
  /** 字段级冲突明细 */
  fields: RevisionConflictField<F>[];
  /** 采用最新值：回填的字段值 + 新的已读修订号 */
  onAdopt: (values: Partial<Record<F, string | number>>, latestRevision: number) => void;
  /** 库内最新行的修订号 */
  latestRevision: number;
  /** 可选补充说明（如联动失效条数） */
  extra?: React.ReactNode;
}

export default function RevisionConflictAlert<F extends string = string>({
  fields,
  onAdopt,
  latestRevision,
  extra
}: RevisionConflictAlertProps<F>): JSX.Element {
  const allValues = fields.reduce(
    (acc, field) => ({ ...acc, [field.fieldName]: field.latestValue }),
    {} as Record<F, string | number>
  );

  const columns: ColumnsType<RevisionConflictField<F>> = [
    { title: '字段', dataIndex: 'label', width: 110 },
    {
      title: '你的输入（已保留）',
      width: 180,
      render: (_, field) => <Tag color="orange">{String(field.inputValue)}</Tag>
    },
    {
      title: '库内最新值',
      width: 180,
      render: (_, field) => <Tag color="green">{String(field.latestValue)}</Tag>
    },
    {
      title: '操作',
      width: 90,
      render: (_, field) => (
        <Button
          type="link"
          size="small"
          onClick={() => onAdopt({ [field.fieldName]: field.latestValue } as Partial<Record<F, string | number>>, latestRevision)}
        >
          采用
        </Button>
      )
    }
  ];

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="检测到修订冲突：该记录已被其他页面（标签页）保存过，你的输入已保留，未写入任何内容"
      description={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            请逐字段核对：保留自己的输入或采用库内最新值；采用后即按最新版本继续保存。
          </Typography.Text>
          <Table<RevisionConflictField<F>>
            rowKey="fieldName"
            size="small"
            pagination={false}
            dataSource={fields}
            columns={columns}
          />
          <Space>
            <Button size="small" onClick={() => onAdopt(allValues, latestRevision)}>
              全部采用最新值
            </Button>
            {extra}
          </Space>
        </Space>
      }
    />
  );
}
