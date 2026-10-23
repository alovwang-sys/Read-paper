import { ArrowUpRight, Clock3, Layers, Languages, MessageCircle, Quote } from 'lucide-react';
import type { ReaderActivity } from '../../domain/types';

const labels = { question: '提问', translation: '翻译', summary: '摘要卡片', excerpt: '保存摘录', highlight: '高亮', card: '制作卡片' };
const statuses = { generating: '进行中', done: '已完成', error: '失败', stopped: '已停止', interrupted: '已中断', draft: '草稿' };

export function ReaderActivityList({ activities, onOpen }: { activities: ReaderActivity[]; onOpen: (activity: ReaderActivity) => void }) {
  return <section className="reader-activity-list" aria-label="此处操作记录">
    <header><Clock3 size={13} /><span>此处记录</span><small>{activities.length}条</small></header>
    {activities.length ? activities.map(activity => {
      const Icon = activity.kind === 'question' ? MessageCircle : activity.kind === 'translation' ? Languages : activity.kind === 'summary' || activity.kind === 'card' ? Layers : Quote;
      const canOpen = !!(activity.conversationId || activity.cardId || activity.draftId);
      return <button key={activity.id} className={`reader-activity-row ${activity.status === 'error' || activity.status === 'interrupted' ? 'has-error' : ''}`}
        disabled={!canOpen} onClick={() => onOpen(activity)}>
        <Icon size={14} /><span><strong>{labels[activity.kind]}<small>{statuses[activity.status]}</small></strong>
          {activity.body && <span className="reader-activity-preview">{activity.body}</span>}
          {activity.error && <span className="reader-activity-error">{activity.error}</span>}
          <time dateTime={activity.createdAt}>{new Date(activity.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
        </span>{canOpen && <ArrowUpRight size={13} />}
      </button>;
    }) : <p>此处尚无已提交的操作。</p>}
  </section>;
}
