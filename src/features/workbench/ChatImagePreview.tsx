import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { ChatImageAttachment } from '../../domain/types';
import { loadChatImage } from '../../services/chat-images';

function ImagePreview({ image, onRemove }: { image: ChatImageAttachment; onRemove?: (assetId: string) => void }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false, objectUrl = '';
    setUrl(''); setError('');
    void loadChatImage(image).then(blob => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(problem => { if (!cancelled) setError((problem as Error).message); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [image.assetId, image.hash, image.mimeType, image.size]);
  return <div className="research-chat-image">
    <details><summary>{url ? <img src={url} alt={image.name} draggable={false} onError={() => setError('图片无法预览，请重新选择。')}/> : <span>图片</span>}<span title={image.name}>{image.name}<small>{Math.max(1, Math.ceil(image.size / 1024))} KB</small></span></summary>{url && <img className="research-chat-image-full" src={url} alt={`预览：${image.name}`}/>}</details>
    {onRemove && <button type="button" aria-label={`移除图片：${image.name}`} onClick={() => onRemove(image.assetId)}><X size={13}/></button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
export function ChatImagePreview({ images, historical = false, onRemove }: { images: ChatImageAttachment[]; historical?: boolean; onRemove?: (assetId: string) => void }) {
  if (!images.length) return null;
  return <section className="research-chat-images" aria-label={historical ? '这轮的图片附件' : '待发送图片'}>{images.map(image => <ImagePreview key={image.assetId} image={image} onRemove={onRemove}/>)}</section>;
}
