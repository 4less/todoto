<script lang="ts">
  import { todos, notes, whiteboards } from '$lib/stores';
  import { parseLinks, resolveLink, openLinkTarget, type LinkKind } from '$lib/links';

  // Renders a string with its @kind:id tokens replaced by the linked resource's
  // current title. Titles are looked up live, so renaming a target updates every
  // place that links to it.

  let { text = '', inline = false }: { text?: string; inline?: boolean } = $props();

  interface Piece {
    kind: 'text' | 'link';
    text: string;
    linkKind?: LinkKind;
    id?: string;
    missing?: boolean;
  }

  let pieces = $derived.by<Piece[]>(() => {
    const links = parseLinks(text);
    if (links.length === 0) return [{ kind: 'text', text }];
    const out: Piece[] = [];
    let cursor = 0;
    for (const l of links) {
      if (l.start > cursor) out.push({ kind: 'text', text: text.slice(cursor, l.start) });
      const target = resolveLink(l, $todos, $notes, $whiteboards);
      out.push({ kind: 'link', text: target.title, linkKind: l.kind, id: l.id, missing: target.missing });
      cursor = l.end;
    }
    if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
    return out;
  });

  function open(kind: LinkKind, id: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    openLinkTarget(kind, id);
  }
</script>

{#each pieces as p, i (i)}
  {#if p.kind === 'text'}{p.text}{:else}
    <button
      class="link {p.linkKind} {p.missing ? 'missing' : ''}"
      class:inline
      onclick={(e) => open(p.linkKind!, p.id!, e)}
      onpointerdown={(e) => e.stopPropagation()}
      title={p.missing ? 'This resource no longer exists' : `Open ${p.linkKind}: ${p.text}`}
    >{p.text}</button>
  {/if}
{/each}

<style>
  .link {
    display: inline; padding: 0 3px; margin: 0 1px;
    border: none; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: inherit; line-height: inherit;
    background: var(--accent-bg); color: var(--accent-lt);
    border-bottom: 1px solid transparent;
  }
  .link:hover { border-bottom-color: currentColor; }
  .link.note  { background: var(--green-bg); color: var(--green); }
  .link.board { background: var(--yellow-bg); color: var(--yellow); }
  .link.missing {
    background: var(--red-bg); color: var(--red);
    text-decoration: line-through; cursor: default;
  }
</style>
