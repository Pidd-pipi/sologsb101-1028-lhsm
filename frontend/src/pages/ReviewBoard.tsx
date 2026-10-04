/**
 * /review 修订复核区
 *
 * 集中处理三类「待复核」数据：
 * - 场次：旧数据升级，或多标签页并发改动后需棚务统筹确认排期；
 * - Take：旧数据升级，或时间码 / 棚号被其他标签页改动；
 * - 优选：Take 时间码或棚号变化后已失效重算，确认前不进入剪接清单。
 *
 * 确认同样走乐观锁：确认期间记录又被改动会返回冲突，需刷新后重试，
 * 避免把别人的新改动当作旧版本盖掉。原有的场次 / Take / 优选页面保持可用，
 * 那里也能看到复核标签并逐条确认。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Popconfirm,
  Row,
  Space,
  Table,
  Tag,
  Typography,
  message
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import StatBadge from '@/components/common/StatBadge';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useSessionStore } from '@/stores/sessionStore';
import { useTakeStore } from '@/stores/takeStore';
import { usePickStore } from '@/stores/pickStore';
import {
  db,
  type PickRow,
  type ProjectRow,
  type SessionRow,
  type SongRow,
  type TakeRow
} from '@/utils/db';
import ReviewStateTag from '@/components/common/ReviewStateTag';
import { formatDuration, takeDuration } from '@/utils/timecode';

export default function ReviewBoard() {
  const sessions = useIdbTable<SessionRow>(db.sessions);
  const takes = useIdbTable<TakeRow>(db.takes);
  const picks = useIdbTable<PickRow>(db.picks);
  const songs = useIdbTable<SongRow>(db.songs);
  const projects = useIdbTable<ProjectRow>(db.projects);

  const confirmSession = useSessionStore((state) => state.confirmSession);
  const confirmTake = useTakeStore((state) => state.confirmTake);
  const confirmPick = usePickStore((state) => state.confirmPick);

  const [busyId, setBusyId] = useState<string | null>(null);

  const pendingSessions = useMemo(
    () => sessions.filter((item) => item.reviewState === '待复核').sort((a, b) => a.date.localeCompare(b.date)),
    [sessions]
  );
  const pendingTakes = useMemo(
    () => takes.filter((item) => item.reviewState === '待复核'),
    [takes]
  );
  const pendingPicks = useMemo(
    () => picks.filter((item) => item.reviewState === '待复核').sort((a, b) => a.order - b.order),
    [picks]
  );

  const takeOf = (takeId: string): TakeRow | undefined => takes.find((item) => item.id === takeId);
  const songOf = (songId: string): SongRow | undefined => songs.find((item) => item.id === songId);

  const songTitle = (songId: string): string => songOf(songId)?.title ?? '曲目已删除';
  const projectNameOf = (songId: string): string => {
    const song = songOf(songId);
    const project = song ? projects.find((item) => item.id === song.projectId) : undefined;
    return project?.name ?? '项目已删除';
  };

  async function runWithBusy(id: string, action: () => Promise<void>, successText: string): Promise<void> {
    setBusyId(id);
    try {
      await action();
      message.success(successText);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败，请刷新后重试');
    } finally {
      setBusyId(null);
    }
  }

  async function confirmMany(
    rows: Array<{ id: string; editVersion: number }>,
    run: (id: string, version: number) => Promise<void>,
    label: string
  ): Promise<void> {
    let done = 0;
    for (const row of rows) {
      try {
        await run(row.id, row.editVersion);
        done += 1;
      } catch (error) {
        message.error(
          `${label}确认中断：${error instanceof Error ? error.message : '请刷新后重试'}（已确认 ${done} 条）`
        );
        return;
      }
    }
    message.success(`${label}已全部确认（${done} 条）`);
  }

  const sessionColumns: ColumnsType<SessionRow> = [
    {
      title: '曲目 / 项目',
      render: (_, row) => (
        <div>
          <div>{songTitle(row.songId)}</div>
          <div className="muted">{projectNameOf(row.songId)}</div>
        </div>
      )
    },
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '时段', dataIndex: 'period', width: 80 },
    { title: '棚号', dataIndex: 'roomNo', width: 90 },
    { title: '录音师', dataIndex: 'engineer', width: 90 },
    {
      title: '状态',
      dataIndex: 'state',
      width: 90,
      render: (value: string) => <Tag>{value}</Tag>
    },
    {
      title: '待复核原因',
      dataIndex: 'reviewReason',
      render: (value: string) => <Typography.Text type="warning">{value || '—'}</Typography.Text>
    },
    {
      title: '操作',
      width: 110,
      render: (_, row) => (
        <Button
          type="primary"
          size="small"
          loading={busyId === row.id}
          onClick={() => void runWithBusy(row.id, () => confirmSession(row.id, row.editVersion), '场次已确认')}
        >
          确认无误
        </Button>
      )
    }
  ];

  const takeColumns: ColumnsType<TakeRow> = [
    { title: 'Take 号', dataIndex: 'takeNo', width: 90 },
    {
      title: '所属场次',
      render: (_, row) => {
        const session = sessions.find((item) => item.id === row.sessionId);
        return session ? `${session.date} ${session.period} · ${session.roomNo}` : '场次已删除';
      }
    },
    { title: '起始', dataIndex: 'startTc', width: 120 },
    { title: '结束', dataIndex: 'endTc', width: 120 },
    {
      title: '时长',
      width: 100,
      render: (_, row) => formatDuration(takeDuration(row.startTc, row.endTc))
    },
    { title: '评级', dataIndex: 'grade', width: 80 },
    {
      title: '待复核原因',
      dataIndex: 'reviewReason',
      render: (value: string) => <Typography.Text type="warning">{value || '—'}</Typography.Text>
    },
    {
      title: '操作',
      width: 110,
      render: (_, row) => (
        <Button
          type="primary"
          size="small"
          loading={busyId === row.id}
          onClick={() => void runWithBusy(row.id, () => confirmTake(row.id, row.editVersion), 'Take 已确认')}
        >
          确认无误
        </Button>
      )
    }
  ];

  const pickColumns: ColumnsType<PickRow> = [
    { title: '顺序', dataIndex: 'order', width: 70 },
    { title: '用途', dataIndex: 'usage', width: 80 },
    {
      title: '被选 Take（最新值）',
      render: (_, row) => {
        const take = takeOf(row.takeId);
        if (!take) return <Tag color="red">条次已删除，请移出该优选</Tag>;
        return (
          <div>
            <div>
              {take.takeNo} · {take.startTc} → {take.endTc}
            </div>
            <div className="muted">评级 {take.grade}</div>
          </div>
        );
      }
    },
    {
      title: '失效时快照',
      width: 260,
      render: (_, row) => (
        <div className="muted">
          <div>
            {row.srcStartTc} → {row.srcEndTc}
          </div>
          <div>棚号：{row.srcRoomNo || '未知'}</div>
        </div>
      )
    },
    {
      title: '失效 / 待复核原因',
      dataIndex: 'reviewReason',
      render: (value: string) => <Typography.Text type="warning">{value || '—'}</Typography.Text>
    },
    {
      title: '操作',
      width: 200,
      render: (_, row) => (
        <Space>
          <Button
            type="primary"
            size="small"
            disabled={takeOf(row.takeId) === undefined}
            loading={busyId === row.id}
            onClick={() =>
              void runWithBusy(row.id, () => confirmPick(row.id, row.editVersion), '优选已重算并确认，纳入剪接清单')
            }
          >
            重算并确认
          </Button>
          <Popconfirm
            title="该优选依据已失效，移出剪接清单？"
            onConfirm={() => void runWithBusy(row.id, () => db.picks.delete(row.id), '优选已移出')}
          >
            <Button size="small" danger>
              移出
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  const totalPending = pendingSessions.length + pendingTakes.length + pendingPicks.length;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">修订复核区</h2>
          <p className="page__subtitle">
            旧数据升级后在此集中复核；Take 时间码或棚号变化导致失效的优选，重算确认后才会重新进入剪接清单。
          </p>
        </div>
      </div>

      <div className="badge-row">
        <StatBadge label="待复核场次" value={pendingSessions.length} suffix="场" tone="warning" icon="grid" />
        <StatBadge label="待复核 Take" value={pendingTakes.length} suffix="条" tone="warning" icon="files" />
        <StatBadge label="待复核优选" value={pendingPicks.length} suffix="条" tone="danger" icon="warning" />
        <StatBadge label="待复核合计" value={totalPending} suffix="项" tone="primary" icon="histogram" />
      </div>

      {totalPending === 0 ? (
        <Card>
          <Empty description="没有待复核内容：所有场次 / Take / 优选均已确认" />
        </Card>
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="复核确认同样受修订保护"
          description="若确认期间该记录又被其他标签页更新，确认会被拒绝并提示刷新，不会用旧版本覆盖新改动。"
        />
      )}

      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card
            title={
              <Space>
                <span>待复核场次</span>
                <ReviewStateTag state="待复核" />
              </Space>
            }
            extra={
              <Button
                size="small"
                disabled={pendingSessions.length === 0 || busyId !== null}
                onClick={() => void confirmMany(pendingSessions, confirmSession, '场次')}
              >
                全部确认（{pendingSessions.length}）
              </Button>
            }
          >
            <Table<SessionRow>
              rowKey="id"
              size="small"
              pagination={false}
              locale={{ emptyText: '无待复核场次' }}
              dataSource={pendingSessions}
              columns={sessionColumns}
            />
          </Card>
        </Col>
        <Col span={24}>
          <Card
            title={
              <Space>
                <span>待复核 Take</span>
                <ReviewStateTag state="待复核" />
              </Space>
            }
            extra={
              <Button
                size="small"
                disabled={pendingTakes.length === 0 || busyId !== null}
                onClick={() => void confirmMany(pendingTakes, confirmTake, 'Take')}
              >
                全部确认（{pendingTakes.length}）
              </Button>
            }
          >
            <Table<TakeRow>
              rowKey="id"
              size="small"
              pagination={false}
              locale={{ emptyText: '无待复核 Take' }}
              dataSource={pendingTakes}
              columns={takeColumns}
            />
          </Card>
        </Col>
        <Col span={24}>
          <Card
            title={
              <Space>
                <span>待复核优选（确认前不进入剪接清单）</span>
                <ReviewStateTag state="待复核" />
              </Space>
            }
            extra={
              <Button
                size="small"
                type="primary"
                ghost
                disabled={
                  pendingPicks.every((pick) => takeOf(pick.takeId) === undefined) || busyId !== null
                }
                onClick={() => void confirmMany(pendingPicks.filter((pick) => takeOf(pick.takeId)), confirmPick, '优选')}
              >
                全部重算并确认
              </Button>
            }
          >
            <Table<PickRow>
              rowKey="id"
              size="small"
              pagination={false}
              locale={{ emptyText: '无待复核优选' }}
              dataSource={pendingPicks}
              columns={pickColumns}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
