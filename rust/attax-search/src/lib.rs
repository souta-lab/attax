//! Native port of the Attax bot's decision path (`src/ai/bot/`): exact movegen BFS,
//! board features, the weights table as data, and the beam search with the optional
//! 7-bag chance ply. Decisions are required to be bit-identical to the TS bot; see
//! `rust/SEARCH-PORT.md` and the agreement harness (`attax-search-cli`).

pub mod features;
pub mod movegen;
pub mod pieces;
pub mod search;
pub mod weights;

pub use movegen::{Board, MoveGen, Placement, Pos, Tspin};
pub use pieces::Kind;
pub use search::{Candidate, SearchInput, SearchOptions, SearchResult, Searcher, Step};
pub use weights::Weights;
