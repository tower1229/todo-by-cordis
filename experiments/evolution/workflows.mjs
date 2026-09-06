// Handwritten mechanism probes. These are not AI-generated plugins.
export const workflows = {
  default: {
    states: ['open', 'done'],
    actions: (task) => task.state === 'done' ? ['reopen'] : ['complete'],
    decide: (task, action) => ({ kind: 'commit', state: action === 'reopen' ? 'open' : 'done', fields: task.fields }),
  },
  review: {
    states: ['open', 'review', 'done'],
    actions: (task) => task.state === 'done' ? ['reopen'] : ['complete'],
    decide: (task, action, input) => {
      if (action === 'reopen') return { kind: 'commit', state: 'open', fields: task.fields };
      if (!input?.review?.trim()) return { kind: 'input-required', fields: [{ key: 'review', label: '完成前，留下一句复盘', type: 'text' }] };
      return { kind: 'commit', state: 'done', fields: { ...task.fields, review: input.review } };
    },
  },
};
