/** /picks 优选 Take 汇总与备注：按用途排序并生成剪接清单 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message
} from 'antd';
import { HolderOutlined, PlusOutlined } from '@ant-design/icons';
import FilterBar from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import TakeBadge from '@/components/common/TakeBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import RevisionConflictAlert, { type RevisionConflictField } from '@/components/common/RevisionConflictAlert';
import { useIdbTable } from '@/hooks/useIdbTable';
import { usePickStore } from '@/stores/pickStore';
import {
  db,
  isRevisionConflict,
  type PickRow,
  type ProjectRow,
  type SessionRow,
  type SongRow,
  type TakeRow
} from '@/utils/db';
import { PICK_USAGES, createEmptyPick, type Pick } from '@/types/pick';
import type { FilterModel, FilterSelectConfig } from '@/types/filter';
import { isPickBasisFresh } from '@/utils/pickBasis';
import { buildEditList, formatDuration, takeDuration, totalDuration } from '@/utils/timecode';

const asArray = (value: string | string[] | boolean | undefined): string[] => (Array.isArray(value) ? value : []);

/** 优选表单字段（confirmState / basis 由保存动作自动维护） */
type PickFormValues = Omit<Pick, 'id' | 'order' | 'confirmState' | 'basis'>;

export default function PickSummary() {
  const [searchParams, setSearchParams] = useSearchParams();
  const picks = useIdbTable<PickRow>(db.picks);
  const takes = useIdbTable<TakeRow>(db.takes);
  const sessions = useIdbTable<SessionRow>(db.sessions);
  const songs = useIdbTable<SongRow>(db.songs);
  const projects = useIdbTable<ProjectRow>(db.projects);

  const filters = usePickStore((state) => state.filters);
  const setFilters = usePickStore((state) => state.setFilters);
  const resetFilters = usePickStore((state) => state.resetFilters);
  const createPick = usePickStore((state) => state.createPick);
  const editPick = usePickStore((state) => state.editPick);
  const confirmPick = usePickStore((state) => state.confirmPick);
  const deletePick = usePickStore((state) => state.deletePick);
  const move = usePickStore((state) => state.move);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PickRow | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  /** 打开编辑弹窗时读到的已读版本，保存前与库内版本比对 */
  const [baseRevision, setBaseRevision] = useState(0);
  const [conflict, setConflict] = useState<PickRow | null>(null);
  const [form] = Form.useForm<PickFormValues>();

  useEffect(() => {
    setFilters({
      keyword: searchParams.get('keyword') ?? '',
      usages: searchParams.get('usages') ? (searchParams.get('usages') as string).split(',') : []
    });
    // 仅首次挂载还原 URL 筛选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters(next: FilterModel): void {
    setFilters(next);
    const params: Record<string, string> = {};
    if (String(next.keyword ?? '').length > 0) params.keyword = String(next.keyword);
    asArray(next.usages).length > 0 && (params.usages = asArray(next.usages).join(','));
    setSearchParams(params, { replace: true });
  }

  const takeOf = (takeId: string): TakeRow | null => takes.find((item) => item.id === takeId) ?? null;
  const sessionOf = (sessionId: string): SessionRow | undefined => sessions.find((item) => item.id === sessionId);

  /** 优选是否仍有效：状态已确认且确认基准与当前 Take 时间码 / 棚号一致（双保险） */
  const isPickActive = (pick: PickRow): boolean => {
    if (pick.confirmState !== '已确认') return false;
    const take = takeOf(pick.takeId);
    const session = take ? sessionOf(take.sessionId) : undefined;
    if (!take || !session) return false;
    return isPickBasisFresh(pick, { startTc: take.startTc, endTc: take.endTc, roomNo: session.roomNo });
  };

  /** 待复核：状态标记待复核，或基准已与现值不符（历史数据 / 跨端写入兜底） */
  const pendingPicks = useMemo(() => picks.filter((pick) => !isPickActive(pick)), [picks, takes, sessions]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  /** 已确认优选（剪接清单只认这些） */
  const confirmedPicks = useMemo(() => picks.filter((pick) => isPickActive(pick)), [picks, takes, sessions]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const sessionLabel = (sessionId: string): string => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return '场次已删除';
    const song = songs.find((item) => item.id === session.songId);
    const project = song ? projects.find((item) => item.id === song.projectId) : undefined;
    return `${song ? song.title : '未知曲目'}${project ? ` · ${project.name}` : ''} · ${session.date} ${session.period}`;
  };

  /** 已确认清单上的用途 / 关键字筛选；待复核区不受筛选影响，保证不被漏掉 */
  const filtered = useMemo(() => {
    const keyword = String(filters.keyword ?? '').trim().toLowerCase();
    const usages = asArray(filters.usages);
    return confirmedPicks
      .filter((pick) => {
        const take = takeOf(pick.takeId);
        const label = `${pick.usage} ${pick.note} ${take ? take.takeNo : ''}`.toLowerCase();
        if (keyword && !label.includes(keyword)) return false;
        if (usages.length > 0 && !usages.includes(pick.usage)) return false;
        return true;
      })
      .sort((a, b) => a.order - b.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmedPicks, takes, filters]);

  const editList = useMemo(
    () =>
      filtered
        .map((pick) => takeOf(pick.takeId))
        .filter((take): take is TakeRow => take !== null)
        .map((take) => ({ takeNo: take.takeNo, startTc: take.startTc, endTc: take.endTc })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, takes]
  );

  const totals = useMemo(() => {
    const usable = takes.filter((take) => take.grade === '可用').length;
    return {
      pickCount: confirmedPicks.length,
      pendingCount: pendingPicks.length,
      usableTakeCount: usable,
      pickRatio: usable > 0 ? Math.round((confirmedPicks.length / usable) * 100) : 0,
      durationText: formatDuration(totalDuration(editList)),
      usageCount: new Set(confirmedPicks.map((item) => item.usage)).size
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmedPicks, pendingPicks, takes, editList]);

  /** 只有「可用」评级且尚未被优选（含待复核）的条次可作为候选 */
  const candidates = useMemo(
    () => takes.filter((take) => take.grade === '可用' && !picks.some((pick) => pick.takeId === take.id)),
    [takes, picks]
  );

  /** 打开编辑弹窗：记录已读版本，清掉旧冲突 */
  function openEdit(pick: PickRow): void {
    setEditing(pick);
    setBaseRevision(pick.revision);
    setConflict(null);
    form.setFieldsValue({ takeId: pick.takeId, usage: pick.usage, note: pick.note });
    setDialogOpen(true);
  }

  function openCreate(): void {
    setEditing(null);
    setConflict(null);
    setBaseRevision(0);
    form.setFieldsValue({ ...createEmptyPick(), takeId: candidates[0]?.id ?? '' });
    setDialogOpen(true);
  }

  /** 构造修订冲突的逐字段对比（保留输入 vs 库内最新值） */
  function buildConflictFields(latest: PickRow): RevisionConflictField<keyof PickFormValues>[] {
    const input = form.getFieldsValue(true);
    const fields: Array<[keyof PickFormValues, string]> = [
      ['takeId', '条次'],
      ['usage', '用途'],
      ['note', '备注']
    ];
    return fields
      .filter(([field]) => String(input[field] ?? '') !== String(latest[field]))
      .map(([field, label]) => ({
        fieldName: field,
        label,
        inputValue: field === 'takeId' ? takeLabel(String(input[field] ?? '')) : String(input[field] ?? ''),
        latestValue: field === 'takeId' ? takeLabel(String(latest[field])) : String(latest[field])
      }));
  }

  function takeLabel(takeId: string): string {
    const take = takeOf(takeId);
    return take ? `${take.takeNo} · ${take.startTc} → ${take.endTc}` : takeId;
  }

  /** 冲突解决：采用库内最新值（可逐字段或全部），并以最新版本为新的已读版本 */
  function adoptConflict(
    values: Partial<Record<keyof PickFormValues, string | number>>,
    latestRevision: number
  ): void {
    form.setFieldsValue(values as Partial<PickFormValues>);
    setBaseRevision(latestRevision);
    setConflict(null);
  }

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    try {
      if (editing) {
        await editPick(editing.id, values, baseRevision);
        message.success('优选记录已更新');
      } else {
        await createPick(values);
        message.success('已加入剪接清单');
      }
      setDialogOpen(false);
      setEditing(null);
      setConflict(null);
      form.resetFields();
    } catch (submitError) {
      if (isRevisionConflict(submitError)) {
        setConflict(submitError.latest as PickRow);
        return;
      }
      const text = submitError instanceof Error ? submitError.message : '保存失败';
      message.error(text);
    }
  }

  /** 复核确认：以当前时间码 / 棚号重算基准，确认后才进入剪接清单 */
  async function handleConfirm(pick: PickRow): Promise<void> {
    try {
      await confirmPick(pick.id, pick.revision);
      message.success('已确认，优选重新进入剪接清单');
    } catch (error) {
      if (isRevisionConflict(error)) {
        message.warning('该优选刚被其他页面改动，请刷新后重新复核');
        return;
      }
      message.error(error instanceof Error ? error.message : '确认失败');
    }
  }

  async function handleDrop(index: number): Promise<void> {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === index) return;
    await move(filtered as Pick[], from, index);
    message.success('剪接顺序已更新并写回本地库');
  }

  /** 待复核卡片：展示确认时基准与现值的差异 */
  function renderPendingCard(): JSX.Element {
    return (
      <Card
        title={
          <Space>
            <Tag color="orange">待复核区（{pendingPicks.length}）</Tag>
            <span className="muted">Take 时间码或棚号变更后自动转入，确认前不进入剪接清单</span>
          </Space>
        }
        style={{ marginBottom: 16, borderColor: '#f0c36d' }}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {pendingPicks.map((pick) => {
            const take = takeOf(pick.takeId);
            const session = take ? sessionOf(take.sessionId) : undefined;
            const basisParts = pick.basis.split(/→|@/);
            const fresh =
              take && session
                ? isPickBasisFresh(pick, { startTc: take.startTc, endTc: take.endTc, roomNo: session.roomNo })
                : false;
            return (
              <Card key={pick.id} size="small" style={{ background: '#fffbe6' }}>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space wrap>
                    <Tag color="orange">待复核</Tag>
                    <Tag color="blue">{pick.usage}</Tag>
                    <Typography.Text strong>{take ? take.takeNo : '条次已删除'}</Typography.Text>
                    <Typography.Text type="secondary">顺序 #{pick.order}</Typography.Text>
                  </Space>
                  <Space size={20} wrap>
                    <div>
                      <div className="muted">确认时基准</div>
                      <div>
                        {basisParts.length === 3
                          ? `${basisParts[0]} → ${basisParts[1]} · ${basisParts[2]}`
                          : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="muted">当前值</div>
                      <div>
                        {take && session
                          ? `${take.startTc} → ${take.endTc} · ${session.roomNo}`
                          : '条次或场次已删除'}
                      </div>
                    </div>
                  </Space>
                  {take && session && !fresh ? (
                    <Typography.Text type="warning">基准已变化，请核对当前时间码与棚号后再确认。</Typography.Text>
                  ) : null}
                  <Space>
                    <Button type="primary" size="small" disabled={!take || !session} onClick={() => void handleConfirm(pick)}>
                      核对无误，确认
                    </Button>
                    <Button size="small" onClick={() => openEdit(pick)}>
                      编辑
                    </Button>
                    <Popconfirm
                      title="移出剪接清单？"
                      onConfirm={async () => {
                        await deletePick(pick.id);
                        message.success('已移出剪接清单');
                      }}
                    >
                      <Button size="small" type="link" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                </Space>
              </Card>
            );
          })}
        </Space>
      </Card>
    );
  }

  const selects: FilterSelectConfig[] = [
    { key: 'usages', label: '用途', options: PICK_USAGES.map((item) => ({ label: item, value: item })) }
  ];

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">优选 Take 汇总与剪接清单</h2>
          <p className="page__subtitle">
            从「可用」评级的条次中挑选，拖拽卡片或用上下移按钮调整剪接顺序。Take 时间码 / 棚号变更后，关联优选转入待复核区，确认前不进入剪接清单。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} disabled={candidates.length === 0} onClick={openCreate}>
          加入优选
        </Button>
      </div>

      <div className="badge-row">
        <StatBadge label="已确认优选" value={totals.pickCount} suffix="条" tone="primary" icon="files" />
        <StatBadge label="待复核" value={totals.pendingCount} suffix="条" tone="warning" icon="warning" />
        <StatBadge label="可用 Take" value={totals.usableTakeCount} suffix="条" tone="success" icon="grid" />
        <StatBadge label="优选覆盖率" value={totals.pickRatio} percent={totals.pickRatio} showPercent tone="warning" icon="pie" />
        <StatBadge label="剪接总时长" value={totals.durationText} tone="info" icon="histogram" />
        <StatBadge label="用途种类" value={totals.usageCount} suffix="类" tone="danger" icon="trend" />
      </div>

      <FilterBar
        modelValue={filters}
        selects={selects}
        keywordPlaceholder="搜索用途 / 备注 / Take 号…"
        onChange={applyFilters}
        onReset={() => {
          resetFilters();
          setSearchParams({}, { replace: true });
        }}
        extra={<Tag color="blue">候选可用 Take {candidates.length} 条</Tag>}
      />

      {pendingPicks.length > 0 ? renderPendingCard() : null}

      {pendingPicks.length === 0 && filtered.length === 0 ? (
        <EmptyPanel
          title="剪接清单还是空的"
          description="从可用评级的 Take 中挑选片段，组成主歌 / 副歌 / 独奏的剪接清单。"
          showCreate={candidates.length > 0}
          createText="加入优选"
          onCreate={openCreate}
        />
      ) : (
        <Row gutter={16}>
          <Col xs={24} xl={15}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {filtered.map((pick, index) => {
                const take = takeOf(pick.takeId);
                return (
                  <Card
                    key={pick.id}
                    size="small"
                    draggable
                    className={dragIndex === index ? 'is-dragging' : overIndex === index ? 'is-over' : ''}
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setOverIndex(index);
                    }}
                    onDrop={() => void handleDrop(index)}
                    onDragEnd={() => setDragIndex(null)}
                    title={
                      <Space>
                        <HolderOutlined className="drag-handle" />
                        <span>#{index + 1}</span>
                        <Tag color="blue">{pick.usage}</Tag>
                        {take ? <TakeBadge grade={take.grade} issues={take.issues} showIssues={false} /> : null}
                      </Space>
                    }
                    extra={
                      <Space>
                        <Button
                          size="small"
                          disabled={index === 0}
                          onClick={() => void move(filtered as Pick[], index, index - 1)}
                        >
                          上移
                        </Button>
                        <Button
                          size="small"
                          disabled={index === filtered.length - 1}
                          onClick={() => void move(filtered as Pick[], index, index + 1)}
                        >
                          下移
                        </Button>
                        <Button size="small" type="link" onClick={() => openEdit(pick)}>
                          编辑
                        </Button>
                        <Popconfirm
                          title="移出剪接清单？"
                          onConfirm={async () => {
                            await deletePick(pick.id);
                            message.success('已移出剪接清单');
                          }}
                        >
                          <Button size="small" type="link" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    }
                  >
                    <Space direction="vertical" size={2}>
                      <Typography.Text>
                        {take ? `${take.takeNo} · ${take.startTc} → ${take.endTc}` : '条次已删除'}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {take ? `${sessionLabel(take.sessionId)} · 时长 ${formatDuration(takeDuration(take.startTc, take.endTc))}` : '—'}
                      </Typography.Text>
                      <Typography.Text type="secondary">备注：{pick.note || '—'}</Typography.Text>
                    </Space>
                  </Card>
                );
              })}
            </Space>
          </Col>
          <Col xs={24} xl={9}>
            <Card title="剪接清单（自动生成，仅含已确认优选）">
              {editList.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可拼接的片段" />
              ) : (
                <List
                  size="small"
                  dataSource={editList}
                  footer={
                    <Typography.Text strong>
                      合计时长 {formatDuration(totalDuration(editList))} · 共 {editList.length} 段
                    </Typography.Text>
                  }
                  renderItem={(item, index) => (
                    <List.Item>
                      <Space>
                        <Tag>{index + 1}</Tag>
                        <span>{item.takeNo}</span>
                        <Typography.Text type="secondary">
                          {item.startTc} → {item.endTc}
                        </Typography.Text>
                      </Space>
                    </List.Item>
                  )}
                />
              )}
              <Typography.Paragraph copyable={{ text: buildEditList(editList) }} style={{ marginTop: 12 }}>
                <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>{buildEditList(editList) || '（空）'}</pre>
              </Typography.Paragraph>
            </Card>
          </Col>
        </Row>
      )}

      <Card title="优选明细表" style={{ marginTop: 16 }}>
        <Table<PickRow>
          rowKey="id"
          dataSource={[...picks].sort((a, b) => a.order - b.order)}
          pagination={false}
          locale={{ emptyText: '暂无优选记录' }}
          columns={[
            { title: '顺序', dataIndex: 'order', width: 80 },
            {
              title: '确认状态',
              dataIndex: 'confirmState',
              width: 100,
              render: (_, row) =>
                isPickActive(row) ? <Tag color="green">已确认</Tag> : <Tag color="orange">待复核</Tag>
            },
            { title: '用途', dataIndex: 'usage', width: 100 },
            {
              title: '条次',
              minWidth: 200,
              render: (_, row) => {
                const take = takeOf(row.takeId);
                return take ? `${take.takeNo} · ${take.startTc} → ${take.endTc}` : '条次已删除';
              }
            },
            { title: '备注', dataIndex: 'note', minWidth: 200 },
            {
              title: '时长',
              width: 100,
              render: (_, row) => {
                const take = takeOf(row.takeId);
                return take ? formatDuration(takeDuration(take.startTc, take.endTc)) : '—';
              }
            },
            {
              title: '操作',
              width: 110,
              render: (_, row) =>
                isPickActive(row) ? (
                  <Button size="small" type="link" onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                ) : (
                  <Button size="small" type="primary" onClick={() => void handleConfirm(row)}>
                    复核确认
                  </Button>
                )
            }
          ]}
        />
      </Card>

      <Modal
        open={dialogOpen}
        title={editing ? '编辑优选记录' : '加入剪接清单'}
        onCancel={() => setDialogOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        {conflict ? (
          <RevisionConflictAlert<keyof PickFormValues>
            fields={buildConflictFields(conflict)}
            latestRevision={conflict.revision}
            onAdopt={adoptConflict}
          />
        ) : null}
        <Form form={form} layout="vertical">
          <Form.Item name="takeId" label="条次" rules={[{ required: true, message: '请选择条次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={(editing ? takes.filter((take) => take.grade === '可用' || take.id === editing.takeId) : candidates).map(
                (take) => ({
                  label: `${take.takeNo} · ${take.startTc} → ${take.endTc}`,
                  value: take.id
                })
              )}
            />
          </Form.Item>
          <Form.Item name="usage" label="用途" rules={[{ required: true }]}>
            <Select options={PICK_USAGES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="如：鼓组干净，可作主歌第一段" />
          </Form.Item>
          {editing ? (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: -4 }}
              message="换选条次保存后将以新条次当前时间码 / 棚号作为确认基准，直接进入剪接清单。"
            />
          ) : null}
        </Form>
      </Modal>
    </div>
  );
}
