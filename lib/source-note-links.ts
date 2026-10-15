import type { Root, RootContent, PhrasingContent } from 'mdast';
import type { TranscriptSource } from './sources';

/** Link only unchanged Markdown text leaves, never code, existing links, or HTML. */
export function remarkSourceLinks(options: { sources: TranscriptSource[] }) {
  const spans = options.sources.flatMap((source) =>
    source.occurrences.flatMap((occurrence) =>
      occurrence.origin === 'notes'
        ? (occurrence.noteSpans || []).map((span) => ({
            ...span,
            url: source.url,
          }))
        : [],
    ),
  );
  return (root: Root, file: { value: unknown }) => {
    const markdown = String(file.value);
    function visit(nodes: Array<RootContent | PhrasingContent>) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.type === 'text') {
          const start = node.position?.start.offset,
            end = node.position?.end.offset;
          if (
            start === undefined ||
            end === undefined ||
            markdown.slice(start, end) !== node.value
          )
            continue;
          const matches = spans
            .filter((span) => span.startChar < end && span.endChar > start)
            .sort((a, b) => a.startChar - b.startChar || b.endChar - a.endChar);
          const replacements: PhrasingContent[] = [];
          let position = 0;
          for (const match of matches) {
            const left = Math.max(0, match.startChar - start),
              right = Math.min(node.value.length, match.endChar - start);
            if (left < position || right <= left) continue;
            if (left > position)
              replacements.push({
                type: 'text',
                value: node.value.slice(position, left),
              });
            replacements.push({
              type: 'link',
              url: match.url,
              children: [
                { type: 'text', value: node.value.slice(left, right) },
              ],
            });
            position = right;
          }
          if (!replacements.length) continue;
          if (position < node.value.length)
            replacements.push({
              type: 'text',
              value: node.value.slice(position),
            });
          nodes.splice(i, 1, ...replacements);
          i += replacements.length - 1;
        } else if (
          'children' in node &&
          node.type !== 'link' &&
          node.type !== 'linkReference'
        )
          visit(node.children as Array<RootContent | PhrasingContent>);
      }
    }
    visit(root.children);
  };
}
