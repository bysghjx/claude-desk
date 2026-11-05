// The user's own prompts, added after Claude Desk's part of the system prompt:
// a global one for every conversation and one per project (the project's wins
// where they conflict). Both are edited in one dialog; changes apply from each
// conversation's next message. Opened from 设置 or from a project's or
// conversation's right-click menu.
import { $ } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';

const MAX = 20000;

export function createInstructions({ store, api, toast }) {
  const dialog = $('#instructions-dialog');
  const fields = { global: $('#instructions-global'), project: $('#instructions-project') };
  let projectId = null;
  const projectOf = id => store.state.projects.find(p => p.id === id);
  // The project of the conversation on screen, or the one picked on the home page.
  const currentProject = () => projectOf(store.current() ? store.current().projectId : store.projectId);

  function count(scope) {
    const n = fields[scope].value.trim().length, label = $(`#instructions-${scope}-count`);
    label.textContent = `${n.toLocaleString()} / ${MAX.toLocaleString()}`; label.classList.toggle('error', n > MAX);
    $('#instructions-save').disabled = Object.values(fields).some(f => f.value.trim().length > MAX);
  }
  // focus: which prompt to put the cursor in; id: the project to edit (defaults to the current one).
  function open(focus = 'global', id = currentProject()?.id) {
    const project = projectOf(id); projectId = project?.id || null;
    fields.global.value = store.state.settings?.instructions || '';
    fields.project.value = project?.instructions || '';
    fields.project.disabled = !project;
    fields.project.placeholder = project ? '例如：这是一个 Electron 应用，界面文字用中文；改完跑 npm test。' : '先在主页选一个项目，或打开项目里的会话';
    $('#instructions-project-name').textContent = project ? `只对「${project.name}」里的会话生效` : '当前没有项目';
    count('global'); count('project');
    dialog.showModal(); (focus === 'project' && project ? fields.project : fields.global).focus();
  }

  // guarded() runs the save a tick later, so the form submission is stopped in the listener first.
  const save = guarded(toast, async () => {
    const changed = [];
    const global = fields.global.value.trim();
    if (global !== (store.state.settings?.instructions || '')) {
      store.state.settings.instructions = await api('instructions:set', 'global', null, global); changed.push('全局');
    }
    const project = projectOf(projectId);
    if (project && fields.project.value.trim() !== (project.instructions || '')) {
      project.instructions = await api('instructions:set', 'project', project.id, fields.project.value.trim()); changed.push('项目');
    }
    dialog.close();
    if (changed.length) toast(`${changed.join('和')}提示词已保存，从每个会话的下一条消息开始生效`);
  });
  $('#instructions-form').addEventListener('submit', event => { event.preventDefault(); save(); });
  for (const scope of Object.keys(fields)) fields[scope].addEventListener('input', () => count(scope));
  $('#instructions-cancel').addEventListener('click', () => dialog.close());
  $('#instructions-close').addEventListener('click', () => dialog.close());
  return { open };
}
