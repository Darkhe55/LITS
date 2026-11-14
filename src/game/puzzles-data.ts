/* 自动生成，勿手改。运行 npm run gen 重新生成。 */
export interface RawPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
  series: string
  /** 题面编码串（格式由 src/game/puzzles.ts 解析） */
  board: string
  /** 参考解编码串（没有则留空） */
  solution?: string
  /** 题面给定格编码串（可选） */
  givens?: string
}

export const RAW_PUZZLES: RawPuzzle[] = [
  { id: "lits2-6x6-46ip0z5t", name: "初识骨墙", width: 6, height: 6, difficulty: 'easy', series: "入门", board: "111112000112000332044332444352555552", solution: "001110111011010101011111110101011110" },
  { id: "lits2-6x6-46ip0z5u", name: "四格初阵", width: 6, height: 6, difficulty: 'easy', series: "入门", board: "335555332254300254302244301144001111", solution: "111111100100110101011111010101011110" },
  { id: "lits2-6x6-46ip0z5v", name: "L 形回廊", width: 6, height: 6, difficulty: 'medium', series: "进阶", board: "555554115544133344110334000022022222", solution: "001111110101101101100111111101000111" },
  { id: "lits2-6x6-46ip0z5w", name: "交错墙影", width: 6, height: 6, difficulty: 'medium', series: "进阶", board: "333333442222540022544011544011555001", solution: "111100010111010101011101100111111101" },
  { id: "lits2-6x6-46ip0z5x", name: "骨墙迷宫", width: 6, height: 6, difficulty: 'hard', series: "挑战", board: "000033220034221134211334251544555544", solution: "011110101010111110101011001001111111" },
  { id: "lits2-6x6-46ip0z5y", name: "四型终局", width: 6, height: 6, difficulty: 'hard', series: "挑战", board: "222222000002011144511114553334553344", solution: "000111111101001001111101100111111101" },
]
