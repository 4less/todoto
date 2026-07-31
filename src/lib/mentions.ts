import { writable, get } from 'svelte/store';

// Typing "@" raises a suggestion, which opens the link picker. One host component
// (MentionHost) renders the popup and picker for the whole app; the places you
// can type into register themselves here.
//
// Two kinds of target, because the app has two kinds of text surface: plain
// input/textarea fields, and the ProseMirror document inside Milkdown. They
// differ only in how the caret is located and how text is written back, so the
// popup, the picker and the insertion flow are shared.

export type MentionTarget =
  | { type: 'field'; el: HTMLInputElement | HTMLTextAreaElement; at: number }
  | { type: 'prose'; view: any; from: number; to: number };

export interface MentionState {
  target: MentionTarget;
  /** Text typed after the "@", used to prefill the picker's search. */
  query: string;
  /** Where to put the popup, in viewport coordinates. */
  left: number;
  top: number;
}

/** Non-null while a "@" is being typed somewhere that supports linking. */
export const mention = writable<MentionState | null>(null);
/** True while the picker window is open. */
export const pickerOpen = writable(false);

/**
 * Finds an active "@" immediately before the caret in a run of text. It only
 * counts when the "@" starts a word, so email addresses and mid-word "@" don't
 * trigger, and it stops at whitespace so a finished token no longer matches.
 *
 * `text` ends at the caret; the returned index is relative to `text`.
 */
export function findMention(text: string): { at: number; query: string } | null {
  for (let i = text.length - 1; i >= 0 && text.length - i <= 64; i--) {
    const ch = text[i];
    if (ch === '@') {
      const before = i > 0 ? text[i - 1] : ' ';
      if (!/[\s(\[{]/.test(before)) return null;
      const query = text.slice(i + 1);
      // A completed link token is not an active mention any more.
      if (/^[tnb]:\S/.test(query)) return null;
      return { at: i, query };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

/** Clears the mention unless the picker is up (which owns a captured copy). */
export function clearMention(matching?: (m: MentionState) => boolean) {
  if (get(pickerOpen)) return;
  mention.update((m) => (m && (!matching || matching(m)) ? null : m));
}

/**
 * Svelte action: makes a plain text field participate in "@" linking.
 * Usage: `<input use:attachMention />`
 */
export function attachMention(node: HTMLInputElement | HTMLTextAreaElement) {
  function update() {
    const caret = node.selectionStart ?? 0;
    const found = findMention(node.value.slice(0, caret));
    if (!found) {
      clearMention((m) => m.target.type === 'field' && m.target.el === node);
      return;
    }
    const r = node.getBoundingClientRect();
    mention.set({
      target: { type: 'field', el: node, at: found.at },
      query: found.query,
      left: r.left,
      top: r.bottom + 4,
    });
  }

  function onBlur() {
    // Delay so a click on the popup lands before it's torn down.
    setTimeout(() => clearMention((m) => m.target.type === 'field' && m.target.el === node), 150);
  }

  node.addEventListener('input', update);
  node.addEventListener('click', update);
  node.addEventListener('keyup', update);
  node.addEventListener('blur', onBlur);

  return {
    destroy() {
      node.removeEventListener('input', update);
      node.removeEventListener('click', update);
      node.removeEventListener('keyup', update);
      node.removeEventListener('blur', onBlur);
      clearMention((m) => m.target.type === 'field' && m.target.el === node);
    },
  };
}

/**
 * Writes text into an input/textarea through the native value setter so Svelte's
 * two-way bindings and any `oninput` handlers see the change.
 */
export function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  el.setSelectionRange(caret, caret);
}

/** Replaces the in-progress "@query" with the given tokens. */
export function insertTokens(state: MentionState, tokens: string[]) {
  const text = tokens.join(' ');

  if (state.target.type === 'field') {
    const { el, at } = state.target;
    const before = el.value.slice(0, at);
    const after = el.value.slice(at + 1 + state.query.length);
    const joined = `${before}${text}${after.startsWith(' ') ? '' : ' '}${after}`;
    setFieldValue(el, joined, before.length + text.length + 1);
    return;
  }

  const { view, from, to } = state.target;
  // insertText replaces the "@query" range in one step, so it's a single undo.
  view.dispatch(view.state.tr.insertText(`${text} `, from, to));
  view.focus();
}

/** Returns focus to wherever the mention started, after the picker closes. */
export function refocus(state: MentionState | null) {
  if (!state) return;
  if (state.target.type === 'field') state.target.el.focus();
  else state.target.view.focus();
}
