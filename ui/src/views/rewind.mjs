// "回退到这里": drops a turn and the ones after it, optionally puts the project
// files back to how they were before that turn, and returns the prompt to the composer.
import { $, escape } from '../core/dom.mjs';
import { isActive } from '../core/format.mjs';
import { guarded } from '../core/ui.mjs';
import { fileChanges } from '../lib/worklog.mjs';

const STATUS = { M: ['改回', 'changed'], D: ['恢复', 'restored'], A: ['删除', 'created'] };

export function filesHtml(files, count) {
  const rows = files.map(f => { const [verb, kind] = STATUS[f.status] || ['改回', 'changed']; return `<div class="rewind-file ${kind}"><span>${verb}</span>${escape(f.path)}</div>`; }).join('');
  return rows + (count > files.length ? `<div class="rewind-more">还有 ${count - files.length} 个文件</div>` : '');
}

export function createRewind({ store, api, actions, composer, toast, confirm }) {
  const dialog = $('#rewind-dialog');
  $('#rewind-cancel').onclick = () => dialog.close('cancel');
  $('#rewind-confirm').onclick = () => dialog.close('confirm');

  async function open(turnId) {
    const thread = store.current(); if (!thread || dialog.open) return;
    if (isActive(thread)) return toast('请先停止当前运行，再回退');
    const preview = await api('thread:rewind-preview', thread.id, turnId);
    const check = $('#rewind-files'), list = $('#rewind-files-list');
    $('#rewind-description').textContent = `将删除这一轮${preview.later ? `及之后的 ${preview.later} 轮` : ''}问答，提问放回输入框，可以修改后重新发送${composer.isEmpty() ? '' : '（会替换输入框里现有的内容）'}。`;
    const changed = preview.available && preview.count > 0;
    check.checked = changed; check.disabled = !changed;
    $('#rewind-files-note').textContent = !preview.available ? preview.reason : changed ? `${preview.count} 个文件会被改回这一轮开始前的状态，包括这之后你手动做的改动。` : '文件和这一轮开始前一致，无需恢复。';
    list.innerHTML = changed ? filesHtml(preview.files, preview.count) : ''; list.hidden = !changed;
    dialog.returnValue = '';
    const confirmed = await new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); $('#rewind-cancel').focus(); });
    if (!confirmed) return;
    const result = await api('thread:rewind', thread.id, turnId, check.checked);
    await actions.apply(result.thread);
    composer.restore(result.draft); composer.save(); composer.focus(); store.emit('composer');
    toast(result.restored ? `已回退，${result.restored} 个文件已恢复` : '已回退，提问已放回输入框');
  }

  // 撤销 / 重做 on a turn's change card. The conversation stays; only files change.
  async function undo(turnId, redo) {
    const thread = store.current(), index = thread?.turns.findIndex(t => t.id === turnId) ?? -1; if (index < 0) return;
    if (isActive(thread)) return toast('请先停止当前运行');
    const files = fileChanges(thread.turns[index], thread.cwd).map(f => f.path);
    if (!redo) {
      const mine = new Set(files.map(p => p.toLowerCase()));
      const later = thread.turns.slice(index + 1).filter(t => fileChanges(t, thread.cwd).some(f => mine.has(f.path.toLowerCase()))).length;
      const ok = await confirm({ title: `撤销这一轮对 ${files.length} 个文件的改动？`, description: `这些文件会改回这一轮开始前的状态，包括之后你手动做的改动${later ? `；之后的 ${later} 轮也改过其中的文件，那些改动会一起撤掉` : ''}。对话记录保留，之后可以点「重做」恢复。`, preview: files.slice(0, 12).join('\n') + (files.length > 12 ? `\n…还有 ${files.length - 12} 个文件` : ''), label: '撤销改动', kind: 'neutral' });
      if (!ok) return;
    }
    const result = await api('turn:undo', thread.id, turnId, files, Boolean(redo));
    await actions.apply(result.thread);
    toast(redo ? `已重做，${result.files} 个文件已恢复` : result.files ? `已撤销 ${result.files} 个文件的改动` : '这些文件和这一轮开始前一致，没有需要撤销的');
  }

  $('#messages').addEventListener('click', guarded(toast, async event => {
    const undoButton = event.target.closest('[data-undo-turn]');
    if (undoButton) { undoButton.disabled = true; try { await undo(undoButton.dataset.undoTurn, Boolean(undoButton.dataset.redo)); } finally { undoButton.disabled = false; } return; }
    const button = event.target.closest('[data-rewind]'); if (!button) return;
    button.disabled = true; try { await open(button.dataset.rewind); } finally { button.disabled = false; }
  }));
  return { open };
}
