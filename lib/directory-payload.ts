import type { Directory } from './yutorah';
export type CompactDirectory = {
  format: 'directory-v1';
  roots: string[];
  teachers: [number, string, string, string, number, string][];
  series: [number, string, number, string][];
  topics: [number, string, number, string, string, string[]][];
  groups: string[];
};
/** Compact lookup metadata preserves portraits and search identity. Full browse
 * responses still supply descriptions when their section is opened. */
export function compactDirectory(directory: Directory): CompactDirectory {
  const roots: string[] = [];
  const image = (url: string) => {
    if (!url) return '';
    const slash = url.lastIndexOf('/');
    if (slash < 8) return url;
    const root = url.slice(0, slash + 1);
    let index = roots.indexOf(root);
    if (index < 0) {
      index = roots.length;
      roots.push(root);
    }
    return '@' + index + ':' + url.slice(slash + 1);
  };
  return {
    format: 'directory-v1',
    roots,
    teachers: directory.teachers.map((t) => [
      t.id,
      t.name,
      t.firstName,
      t.lastName,
      t.count,
      image(t.image),
    ]),
    series: directory.series.map((s) => [
      s.id,
      s.name,
      s.count,
      image(s.image),
    ]),
    topics: directory.topics.map((t) => [
      t.id,
      t.name,
      t.count,
      t.group,
      t.branch || '',
      t.path || [],
    ]),
    groups: directory.groups,
  };
}
export function expandDirectory(
  payload: Directory | CompactDirectory,
): Directory {
  if (!('format' in payload)) return payload;
  if (payload.format !== 'directory-v1')
    throw new Error('Unsupported directory response.');
  const image = (url: string) => {
    const match = url.match(/^@(\d+):([\s\S]*)$/);
    return match ? (payload.roots[Number(match[1])] || '') + match[2] : url;
  };
  return {
    teachers: payload.teachers.map(
      ([id, name, firstName, lastName, count, src]) => ({
        id,
        name,
        firstName,
        lastName,
        count,
        image: image(src),
      }),
    ),
    series: payload.series.map(([id, name, count, src]) => ({
      id,
      name,
      count,
      image: image(src),
      description: '',
    })),
    topics: payload.topics.map(([id, name, count, group, branch, path]) => ({
      id,
      name,
      count,
      group,
      branch,
      path,
    })),
    groups: payload.groups,
  };
}
