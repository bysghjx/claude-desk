// The message list. Turns are keyed by id; only turns whose revision changed are updated.
import { $, escape, setHtml } from '../core/dom.mjs';
import { elapsed, isActive } from '../core/format.mjs';
import { guarded } from '../core/ui.mjs';
import { createTurn, updateTurn, animateIn } from './turn.mjs';

const SUGGESTIONS = [
  ['⌘', '了解这个项目', '梳理结构与启动方式', '请先阅读这个项目，概述目录结构、技术栈和启动方式。先不要修改文件。'],
  ['⌕', '检查代码问题', '从具体证据出发', '请检查当前项目，找出值得优先修复的问题，给出具体位置和改进建议。先不要修改文件。'],
  ['↗', '一起实现新想法', '先计划，再逐步构建', '我想实现一个新功能。请先了解项目，然后和我确认需求并制定实施计划。']
];

function welcomeHtml(store) {
  const p = store.currentProject(), { projects, threads } = store.state;
  const selection = `<div class="home-project-selection"><span>▱</span><select id="home-project" aria-label="选择工作项目"><option value="">选择要工作的项目…</option>${projects.map(x => `<option value="${escape(x.id)}" ${p?.id === x.id ? 'selected' : ''}>${escape(x.name)}</option>`).join('')}</select><button data-action="add-project" title="添加项目文件夹">＋ 添加文件夹</button></div>`;
  const suggestions = SUGGESTIONS.map(([icon, title, sub, prompt]) => `<button class="suggestion" data-suggestion="${escape(prompt)}"><span class="suggest-icon">${icon}</span><strong>${title}</strong><small>${sub}</small></button>`).join('');
  return `<div class="welcome"><div class="welcome-icon">✳</div><span class="eyebrow">CLAUDE DESK / 本地工作空间</span><h1>你想构建什么？</h1><p class="intro">选择一个项目开始新任务，<br>也可以从左侧继续已有的对话。</p>${selection}${p ? `<div class="welcome-path">${escape(p.path)}</div>` : ''}<div class="suggestions">${suggestions}</div><div class="welcome-note"><span class="dot"></span>${projects.length} 个项目 · ${threads.length} 个已有会话，保留在左侧列表</div></div>`;
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
      let view = views.get(turn.id);
      if (!view) { view = createTurn(turn, context); views.set(turn.id, view); if (!switched) animateIn(view.root); }
      else updateTurn(view, turn, context);
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
    const review = target.closest('[data-review-file]'); if (review) return reviewPanel.open(review.dataset.reviewFile);
    const image = target.closest('[data-open-image]'); if (image) return api('attachment:open', store.selected, image.dataset.imageTurn, image.dataset.openImage);
    const remove = target.closest('[data-delete-turn]');
    if (remove) { remove.disabled = true; try { await actions.deleteTurn(remove.dataset.deleteTurn); } finally { remove.disabled = false; } return; }
    const copy = target.closest('[data-copy]'); if (copy) return actions.copyAnswer(copy.dataset.copy);
    const retry = target.closest('[data-retry]'); if (retry) return actions.retry(retry.dataset.retry);
  }));
  box.addEventListener('change', event => { if (event.target.id === 'home-project') actions.selectProject(event.target.value); });

  store.on('select', render);
  store.on('threads', () => { if (!store.current()?.turns.length) render(); });
  store.on('thread', thread => { if (thread.id === store.selected) render(); });
  return { render, tick };
}
