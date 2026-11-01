// Application state shared by views. Views subscribe to events instead of
// reaching into each other; actions are the only code that changes selection.
import { isActive } from './format.mjs';

export function createStore() {
  const listeners = new Map();
  const store = {
    state: { projects: [], threads: [], settings: {}, ui: {}, provider: {} },
    selected: null,
    // Set once the first selection happened; until then there is no draft to save.
    ready: false,
    projectId: null,
    panelTab: 'changes',
    showArchived: false,
    drafts: new Map(),

    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
      return () => listeners.get(event).delete(callback);
    },
    emit(event, ...args) { for (const callback of [...(listeners.get(event) || [])]) callback(...args); },

    thread(id) { return id ? this.state.threads.find(t => t.id === id) : undefined; },
    current() { return this.thread(this.selected); },
    currentProject() { const id = this.current()?.projectId || this.projectId; return this.state.projects.find(p => p.id === id); },
    running() { return isActive(this.current()); },

    load(state) {
      this.state = { ...state, threads: state.threads || [], projects: state.projects || [] };
      for (const [id, draft] of Object.entries(state.ui?.drafts || {})) this.drafts.set(id, draft);
      this.emit('load'); this.emit('threads');
    },
    // Threads from the main process list unchanged turns as {id, rev, same:true}.
    // Returns false when such a turn is unknown here and the full thread must be fetched.
    mergeThread(incoming) {
      const previous = new Map((this.thread(incoming.id)?.turns || []).map(t => [t.id, t]));
      let complete = true;
      const turns = (incoming.turns || []).map(turn => {
        if (!turn.same) return turn;
        const known = previous.get(turn.id);
        if (known && known.rev === turn.rev) return known;
        complete = false; return known || { id: turn.id, rev: -1, user: '', answer: '', tools: [], status: 'done' };
      });
      const thread = { ...incoming, turns };
      const index = this.state.threads.findIndex(t => t.id === thread.id);
      if (index >= 0) this.state.threads[index] = thread; else this.state.threads.unshift(thread);
      this.emit('thread', thread);
      return complete;
    },
    removeThread(id) {
      this.state.threads = this.state.threads.filter(t => t.id !== id);
      this.drafts.delete(id);
      this.emit('removed', id);
      this.emit('threads');
    },
    addProject(project) {
      if (!this.state.projects.some(p => p.id === project.id)) this.state.projects.push(project);
      this.emit('threads');
    }
  };
  return store;
}
