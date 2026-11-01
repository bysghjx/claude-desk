const test = require('node:test');
const assert = require('node:assert');
const { NotificationTracker } = require('../notify.cjs');

const thread = (status, turns = [], extra = {}) => ({ id: 't1', title: '修复登录', status, turns, ...extra });

test('notifies once when a running turn finishes', () => {
  const tracker = new NotificationTracker();
  assert.deepEqual(tracker.update(thread('generating', [{ id: 'a' }])), []);
  const [notice] = tracker.update(thread('done', [{ id: 'a', answer: '已经修好了，\n测试全部通过。' }]));
  assert.equal(notice.kind, 'done');
  assert.equal(notice.threadId, 't1');
  assert.match(notice.title, /任务已完成 · 修复登录/);
  assert.equal(notice.body, '已经修好了， 测试全部通过。');
  assert.deepEqual(tracker.update(thread('done', [{ id: 'a', answer: 'x' }])), [], 'a rename or re-publish does not notify again');
});

test('stays quiet for idle threads, stops and turns that continue with queued messages', () => {
  const tracker = new NotificationTracker();
  assert.deepEqual(tracker.update(thread('done')), [], 'first sight of a finished thread (startup, import)');
  tracker.update(thread('tool'));
  assert.deepEqual(tracker.update(thread('done', [], { queue: [{ id: 'q' }] })), []);
  tracker.update(thread('tool'));
  assert.deepEqual(tracker.update(thread('stopped')), []);
});

test('reports failures', () => {
  const tracker = new NotificationTracker();
  tracker.update(thread('thinking'));
  const [notice] = tracker.update(thread('error', [{ id: 'a', error: 'HTTP 529 服务过载' }]));
  assert.equal(notice.kind, 'error');
  assert.equal(notice.body, 'HTTP 529 服务过载');
});

test('approvals, questions and plans each notify once per request', () => {
  const tracker = new NotificationTracker();
  tracker.update(thread('tool', [{ id: 'a' }]));
  const bash = { id: 'r1', name: 'Bash', input: { command: 'npm test' }, reason: '运行测试' };
  let [notice] = tracker.update(thread('approval', [{ id: 'a', approvals: [bash] }]));
  assert.deepEqual([notice.kind, notice.title, notice.body], ['approval', 'Claude 需要你批准 Bash', 'npm test']);
  assert.deepEqual(tracker.update(thread('approval', [{ id: 'a', approvals: [bash] }])), [], 'same request is not repeated');

  const ask = { id: 'r2', name: 'AskUserQuestion', agentName: 'reviewer', input: { questions: [{ question: '要保留旧接口吗？' }] } };
  [notice] = tracker.update(thread('approval', [{ id: 'a', approvals: [bash, ask] }]));
  assert.deepEqual([notice.kind, notice.title, notice.body], ['question', '子智能体「reviewer」有问题想问你', '要保留旧接口吗？']);

  const plan = { id: 'r3', name: 'ExitPlanMode', input: { plan: '1. 改接口\n2. 写测试' } };
  [notice] = tracker.update(thread('approval', [{ id: 'a', approvals: [plan] }]));
  assert.deepEqual([notice.kind, notice.body], ['plan', '1. 改接口 2. 写测试']);
});

test('long text is shortened', () => {
  const tracker = new NotificationTracker();
  tracker.update(thread('generating'));
  const [notice] = tracker.update(thread('done', [{ id: 'a', answer: '字'.repeat(300) }]));
  assert.equal(notice.body.length, 120);
  assert.ok(notice.body.endsWith('…'));
});
