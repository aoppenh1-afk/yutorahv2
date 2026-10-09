import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, RootContent, PhrasingContent } from 'mdast';

export type NotesRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  url?: string;
};
export type NotesBlock = {
  runs: NotesRun[];
  heading?: number;
  prefix?: string;
  indent?: number;
};

function inline(
  nodes: PhrasingContent[],
  style: Omit<NotesRun, 'text'> = {},
  links: Map<string, string> = new Map(),
): NotesRun[] {
  return nodes.flatMap((node): NotesRun[] => {
    switch (node.type) {
      case 'text':
        return [{ text: node.value, ...style }];
      case 'inlineCode':
        return [{ text: node.value, ...style, code: true }];
      case 'break':
        return [{ text: '\n', ...style }];
      case 'strong':
        return inline(node.children, { ...style, bold: true }, links);
      case 'emphasis':
        return inline(node.children, { ...style, italic: true }, links);
      case 'link':
        return inline(
          node.children,
          { ...style, url: safeLink(node.url) },
          links,
        );
      case 'linkReference':
        return inline(
          node.children,
          { ...style, url: links.get(node.identifier) },
          links,
        );
      case 'image':
        return [{ text: node.alt ?? '', ...style }];
      default:
        return [];
    }
  });
}

function safeLink(url: string) {
  return /^(https?:|mailto:)/i.test(url) ? url : undefined;
}

export function notesBlocks(markdown: string): NotesBlock[] {
  const root = unified().use(remarkParse).parse(markdown) as Root;
  const blocks: NotesBlock[] = [];
  const links = new Map(
    root.children.flatMap((node) =>
      node.type === 'definition' && safeLink(node.url)
        ? [[node.identifier, node.url] as const]
        : [],
    ),
  );
  function visit(nodes: RootContent[], indent = 0) {
    for (const node of nodes) {
      if (node.type === 'heading' || node.type === 'paragraph') {
        blocks.push({
          runs: inline(node.children, {}, links),
          indent,
          ...(node.type === 'heading' ? { heading: node.depth } : {}),
        });
      } else if (node.type === 'list') {
        node.children.forEach((item, index) => {
          const start = blocks.length;
          visit(item.children, indent + 1);
          if (blocks[start])
            blocks[start].prefix = node.ordered
              ? `${(node.start ?? 1) + index}. `
              : '• ';
        });
      } else if (node.type === 'blockquote') {
        visit(node.children, indent + 1);
      } else if (node.type === 'code') {
        blocks.push({ runs: [{ text: node.value, code: true }], indent });
      }
    }
  }
  visit(root.children);
  return blocks;
}
