import type { RawPuzzle } from './puzzles-data'

/** 由 scripts/import-image.mjs 追加；不会在 npm run gen 时被覆盖 */
export const IMPORTED_PUZZLES: RawPuzzle[] = [
  { id: "lits-import-15x15", name: "十五阶骨墙", width: 15, height: 15, difficulty: 'hard', series: "导入", board: "00001111222344400555671288334309995671188333399995677a8b3bccddd9667aabbbbbcd999e677abfccccg9eeee77ahffffcg9ijjj77hhhfkfcggijjllhhhmmkknggiijjlllmmkkknogpjjqqrrrskknnogpjjjqqrrsttntogpjuuuqrrsstttogpjjuuqqvvvvwtgggjuuqqvvwwwww", solution: "110011111110111101110101010010111010100111111001101111100101111011001011101100001001000011001111001011110101000001110100111011101011111101110110110101101010001010011101010001110001101011111011011101001010110001000000111101111" },
]
