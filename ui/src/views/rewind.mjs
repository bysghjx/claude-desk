// "回退到这里": drops a turn and the ones after it, optionally puts the project
// files back to how they were before that turn, and returns the prompt to the composer.
// Editing a sent message does the same rewind, then sends the edited text in its place.
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

  // With `edit`, sends that text instead of returning the prompt to the composer. Returns false if cancelled.
  async function open(turnId, edit = null) {
    const thread = store.current(); if (!thread || dialog.open) return false;
    if (isActive(thread)) { toast(edit ? '请先停止当前运行，再编辑' : '请先停止当前运行，再回退'); return false; }
    const preview = await api('thread:rewind-preview', thread.id, turnId);
    const check = $('#rewind-files'), list = $('#rewind-files-list');
    const later = preview.later ? `及之后的 ${preview.later} 轮` : '';
    $('#rewind-title').textContent = edit ? '重新发送改过的消息？' : '回退到这一轮之前？';
    $('#rewind-confirm').textContent = edit ? '重新发送' : '回退';
    $('#rewind-description').textContent = edit ? `将删除这一轮${later}问答，用改过的内容重新发送。` : `将删除这一轮${later}问答，提问放回输入框，可以修改后重新发送${composer.isEmpty() ? '' : '（会替换输入框里现有的内容）'}。`;
    const changed = preview.available && preview.count > 0;
    check.checked = changed; check.disabled = !changed;
    $('#rewind-files-note').textContent = !preview.available ? preview.reason : changed ? `${preview.count} 个文件会被改回这一轮开始前的状态，包括这之后你手动做的改动。` : '文件和这一轮开始前一致，无需恢复。';
    list.innerHTML = changed ? filesHtml(preview.files, preview.count) : ''; list.hidden = !changed;
    dialog.returnValue = '';
    // Editing the last turn with no files to restore loses nothing else, so it goes without asking.
    const ask = !edit || changed || preview.later;
    const confirmed = !ask || await new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); $('#rewind-cancel').focus(); });
    if (!confirmed) return false;
    const result = await api('thread:rewind', thread.id, turnId, Boolean(ask && check.checked));
    await actions.apply(result.thread);
    if (!edit) {
      composer.restore(result.draft); composer.save(); composer.focus(); store.emit('composer');
      toast(result.restored ? `已回退，${result.restored} 个文件已恢复` : '已回退，提问已放回输入框');
      return true;
    }
    const { references, images } = result.draft;
    try { await actions.apply(await api('thread:send', thread.id, edit.text, { ...composer.options(), references, images: images.filter(i => i.data || i.path) })); }
    catch (e) { composer.restore({ ...result.draft, text: edit.text }); composer.save(); store.emit('composer'); throw Error('没有发送出去，改过的消息已放回输入框：' + e.message); }
    if (result.restored) toast(`${result.restored} 个文件已恢复，已重新发送`);
    return true;
  }

  // Edits the message in its bubble; Enter sends, Shift+Enter starts a new line, Esc cancels.
  function startEdit(button) {
    const thread = store.current(), turn = thread?.turns.find(t => t.id === button.dataset.editTurn), line = button.closest('.user-line');
    if (!turn || !line || line.querySelector('.user-edit')) return;
    if (isActive(thread)) return toast('请先停止当前运行，再编辑');
    const box = document.createElement('div'); box.className = 'user-edit'; box.dataset.turn = turn.id;
    box.innerHTML = '<textarea rows="1" aria-label="编辑消息"></textarea><div class="user-edit-actions"><button type="button" data-edit-cancel>取消</button><button type="button" class="user-edit-send" data-edit-send>发送</button></div>';
    line.classList.add('editing'); line.append(box);
    const input = box.querySelector('textarea'); input.value = turn.user || ''; resize(input);
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
  function stopEdit(box) { box.closest('.user-line')?.classList.remove('editing'); box.remove(); }
  function resize(input) { input.style.height = 'auto'; input.style.height = Math.min(320, input.scrollHeight + 2) + 'px'; }
  async function sendEdit(box) {
    const text = box.querySelector('textarea').value.trim(), turn = store.current()?.turns.find(t => t.id === box.dataset.turn);
    if (!text && !turn?.images?.length) return toast('消息不能为空');
    const buttons = box.querySelectorAll('button'); buttons.forEach(b => { b.disabled = true; });
    try { if (!await open(box.dataset.turn, { text }) && box.isConnected) box.querySelector('textarea').focus(); }
    finally { buttons.forEach(b => { b.disabled = false; }); }
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
    const edit = event.target.closest('[data-edit-turn]'); if (edit) return startEdit(edit);
    const box = event.target.closest('.user-edit');
    if (box && event.target.closest('[data-edit-cancel]')) return stopEdit(box);
    if (box && event.target.closest('[data-edit-send]')) return sendEdit(box);
    const button = event.target.closest('[data-rewind]'); if (!button) return;
    button.disabled = true; try { await open(button.dataset.rewind); } finally { button.disabled = false; }
  }));
  $('#messages').addEventListener('input', event => { if (event.target.matches('.user-edit textarea')) resize(event.target); });
  $('#messages').addEventListener('keydown', guarded(toast, async event => {
    const box = event.target.closest?.('.user-edit'); if (!box || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); stopEdit(box); }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); await sendEdit(box); }
  }));
  return { open };
}
