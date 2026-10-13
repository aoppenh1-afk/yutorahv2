/** Names and IDs follow YUTorah's public daf selector. */
export const dafTractates = [
  ['Berachot', 6004, 64],
  ['Shabbat', 6005, 157],
  ['Eruvin', 6006, 105],
  ['Pesachim', 6007, 121],
  ['Shekalim', 6008, 22],
  ['Yoma', 6009, 88],
  ['Succah', 6010, 56],
  ['Beitza', 6011, 40],
  ['Rosh Hashana', 6012, 35],
  ['Taanit', 6040, 31],
  ['Megilla', 6013, 32],
  ['Moed Katan', 6014, 29],
  ['Chagiga', 6015, 27],
  ['Yevamot', 6016, 122],
  ['Ketuvot', 6017, 112],
  ['Nedarim', 6018, 91],
  ['Nazir', 6019, 66],
  ['Sotah', 6020, 49],
  ['Gittin', 6021, 90],
  ['Kiddushin', 6022, 82],
  ['Bava Kamma', 6023, 119],
  ['Bava Metzia', 6024, 119],
  ['Bava Batra', 6025, 176],
  ['Sanhedrin', 6026, 113],
  ['Makot', 6027, 24],
  ['Shevuot', 6028, 49],
  ['Avoda Zara', 6029, 76],
  ['Horayot', 6030, 14],
  ['Zevachim', 6031, 120],
  ['Menachot', 6032, 110],
  ['Chullin', 6033, 142],
  ['Bechorot', 6034, 61],
  ['Arachin', 6039, 34],
  ['Temura', 6035, 34],
  ['Keritut', 6036, 28],
  ["Me'ila etc", 6037, 37],
  ['Nidah', 6038, 73],
].map(([name, id, lastPage]) => ({
  name: String(name),
  id: Number(id),
  lastPage: Number(lastPage),
}));
export type DafSelection = { tractate: string; page: number; side: 'a' | 'b' };
export function parseDaf(value: string): DafSelection | null {
  const match = /^(.*?)\s+(\d+)([ab])?$/i.exec(
    value.trim().replace(/[-_]+/g, ' '),
  );
  const tractate = dafTractates.find(
    (t) => t.name.toLowerCase() === match?.[1].toLowerCase(),
  );
  const page = Number(match?.[2]);
  return tractate && page >= 2 && page <= tractate.lastPage
    ? {
        tractate: tractate.name,
        page,
        side: match?.[3]?.toLowerCase() === 'b' ? 'b' : 'a',
      }
    : null;
}
