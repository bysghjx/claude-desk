// The message list. Turns are keyed by id; only turns whose revision changed are updated.
import { $, escape, setHtml } from '../core/dom.mjs';
import { elapsed, isActive } from '../core/format.mjs';
import { guarded } from '../core/ui.mjs';
import { createTurn, updateTurn, animateIn } from './turn.mjs';

const SUGGESTIONS = [
  // Drawn icons: text symbols like ⌘ ⌕ ↗ sit at different heights in each font.
  ['<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1 1 0 0 0-1-1h-4.5Z"/><path d="M13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1 1 0 0 1 1-1h4.5Z"/></svg>', '了解这个项目', '梳理结构与启动方式', '请先阅读这个项目，概述目录结构、技术栈和启动方式。先不要修改文件。'],
  ['<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/></svg>', '检查代码问题', '从具体证据出发', '请检查当前项目，找出值得优先修复的问题，给出具体位置和改进建议。先不要修改文件。'],
  ['<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 12.5h3.6M6.7 14.2h2.6M8 1.8a4.2 4.2 0 0 0-2.6 7.5c.5.4.8.9.8 1.5v.2h3.6v-.2c0-.6.3-1.1.8-1.5A4.2 4.2 0 0 0 8 1.8Z"/></svg>', '一起实现新想法', '先计划，再逐步构建', '我想实现一个新功能。请先了解项目，然后和我确认需求并制定实施计划。']
];

function welcomeHtml(store) {
  const p = store.currentProject(), { projects, threads } = store.state;
  const selection = `<div class="home-project-selection"><span class="folder"><svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 1.6h4.8A1.6 1.6 0 0 1 14 6.2v5.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4Z"/></svg></span><select id="home-project" aria-label="选择工作项目"><option value="">不选项目 · 直接对话</option>${projects.map(x => `<option value="${escape(x.id)}" ${p?.id === x.id ? 'selected' : ''}>${escape(x.name)}</option>`).join('')}</select><button data-action="add-project" title="添加项目文件夹">＋ 添加文件夹</button></div>`;
  const location = store.state.settings?.location === 'worktree' ? 'worktree' : 'local', wt = store.current()?.worktree;
  const where = !store.current() && p ? `<div class="home-location" role="radiogroup" aria-label="新对话在哪里运行"><button type="button" role="radio" data-location="local" aria-checked="${location === 'local'}">本地项目目录</button><button type="button" role="radio" data-location="worktree" aria-checked="${location === 'worktree'}"><svg class="branch-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3-5.5 4"/></svg>独立工作树</button></div><div class="home-location-note">${location === 'worktree' ? '从当前提交新建分支和文件夹，Claude 的改动不影响主目录；完成后在右侧「改动」里合并。需要 Git 仓库。' : '直接在项目目录里修改文件。'}</div>` : '';
  const suggestions = SUGGESTIONS.map(([icon, title, sub, prompt]) => `<button class="suggestion" data-suggestion="${escape(prompt)}"><span class="suggest-icon">${icon}</span><strong>${title}</strong><small>${sub}</small></button>`).join('');
  return `<div class="welcome"><div class="welcome-icon">✳</div><span class="eyebrow">CLAUDE DESK / 本地工作空间</span><h1>你想构建什么？</h1><p class="intro">选择一个项目开始任务，<br>也可以不选项目，直接提问开始一段对话。</p>${selection}${where}${p ? `<div class="welcome-path">${wt && !wt.removed ? `独立工作树 ${escape(wt.branch)} · ${escape(store.current().cwd)}` : escape(p.path)}</div>` : ''}<div class="suggestions">${suggestions}</div><div class="welcome-note"><span class="dot"></span>${projects.length} 个项目 · ${threads.length} 个已有会话，保留在左侧列表</div></div>`;
}

export function createConversation({ store, actions, api, composer, toast, reviewPanel }) {
  const box = $('#messages'), views = new Map();
  let shownThread = undefined;

  function render() {
    const thread = store.current(), home = !thread?.turns.length;
    $('.workspace').classList.toggle('home-view', home);
    if (home) { if (shownThread !== 'home') animateIn(box, 'is-switching'); views.clear(); shownThread = 'home'; setHtml(box, welcomeHtml(store)); return; }
    const switched = shownThread !== thread.id;
    if (switched) { box.__html = null; box.textContent = ''; views.clear(); shownThread = thread.id; animateIn(box, 'is-switching'); }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 110;
    const ids = new Set(thread.turns.map(t => t.id)), context = { cwd: thread.cwd, threadActive: isActive(thread) };
    for (const [id, view] of views) if (!ids.has(id)) { view.root.remove(); views.delete(id); }
    let previous = null;
    for (const turn of thread.turns) {
      const latest = turn === thread.turns.at(-1), turnContext = latest ? { ...context, latest, turns: thread.turns } : context;
      let view = views.get(turn.id);
      if (!view) { view = createTurn(turn, turnContext); views.set(turn.id, view); if (!switched) animateIn(view.root); }
      else updateTurn(view, turn, turnContext);
      if (view.root.previousSibling !== previous || view.root.parentNode !== box) previous ? previous.after(view.root) : box.prepend(view.root);
      previous = view.root;
    }
    if (switched || nearBottom) box.scrollTop = box.scrollHeight;
  }

  // Live "正在处理 · 1m 2s" labels advance once a second without re-rendering turns.
  function tick() { for (const label of box.querySelectorAll('.work-label[data-since]')) label.textContent = `正在处理 · ${elapsed(Number(label.dataset.since))}`; }

  box.addEventListener('click', guarded(toast, async event => {
    const target = event.target;
    const suggestion = target.closest('[data-suggestion]'); if (suggestion) { composer.setText(suggestion.dataset.suggestion); composer.focus(); composer.save(); return; }
    if (target.closest('[data-action="add-project"]')) return actions.addProject();
    const location = target.closest('[data-location]'); if (location) return actions.setLocation(location.dataset.location);
    const review = target.closest('[data-review-file]'); if (review) return reviewPanel.open(review.dataset.reviewFile);
    const image = target.closest('[data-open-image]'); if (image) return api('attachment:open', store.selected, image.dataset.imageTurn, image.dataset.openImage);
    const remove = target.closest('[data-delete-turn]');
    if (remove) { remove.disabled = true; try { await actions.deleteTurn(remove.dataset.deleteTurn); } finally { remove.disabled = false; } return; }
    const copy = target.closest('[data-copy]'); if (copy) return actions.copyAnswer(copy.dataset.copy);
    const retry = target.closest('[data-retry]'); if (retry) return actions.retry(retry.dataset.retry);
    // A wrap-up button sends its own text as the reply.
    const reply = target.closest('[data-wrap-reply]'); if (reply) { reply.disabled = true; try { await actions.sendMessage(reply.dataset.wrapReply); } finally { reply.disabled = false; } return; }
  }));
  box.addEventListener('change', event => { if (event.target.id === 'home-project') actions.selectProject(event.target.value); });

  store.on('select', render);
  store.on('threads', () => { if (!store.current()?.turns.length) render(); });
  store.on('thread', thread => { if (thread.id === store.selected) render(); });
  return { render, tick };
}
