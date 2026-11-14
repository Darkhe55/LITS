/**
 * LITS —— 游戏类型入口
 *
 * 规则与求解所需的纯逻辑都在 engine.ts；这里只做统一转出，
 * 让 src/game 下其它模块保持和模板一致的引用方式。
 */

export {
  asLitsPuzzle,
  asLitsState,
  EMPTY,
  FILLED,
  PIECE_TYPES,
  type Candidate,
  type LitsPuzzle,
  type LitsResult,
  type LitsState,
  type PieceType,
  type RegionInfo,
} from './engine'
