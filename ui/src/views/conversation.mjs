// The message list. Turns are keyed by id; only turns whose revision changed are updated.
import { $, escape, setHtml, setText } from '../core/dom.mjs';
import { elapsed, isActive } from '../core/format.mjs';
import { guarded, showImage } from '../core/ui.mjs';
import { createTurn, updateTurn, animateIn, liveLabel } from './turn.mjs';

const SUGGESTIONS = [
  // Drawn icons: text symbols like ⌘ ⌕ ↗ sit at different heights in each font.
  ['<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1 1 0 0 0-1-1h-4.5Z"/><path d="M13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1 1 0 0 1 1-1h4.5Z"/></svg>', '了解这个项目', '梳理结构与启动方式', '请先阅读这个项目，概述目录结构、技术栈和启动方式。先不要修改文件。'],
  ['<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/></svg>', '检查代码问题', '从具体证据出发', '请检查当前项目，找出值得优先修复的问题，给出具体位置和改进建议。先不要修改文件。'],
  ['<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 12.5h3.6M6.7 14.2h2.6M8 1.8a4.2 4.2 0 0 0-2.6 7.5c.5.4.8.9.8 1.5v.2h3.6v-.2c0-.6.3-1.1.8-1.5A4.2 4.2 0 0 0 8 1.8Z"/></svg>', '一起实现新想法', '先计划，再逐步构建', '我想实现一个新功能。请先了解项目，然后和我确认需求并制定实施计划。']
];

function welcomeHtml(store) {
  const p = store.currentProject(), { projects, threads } = store.state;
  const options = [{ id: '', name: '不选项目 · 直接对话' }, ...projects];
  // Where a new conversation edits files: right in the project, or on a new branch in its own folder (git worktree).
  const location = store.state.settings?.location === 'worktree' ? 'worktree' : 'local', wt = store.current()?.worktree;
  const where = !store.current() && p ? `<span class="home-project-divider" aria-hidden="true"></span><div class="home-location" role="radiogroup" aria-label="新对话在哪里改文件"><button type="button" role="radio" data-location="local" aria-checked="${location === 'local'}" title="Claude 直接修改项目目录里的文件">项目目录</button><button type="button" role="radio" data-location="worktree" aria-checked="${location === 'worktree'}" title="新建一个分支和文件夹（Git 工作树）给 Claude 改，项目目录不受影响；完成后在右侧「改动」里合并。需要 Git 仓库。"><svg class="branch-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3-5.5 4"/></svg>新分支</button></div>` : '';
  const selection = `<div class="home-project-selection"><span class="folder"><svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 1.6h4.8A1.6 1.6 0 0 1 14 6.2v5.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4Z"/></svg></span><div class="home-project-picker"><button id="home-project" type="button" aria-label="选择工作项目" aria-haspopup="listbox" aria-expanded="false" aria-controls="home-project-menu"><span>${escape(p?.name || options[0].name)}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div id="home-project-menu" class="home-project-menu" role="listbox" aria-label="工作项目" hidden>${options.map(x => `<button type="button" role="option" tabindex="-1" data-home-project="${escape(x.id)}" aria-selected="${x.id === (p?.id || '')}"${x.path ? ` title="${escape(x.path)}"` : ''}><span>${escape(x.name)}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8 3 3 6-6"/></svg></button>`).join('')}</div></div><span class="home-project-divider" aria-hidden="true"></span><button class="home-add-project" type="button" data-action="add-project" title="添加项目文件夹">＋ 添加文件夹</button>${where}</div>`;
  const suggestions = SUGGESTIONS.map(([icon, title, sub, prompt]) => `<button class="suggestion" data-suggestion="${escape(prompt)}"><span class="suggest-icon">${icon}</span><strong>${title}</strong><small>${sub}</small></button>`).join('');
  return `<div class="welcome"><div class="welcome-icon">✳</div><span class="eyebrow">CLAUDE DESK / 本地工作空间</span><h1>你想构建什么？</h1><p class="intro">选择一个项目开始任务，<br>也可以不选项目，直接提问开始一段对话。</p>${selection}${p ? `<div class="welcome-path">${wt && !wt.removed ? `独立工作树 ${escape(wt.branch)} · ${escape(store.current().cwd)}` : escape(p.path)}</div>` : ''}<div class="suggestions">${suggestions}</div><div class="welcome-note"><span class="dot"></span>${projects.length} 个项目 · ${threads.length} 个已有会话，保留在左侧列表</div></div>`;
}

