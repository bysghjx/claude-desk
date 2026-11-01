// The card above the composer when Claude waits on you: questions with clickable
// options, a plan to confirm, or a tool call to approve. Building the markup and
// reading the answers back are pure, so both are tested without a window.
import { escape } from '../core/dom.mjs';

const isPlan = request => request.name === 'ExitPlanMode';
const questionsOf = request => Array.isArray(request.input?.questions) ? request.input.questions : null;

function questionHtml(q, i) {
  const options = Array.isArray(q.options) ? q.options : [];
  const choices = options.map((o, j) => `<button type="button" class="choice" data-choice="${j}" aria-pressed="false"><span class="choice-key">${j + 1}</span><span class="choice-copy"><strong>${escape(o.label)}</strong>${o.description ? `<small>${escape(o.description)}</small>` : ''}</span></button>`).join('');
  const other = `<button type="button" class="choice choice-other" data-choice="other" aria-pressed="${options.length ? 'false' : 'true'}"><span class="choice-key">…</span><span class="choice-copy"><strong>其他</strong><small>自己输入回答</small></span></button>`;
  return `<fieldset class="question" data-question="${i}" data-multi="${q.multiSelect ? 'true' : 'false'}"><legend>${q.header ? `<span class="question-header">${escape(q.header)}</span>` : ''}${escape(q.question)}${q.multiSelect ? '<small>可多选</small>' : ''}</legend><div class="choices">${choices}${other}</div><input class="choice-input" data-other="${i}" placeholder="输入你的回答" aria-label="${escape(q.question)}"${options.length ? ' hidden' : ''}></fieldset>`;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
function toolSummary(request) {
  const input = request.input || {};
  if (request.name === 'Bash' && input.command) return `${input.description ? `<p class="approval-what">${escape(input.description)}</p>` : ''}<pre class="approval-command">${escape(input.command)}</pre>`;
  if (EDIT_TOOLS.has(request.name) && (input.file_path || input.notebook_path)) return `<p class="approval-what">${request.name === 'Write' ? '写入文件' : '修改文件'} <code>${escape(input.file_path || input.notebook_path)}</code></p><details class="approval-raw"><summary>查看完整参数</summary><pre>${escape(JSON.stringify(input, null, 2))}</pre></details>`;
  return `<pre>${escape(JSON.stringify(input, null, 2))}</pre>`;
}

export function approvalHtml(request, source = '', markdown = text => `<p>${escape(text)}</p>`) {
  const who = source ? `<span class="approval-source">${escape(source)}</span>` : '';
  const questions = questionsOf(request);
  if (questions) {
    const quick = questions.length === 1 && !questions[0].multiSelect && questions[0].options?.length;
    return `<div class="approval-title">${who}Claude 有问题想问你</div>${questions.map(questionHtml).join('')}<div class="approval-actions"><span class="approval-hint">${quick ? '点选项直接回答' : '每个问题选好后提交'}</span><button class="secondary" data-approve="no">跳过</button><button class="primary" data-approve="yes"${quick ? ' hidden' : ''}>提交回答</button></div>`;
  }
  if (isPlan(request)) {
    return `<div class="approval-title">${who}计划等待你确认</div><div class="plan-body markdown">${markdown(request.input?.plan || '')}</div><textarea class="plan-feedback" rows="2" placeholder="想调整的话，写下修改意见再点「继续修改」"></textarea><div class="approval-actions"><button class="secondary" data-approve="no">继续修改</button><button class="secondary" data-approve="yes" data-plan-mode="default">执行，改文件前问我</button><button class="primary" data-approve="yes" data-plan-mode="acceptEdits">执行并自动接受编辑</button></div>`;
  }
  return `<div class="approval-title">${who}批准 ${escape(request.name)}？</div><p>${escape(request.reason)}</p>${toolSummary(request)}<div class="approval-actions"><button class="secondary" data-approve="no">拒绝</button><button class="primary" data-approve="yes">仅允许这一次</button></div>`;
}

// Toggles an option; single-choice questions keep one pressed. Returns whether the
// card can be submitted right away (one single-choice question, a real option).
export function pickChoice(card, button) {
  const field = button.closest('.question'), multi = field.dataset.multi === 'true';
  const pressed = button.getAttribute('aria-pressed') !== 'true' || !multi && button.dataset.choice !== 'other';
  if (!multi) for (const other of field.querySelectorAll('.choice')) other.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-pressed', String(pressed));
  const input = field.querySelector('.choice-input'), otherOn = field.querySelector('.choice-other').getAttribute('aria-pressed') === 'true';
  input.hidden = !otherOn; if (otherOn && button.dataset.choice === 'other') input.focus();
  return card.querySelectorAll('.question').length === 1 && !multi && pressed && button.dataset.choice !== 'other';
}

// Reads every question's answer: chosen labels plus any typed text, joined with ", ".
export function collectAnswers(card, questions) {
  const answers = {};
  for (const field of card.querySelectorAll('.question')) {
    const q = questions[Number(field.dataset.question)], parts = [];
    for (const button of field.querySelectorAll('.choice[aria-pressed="true"]')) {
      if (button.dataset.choice === 'other') { const text = field.querySelector('.choice-input').value.trim(); if (text) parts.push(text); }
      else parts.push(q.options[Number(button.dataset.choice)].label);
    }
    if (!parts.length) return { missing: q.question };
    answers[q.question] = parts.join(', ');
  }
  return { answers };
}

export { isPlan, questionsOf };
