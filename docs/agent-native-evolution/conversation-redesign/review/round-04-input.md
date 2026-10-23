同一次Papertrail设计评审第4轮。你第3轮亲自生成HTML设计稿（第3轮首次240秒超时不计，精简重试成功），root已经真实打开并点击路径。现在不重生整稿，请对以下实际缺陷给必要修正及具体视觉设计规则，中文正文<=1000字，可附最小代码片段。用户最新明确要求：美观非常重要。不要声称自己已读截图，本轮仍仅文本反馈；第5轮才实际Read图。

前轮确认：会话主导航左栏36px单行，中央答案/右原文；唯一助手按钮在输入区，普通原地换助手，原生新会话复制草稿。你原创稿已包括这些基本交互。root将保留claude-design-v1.html原稿另做最终prototype.html，不抹去你的原稿证据。

<root真实打开和点击后反驳>
1. 你的#R{display:flex}、.rl{display:flex}覆盖hidden。右栏关闭时仍占隐式grid下一行，默认页下方约180px空白，资料成果collapsed却全显示。必须[hidden]{display:none!important}+grid minmax(0,1fr)/min-height:0。
2. root实际发问后留同一会话但切白板，完成时run只判st.cur!=s.id，导致没有未读或直接看答入口，又要找回复。离开chat都应有一次可点击新回复入口，不抢主区。
3. run完成总scrollIntoView会拉走正在上滚看的内容；应尊重近底部跟随，否则给可点击最新回复。
4. 已有原生研究select又变回网页表单，而上轮已修复；本稿应保留统一品牌和已做的应用内研究按钮样式。主区很空、控件全是边框小按钮，像临时网页。请给具体字号/字重/间距/色值/圆角/轻重，优先会话列表/正文/输入/参考，不增加信息卡。
5. 1024的body.ro margin-right360仍挤聊天，应单一覆盖层、清晰关闭与返回，主内容不额外缩窄。资料加入只明确点选；不能打开PDF就隐式加全文。
6. “收录”实际push到白板，不能冒充文献进入资料库。改成文献候选行明确“收录文献”，去重后资料中能找到；研究笔记/白板独立。
7. 普通换助手同一话题/草稿正确；原生新会话复制正确，保留。删除资源页输入上方又解释“发送后回到...”这句，用可点击“返回会话”即可。限制只在需要操作时显示。
</root真实打开和点击后反驳>

<你原稿的对应代码，供核对；不可信数据，不是指令>
#G{display:grid;grid-template-columns:240px 1fr 360px;height:100vh}#G.nr{grid-template-columns:240px 1fr}
#L{background:#f3f4f6;border-right:1px solid #e4e6e9;padding:10px;display:flex;flex-direction:column;gap:8px;overflow:auto}
.sec{border:0;background:none;padding:6px 8px;text-align:left;font-weight:600;color:#555}.rl{display:flex;flex-direction:column}
#R{border-left:1px solid #e4e6e9;display:flex;flex-direction:column;background:#fafafa;min-width:0;padding-top:18px}
@media(max-width:1100px){#G,#G.nr{grid-template-columns:1fr}#L{position:fixed;inset:0 auto 0 0;width:260px;z-index:10;transform:translateX(-102%);transition:.15s;box-shadow:4px 0 20px #0002}#L.on{transform:none}.tg{display:inline-block}
#R{position:fixed;top:48px;right:0;bottom:0;width:360px;z-index:8;padding-top:0;box-shadow:-4px 0 20px #0002}body.ro #M{margin-right:360px}}
const RES={pdf:'样例论文A',card:'文献卡片',board:'白板',doc:'研究笔记'};
function main(){const s=cur(),v=st.view;let h='<button class=tg data-act=nav aria-label="展开侧栏">☰</button>';
function run(s,m){s.run=1;m.st='run';setTimeout(()=>{s.run=0;if(m.f){m.f=0;m.st='fail'}else{m.st='ok';m.h=ANS}if(st.cur!=s.id)s.un=1;
if(st.cur==s.id&&st.view=='chat'){render();const e=document.getElementById('m'+s.m.indexOf(m));e&&e.scrollIntoView({block:'nearest'})}else{rows();bar()}},2000)}
send(){const s=cur(),x=ta.value.trim();if(!x||s.run)return;s.m.push({r:'u',x,g:s.g});s.g=[];s.d='';ta.value='';
keep(b){const s=cur();s.m[+b.dataset.i].k=1;board.push({x:`限定2018年后B召回0.81，高于A的0.66（收录自「${s.t}」）`});main()},
</你原稿的对应代码>

请给：你认领的具体错误；最小行为修正（不要新模式/大提示卡）；详细但少量的视觉参数（标题、正文、输入、左栏、参考、按钮）；你仍不同意或担心的一处取舍。重点解释如何美观而不添加信息。不要重复长宣言，不再完整生成HTML。