export function createConversation({ store, actions, api, composer, toast, dock }) {
  const box = $('#messages'), views = new Map(), jump = $('#jump-latest');
  let shownThread = undefined;
  // Long conversations show their latest turns first; earlier ones load from the top
  // (button, or scrolling up to it) a window at a time.
  const WINDOW = 30;
  let shownCount = WINDOW;
  const older = document.createElement('button');
  older.type = 'button'; older.className = 'older-turns';
  function showOlder() {
    const thread = store.current(); if (!thread || thread.turns.length <= shownCount) return;
    const before = box.scrollHeight;
    shownCount += WINDOW; render();
    box.scrollTop += box.scrollHeight - before;
  }
  older.addEventListener('click', showOlder);

  // 回到最新: appears once you scroll more than about a screen above the latest
  // message, and gets a dot when something new arrives while you are up there.
  const fromBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight;
  function updateJump(grew = false) {
    const away = shownThread !== 'home' && fromBottom() > Math.max(240, box.clientHeight * 0.6);
    if (!away) jump.classList.remove('has-new'); else if (grew) jump.classList.add('has-new');
    jump.hidden = !away;
  }
  // The running status of the turn, copied above the input box while the original is scrolled
  // off the top; it goes back once the original is in view again. Clicking it scrolls there.
  const liveFloat = $('#live-float');
  const liveSummary = () => box.querySelector('.work-group.live>summary');
  function updateLiveFloat() {
    const summary = liveSummary(), above = Boolean(summary) && summary.getBoundingClientRect().bottom < box.getBoundingClientRect().top + 4;
    if (above) { setText(liveFloat.querySelector('.work-label'), summary.querySelector('.work-label').textContent); setText(liveFloat.querySelector('.work-detail'), summary.querySelector('.work-detail').textContent); }
    if (liveFloat.hidden === above) liveFloat.hidden = !above;
  }
  liveFloat.addEventListener('click', () => liveSummary()?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  box.addEventListener('scroll', () => { updateJump(); updateLiveFloat(); if (box.scrollTop < 80 && older.isConnected) showOlder(); }, { passive: true });
  jump.addEventListener('click', () => { box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); jump.classList.remove('has-new'); });

  function closeProjects(restoreFocus = false) {
    const trigger = $('#home-project'), menu = $('#home-project-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }
  function openProjects() {
    const menu = $('#home-project-menu');
    menu.hidden = false; $('#home-project').setAttribute('aria-expanded', 'true');
    menu.querySelector('[aria-selected="true"]').focus();
  }
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.home-project-picker')) closeProjects(); });
  window.addEventListener('blur', () => closeProjects());
  box.addEventListener('focusout', event => { if (event.target.closest('.home-project-picker') && !event.relatedTarget?.closest('.home-project-picker')) closeProjects(); });
  box.addEventListener('keydown', event => {
    if (!event.target.closest('.home-project-picker')) return;
    const menu = $('#home-project-menu');
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeProjects(true); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.target.closest('button').click(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (menu.hidden) { openProjects(); return; }
    const choices = [...menu.querySelectorAll('[role="option"]')], at = choices.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    choices[next].focus();
  });

  function render() {
    const thread = store.current(), home = !thread?.turns.length;
    $('.workspace').classList.toggle('home-view', home);
    if (home) { if (shownThread !== 'home') animateIn(box, 'is-switching'); views.clear(); shownThread = 'home'; setHtml(box, welcomeHtml(store)); updateJump(); return; }
    const switched = shownThread !== thread.id;
    if (switched) { box.__html = null; box.textContent = ''; views.clear(); shownThread = thread.id; shownCount = WINDOW; animateIn(box, 'is-switching'); }
    const nearBottom = fromBottom() < 110, height = box.scrollHeight;
    const hidden = Math.max(0, thread.turns.length - shownCount), turns = hidden ? thread.turns.slice(hidden) : thread.turns;
    const ids = new Set(turns.map(t => t.id)), context = { cwd: thread.cwd, threadActive: isActive(thread) };
    for (const [id, view] of views) if (!ids.has(id)) { view.root.remove(); views.delete(id); }
    if (hidden) { older.textContent = `显示更早的 ${Math.min(hidden, WINDOW)} 轮（共 ${hidden} 轮未显示）`; if (box.firstChild !== older) box.prepend(older); }
    else older.remove();
    let previous = hidden ? older : null;
    for (const turn of turns) {
      const latest = turn === thread.turns.at(-1), turnContext = latest ? { ...context, latest, turns: thread.turns, run: { status: thread.status, detail: thread.detail, lastEventAt: thread.lastEventAt } } : context;
      let view = views.get(turn.id);
      if (!view) { view = createTurn(turn, turnContext); views.set(turn.id, view); if (!switched) animateIn(view.root); }
      else updateTurn(view, turn, turnContext);
      if (view.root.previousSibling !== previous || view.root.parentNode !== box) previous ? previous.after(view.root) : box.prepend(view.root);
      previous = view.root;
    }
    if (switched || nearBottom) box.scrollTop = box.scrollHeight;
    updateJump(!switched && box.scrollHeight > height); updateLiveFloat();
  }

  // Live "正在处理 · 1m 2s" labels advance once a second without re-rendering turns.
  function tick() {
    for (const label of box.querySelectorAll('.work-label[data-since]')) {
      const now = liveLabel(label.dataset.status, Number(label.dataset.since), Number(label.dataset.lastEvent) || 0, label.dataset.detail);
      label.textContent = now.label; label.parentNode.querySelector('.work-detail').textContent = now.detail;
    }
    updateLiveFloat();
  }

  box.addEventListener('click', guarded(toast, async event => {
    const target = event.target;
    if (target.closest('#home-project')) { if ($('#home-project-menu').hidden) openProjects(); else closeProjects(true); return; }
    const project = target.closest('[data-home-project]'); if (project) { closeProjects(); actions.selectProject(project.dataset.homeProject); return; }
    const suggestion = target.closest('[data-suggestion]'); if (suggestion) { composer.setText(suggestion.dataset.suggestion); composer.focus(); composer.save(); return; }
    if (target.closest('[data-action="add-project"]')) return actions.addProject();
    const location = target.closest('[data-location]'); if (location) return actions.setLocation(location.dataset.location);
    const review = target.closest('[data-review-file]');
    // 查看变更 opens the turn's 变更 tab at the top; a file row opens it at that file.
    if (review) return dock.openChanges(store.selected, review.closest('[data-turn]').dataset.turn, review.classList.contains('changes-review') ? '' : review.dataset.reviewFile);
    const fileRef = target.closest('[data-file-ref]'); if (fileRef) return dock.openFile(store.selected, fileRef.dataset.fileRef, fileRef.dataset.fileLine);
    const image = target.closest('[data-open-image]'); if (image) return showImage(await api('attachment:read', store.selected, image.dataset.imageTurn, image.dataset.openImage), image.title);
    const remove = target.closest('[data-delete-turn]');
    if (remove) { remove.disabled = true; try { await actions.deleteTurn(remove.dataset.deleteTurn); } finally { remove.disabled = false; } return; }
    const steerNow = target.closest('[data-steer-now]'); if (steerNow) { steerNow.disabled = true; try { await actions.steerNow(steerNow.dataset.steerNow); } finally { steerNow.disabled = false; } return; }
    const copy = target.closest('[data-copy]'); if (copy) return actions.copyAnswer(copy.dataset.copy);
    const retry = target.closest('[data-retry]'); if (retry) return actions.retry(retry.dataset.retry);
    const open = target.closest('[data-open-thread]'); if (open) return actions.selectThread(open.dataset.openThread);
    const start = target.closest('[data-proposal-start]');
    if (start) { start.disabled = true; try { const result = await api('proposal:start', store.selected, start.dataset.proposalStart); await actions.apply(result.thread); await actions.apply(result.child); toast('新会话已开始，在左侧可以看到进度'); } finally { start.disabled = false; } return; }
    const dismiss = target.closest('[data-proposal-dismiss]'); if (dismiss) return actions.apply(await api('proposal:dismiss', store.selected, dismiss.dataset.proposalDismiss));
    // A wrap-up button sends its own text as the reply.
    const reply = target.closest('[data-wrap-reply]'); if (reply) { reply.disabled = true; try { await actions.sendMessage(reply.dataset.wrapReply); } finally { reply.disabled = false; } return; }
  }));

  store.on('select', render);
  store.on('threads', () => { if (!store.current()?.turns.length) render(); });
  store.on('thread', thread => { if (thread.id === store.selected) render(); });
  return { render, tick };
}
