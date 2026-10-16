const form = document.querySelector('form');
const status = document.querySelector('#status');
const submit = form.querySelector('button');
const api = window.papertrailDesktop;
api.getAISettings().then(settings => {
  form.elements.baseURL.value = settings.baseURL;
  form.elements.model.value = settings.model;
  form.elements.images.checked = settings.images;
  status.textContent = settings.configured ? '已保存密钥。留空即可沿用；是否可用请发送消息验证。' : '尚未配置密钥；人工阅读和演示模式可直接使用。';
  submit.disabled = false;
}).catch(() => { status.textContent = '无法读取模型设置，请关闭后重试。'; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  submit.disabled = true;
  try {
    const result = await api.saveAISettings({ baseURL: form.elements.baseURL.value, model: form.elements.model.value, key: form.elements.key.value, images: form.elements.images.checked, removeKey: form.elements.removeKey.checked });
    form.elements.key.value = '';
    form.elements.removeKey.checked = false;
    status.textContent = result.configured ? '设置已保存；尚未验证模型连通性，请返回工作台发送消息验证。' : '设置已保存，当前未配置密钥。';
  } catch (error) { status.textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  finally { submit.disabled = false; }
});
