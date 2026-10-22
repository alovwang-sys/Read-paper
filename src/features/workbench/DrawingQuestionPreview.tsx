import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { DrawingQuestion } from '../../domain/types';
import { drawingTextLength } from '../../domain/drawing-question';
import { loadDrawingImage } from '../../services/drawing-question';

export function DrawingQuestionPreview({ question, historical = false, onRemove }: { question: DrawingQuestion; historical?: boolean; onRemove?: () => void }) {
  const { snapshot, mode } = question;
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false, objectUrl = '';
    setUrl(''); setError('');
    void loadDrawingImage(snapshot).then(blob => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(problem => { if (!cancelled) setError((problem as Error).message); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [snapshot.hash, snapshot.image.assetId, snapshot.image.hash]);
  const endpoint = (id?: string, outside?: boolean) => {
    if (outside) return '选区外';
    if (!id) return '未连接';
    const element = snapshot.elements.find(item => item.id === id);
    const label = element?.text || element?.resource?.title;
    return label ? `${label.slice(0, 28)}（${id}）` : id;
  };
  return <section className={`research-drawing-attachment${historical ? ' research-drawing-attachment-history' : ''}`} aria-label={historical ? '这轮的绘图快照' : '待发送的绘图选区'}>
    <details>
      <summary>
        <span className="research-drawing-thumbnail">{url ? <img src={url} alt="所选绘图的实际快照"/> : <span>{error ? '预览不可用' : '加载图片…'}</span>}</span>
        <span className="research-drawing-caption"><strong>{snapshot.boardTitle} · 局部选区</strong><small>{snapshot.elements.length} 个元素 · {drawingTextLength(snapshot)} 字符 · {mode === 'image' ? '图片＋文字与结构' : '仅文字与结构，Agent 未看图'}</small><span>{error || (historical ? '查看当时的快照与范围' : '查看将发送的图片与内容')}</span></span>
      </summary>
      <div className="research-drawing-details">
        {error ? <p className="research-agent-error" role="alert">{error}</p> : url ? <img className="research-drawing-full-image" src={url} alt={mode === 'image' ? '发送给 Agent 的选区图片' : '保存的选区图片，这轮未发送图片'}/> : <p role="status">正在加载选区图片…</p>}
        <p>{mode === 'image' ? `一张 ${snapshot.image.width} × ${snapshot.image.height} PNG，附带以下文字和结构。` : '本轮只发送以下文字和结构，不发送图片；Agent 无法看见笔迹与图片内容。'}未追加论文原文。</p>
        <p>{historical ? '本轮历史范围：提交时同会话' : '延续当前会话'}已完成问答；历史最多 80,000 字符，超限会明确提示而不静默裁剪；不读取其他会话。历史引用不作为本轮论文依据。</p>
        <div className="research-drawing-text" aria-label="选区文字与结构">
          {snapshot.elements.map(element => <section key={element.id}><strong>{element.resource?.title || element.type} <code>{element.id}</code></strong><small>位置 ({element.x}, {element.y}) · 尺寸 {element.width} × {element.height} · 角度 {element.angle}</small>{element.text && <p>{element.text}</p>}{element.resource && <><small>{element.resource.ref.kind === 'card' ? '卡片' : '论文入口'} · {element.resource.ref.id}</small><p>{element.resource.body || '正文为空'}</p></>}</section>)}
          {snapshot.connections.length > 0 && <section><strong>所选连线</strong>{snapshot.connections.map(connection => <p key={connection.id}><code>{connection.id}</code>：{endpoint(connection.startId, connection.startOutside)} {connection.startArrowhead === 'arrow' ? '←' : '—'}{connection.endArrowhead === 'arrow' ? '→' : '—'} {endpoint(connection.endId, connection.endOutside)}{connection.label && `；标签：${connection.label}`}<small>起点标记：{connection.startArrowhead || '无'}；终点标记：{connection.endArrowhead || '无'}。方向不代表已核实的因果或论据。</small></p>)}</section>}
        </div>
        <small className="research-drawing-hash">快照 {snapshot.hash.slice(0, 12)} · {new Date(snapshot.createdAt).toLocaleString('zh-CN')}</small>
      </div>
    </details>
    {onRemove && <button type="button" className="research-drawing-remove" aria-label="移除绘图附件" onClick={onRemove}><X size={14}/></button>}
  </section>;
}
