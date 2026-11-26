import { createApp, h, shallowRef } from 'vue';

interface NoteRow {
  id: string;
  title: string;
  subtitle: string;
  preview: string;
  phase: string;
  active: boolean;
  selection: null | { checked: boolean; disabled: boolean; visibility: string };
}

export function mountNotes(host: HTMLElement, actions: {
  open(id: string): void;
  select(id: string, checked: boolean): boolean;
}) {
  const notes = shallowRef<NoteRow[]>([]);
  const app = createApp(() => notes.value.length ? notes.value.map((note) => {
    const button = h('button', {
      key: note.id,
      type: 'button',
      class: ['kb-document', { active: note.active }],
      onClick: () => actions.open(note.id)
    }, [
      h('strong', note.title), h('small', note.subtitle), h('p', note.preview),
      note.phase ? h('small', note.phase) : null,
      note.selection ? h('span', { class: 'kb-hint' }, note.selection.visibility) : null
    ]);
    if (!note.selection) return button;
    return h('div', { key: note.id, class: 'kb-document-row' }, [
      h('input', {
        type: 'checkbox',
        'aria-label': '选择笔记：' + note.title,
        checked: note.selection.checked,
        disabled: note.selection.disabled,
        onChange(event: Event) {
          const input = event.currentTarget as HTMLInputElement;
          if (!actions.select(note.id, input.checked)) input.checked = !input.checked;
        }
      }),
      button
    ]);
  }) : [h('p', { class: 'kb-hint' }, '还没有符合条件的内容。上传视频后会出现在这里。')]);
  app.mount(host);
  return {
    update(rows: NoteRow[]) { notes.value = rows; },
    dispose() { app.unmount(); }
  };
}
