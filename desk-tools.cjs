// Tools Claude Desk gives Claude on top of Claude Code's own.
// - wrap_up fills the box under a finished turn: a short recap and, when the
//   user has a decision to make, one question with reply buttons.
// - propose_session puts a card under the turn for work worth its own
//   conversation; nothing starts until the user clicks it.
// - preview_* open and drive the conversation's page in the 浏览器 panel, so
//   Claude can look at what it built (see preview.cjs).
const WRAP_UP='mcp__desk__wrap_up',PROPOSE='mcp__desk__propose_session';
const PREVIEW_TOOLS=['open','screenshot','text','click','fill','eval','console'].map(name=>'mcp__desk__preview_'+name);
const DESK_TOOLS=[WRAP_UP,PROPOSE,...PREVIEW_TOOLS];
const DESCRIPTION='在本轮工作结束、写最后的回复之前调用，填写回复下方的收尾框。recap：两三句话说明现在是什么状态、还有什么没做或没验证。只有需要用户做决定或操作时才填 ask（一句话的问题，不写理由）和 actions（1–2 个按钮文字，每个 1–4 个词，第一个是你推荐的；用户点按钮等于把这段文字发给你）。';
const PROPOSE_DESCRIPTION='提议一个单独的新会话：用户会在回复下方看到一张卡片，点「开始」才会在同一个项目里开一个新会话，把 prompt 作为第一条消息发过去。用于和当前任务无关、但值得单独做的事（顺手发现的问题、你建议的后续工作）。title：不超过 30 个字的任务名。prompt：完整的任务说明，新会话看不到这段对话，所以要写清楚背景、涉及的文件和怎样算完成。';
const PROMPT='如果这一轮改了文件、运行了命令或完成了多步工作，在写最后的回复之前调用 wrap_up 工具填写收尾框；简单问答和闲聊不要调用。收尾框不代替回复：调用之后照常写出完整的最后回复，并且不要在回复里重复收尾框里的问题。发现和当前任务无关、但值得单独做的事时，用 propose_session 提议，不要自己顺手去做，也不要把当前任务本身拆成提议；每轮最多 3 个。改了能在浏览器里看到的东西（网页、前端界面）时，用 preview_ 开头的工具在 Claude Desk 的浏览器面板里打开页面验证：需要开发服务器就先用 Bash 在后台启动，再用 preview_open 打开它的地址，用 preview_screenshot 看效果、preview_console 查报错。';
const text=(value,max)=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,max):'';
// The recorded box, or null when the call has no recap. Buttons need a question to answer.
function wrapUpOf(input){
  const recap=text(input?.recap,600);if(!recap)return null;
  const ask=text(input?.ask,160);
  const actions=ask&&Array.isArray(input?.actions)?input.actions.map(a=>text(typeof a==='string'?a:a?.label,24)).filter(Boolean).slice(0,2):[];
  return{recap,...(ask?{ask}:{}),...(actions.length?{actions}:{})};
}
// The recorded proposal, or null without a title and a brief. The brief keeps its line breaks.
function proposalOf(input,id){
  const title=text(input?.title,60),prompt=typeof input?.prompt==='string'?input.prompt.trim().slice(0,20000):'';
  return title&&prompt?{id:String(id),title,prompt,status:'pending'}:null;
}
const reply=text=>({content:[{type:'text',text:String(text)}]});
// The preview tools for one conversation; failures come back as tool errors Claude can read.
function previewTools({tool,z,preview},threadId){
  const run=task=>async args=>{try{return await task(args);}catch(e){return{...reply(e.message||String(e)),isError:true};}};
  return[
    tool('preview_open','在 Claude Desk 的浏览器面板里打开一个 http(s) 地址（通常是本机开发服务器，例如 http://localhost:5173），并等页面加载完。每个会话有自己的页面，再次调用会跳转到新地址。',{url:z.string()},run(async({url})=>{const page=await preview.open(threadId,url);return reply(`已打开 ${page.url}${page.title?'（'+page.title+'）':''}`);})),
    tool('preview_screenshot','给当前页面截图，返回图片。用来确认布局和样式。',{},run(async()=>({content:[{type:'image',data:await preview.screenshot(threadId),mimeType:'image/jpeg'}]}))),
    tool('preview_text','读取当前页面的地址、标题和可见文字。核对文字内容时比截图更准。',{},run(async()=>reply(await preview.text(threadId)))),
    tool('preview_click','点击当前页面里第一个匹配 CSS 选择器的元素。',{selector:z.string()},run(async({selector})=>reply('已点击 '+await preview.click(threadId,selector)))),
    tool('preview_fill','给输入框、文本框或下拉框填值，并触发 input / change 事件。',{selector:z.string(),value:z.string()},run(async({selector,value})=>reply(await preview.fill(threadId,selector,value)))),
    tool('preview_eval','在当前页面里执行一段 JavaScript 表达式并返回结果（可以是 Promise）。用于读取页面状态、调试；不要用它代替修改源码。',{expression:z.string()},run(async({expression})=>reply(await preview.evaluate(threadId,expression)))),
    tool('preview_console','读取当前页面最近的控制台输出。level：all、warn（警告和错误）或 error。',{level:z.enum(['all','warn','error']).optional()},run(async({level})=>reply(preview.console(threadId,level||'all'))))
  ];
}
// One server per CLI process: an SDK MCP server instance serves a single connection.
// `preview` (a BrowserPreview) is optional; without it the preview tools are left out.
function deskServerFactory({createSdkMcpServer,tool,z,preview=null}){
  return threadId=>createSdkMcpServer({name:'desk',version:'1.0.0',alwaysLoad:true,tools:[
    tool('wrap_up',DESCRIPTION,{recap:z.string(),ask:z.string().optional(),actions:z.array(z.string()).max(2).optional()},async()=>({content:[{type:'text',text:'收尾框已显示。现在写最后的回复。'}]})),
    tool('propose_session',PROPOSE_DESCRIPTION,{title:z.string(),prompt:z.string()},async()=>({content:[{type:'text',text:'提议卡片已显示给用户，用户点「开始」才会开新会话。不要自己去做这件事。'}]})),
    ...(preview?previewTools({tool,z,preview},threadId):[])
  ]});
}
module.exports={WRAP_UP,PROPOSE,PREVIEW_TOOLS,DESK_TOOLS,PROMPT,wrapUpOf,proposalOf,deskServerFactory};
