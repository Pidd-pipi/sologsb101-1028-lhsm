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
import ReviewStateTag from '@/components/common/ReviewStateTag';
import RevisionConflictAlert from '@/components/common/RevisionConflictAlert';
import { useIdbTable } from '@/hooks/useIdbTable';
import { usePickStore } from '@/stores/pickStore';
import { db, type PickRow, type ProjectRow, type SessionRow, type SongRow, type TakeRow } from '@/utils/db';
import { isRevisionConflict, type RevisionConflictError } from '@/utils/concurrency';
import { PICK_USAGES, createEmptyPick, type Pick } from '@/types/pick';
import type { FilterModel, FilterSelectConfig } from '@/types/filter';
import { buildEditList, formatDuration, takeDuration, totalDuration } from '@/utils/timecode';

const asArray = (value: string | string[] | boolean | undefined): string[] => (Array.isArray(value) ? value : []);

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
  const reorder = usePickStore((state) => state.reorder);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PickRow | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  /** 修订保存冲突：保留输入并列差异，未解决前不能写新版本 */
  const [conflict, setConflict] = useState<RevisionConflictError | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [form] = Form.useForm<Omit<Pick, 'id' | 'order'>>();

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

  const sessionLabel = (sessionId: string): string => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return '场次已删除';
    const song = songs.find((item) => item.id === session.songId);
    const project = song ? projects.find((item) => item.id === song.projectId) : undefined;
    return `${song ? song.title : '未知曲目'}${project ? ` · ${project.name}` : ''} · ${session.date} ${session.period}`;
  };

  /** 按 order 排序的全部优选（用于拖拽时取已读版本） */
  const orderedPicks = useMemo(() => [...picks].sort((a, b) => a.order - b.order), [picks]);

  const filtered = useMemo(() => {
    const keyword = String(filters.keyword ?? '').trim().toLowerCase();
    const usages = asArray(filters.usages);
    return orderedPicks.filter((pick) => {
      const take = takeOf(pick.takeId);
      const label = `${pick.usage} ${pick.note} ${take ? take.takeNo : ''}`.toLowerCase();
      if (keyword && !label.includes(keyword)) return false;
      if (usages.length > 0 && !usages.includes(pick.usage)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedPicks, takes, filters]);

  /** 待复核优选：Take 时间码 / 棚号变化后失效重算，确认前不进入剪接清单 */
  const pendingPicks = useMemo(() => orderedPicks.filter((pick) => pick.reviewState === '待复核'), [orderedPicks]);

  /**
   * 剪接清单只派生自已确认的优选：
   * 失效重算中的待复核优选一律排除，直到复核区 / 本页确认后才纳入。
   */
  const confirmedPicks = useMemo(() => filtered.filter((pick) => pick.reviewState === '已确认'), [filtered]);

  const editList = useMemo(
    () =>
      confirmedPicks
        .map((pick) => takeOf(pick.takeId))
        .filter((take): take is TakeRow => take !== null)
        .map((take) => ({ takeNo: take.takeNo, startTc: take.startTc, endTc: take.endTc })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirmedPicks, takes]
  );

  const totals = useMemo(() => {
    const usable = takes.filter((take) => take.grade === '可用').length;
    return {
      pickCount: picks.length,
      pendingCount: pendingPicks.length,
      usableTakeCount: usable,
      pickRatio: usable > 0 ? Math.round((picks.length / usable) * 100) : 0,
      durationText: formatDuration(totalDuration(editList)),
      usageCount: new Set(picks.map((item) => item.usage)).size
    };
  }, [picks, takes, editList, pendingPicks.length]);

  /** 只有「可用」评级且尚未被优选的条次可作为候选 */
  const candidates = useMemo(
    () => takes.filter((take) => take.grade === '可用' && !picks.some((pick) => pick.takeId === take.id)),
    [takes, picks]
  );

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    try {
      if (editing) {
        // 已读的 order 原样回传；若期间顺序被别的标签页调整，乐观锁会拦截
        await editPick(editing.id, { ...values, id: editing.id, order: editing.order }, editing);
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
        setConflict(submitError);
        message.error(submitError.message);
        return;
      }
      message.error(submitError instanceof Error ? submitError.message : '保存失败');
    }
  }

  /**
   * 以当前展示顺序构造移动指令（携带每条的已读 editVersion）。
   * 只重排筛选视图内的优选：按它们在全库中占据的顺序槽位回填 order，
   * 不影响视图外优选；任一条已被其他标签页改动，整笔回滚、顺序不变。
   */
  function buildMoveEntries(from: number, to: number): Array<{ id: string; baseVersion: number; order: number }> {
    const slots = filtered.map((pick) => pick.order).sort((a, b) => a - b);
    const nextView = [...filtered];
    const [moved] = nextView.splice(from, 1);
    nextView.splice(to, 0, moved);
    return nextView.map((pick, index) => ({
      id: pick.id,
      baseVersion: pick.editVersion,
      order: slots[index] ?? index + 1
    }));
  }

  async function handleDrop(index: number): Promise<void> {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === index) return;
    setOrderError(null);
    try {
      await reorder(buildMoveEntries(from, index));
      message.success('剪接顺序已更新并写回本地库');
    } catch (reorderError) {
      const text = reorderError instanceof Error ? reorderError.message : '排序保存失败';
      setOrderError(text);
      message.error(text);
    }
  }

  /** 复核确认优选：按最新 Take / 场次重算快照，确认后进入剪接清单 */
  async function handleConfirm(pick: PickRow): Promise<void> {
    try {
      await confirmPick(pick.id, pick.editVersion);
      message.success('优选已重算并确认，已纳入剪接清单');
    } catch (confirmError) {
      message.error(confirmError instanceof Error ? confirmError.message : '确认失败，请刷新后重试');
    }
  }

  const selects: FilterSelectConfig[] = [
    { key: 'usages', label: '用途', options: PICK_USAGES.map((item) => ({ label: item, value: item })) }
  ];

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">优选 Take 汇总与剪接清单</h2>
          <p className="page__subtitle">从「可用」评级的条次中挑选，拖拽卡片或用上下移按钮调整剪接顺序。</p>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={candidates.length === 0}
          onClick={() => {
            setEditing(null);
            setConflict(null);
            form.setFieldsValue({ ...createEmptyPick(), takeId: candidates[0]?.id ?? '' });
            setDialogOpen(true);
          }}
        >
          加入优选
        </Button>
      </div>

      <div className="badge-row">
        <StatBadge label="优选条次" value={totals.pickCount} suffix="条" tone="primary" icon="files" />
        <StatBadge label="待复核" value={totals.pendingCount} suffix="条" tone="warning" icon="warning" />
        <StatBadge label="可用 Take" value={totals.usableTakeCount} suffix="条" tone="success" icon="grid" />
        <StatBadge label="优选覆盖率" value={totals.pickRatio} percent={totals.pickRatio} showPercent tone="warning" icon="pie" />
        <StatBadge label="剪接总时长" value={totals.durationText} tone="info" icon="histogram" />
        <StatBadge label="用途种类" value={totals.usageCount} suffix="类" tone="danger" icon="trend" />
      </div>

      {totals.pendingCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`${totals.pendingCount} 条优选因 Take 时间码或棚号变化已失效重算，确认前不进入剪接清单`}
          description="可在下方卡片逐条「重算并确认」，或到修订复核区集中处理。"
        />
      ) : null}
      {orderError ? (
        <Alert type="error" showIcon closable style={{ marginBottom: 12 }} message={orderError} onClose={() => setOrderError(null)} />
      ) : null}

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

      {filtered.length === 0 ? (
        <EmptyPanel
          title="剪接清单还是空的"
          description="从可用评级的 Take 中挑选片段，组成主歌 / 副歌 / 独奏的剪接清单。"
          showCreate={candidates.length > 0}
          createText="加入优选"
          onCreate={() => {
            setEditing(null);
            setConflict(null);
            form.setFieldsValue({ ...createEmptyPick(), takeId: candidates[0]?.id ?? '' });
            setDialogOpen(true);
          }}
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
                        <ReviewStateTag state={pick.reviewState} reason={pick.reviewReason} />
                        <Tag>v{pick.editVersion}</Tag>
                      </Space>
                    }
                    extra={
                      <Space>
                        {pick.reviewState === '待复核' ? (
                          <Button size="small" type="primary" ghost onClick={() => void handleConfirm(pick)}>
                            重算并确认
                          </Button>
                        ) : null}
                        <Button
                          size="small"
                          disabled={index === 0}
                          onClick={() => void reorder(buildMoveEntries(index, index - 1))}
                        >
                          上移
                        </Button>
                        <Button
                          size="small"
                          disabled={index === filtered.length - 1}
                          onClick={() => void reorder(buildMoveEntries(index, index + 1))}
                        >
                          下移
                        </Button>
                        <Button
                          size="small"
                          type="link"
                          onClick={() => {
                            setEditing(pick);
                            setConflict(null);
                            form.setFieldsValue({ takeId: pick.takeId, usage: pick.usage, note: pick.note });
                            setDialogOpen(true);
                          }}
                        >
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
                      {pick.reviewState === '待复核' ? (
                        <Typography.Text type="warning">失效原因：{pick.reviewReason || '来源数据已变，需重算确认'}</Typography.Text>
                      ) : null}
                    </Space>
                  </Card>
                );
              })}
            </Space>
          </Col>
          <Col xs={24} xl={9}>
            <Card title="剪接清单（自动生成）">
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

      <Card title="优选明细表">
        <Table<PickRow>
          rowKey="id"
          dataSource={filtered}
          pagination={false}
          locale={{ emptyText: '暂无优选记录' }}
          columns={[
            { title: '顺序', dataIndex: 'order', width: 70 },
            { title: '用途', dataIndex: 'usage', width: 90 },
            {
              title: '条次',
              minWidth: 200,
              render: (_, row) => {
                const take = takeOf(row.takeId);
                return take ? `${take.takeNo} · ${take.startTc} → ${take.endTc}` : '条次已删除';
              }
            },
            {
              title: '复核',
              width: 150,
              render: (_, row) => (
                <Space size={4}>
                  <ReviewStateTag state={row.reviewState} reason={row.reviewReason} />
                  {row.reviewState === '待复核' ? (
                    <Button type="link" size="small" onClick={() => void handleConfirm(row)}>
                      确认
                    </Button>
                  ) : null}
                </Space>
              )
            },
            { title: '备注', dataIndex: 'note', minWidth: 160 },
            {
              title: '时长',
              width: 100,
              render: (_, row) => {
                const take = takeOf(row.takeId);
                return take ? formatDuration(takeDuration(take.startTc, take.endTc)) : '—';
              }
            }
          ]}
        />
      </Card>

      <Modal
        open={dialogOpen}
        title={
          editing ? (
            <Space>
              <span>编辑优选记录</span>
              <Tag>已读版本 v{editing.editVersion}</Tag>
              {editing.reviewState === '待复核' ? <Tag color="gold">待复核</Tag> : null}
            </Space>
          ) : (
            '加入剪接清单'
          )
        }
        onCancel={() => setDialogOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        {conflict ? (
          <RevisionConflictAlert
            latestVersion={conflict.latestVersion}
            fields={conflict.fields}
            idLabels={Object.fromEntries(
              takes.map((take) => [take.id, `${take.takeNo} · ${take.startTc} → ${take.endTc}`])
            )}
            onLoadLatest={() => {
              const latest = picks.find((item) => item.id === conflict.rowId);
              if (!latest) {
                message.warning('最新数据尚未同步到本页，请稍后再试');
                return;
              }
              setEditing(latest);
              form.setFieldsValue({ takeId: latest.takeId, usage: latest.usage, note: latest.note });
              setConflict(null);
            }}
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
        </Form>
      </Modal>
    </div>
  );
}
