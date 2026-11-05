// 设置 › 服务商: Claude Code's own setup, or an Anthropic-compatible endpoint with its
// own key. Keys go to the main process once and are never shown again; editing with
// the key left blank keeps it.
import { $, escape, setHtml, setText } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';

const host = url => { try { return new URL(url).host; } catch { return url; } };

export function providerListHtml({ active = '', providers = [] }, info = {}) {
  const row = (id, name, detail, extra = '') => `<div class="provider-row${id === active ? ' selected' : ''}"><button type="button" class="provider-pick" role="radio" aria-checked="${id === active}" data-provider-pick="${escape(id)}"><span class="provider-radio" aria-hidden="true"></span><span class="provider-copy"><strong>${escape(name)}</strong><small>${escape(detail)}</small></span></button>${extra}</div>`;
  const own = row('', 'Claude Code 自己的配置', `${info.custom ? '' : info.host ? info.host + ' · ' : ''}来自 ~/.claude/settings.json、环境变量或登录`);
  return own + providers.map(p => row(p.id, p.name, `${host(p.baseUrl)} · ${p.authType === 'key' ? 'API Key' : 'Auth Token'}${p.models?.length ? ` · ${p.models.length} 个模型` : ''}`, `<button type="button" class="provider-action" data-provider-edit="${escape(p.id)}">编辑</button><button type="button" class="provider-action danger" data-provider-remove="${escape(p.id)}">删除</button>`)).join('');
}

export function createProviders({ store, api, toast, confirm, env, composer }) {
  const form = $('#provider-form');
  let editing = null;
  const state = () => store.state.providers || { active: '', providers: [] };

  function render() { setHtml($('#provider-list'), providerListHtml(state(), store.state.provider)); }
  function apply(result) {
    store.state.providers = { active: result.active, providers: result.providers };
    env.showProvider(result.provider); render();
  }
  function openForm(provider = null) {
    editing = provider?.id || null;
    form.hidden = false; $('#provider-add').hidden = true;
    setText($('#provider-form-title'), provider ? `编辑「${provider.name}」` : '添加服务商');
    $('#provider-name').value = provider?.name || ''; $('#provider-url').value = provider?.baseUrl || '';
    $('#provider-auth').value = provider?.authType || 'token'; $('#provider-key').value = '';
    $('#provider-key').placeholder = provider?.hasKey ? '已保存，留空表示不修改' : '粘贴密钥';
    $('#provider-models').value = (provider?.models || []).join('\n'); $('#provider-fast').value = provider?.fastModel || '';
    setText($('#provider-test-result'), ''); $('#provider-name').focus();
  }
  function closeForm() { form.hidden = true; $('#provider-add').hidden = false; editing = null; }
  const values = () => ({ id: editing, name: $('#provider-name').value, baseUrl: $('#provider-url').value, authType: $('#provider-auth').value, key: $('#provider-key').value, models: $('#provider-models').value, fastModel: $('#provider-fast').value });

  // Switching provider: the composer moves to one of its models when the current one is not offered.
  async function activate(id) {
    apply(await api('providers:activate', id));
    const chosen = state().providers.find(p => p.id === id), model = composer.options().model;
    if (chosen?.models?.length && !chosen.models.includes(model)) {
      composer.ensureModel(chosen.models[0]);
      store.state.settings = { ...store.state.settings, model: chosen.models[0] }; await api('settings', store.state.settings);
    }
    store.state.availableModels = chosen?.models?.length ? chosen.models : [];
    toast(`已切换到${chosen ? `「${chosen.name}」` : ' Claude Code 自己的配置'}，从每个会话的下一条消息开始生效`);
  }

  $('#provider-list').addEventListener('click', guarded(toast, async event => {
    const pick = event.target.closest('[data-provider-pick]'); if (pick) { if (pick.dataset.providerPick !== state().active) await activate(pick.dataset.providerPick); return; }
    const edit = event.target.closest('[data-provider-edit]'); if (edit) return openForm(state().providers.find(p => p.id === edit.dataset.providerEdit));
    const remove = event.target.closest('[data-provider-remove]');
    if (remove) {
      const p = state().providers.find(x => x.id === remove.dataset.providerRemove); if (!p) return;
      if (!await confirm({ title: `删除服务商「${p.name}」？`, description: p.id === state().active ? '它正在使用中，删除后改回 Claude Code 自己的配置。' : '保存的密钥会一起删除。', label: '删除' })) return;
      apply(await api('providers:remove', p.id)); if (editing === p.id) closeForm();
    }
  }));
  $('#provider-add').addEventListener('click', () => openForm());
  $('#provider-cancel').addEventListener('click', closeForm);
  $('#provider-test').addEventListener('click', guarded(toast, async () => {
    setText($('#provider-test-result'), '正在连接…'); $('#provider-test').disabled = true;
    try { const models = await api('providers:test', values()); setText($('#provider-test-result'), `连接成功${models.length ? `，服务商提供 ${models.length} 个模型` : ''}`); if (models.length && !$('#provider-models').value.trim()) $('#provider-models').value = models.slice(0, 20).join('\n'); }
    catch (e) { setText($('#provider-test-result'), e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { $('#provider-test').disabled = false; }
  }));
  // guarded() runs a tick later, so the submission is stopped here first.
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('submit', guarded(toast, async () => {
    const first = !state().providers.length, result = await api('providers:save', values()); apply(result); closeForm();
    toast('服务商已保存' + (result.id === result.active ? '，从每个会话的下一条消息开始生效' : first ? '，点它即可切换' : ''));
  }));
  $('#settings-dialog').addEventListener('close', closeForm);
  return { render };
}
