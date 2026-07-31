import { get } from 'svelte/store';

import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { editorViewCtx } from '@milkdown/core';
import { todos, notes, whiteboards } from './stores';
import { parseLinks, resolveLink, openLinkTarget, type LinkKind } from './links';
import { mention, pickerOpen, findMention, clearMention } from './mentions';

// ProseMirror plugin that makes @kind:id link tokens live inside the Milkdown
// editor: each one is highlighted in place and opens its resource on click.
//
// Decorations rather than node substitution: the token stays real text, so
// typing, selection, undo and the markdown that gets written to disk are all
// untouched. Replacing the token with a widget showing the title would read
// better but puts an uneditable atom in the middle of a paragraph, and the
// caret behaviour around it is consistently awful.

export const linkDecorationKey = new PluginKey('todoto-links');

/**
 * Looks for an active "@…" immediately before the caret and publishes it as
 * mention state so the shared popup can appear over the editor.
 */
function syncMention(view: any) {
  if (get(pickerOpen)) return; // the picker owns a captured copy; don't disturb it
  const { selection } = view.state;
  if (!selection.empty || !view.hasFocus()) {
    clearMention((m) => m.target.type === 'prose');
    return;
  }

  const $from = selection.$from;
  // Only the text of the current block, up to the caret — a mention never
  // spans a block boundary.
  const start = Math.max(0, $from.parentOffset - 64);
  const textBefore = $from.parent.textBetween(start, $from.parentOffset, undefined, '￼');

  const found = findMention(textBefore);
  if (!found) {
    clearMention((m) => m.target.type === 'prose');
    return;
  }

  const from = $from.pos - (textBefore.length - found.at);
  const to = $from.pos;
  const coords = view.coordsAtPos(from);

  mention.set({
    target: { type: 'prose', view, from, to },
    query: found.query,
    left: coords.left,
    top: coords.bottom + 4,
  });
}

export function createLinkDecorationPlugin() {
  return new Plugin({
    key: linkDecorationKey,
    props: {
      decorations(state: any) {
        const $todos = get(todos);
        const $notes = get(notes);
        const $boards = get(whiteboards);
        const decos: Decoration[] = [];

        state.doc.descendants((node: any, pos: number) => {
          if (!node.isText || !node.text) return;
          for (const link of parseLinks(node.text)) {
            const target = resolveLink(link, $todos, $notes, $boards);
            decos.push(
              Decoration.inline(pos + link.start, pos + link.end, {
                class: `todoto-link todoto-link-${link.kind}${target.missing ? ' todoto-link-missing' : ''}`,
                // Surfaced on hover, since the raw token stays visible in the text.
                title: target.missing
                  ? 'This resource no longer exists'
                  : `${target.title} — click to open`,
                'data-link-kind': link.kind,
                'data-link-id': link.id,
              })
            );
          }
        });

        return DecorationSet.create(state.doc, decos);
      },

      handleClick(_view: any, _pos: number, event: MouseEvent) {
        const el = (event.target as HTMLElement | null)?.closest?.('.todoto-link') as HTMLElement | null;
        if (!el) return false;
        const kind = el.getAttribute('data-link-kind') as LinkKind | null;
        const id = el.getAttribute('data-link-id');
        if (!kind || !id || el.classList.contains('todoto-link-missing')) return false;
        event.preventDefault();
        openLinkTarget(kind, id);
        return true; // handled — don't also move the caret into the token
      },
    },

    // Watches the caret so "@" raises the suggestion as you type. Enter is
    // intercepted globally by MentionHost, which sees the same mention state.
    view() {
      return {
        update(view: any) {
          syncMention(view);
        },
        destroy() {
          clearMention((m) => m.target.type === 'prose');
        },
      };
    },
  });
}

/** Adds the plugin to a live Milkdown editor. Call inside `editor.action(ctx => …)`. */
export function installLinkPlugin(milkCtx: any) {
  const view = milkCtx.get(editorViewCtx);
  view.updateState(
    view.state.reconfigure({ plugins: [...view.state.plugins, createLinkDecorationPlugin()] })
  );
}
