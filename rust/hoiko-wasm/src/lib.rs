//! wasm32 cdylib wrapper for `hoiko-core`.
//!
//! The engine is pure and deterministic, so it is developed/verified as a native
//! binary (`cargo test`) and only compiled to wasm for shipping. FFI is one call
//! per move (`search`) plus zero-copy board handoff via linear memory.

use hoiko_core::ffi::{run_search_ffi, HSearchInput, HSearchOutput};
use hoiko_core::{Board, BOARD_HEIGHT, BOARD_WIDTH, log2, popcount};

/// Allocate `size` bytes in linear memory for the host to write into.
#[unsafe(no_mangle)]
pub extern "C" fn h_alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Free a buffer previously returned by `h_alloc` (same `size`).
///
/// # Safety
/// `ptr` must originate from `h_alloc(size)` and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn h_dealloc(ptr: *mut u8, size: usize) {
    if !ptr.is_null() {
        unsafe {
            drop(Vec::from_raw_parts(ptr, 0, size));
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn h_popcount(v: i32) -> i32 {
    popcount(v)
}

#[unsafe(no_mangle)]
pub extern "C" fn h_log2(bit: i32) -> i32 {
    log2(bit)
}

#[unsafe(no_mangle)]
pub extern "C" fn h_search_input_size() -> usize {
    core::mem::size_of::<HSearchInput>()
}

#[unsafe(no_mangle)]
pub extern "C" fn h_search_output_size() -> usize {
    core::mem::size_of::<HSearchOutput>()
}

/// One search per move. `in_ptr`/`out_ptr` point at linear-memory blocks of
/// `h_search_input_size()` / `h_search_output_size()` bytes laid out exactly as
/// `hoiko_core::ffi::HSearchInput` / `HSearchOutput` (documented there).
///
/// Returns 1 when a first move was produced (and `out` is filled), else 0.
///
/// # Safety
/// `in_ptr` must point to a valid, initialised `HSearchInput` and `out_ptr` to a
/// writable `HSearchOutput`; neither may overlap.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn h_search(in_ptr: *const HSearchInput, out_ptr: *mut HSearchOutput) -> i32 {
    if in_ptr.is_null() || out_ptr.is_null() {
        return 0;
    }
    let input = unsafe { &*in_ptr };
    let out = unsafe { &mut *out_ptr };
    run_search_ffi(input, out)
}

/// Read `BOARD_HEIGHT` row masks + `stack_height` from linear memory, write
/// `BOARD_WIDTH` column heights back, and return the garbage height.
///
/// # Safety
/// `rows` must point to at least `BOARD_HEIGHT` `i32`s; `out` to at least
/// `BOARD_WIDTH` `i32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn h_get_column_height(
    rows: *const i32,
    stack_height: i32,
    out: *mut i32,
) -> i32 {
    let mut board = Board::default();
    for y in 0..BOARD_HEIGHT {
        board.line[y] = unsafe { *rows.add(y) };
    }
    board.stack_height = stack_height;
    let mut ch = [-1i32; BOARD_WIDTH];
    let garbage = board.get_column_height(&mut ch);
    for x in 0..BOARD_WIDTH {
        unsafe {
            *out.add(x) = ch[x];
        }
    }
    garbage
}
